import { Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

/**
 * Daglo STT 응답 구조
 */
interface DagloTranscript {
    text: string;
    confidence?: number;
    isFinal: boolean;
    detectedLanguage?: string;
}

/**
 * Daglo STT 설정
 */
interface DagloSttConfig {
    language?: string;           // 'ko-KR', 'en-US', 'mixed' (기본값: ko-KR)
    encoding?: string;           // 'LINEAR16' (기본값)
    sampleRate?: number;         // 16000 (기본값)
    interimResults?: boolean;    // true (기본값) - 중간 결과 반환
}

/**
 * Daglo Speech STT gRPC 어댑터
 *
 * 엔드포인트: apis.daglo.ai
 * 프로토콜: gRPC 양방향 스트리밍 (SSL/TLS)
 */
export class DagloSttAdapter {
    private readonly logger = new Logger(DagloSttAdapter.name);
    private client: any = null;
    private grpcPackage: any = null;

    private readonly DAGLO_ENDPOINT = 'apis.daglo.ai:443';
    private readonly PROTO_PATH = path.join(__dirname, 'daglo-speech.proto');

    // 인증 정보
    private readonly apiToken: string;

    constructor(apiToken: string) {
        this.apiToken = apiToken;
    }

    /**
     * gRPC 클라이언트 초기화
     */
    async initialize(): Promise<void> {
        this.logger.log(`[Daglo STT] 초기화 시작`);
        this.logger.log(`  Proto: ${this.PROTO_PATH}`);
        this.logger.log(`  Endpoint: ${this.DAGLO_ENDPOINT}`);

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

            // SpeechToText 클라이언트 생성 (SSL 사용)
            const SpeechToText = (this.grpcPackage.daglo.speech.v1 as any).SpeechToText;

            // SSL 인증서 (공개 CA 사용)
            const sslCreds = grpc.credentials.createSsl();

            this.client = new SpeechToText(
                this.DAGLO_ENDPOINT,
                sslCreds,
                {
                    'grpc.max_receive_message_length': 10 * 1024 * 1024, // 10MB
                    'grpc.max_send_message_length': 10 * 1024 * 1024,
                }
            );

            this.logger.log(`[Daglo STT] 초기화 완료`);
        } catch (error) {
            this.logger.error(`[Daglo STT] 초기화 실패: ${error.message}`);
            throw error;
        }
    }

    /**
     * 버퍼에서 음성 인식 (단일 요청)
     */
    async transcribe(audioBuffer: Buffer, config?: DagloSttConfig): Promise<string> {
        if (!this.client) {
            await this.initialize();
        }

        const startTime = Date.now();
        this.logger.log(`[Daglo STT] 인식 시작 - ${audioBuffer.length} bytes`);

        return new Promise((resolve, reject) => {
            // 메타데이터에 인증 정보 추가
            const metadata = new grpc.Metadata();
            metadata.set('authorization', `Bearer ${this.apiToken}`);

            // 양방향 스트리밍 호출
            const call = this.client.StreamingRecognize(metadata);

            let finalTranscript = '';
            const transcripts: string[] = [];

            // 응답 수신
            call.on('data', (response: any) => {
                if (response.results && response.results.length > 0) {
                    for (const result of response.results) {
                        this.logger.debug(`[Daglo STT] 결과: "${result.transcript}" (final=${result.is_final})`);
                        if (result.is_final && result.transcript) {
                            transcripts.push(result.transcript);
                        }
                    }
                }
            });

            call.on('end', () => {
                const latency = Date.now() - startTime;
                finalTranscript = transcripts.join(' ').trim();
                this.logger.log(`[Daglo STT] 완료 - "${finalTranscript}" (${latency}ms)`);
                resolve(finalTranscript);
            });

            call.on('error', (error: grpc.ServiceError) => {
                const latency = Date.now() - startTime;
                this.logger.error(`[Daglo STT] 에러 (${latency}ms): ${error.message}`);
                reject(error);
            });

            // 설정 전송 (첫 번째 메시지)
            const configMessage = {
                config: {
                    encoding: 'LINEAR16',
                    sample_rate_hertz: config?.sampleRate || 16000,
                    language_code: config?.language || 'ko-KR',
                    interim_results: config?.interimResults !== false,
                    audio_channel_count: 1,
                },
            };
            call.write(configMessage);

            // 오디오 데이터 전송 (청크 단위)
            const CHUNK_SIZE = 32000; // 32KB (1초 분량 @ 16kHz 16bit mono)
            let offset = 0;

            while (offset < audioBuffer.length) {
                const chunk = audioBuffer.slice(offset, offset + CHUNK_SIZE);
                call.write({ audio_content: chunk });
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
        config?: DagloSttConfig
    ): AsyncGenerator<DagloTranscript> {
        if (!this.client) {
            await this.initialize();
        }

        this.logger.log(`[Daglo STT] 스트리밍 시작`);

        // 메타데이터
        const metadata = new grpc.Metadata();
        metadata.set('authorization', `Bearer ${this.apiToken}`);

        // 양방향 스트리밍 호출
        const call = this.client.StreamingRecognize(metadata);

        // 응답 큐
        const responseQueue: DagloTranscript[] = [];
        let isEnded = false;
        let error: Error | null = null;

        // 응답 수신 핸들러
        call.on('data', (response: any) => {
            if (response.results && response.results.length > 0) {
                for (const result of response.results) {
                    responseQueue.push({
                        text: result.transcript || '',
                        confidence: result.confidence,
                        isFinal: result.is_final || false,
                        detectedLanguage: result.detected_language_code,
                    });
                }
            }
        });

        call.on('end', () => {
            isEnded = true;
        });

        call.on('error', (err: grpc.ServiceError) => {
            error = err;
            isEnded = true;
        });

        // 설정 전송 (첫 번째 메시지)
        const configMessage = {
            config: {
                encoding: 'LINEAR16',
                sample_rate_hertz: config?.sampleRate || 16000,
                language_code: config?.language || 'ko-KR',
                interim_results: config?.interimResults !== false,
                audio_channel_count: 1,
            },
        };
        call.write(configMessage);

        // 오디오 데이터 전송 (별도 태스크)
        (async () => {
            try {
                for await (const chunk of audioGenerator) {
                    if (isEnded) break;
                    call.write({ audio_content: chunk });
                }
                call.end();
            } catch (e) {
                this.logger.error(`[Daglo STT] 오디오 전송 에러: ${e.message}`);
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

        this.logger.log(`[Daglo STT] 스트리밍 종료`);
    }

    /**
     * 연결 종료
     */
    close(): void {
        if (this.client) {
            grpc.closeClient(this.client);
            this.client = null;
            this.logger.log(`[Daglo STT] 연결 종료`);
        }
    }
}
