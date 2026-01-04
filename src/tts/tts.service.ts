import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

export interface VisemeEvent {
    visemeId: number;
    audioOffset: number; // milliseconds from audio start
}

export interface TtsResult {
    audio: Buffer;
    visemes: VisemeEvent[];
}

@Injectable()
export class TtsService {
    private readonly logger = new Logger(TtsService.name);
    private readonly azureKey: string;
    private readonly azureRegion: string;
    private readonly voiceName = 'ko-KR-SunHiNeural';
    private styleMode: string | null = null;

    constructor(private configService: ConfigService) {
        this.azureKey = this.configService.get<string>('AZURE_SPEECH_KEY') || '';
        this.azureRegion = this.configService.get<string>('AZURE_SPEECH_REGION') || 'koreacentral';
    }

    /**
     * Synthesize speech with viseme events using Azure Speech SDK
     * Returns both audio buffer and viseme timing data
     */
    async synthesizePcmWithVisemes(text: string): Promise<TtsResult> {
        this.logger.log(`[TTS+Viseme 시작] 텍스트 길이: ${text.length}자`);

        if (!this.azureKey) {
            throw new Error('AZURE_SPEECH_KEY is not set');
        }

        return new Promise((resolve, reject) => {
            const speechConfig = sdk.SpeechConfig.fromSubscription(this.azureKey, this.azureRegion);

            // Configure for PCM output (16kHz, 16-bit mono) matching LiveKit requirements
            speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;
            speechConfig.speechSynthesisVoiceName = this.voiceName;

            const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
            const visemes: VisemeEvent[] = [];

            // Capture viseme events
            synthesizer.visemeReceived = (sender, event) => {
                visemes.push({
                    visemeId: event.visemeId,
                    // Convert from 100ns ticks to milliseconds
                    audioOffset: event.audioOffset / 10000,
                });
            };

            const ssml = this.buildSsmlWithViseme(text);

            synthesizer.speakSsmlAsync(
                ssml,
                (result) => {
                    if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
                        const audioData = Buffer.from(result.audioData);
                        this.logger.log(`[TTS+Viseme 완료] 오디오: ${audioData.length} bytes, Visemes: ${visemes.length}개`);
                        synthesizer.close();
                        resolve({ audio: audioData, visemes });
                    } else {
                        const errorDetail = sdk.CancellationDetails.fromResult(result);
                        this.logger.error(`[TTS 에러] ${errorDetail.errorDetails}`);
                        synthesizer.close();
                        reject(new Error(`TTS failed: ${errorDetail.errorDetails}`));
                    }
                },
                (error) => {
                    this.logger.error(`[TTS 에러] ${error}`);
                    synthesizer.close();
                    reject(error);
                }
            );
        });
    }

    /**
     * Legacy method: PCM only without visemes (for backward compatibility)
     */
    async synthesizePcm(text: string): Promise<Buffer> {
        const result = await this.synthesizePcmWithVisemes(text);
        return result.audio;
    }

    /**
     * Get visemes along with audio synthesis
     * This is the main method for lip-sync enabled TTS
     */
    async synthesizeWithVisemes(text: string): Promise<TtsResult> {
        return this.synthesizePcmWithVisemes(text);
    }

    /**
     * Legacy MP3 output (HTTP 응답용) - uses REST API
     */
    async synthesize(text: string): Promise<Buffer> {
        this.logger.log(`[TTS 시작] 텍스트 길이: ${text.length}자`);

        try {
            const audioBuffer = await this.synthesizeWithAzureRest(
                text,
                'audio-24khz-48kbitrate-mono-mp3'
            );
            this.logger.log(`[TTS 완료] 오디오 크기: ${audioBuffer.length} bytes`);

            return audioBuffer;
        } catch (error) {
            this.logger.error(`[TTS 에러] ${error.message}`);
            throw error;
        }
    }

    /**
     * Build SSML with viseme request
     */
    private buildSsmlWithViseme(text: string): string {
        const normalized = this.normalizeSpeech(text);
        const escaped = this.escapeSsml(normalized);
        const style = this.pickStyle();

        // Request viseme data in SSML
        if (style) {
            return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ko-KR">` +
                `<voice name="${this.voiceName}">` +
                `<mstts:viseme type="redlips_front"/>` +
                `<mstts:express-as style="${style}">` +
                `<prosody pitch="-3%" rate="10%">${escaped}</prosody>` +
                `</mstts:express-as>` +
                `</voice></speak>`;
        }

        return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="ko-KR">` +
            `<voice name="${this.voiceName}">` +
            `<mstts:viseme type="redlips_front"/>` +
            `<prosody pitch="-5%" rate="10%">${escaped}</prosody>` +
            `</voice></speak>`;
    }

    /**
     * REST API fallback for MP3 output
     */
    private async synthesizeWithAzureRest(text: string, outputFormat: string): Promise<Buffer> {
        if (!this.azureKey) {
            throw new Error('AZURE_SPEECH_KEY is not set');
        }

        const url = `https://${this.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
        const headers = {
            'Ocp-Apim-Subscription-Key': this.azureKey,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': outputFormat,
            'User-Agent': 'aura-voice-bot',
        };

        const style = this.pickStyle();
        const primary = style ? this.buildSsmlWithStyle(text, style) : this.buildSsml(text);
        const primaryResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: primary,
        });

        if (primaryResponse.ok) {
            if (style) {
                this.styleMode = style;
            }
            const arrayBuffer = await primaryResponse.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }

        // 스타일 미지원 등 실패 시 기본 SSML로 재시도
        if (style) {
            this.styleMode = 'none';
        }
        const fallbackResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: this.buildSsml(text),
        });

        if (!fallbackResponse.ok) {
            const errorText = await fallbackResponse.text();
            throw new Error(`Azure TTS failed: ${fallbackResponse.status} ${errorText}`);
        }

        const fallbackBuffer = await fallbackResponse.arrayBuffer();
        return Buffer.from(fallbackBuffer);
    }

    private buildSsml(text: string): string {
        const normalized = this.normalizeSpeech(text);
        const escaped = this.escapeSsml(normalized);
        return `<speak version="1.0" xml:lang="ko-KR"><voice name="${this.voiceName}"><prosody pitch="-5%" rate="10%">${escaped}</prosody></voice></speak>`;
    }

    private buildSsmlWithStyle(text: string, style: string): string {
        const normalized = this.normalizeSpeech(text);
        const escaped = this.escapeSsml(normalized);
        return `<speak version="1.0" xml:lang="ko-KR">` +
            `<voice xmlns:mstts="https://www.w3.org/2001/mstts" name="${this.voiceName}">` +
            `<mstts:express-as style="${style}">` +
            `<prosody pitch="-3%" rate="10%">${escaped}</prosody>` +
            `</mstts:express-as></voice></speak>`;
    }

    private pickStyle(): string | null {
        if (this.styleMode === 'none') {
            return null;
        }
        if (this.styleMode) {
            return this.styleMode;
        }
        const styles = ['conversational', 'friendly', 'cheerful'];
        return styles[Math.floor(Math.random() * styles.length)];
    }

    private normalizeSpeech(text: string): string {
        return text
            .replace(/합니다(?=[\s\.\?\!]|$)/g, '해요')
            .replace(/입니다(?=[\s\.\?\!]|$)/g, '이에요');
    }

    private escapeSsml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}
