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
 * - Clova는 16kHz, 1 Channel, 16bit PCM 고정
 */
interface ClovaSttConfig {
    language?: string;           // 'ko' | 'en' | 'ja' (기본값: 'ko')
    keywordBoosting?: string[];  // 키워드 힌트 (콤마로 연결됨)
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

        return new Promise((resolve, reject) => {
            // 메타데이터에 인증 정보 추가 (gRPC는 Bearer 토큰 사용)
            const metadata = new grpc.Metadata();
            metadata.set('authorization', `Bearer ${this.clientSecret}`);

            // 양방향 스트리밍 호출
            const call = this.client.recognize(metadata);

            let finalTranscript = '';
            // position 기반으로 텍스트를 저장 (덮어쓰기 방식)
            const transcriptMap: Map<number, string> = new Map();
            let configReceived = false;
            let responseCount = 0;

            // gRPC 상태 이벤트 핸들러 (에러만 로깅)
            call.on('status', (status: any) => {
                if (status.code !== 0) {
                    this.logger.error(`[Clova STT] gRPC 에러: code=${status.code}, details="${status.details}"`);
                }
            });

            // 응답 수신
            call.on('data', (response: any) => {
                responseCount++;
                const contents = response.contents;

                try {
                    if (!contents) return;

                    const parsed = JSON.parse(contents);
                    const responseType = parsed.responseType || [];

                    // Config 응답 처리 - 받으면 오디오 데이터 전송 시작
                    if (responseType.includes('config')) {
                        const configStatus = parsed.config?.status;
                        if (configStatus !== 'Success') {
                            this.logger.error(`[Clova STT] Config 실패: ${configStatus}`);
                        }
                        configReceived = true;
                        this.sendAudioData(call, audioBuffer);
                        return;
                    }

                    // Transcription 응답 처리
                    if (responseType.includes('transcription') && parsed.transcription) {
                        const t = parsed.transcription;
                        if (t.text) {
                            const position = t.position ?? 0;
                            transcriptMap.set(position, t.text);
                        }
                        if (t.epFlag === true) {
                            call.end();
                        }
                        return;
                    }
                } catch (error) {
                    this.logger.warn(`[Clova STT] 응답 파싱 실패: ${error.message}`);
                }
            });

            call.on('error', (error: grpc.ServiceError) => {
                this.logger.error(`[Clova STT] 에러: ${error.code} - ${error.message}`);
                reject(error);
            });

            // 타임아웃 설정: 5초 후에도 응답이 없으면 강제 종료
            const timeout = setTimeout(() => {
                this.logger.warn(`[Clova STT] 5초 타임아웃 - 스트림 강제 종료`);
                call.end();
            }, 5000);

            // 스트림 종료 시 처리
            call.on('end', () => {
                clearTimeout(timeout);

                // position 순서대로 정렬하여 텍스트 조합
                const sortedPositions = Array.from(transcriptMap.keys()).sort((a, b) => a - b);
                finalTranscript = sortedPositions.map(pos => transcriptMap.get(pos)).join('').trim();

                resolve(finalTranscript);
            });

            // 먼저 설정만 전송 - 오디오는 config 응답 받은 후 전송
            const configMessage = this.buildConfigMessage(config);
            call.write(configMessage);
        });
    }

    /**
     * 오디오 데이터 전송 (Config 응답 받은 후 호출)
     */
    private sendAudioData(call: any, audioBuffer: Buffer): void {
        const CHUNK_SIZE = 32000; // 32KB (1초 분량 @ 16kHz 16bit mono)
        let offset = 0;
        let chunkCount = 0;

        while (offset < audioBuffer.length) {
            const chunk = audioBuffer.slice(offset, offset + CHUNK_SIZE);
            const isLastChunk = (offset + CHUNK_SIZE >= audioBuffer.length);
            chunkCount++;

            const extraContents = isLastChunk
                ? JSON.stringify({ epFlag: true, seqId: chunkCount })
                : JSON.stringify({ seqId: chunkCount });

            const dataMessage = {
                type: 1,
                data: {
                    chunk: chunk,
                    extra_contents: extraContents,
                },
            };

            call.write(dataMessage);
            offset += CHUNK_SIZE;
        }
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

        // 메타데이터 (gRPC는 Bearer 토큰 사용)
        const metadata = new grpc.Metadata();
        metadata.set('authorization', `Bearer ${this.clientSecret}`);

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
     * Clova Speech API 문서 기준 Config JSON 구조
     */
    private buildConfigMessage(config?: ClovaSttConfig): any {
        const clovaConfig: any = {
            transcription: {
                language: config?.language || 'ko',
            },
        };

        // 키워드 부스팅 (있으면) - keywordBoosting.boostings 구조
        if (config?.keywordBoosting && config.keywordBoosting.length > 0) {
            // 여러 키워드를 콤마로 연결
            clovaConfig.keywordBoosting = {
                boostings: [
                    {
                        words: config.keywordBoosting.join(','),
                        weight: 2,
                    },
                ],
            };
        }

        const configJson = JSON.stringify(clovaConfig);
        this.logger.log(`[Clova STT] Config JSON 내용: ${configJson}`);

        return {
            type: 0, // CONFIG enum value
            config: {
                config: configJson,
            },
        };
    }

    /**
     * 응답 파싱
     * Clova Speech API 문서 기준 응답 구조:
     * - responseType: ["config"] → 설정 응답
     * - responseType: ["transcription"] → 인식 결과
     */
    private parseResponse(contents: string): ClovaTranscript | null {
        if (!contents) return null;

        try {
            const response = JSON.parse(contents);

            // responseType 확인
            const responseType = response.responseType || [];

            // config 응답은 무시 (설정 확인용)
            if (responseType.includes('config')) {
                this.logger.debug(`[Clova STT] Config 응답: ${response.config?.status}`);
                return null;
            }

            // transcription 응답 - 실제 인식 결과
            if (responseType.includes('transcription') && response.transcription) {
                const t = response.transcription;
                return {
                    text: t.text || '',
                    confidence: t.confidence,
                    start: t.startTimestamp,
                    end: t.endTimestamp,
                    isFinal: true, // Clova는 최종 결과만 보냄
                };
            }

            // recognize 응답 (에러 등)
            if (responseType.includes('recognize')) {
                this.logger.debug(`[Clova STT] Recognize 응답: ${response.recognize?.status}`);
                return null;
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
