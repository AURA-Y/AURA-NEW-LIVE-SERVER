import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { Readable } from 'stream';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
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
    private readonly clovaSpeechEndpoint: string;
    private readonly clovaSpeechSecret: string;
    private readonly clovaSpeechLang: string;
    private clovaClient: any;

    // LLM 교정용
    private bedrockClient: BedrockRuntimeClient;
    private readonly llmModelId = 'anthropic.claude-3-haiku-20240307-v1:0';

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
    // LLM 교정 메서드
    // =====================================================

    async correctWithLlm(rawTranscript: string): Promise<{
        hasWakeWord: boolean;
        correctedText: string;
        searchKeyword: string | null;
        searchType: 'local' | 'news' | null;
        category: string | null;
        confidence: number;
    }> {
        if (!rawTranscript || rawTranscript.trim().length < 3) {
            return {
                hasWakeWord: false,
                correctedText: rawTranscript,
                searchKeyword: null,
                searchType: null,
                category: null,
                confidence: 0,
            };
        }

        const prompt = `음성인식 결과를 분석하세요.

## 웨이크워드 (봇 호출)
표준: 빅스야, 빅스비, 헤이빅스
변형: 믹스야, 익수야, 빅세야, 빅쓰, 픽스야, 비수야, 긱스야, 익쇠야, 해빅스, 에이빅스 등

## 카테고리
- 카페: 카페, 커피, 커피숍
- 맛집: 맛집, 식당, 레스토랑, 밥집
- 술집: 술집, 바, 포차, 호프
- 분식: 분식, 떡볶이, 김밥
- 치킨: 치킨
- 피자: 피자
- 빵집: 빵집, 베이커리
- 디저트: 디저트, 케이크, 마카롱
- 쇼핑: 쇼핑, 백화점, 마트
- 팝업: 팝업, 팝업스토어
- 전시: 전시, 갤러리, 미술관
- 날씨: 날씨, 기온, 비, 눈
- 뉴스: 뉴스, 소식, 기사
- 주식: 주식, 주가, 증시
- 스포츠: 스포츠, 축구, 야구
- 영화: 영화, 개봉

## 검색타입
- local: 장소/맛집/카페/가게
- news: 뉴스/날씨/정보/주식

## 작업
1. 웨이크워드 감지: 있으면 표준형으로 교정
2. 카테고리 분류
3. 검색 키워드 추출 (명사만, 간결하게)

## 입력
"${rawTranscript}"

## 출력 (JSON만)
{"hasWakeWord":true,"correctedText":"빅스야 성수동 카페 추천해줘","searchKeyword":"성수동 카페","searchType":"local","category":"카페","confidence":0.95}`;

        try {
            const payload = {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 200,
                messages: [{ role: "user", content: prompt }],
            };

            const command = new InvokeModelCommand({
                modelId: this.llmModelId,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(payload),
            });

            const response = await this.bedrockClient.send(command);
            const body = JSON.parse(new TextDecoder().decode(response.body));
            const text = body.content?.[0]?.text || '{}';

            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('JSON not found');
            }

            const result = JSON.parse(jsonMatch[0]);

            this.logger.log(`[LLM 교정] "${rawTranscript}" → wake=${result.hasWakeWord}, cat=${result.category}, keyword="${result.searchKeyword}"`);

            return {
                hasWakeWord: result.hasWakeWord ?? false,
                correctedText: result.correctedText ?? rawTranscript,
                searchKeyword: result.searchKeyword ?? null,
                searchType: result.searchType === 'local' ? 'local' : (result.searchType === 'news' ? 'news' : null),
                category: result.category ?? null,
                confidence: result.confidence ?? 0,
            };
        } catch (error) {
            this.logger.warn(`[LLM 교정 실패] ${error.message}`);
            return {
                hasWakeWord: false,
                correctedText: rawTranscript,
                searchKeyword: null,
                searchType: null,
                category: null,
                confidence: 0,
            };
        }
    }

    // =====================================================
    // 기존 STT 메서드들
    // =====================================================

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