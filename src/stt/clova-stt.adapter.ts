import { Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

/**
 * Clova Speech STT 응답 구조
 */
interface ClovaTranscript {
    text: string;
    confidence?: number;
    start?: number;
    end?: number;
    isFinal: boolean;
}

/**
 * Clova Speech 설정
 */
interface ClovaSttConfig {
    language?: string;           // 'ko-KR' (기본값)
    encoding?: string;           // 'LINEAR16' (기본값)
    sampleRate?: number;         // 16000 (기본값)
    endPointDetection?: boolean; // true (기본값)
    keywordBoosting?: string[];  // 키워드 힌트
}

/**
 * Clova Speech STT gRPC 어댑터
 * 네이버 클라우드 Clova Speech Recognition API
 *
 * 엔드포인트: clovaspeech-gw.ncloud.com:50051
 * 프로토콜: gRPC 양방향 스트리밍
 */
export class ClovaSttAdapter {
    private readonly logger = new Logger(ClovaSttAdapter.name);
    private client: any = null;
    private grpcPackage: any = null;

    private readonly CLOVA_ENDPOINT = 'clovaspeech-gw.ncloud.com:50051';
    private readonly PROTO_PATH = path.join(__dirname, 'nest.proto');

    // 인증 정보
    private readonly clientId: string;
    private readonly clientSecret: string;

    constructor(clientId: string, clientSecret: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    /**
     * gRPC 클라이언트 초기화
     */
    async initialize(): Promise<void> {
        this.logger.log(`[Clova STT] 초기화 시작`);
        this.logger.log(`  Proto: ${this.PROTO_PATH}`);
        this.logger.log(`  Endpoint: ${this.CLOVA_ENDPOINT}`);

        try {
            // Proto 파일 로드
            const packageDefinition = await protoLoader.load(this.PROTO_PATH, {
                keepCase: true,
                longs: String,
                enums: String,
                defaults: true,
                oneofs: true,
            });

            this.grpcPackage = grpc.loadPackageDefinition(packageDefinition);

            // NestService 클라이언트 생성 (SSL 사용)
            const NestService = (this.grpcPackage.com.nbp.cdncp.nest.grpc.proto.v1 as any).NestService;

            // SSL 인증서 (Clova는 공개 CA 사용)
            const sslCreds = grpc.credentials.createSsl();

            this.client = new NestService(
                this.CLOVA_ENDPOINT,
                sslCreds,
                {
                    'grpc.max_receive_message_length': 10 * 1024 * 1024, // 10MB
                    'grpc.max_send_message_length': 10 * 1024 * 1024,
                }
            );

            this.logger.log(`[Clova STT] 초기화 완료`);
        } catch (error) {
            this.logger.error(`[Clova STT] 초기화 실패: ${error.message}`);
            throw error;
        }
    }

    /**
     * 버퍼에서 음성 인식 (단일 요청)
     */
    async transcribe(audioBuffer: Buffer, config?: ClovaSttConfig): Promise<string> {
        if (!this.client) {
            await this.initialize();
        }

        const startTime = Date.now();
        this.logger.log(`[Clova STT] 인식 시작 - ${audioBuffer.length} bytes`);

        return new Promise((resolve, reject) => {
            // 메타데이터에 인증 정보 추가
            const metadata = new grpc.Metadata();
            metadata.set('x-clovaspeech-api-key', this.clientSecret);

            // 양방향 스트리밍 호출
            const call = this.client.recognize(metadata);

            let finalTranscript = '';
            const transcripts: string[] = [];

            // 응답 수신
            call.on('data', (response: any) => {
                try {
                    const result = this.parseResponse(response.contents);
                    if (result) {
                        this.logger.debug(`[Clova STT] 중간 결과: "${result.text}" (final=${result.isFinal})`);
                        if (result.isFinal && result.text) {
                            transcripts.push(result.text);
                        }
                    }
                } catch (error) {
                    this.logger.warn(`[Clova STT] 응답 파싱 실패: ${error.message}`);
                }
            });

            call.on('end', () => {
                const latency = Date.now() - startTime;
                finalTranscript = transcripts.join(' ').trim();
                this.logger.log(`[Clova STT] 완료 - "${finalTranscript}" (${latency}ms)`);
                resolve(finalTranscript);
            });

            call.on('error', (error: grpc.ServiceError) => {
                const latency = Date.now() - startTime;
                this.logger.error(`[Clova STT] 에러 (${latency}ms): ${error.message}`);
                reject(error);
            });

            // 설정 전송
            const configMessage = this.buildConfigMessage(config);
            call.write(configMessage);

            // 오디오 데이터 전송 (청크 단위)
            const CHUNK_SIZE = 32000; // 32KB (1초 분량 @ 16kHz 16bit mono)
            let offset = 0;

            while (offset < audioBuffer.length) {
                const chunk = audioBuffer.slice(offset, offset + CHUNK_SIZE);
                const dataMessage = {
                    type: 'DATA',
                    data: {
                        chunk: chunk,
                        extra_contents: '',
                    },
                };
                call.write(dataMessage);
                offset += CHUNK_SIZE;
            }

            // 스트림 종료
            call.end();
        });
    }

    /**
     * 실시간 스트리밍 인식
     * @returns AsyncGenerator - 중간 결과를 yield
     */
    async *transcribeStream(
        audioGenerator: AsyncGenerator<Buffer>,
        config?: ClovaSttConfig
    ): AsyncGenerator<ClovaTranscript> {
        if (!this.client) {
            await this.initialize();
        }

        this.logger.log(`[Clova STT] 스트리밍 시작`);

        // 메타데이터
        const metadata = new grpc.Metadata();
        metadata.set('x-clovaspeech-api-key', this.clientSecret);

        // 양방향 스트리밍 호출
        const call = this.client.recognize(metadata);

        // 응답 큐
        const responseQueue: ClovaTranscript[] = [];
        let isEnded = false;
        let error: Error | null = null;

        // 응답 수신 핸들러
        call.on('data', (response: any) => {
            try {
                const result = this.parseResponse(response.contents);
                if (result) {
                    responseQueue.push(result);
                }
            } catch (e) {
                this.logger.warn(`[Clova STT] 응답 파싱 실패: ${e.message}`);
            }
        });

        call.on('end', () => {
            isEnded = true;
        });

        call.on('error', (err: grpc.ServiceError) => {
            error = err;
            isEnded = true;
        });

        // 설정 전송
        const configMessage = this.buildConfigMessage(config);
        call.write(configMessage);

        // 오디오 데이터 전송 (별도 태스크)
        (async () => {
            try {
                for await (const chunk of audioGenerator) {
                    if (isEnded) break;
                    const dataMessage = {
                        type: 'DATA',
                        data: {
                            chunk: chunk,
                            extra_contents: '',
                        },
                    };
                    call.write(dataMessage);
                }
                call.end();
            } catch (e) {
                this.logger.error(`[Clova STT] 오디오 전송 에러: ${e.message}`);
                call.end();
            }
        })();

        // 응답 yield
        while (!isEnded || responseQueue.length > 0) {
            if (error) {
                throw error;
            }

            if (responseQueue.length > 0) {
                yield responseQueue.shift()!;
            } else {
                // 잠시 대기
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }

        this.logger.log(`[Clova STT] 스트리밍 종료`);
    }

    /**
     * 설정 메시지 생성
     */
    private buildConfigMessage(config?: ClovaSttConfig): any {
        const clovaConfig = {
            transcription: {
                language: config?.language || 'ko-KR',
            },
            encoding: config?.encoding || 'LINEAR16',
            sampleRate: config?.sampleRate || 16000,
            endPointDetection: config?.endPointDetection !== false,
            // 키워드 부스팅 (있으면)
            ...(config?.keywordBoosting && config.keywordBoosting.length > 0 && {
                boostings: config.keywordBoosting.map(keyword => ({
                    words: keyword,
                    weight: 2,
                })),
            }),
        };

        return {
            type: 'CONFIG',
            config: {
                config: JSON.stringify(clovaConfig),
            },
        };
    }

    /**
     * 응답 파싱
     */
    private parseResponse(contents: string): ClovaTranscript | null {
        if (!contents) return null;

        try {
            const response = JSON.parse(contents);

            // Clova 응답 구조에 따라 파싱
            // 실제 응답 형식은 Clova 문서 참조 필요
            if (response.transcription) {
                return {
                    text: response.transcription.text || '',
                    confidence: response.transcription.confidence,
                    start: response.transcription.start,
                    end: response.transcription.end,
                    isFinal: response.transcription.isFinal !== false,
                };
            }

            // 단순 텍스트 응답
            if (response.text) {
                return {
                    text: response.text,
                    isFinal: true,
                };
            }

            return null;
        } catch (error) {
            this.logger.warn(`[Clova STT] JSON 파싱 실패: ${contents.substring(0, 100)}`);
            return null;
        }
    }

    /**
     * 연결 종료
     */
    close(): void {
        if (this.client) {
            grpc.closeClient(this.client);
            this.client = null;
            this.logger.log(`[Clova STT] 연결 종료`);
        }
    }
}
