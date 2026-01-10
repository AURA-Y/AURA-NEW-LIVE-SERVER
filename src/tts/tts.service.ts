import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

    // LiveKit용 PCM 출력 (16kHz, 16-bit signed)
    async synthesizePcm(text: string): Promise<Buffer> {
        this.logger.log(`[TTS PCM 시작] 텍스트 길이: ${text.length}자`);

        try {
            const audioBuffer = await this.synthesizeWithAzure(
                text,
                'raw-16khz-16bit-mono-pcm'
            );
            this.logger.log(`[TTS PCM 완료] 오디오 크기: ${audioBuffer.length} bytes`);
            return audioBuffer;
        } catch (error) {
            this.logger.error(`[TTS PCM 에러] ${error.message}`);
            throw error;
        }
    }

    // Buffer 반환용 (voice-bot에서 사용)
    async synthesizeToBuffer(text: string): Promise<Buffer> {
        return this.synthesizePcm(text);
    }

    // 기존 MP3 출력 (HTTP 응답용)
    async synthesize(text: string): Promise<Buffer> {
        this.logger.log(`[TTS 시작] 텍스트 길이: ${text.length}자`);

        try {
            const audioBuffer = await this.synthesizeWithAzure(
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

    private async synthesizeWithAzure(text: string, outputFormat: string): Promise<Buffer> {
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
        // 마크다운 포맷 및 이모티콘 제거 (TTS가 읽지 않도록)
        return this.stripMarkdown(text);
    }

    /**
     * 마크다운 포맷 및 이모티콘 제거
     * LLM 응답에 포함된 마크다운과 이모티콘을 TTS가 읽지 않도록 제거
     */
    private stripMarkdown(text: string): string {
        return text
            // Bold/Italic: ***text***, **text**, *text*
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
            // Strikethrough: ~~text~~
            .replace(/~~([^~]+)~~/g, '$1')
            // Inline code: `code`
            .replace(/`([^`]+)`/g, '$1')
            // Headers: # text, ## text, etc.
            .replace(/^#{1,6}\s+/gm, '')
            // Unordered list: - item, * item
            .replace(/^[\-\*]\s+/gm, '')
            // Ordered list: 1. item
            .replace(/^\d+\.\s+/gm, '')
            // Links: [text](url) → text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Images: ![alt](url) → remove entirely
            .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
            // Blockquote: > text
            .replace(/^>\s+/gm, '')
            // Horizontal rule: ---, ***
            .replace(/^[\-\*]{3,}$/gm, '')
            // 이모티콘/이모지 제거 (Unicode emoji ranges)
            .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')  // Miscellaneous Symbols, Emoticons, etc.
            .replace(/[\u{2600}-\u{26FF}]/gu, '')    // Misc symbols
            .replace(/[\u{2700}-\u{27BF}]/gu, '')    // Dingbats
            .replace(/[\u{FE00}-\u{FE0F}]/gu, '')    // Variation Selectors
            .replace(/[\u{1F000}-\u{1F02F}]/gu, '')  // Mahjong, Domino
            .replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '')  // Playing cards
            // 텍스트 이모티콘 (❌, ✅, ✓, ✗ 등)
            .replace(/[❌✅✓✗⭕️⚠️❗️❓]/g, '')
            // Clean up multiple spaces
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    private escapeSsml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}