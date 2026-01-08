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
        this.logger.log(`[Clova STT] ========== 인식 시작 ==========`);
        this.logger.log(`[Clova STT] 오디오 버퍼 크기: ${audioBuffer.length} bytes`);
        this.logger.log(`[Clova STT] 예상 재생 시간: ${(audioBuffer.length / 32000).toFixed(2)}초 (16kHz 16bit mono 기준)`);

        // 오디오 레벨 분석 (음성이 있는지 확인)
        let maxAmplitude = 0;
        let sumSquared = 0;
        for (let i = 0; i < audioBuffer.length; i += 2) {
            const sample = audioBuffer.readInt16LE(i);
            maxAmplitude = Math.max(maxAmplitude, Math.abs(sample));
            sumSquared += sample * sample;
        }
        const rms = Math.sqrt(sumSquared / (audioBuffer.length / 2));
        const rmsDb = 20 * Math.log10(rms / 32768);
        this.logger.log(`[Clova STT] 오디오 분석: maxAmp=${maxAmplitude}, RMS=${rms.toFixed(0)}, RMS dB=${rmsDb.toFixed(1)}dB`);

        return new Promise((resolve, reject) => {
            // 메타데이터에 인증 정보 추가 (gRPC는 Bearer 토큰 사용)
            const metadata = new grpc.Metadata();
            metadata.set('authorization', `Bearer ${this.clientSecret}`);
            this.logger.log(`[Clova STT] 인증 헤더 설정 완료`);

            // 양방향 스트리밍 호출
            const call = this.client.recognize(metadata);
            this.logger.log(`[Clova STT] gRPC 스트림 연결됨`);

            let finalTranscript = '';
            // position 기반으로 텍스트를 저장 (덮어쓰기 방식)
            const transcriptMap: Map<number, string> = new Map();
            let configReceived = false;
            let responseCount = 0;

            // gRPC 상태 이벤트 핸들러
            call.on('status', (status: any) => {
                this.logger.log(`[Clova STT] gRPC 상태: code=${status.code}, details="${status.details}"`);
            });

            call.on('metadata', (metadata: any) => {
                this.logger.log(`[Clova STT] gRPC 메타데이터: ${JSON.stringify(metadata.getMap())}`);
            });

            // 응답 수신
            call.on('data', (response: any) => {
                responseCount++;
                const contents = response.contents;
                this.logger.log(`[Clova STT] ===== 응답 #${responseCount} 수신 =====`);
                this.logger.log(`[Clova STT] 원본 내용: ${contents}`);

                try {
                    if (!contents) {
                        this.logger.warn(`[Clova STT] 응답 내용이 비어있음`);
                        return;
                    }

                    const parsed = JSON.parse(contents);
                    const responseType = parsed.responseType || [];
                    this.logger.log(`[Clova STT] responseType: ${JSON.stringify(responseType)}`);

                    // Config 응답 처리 - 받으면 오디오 데이터 전송 시작
                    if (responseType.includes('config')) {
                        const configStatus = parsed.config?.status;
                        this.logger.log(`[Clova STT] Config 응답 - status: "${configStatus}"`);
                        if (parsed.config?.keywordBoosting) {
                            this.logger.log(`[Clova STT]   keywordBoosting: ${parsed.config.keywordBoosting.status}`);
                        }
                        if (configStatus !== 'Success') {
                            this.logger.error(`[Clova STT] Config 실패! 상태: ${configStatus}`);
                        }
                        configReceived = true;

                        // Config 응답을 받은 후 오디오 데이터 전송
                        this.sendAudioData(call, audioBuffer);
                        return;
                    }

                    // Transcription 응답 처리
                    if (responseType.includes('transcription') && parsed.transcription) {
                        const t = parsed.transcription;
                        this.logger.log(`[Clova STT] Transcription 응답:`);
                        this.logger.log(`[Clova STT]   text: "${t.text}"`);
                        this.logger.log(`[Clova STT]   position: ${t.position}`);
                        this.logger.log(`[Clova STT]   epFlag: ${t.epFlag}`);
                        this.logger.log(`[Clova STT]   seqId: ${t.seqId}`);
                        this.logger.log(`[Clova STT]   epdType: ${t.epdType}`);
                        this.logger.log(`[Clova STT]   startTimestamp: ${t.startTimestamp}ms`);
                        this.logger.log(`[Clova STT]   endTimestamp: ${t.endTimestamp}ms`);
                        this.logger.log(`[Clova STT]   confidence: ${t.confidence}`);

                        if (t.text) {
                            // position 기반으로 텍스트 저장 (같은 position은 덮어씀)
                            const position = t.position ?? 0;
                            transcriptMap.set(position, t.text);
                            this.logger.log(`[Clova STT]   -> position ${position}에 저장, 현재 누적: ${transcriptMap.size}개`);
                        }

                        // epFlag가 true이면 인식 완료 - 스트림 종료
                        if (t.epFlag === true) {
                            this.logger.log(`[Clova STT] epFlag=true 수신 - 스트림 종료 요청`);
                            call.end();
                        }
                        return;
                    }

                    // Recognize 응답 처리 (인식 상태)
                    if (responseType.includes('recognize')) {
                        this.logger.log(`[Clova STT] Recognize 응답:`);
                        this.logger.log(`[Clova STT]   status: ${parsed.recognize?.status}`);
                        if (parsed.recognize?.epFlag) {
                            this.logger.log(`[Clova STT]   epFlag.status: ${parsed.recognize.epFlag.status}`);
                        }
                        if (parsed.recognize?.seqId) {
                            this.logger.log(`[Clova STT]   seqId.status: ${parsed.recognize.seqId.status}`);
                        }
                        return;
                    }

                    this.logger.log(`[Clova STT] 알 수 없는 응답 타입: ${JSON.stringify(responseType)}`);

                } catch (error) {
                    this.logger.warn(`[Clova STT] 응답 파싱 실패: ${error.message}`);
                }
            });

            call.on('error', (error: grpc.ServiceError) => {
                const latency = Date.now() - startTime;
                this.logger.error(`[Clova STT] ========== 에러 발생 ==========`);
                this.logger.error(`[Clova STT] 에러 코드: ${error.code}`);
                this.logger.error(`[Clova STT] 에러 메시지: ${error.message}`);
                this.logger.error(`[Clova STT] 에러 상세: ${error.details}`);
                this.logger.error(`[Clova STT] 소요 시간: ${latency}ms`);
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
                const latency = Date.now() - startTime;

                // position 순서대로 정렬하여 텍스트 조합
                const sortedPositions = Array.from(transcriptMap.keys()).sort((a, b) => a - b);
                finalTranscript = sortedPositions.map(pos => transcriptMap.get(pos)).join('').trim();

                this.logger.log(`[Clova STT] ========== 스트림 종료 ==========`);
                this.logger.log(`[Clova STT] configReceived: ${configReceived}`);
                this.logger.log(`[Clova STT] 총 응답 수: ${responseCount}`);
                this.logger.log(`[Clova STT] position 맵: ${JSON.stringify(Object.fromEntries(transcriptMap))}`);
                this.logger.log(`[Clova STT] 최종 텍스트: "${finalTranscript}"`);
                this.logger.log(`[Clova STT] 총 소요 시간: ${latency}ms`);
                resolve(finalTranscript);
            });

            // 먼저 설정만 전송 - 오디오는 config 응답 받은 후 전송
            const configMessage = this.buildConfigMessage(config);
            this.logger.log(`[Clova STT] Config 메시지 전송:`);
            this.logger.log(`[Clova STT]   ${JSON.stringify(configMessage)}`);
            const writeResult = call.write(configMessage);
            this.logger.log(`[Clova STT] Config write 결과: ${writeResult}`);
        });
    }

    /**
     * 오디오 데이터 전송 (Config 응답 받은 후 호출)
     */
    private sendAudioData(call: any, audioBuffer: Buffer): void {
        const CHUNK_SIZE = 32000; // 32KB (1초 분량 @ 16kHz 16bit mono)
        let offset = 0;
        let chunkCount = 0;
        const totalChunks = Math.ceil(audioBuffer.length / CHUNK_SIZE);

        this.logger.log(`[Clova STT] 오디오 데이터 전송 시작 (총 ${totalChunks}개 청크)`);

        while (offset < audioBuffer.length) {
            const chunk = audioBuffer.slice(offset, offset + CHUNK_SIZE);
            const isLastChunk = (offset + CHUNK_SIZE >= audioBuffer.length);
            chunkCount++;

            // 모든 청크에 seqId 포함, 마지막 청크에만 epFlag: true
            const extraContents = isLastChunk
                ? JSON.stringify({ epFlag: true, seqId: chunkCount })
                : JSON.stringify({ seqId: chunkCount });

            // type을 숫자로 (DATA = 1), proto enum 호환성 확인
            const dataMessage = {
                type: 1, // DATA enum value
                data: {
                    chunk: chunk,
                    extra_contents: extraContents,
                },
            };

            const writeResult = call.write(dataMessage);

            if (isLastChunk) {
                this.logger.log(`[Clova STT] 청크 #${chunkCount}/${totalChunks} 전송: ${chunk.length} bytes (마지막, epFlag=true, seqId=${chunkCount}) write=${writeResult}`);
            } else if (chunkCount === 1 || chunkCount % 10 === 0) {
                this.logger.log(`[Clova STT] 청크 #${chunkCount}/${totalChunks} 전송: ${chunk.length} bytes, write=${writeResult}`);
            }

            offset += CHUNK_SIZE;
        }

        this.logger.log(`[Clova STT] 모든 청크 전송 완료 (epFlag=true로 서버 응답 대기)`);

        // epFlag=true를 보냈으므로 서버가 결과를 보내고 스트림을 닫을 때까지 대기
        // call.end()는 호출하지 않음 - 서버가 먼저 닫도록 함
        // 10초 타임아웃에서 강제 종료됨
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
