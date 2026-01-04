import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { Readable } from 'stream';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

@Injectable()
export class SttService {
    private readonly logger = new Logger(SttService.name);
    private deepgramClient: any;
    private azureSpeechConfig: speechsdk.SpeechConfig | null = null;
    private readonly provider: string;
    private readonly clovaSpeechEndpoint: string;
    private readonly clovaSpeechSecret: string;
    private readonly clovaSpeechLang: string;
    private clovaClient: any;

    constructor(private configService: ConfigService) {
        this.provider = (this.configService.get<string>('STT_PROVIDER') || 'clova').toLowerCase();
        this.clovaSpeechEndpoint = this.configService.get<string>('CLOVA_SPEECH_GRPC_ENDPOINT') || 'clovaspeech-gw.ncloud.com:50051';
        this.clovaSpeechSecret = this.configService.get<string>('CLOVA_SPEECH_SECRET') || '';
        this.clovaSpeechLang = this.configService.get<string>('CLOVA_SPEECH_LANG') || 'ko';

        if (this.provider === 'clova') {
            if (!this.clovaSpeechSecret) {
                this.logger.error('[Clova STT] CLOVA_SPEECH_SECRET이 설정되지 않았습니다!');
            }
            this.initClovaClient();
        } else if (this.provider === 'azure') {
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
    }

    // 오디오 파일 버퍼로 STT (Deepgram Prerecorded API 사용)
    async transcribeFromBuffer(audioBuffer: Buffer, fileName: string): Promise<string> {
        if (this.provider === 'clova') {
            return this.transcribeFromBufferClova(audioBuffer, fileName);
        }
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
                    // Raw PCM 형식 지정
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

    // 실시간 스트리밍 STT (라이브/버퍼 모두 가능)
    async transcribeStream(audioStream: Readable): Promise<string> {
        if (this.provider === 'clova') {
            return this.transcribeStreamClova(audioStream);
        }
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
                interim_results: false, // 최종 결과만
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

    // 버퍼를 스트리밍 API로 처리 (지연 최소화)
    async transcribeFromBufferStream(audioBuffer: Buffer, fileName: string): Promise<string> {
        if (this.provider === 'clova') {
            return this.transcribeFromBufferStreamClova(audioBuffer, fileName);
        }
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

    private async transcribeFromBufferClova(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[Clova 파일 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        return this.recognizeOnceClova(audioBuffer);
    }

    private async transcribeStreamClova(audioStream: Readable): Promise<string> {
        if (!this.clovaSpeechSecret) {
            throw new Error('CLOVA_SPEECH_SECRET is not set');
        }
        if (!this.clovaClient) {
            this.initClovaClient();
        }

        return new Promise((resolve, reject) => {
            const metadata = new grpc.Metadata();
            metadata.add('authorization', `Bearer ${this.clovaSpeechSecret}`);
            const call = this.clovaClient.recognize(metadata);

            const transcripts: string[] = [];
            call.on('data', (response: any) => {
                const contents = response?.contents || '';
                if (contents) {
                    transcripts.push(contents);
                }
            });
            call.on('error', (error: any) => {
                reject(error);
            });
            call.on('end', () => {
                resolve(transcripts.join(' ').trim());
            });

            const config = JSON.stringify({
                transcription: { language: this.clovaSpeechLang },
                semanticEpd: {
                    skipEmptyText: false,
                    useWordEpd: false,
                    usePeriodEpd: true,
                    gapThreshold: 2000,
                    durationThreshold: 20000,
                    syllableThreshold: 0,
                },
            });

            call.write({ type: 'CONFIG', config: { config } });

            let seqId = 0;
            audioStream.on('data', (chunk: Buffer) => {
                call.write({
                    type: 'DATA',
                    data: {
                        chunk,
                        extra_contents: JSON.stringify({ seqId, epFlag: false }),
                    },
                });
                seqId += 1;
            });
            audioStream.on('end', () => {
                call.write({
                    type: 'DATA',
                    data: {
                        chunk: Buffer.alloc(0),
                        extra_contents: JSON.stringify({ seqId, epFlag: true }),
                    },
                });
                call.end();
            });
            audioStream.on('error', (error) => {
                this.logger.error(`[Clova STT 스트림 에러] ${error.message}`);
                reject(error);
            });
        });
    }

    private async transcribeFromBufferStreamClova(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[Clova 스트림 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        const audioStream = Readable.from([audioBuffer]);
        try {
            const transcript = await this.transcribeStreamClova(audioStream);
            this.logger.log(`[Clova STT 완료] 전체 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[Clova STT 에러] ${error.message}`);
            throw error;
        }
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

    private initClovaClient(): void {
        const protoPath = path.join(__dirname, 'nest.proto');
        const packageDef = protoLoader.loadSync(protoPath, {
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        const proto = grpc.loadPackageDefinition(packageDef) as any;
        const service = proto?.com?.nbp?.cdncp?.nest?.grpc?.proto?.v1?.NestService;
        if (!service) {
            throw new Error('Failed to load Clova gRPC proto');
        }
        this.clovaClient = new service(
            this.clovaSpeechEndpoint,
            grpc.credentials.createSsl()
        );
    }

    private async recognizeOnceClova(audioBuffer: Buffer): Promise<string> {
        if (!this.clovaSpeechSecret) {
            throw new Error('CLOVA_SPEECH_SECRET is not set');
        }
        if (!this.clovaClient) {
            this.initClovaClient();
        }

        return new Promise((resolve, reject) => {
            const metadata = new grpc.Metadata();
            metadata.add('authorization', `Bearer ${this.clovaSpeechSecret}`);
            const call = this.clovaClient.recognize(metadata);

            const transcripts: string[] = [];
            call.on('data', (response: any) => {
                const contents = response?.contents || '';
                if (contents) {
                    transcripts.push(contents);
                }
            });
            call.on('error', (error: any) => {
                reject(error);
            });
            call.on('end', () => {
                resolve(transcripts.join(' ').trim());
            });

            const config = JSON.stringify({
                transcription: { language: this.clovaSpeechLang },
                semanticEpd: {
                    skipEmptyText: false,
                    useWordEpd: false,
                    usePeriodEpd: true,
                    gapThreshold: 2000,
                    durationThreshold: 20000,
                    syllableThreshold: 0,
                },
            });

            call.write({ type: 'CONFIG', config: { config } });

            const chunkSize = 32000;
            let offset = 0;
            let seqId = 0;
            while (offset < audioBuffer.length) {
                const end = Math.min(offset + chunkSize, audioBuffer.length);
                const chunk = audioBuffer.subarray(offset, end);
                const epFlag = end >= audioBuffer.length;
                call.write({
                    type: 'DATA',
                    data: {
                        chunk,
                        extra_contents: JSON.stringify({ seqId, epFlag }),
                    },
                });
                offset = end;
                seqId += 1;
            }
            call.end();
        });
    }
}
