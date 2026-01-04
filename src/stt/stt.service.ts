import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { Readable } from 'stream';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

@Injectable()
export class SttService {
    private readonly logger = new Logger(SttService.name);
    private deepgramClient: any;
    private azureSpeechConfig: speechsdk.SpeechConfig | null = null;
    private readonly provider: string;

    // LLM 교정용
    private bedrockClient: BedrockRuntimeClient;
    private readonly llmModelId = 'anthropic.claude-3-haiku-20240307-v1:0';

    constructor(private configService: ConfigService) {
        const requestedProvider = (this.configService.get<string>('STT_PROVIDER') || 'deepgram').toLowerCase();
        this.provider = requestedProvider === 'azure' || requestedProvider === 'deepgram'
            ? requestedProvider
            : 'deepgram';
        if (this.provider !== requestedProvider) {
            this.logger.warn(`[STT] Unsupported provider "${requestedProvider}", defaulting to "${this.provider}"`);
        }

        if (this.provider === 'azure') {
            const azureKey = this.configService.get<string>('AZURE_SPEECH_KEY');
            const azureRegion = this.configService.get<string>('AZURE_SPEECH_REGION') || 'koreacentral';
            if (!azureKey) {
                this.logger.error('[Azure STT] AZURE_SPEECH_KEY가 설정되지 않았습니다!');
            } else {
                this.azureSpeechConfig = speechsdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
                this.azureSpeechConfig.speechRecognitionLanguage = 'ko-KR';
            }
        } else {
            const apiKey = this.configService.get<string>('DEEPGRAM_API_KEY');
            if (!apiKey) {
                this.logger.error('[Deepgram] API 키가 설정되지 않았습니다!');
            }
            this.deepgramClient = createClient(apiKey);
        }

        // Bedrock 클라이언트 초기화
        this.bedrockClient = new BedrockRuntimeClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID') || '',
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '',
            },
        });
    }


    // =====================================================
    // 기존 STT 메서드들
    // =====================================================

    async transcribeFromBuffer(audioBuffer: Buffer, fileName: string): Promise<string> {
        if (this.provider === 'azure') {
            return this.transcribeFromBufferAzure(audioBuffer, fileName);
        }

        this.logger.log(`[파일 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);

        try {
            const { result, error } = await this.deepgramClient.listen.prerecorded.transcribeFile(
                audioBuffer,
                {
                    model: 'nova-3',
                    language: 'ko',
                    smart_format: true,
                    punctuate: true,
                    encoding: 'linear16',
                    sample_rate: 16000,
                    channels: 1,
                }
            );

            if (error) {
                this.logger.error(`[Deepgram 에러] ${error.message}`);
                throw error;
            }

            const transcript = result.results.channels[0].alternatives[0].transcript;
            this.logger.log(`[STT 완료] 전체 결과: ${transcript}`);

            return transcript || '';
        } catch (error) {
            this.logger.error(`[STT 에러] ${error.message}`);
            throw error;
        }
    }

    async transcribeStream(audioStream: Readable): Promise<string> {
        if (this.provider === 'azure') {
            return this.transcribeStreamAzure(audioStream);
        }

        return new Promise((resolve, reject) => {
            const transcripts: string[] = [];

            const connection = this.deepgramClient.listen.live({
                model: 'nova-3',
                language: 'ko',
                smart_format: true,
                punctuate: true,
                interim_results: false,
                encoding: 'linear16',
                sample_rate: 16000,
                channels: 1,
            });

            connection.on(LiveTranscriptionEvents.Open, () => {
                this.logger.log('[Deepgram 실시간] 연결 성공');

                audioStream.on('data', (chunk: Buffer) => {
                    connection.send(chunk);
                });

                audioStream.on('end', () => {
                    connection.finish();
                });
            });

            connection.on(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel.alternatives[0].transcript;
                if (transcript && transcript.trim().length > 0) {
                    this.logger.log(`[STT 결과] ${transcript}`);
                    transcripts.push(transcript);
                }
            });

            connection.on(LiveTranscriptionEvents.Close, () => {
                this.logger.log('[Deepgram 실시간] 연결 종료');
                const fullTranscript = transcripts.join(' ');
                resolve(fullTranscript);
            });

            connection.on(LiveTranscriptionEvents.Error, (error) => {
                this.logger.error(`[Deepgram 에러] ${error.message}`);
                reject(error);
            });
        });
    }

    async transcribeFromBufferStream(audioBuffer: Buffer, fileName: string): Promise<string> {
        if (this.provider === 'azure') {
            return this.transcribeFromBufferStreamAzure(audioBuffer, fileName);
        }

        this.logger.log(`[스트림 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        const audioStream = Readable.from([audioBuffer]);
        try {
            const transcript = await this.transcribeStream(audioStream);
            this.logger.log(`[STT 완료] 전체 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[STT 에러] ${error.message}`);
            throw error;
        }
    }

    private getAzureSpeechConfig(): speechsdk.SpeechConfig {
        if (!this.azureSpeechConfig) {
            throw new Error('AZURE_SPEECH_KEY is not set');
        }
        return this.azureSpeechConfig;
    }

    private async transcribeFromBufferAzure(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[Azure 파일 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        return this.recognizeOnceAzure(audioBuffer);
    }

    private async transcribeStreamAzure(audioStream: Readable): Promise<string> {
        const chunks: Buffer[] = [];

        return new Promise((resolve, reject) => {
            audioStream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });
            audioStream.on('end', async () => {
                try {
                    const fullAudio = Buffer.concat(chunks);
                    if (fullAudio.length === 0) {
                        resolve('');
                        return;
                    }
                    const transcript = await this.recognizeOnceAzure(fullAudio);
                    resolve(transcript);
                } catch (error) {
                    reject(error);
                }
            });
            audioStream.on('error', (error) => {
                this.logger.error(`[Azure STT 스트림 에러] ${error.message}`);
                reject(error);
            });
        });
    }

    private async transcribeFromBufferStreamAzure(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[Azure 스트림 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        const audioStream = Readable.from([audioBuffer]);
        try {
            const transcript = await this.transcribeStreamAzure(audioStream);
            this.logger.log(`[Azure STT 완료] 전체 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[Azure STT 에러] ${error.message}`);
            throw error;
        }
    }

    private async recognizeOnceAzure(audioBuffer: Buffer): Promise<string> {
        const speechConfig = this.getAzureSpeechConfig();
        const format = speechsdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
        const pushStream = speechsdk.AudioInputStream.createPushStream(format);
        const audioConfig = speechsdk.AudioConfig.fromStreamInput(pushStream);
        const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

        return new Promise((resolve, reject) => {
            recognizer.recognizeOnceAsync(
                (result) => {
                    recognizer.close();
                    if (result.reason === speechsdk.ResultReason.RecognizedSpeech) {
                        resolve(result.text || '');
                        return;
                    }
                    if (result.reason === speechsdk.ResultReason.NoMatch) {
                        this.logger.warn('[Azure STT] NoMatch - 음성이 감지되지 않았습니다.');
                        resolve('');
                        return;
                    }
                    if (result.reason === speechsdk.ResultReason.Canceled) {
                        const details = speechsdk.CancellationDetails.fromResult(result);
                        const reason = speechsdk.CancellationReason[details.reason] || details.reason;
                        const code = details.ErrorCode ? speechsdk.CancellationErrorCode[details.ErrorCode] : 'Unknown';
                        this.logger.error(`[Azure STT 취소] reason=${reason} code=${code} details=${details.errorDetails || 'Unknown error'}`);
                        if (details.reason === speechsdk.CancellationReason.EndOfStream) {
                            resolve('');
                            return;
                        }
                        reject(new Error(details.errorDetails || 'Azure STT canceled'));
                        return;
                    }
                    resolve('');
                },
                (error) => {
                    recognizer.close();
                    reject(error);
                }
            );

            const arrayBuffer = Uint8Array.from(audioBuffer).buffer as ArrayBuffer;
            pushStream.write(arrayBuffer);
            pushStream.close();
        });
    }

}
