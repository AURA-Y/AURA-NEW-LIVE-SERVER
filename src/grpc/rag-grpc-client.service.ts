import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';

/**
 * gRPC 연결 컨텍스트 (roomId별 관리)
 */
interface GrpcConnectionContext {
    sessionId: string;
    connected: boolean;
    createdAt: Date;
}

/**
 * RagService gRPC 클라이언트
 * WebSocket 기반 RagClientService와 동일한 인터페이스 제공
 */
@Injectable()
export class RagGrpcClientService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RagGrpcClientService.name);

    // gRPC 클라이언트 (싱글톤 - 모든 room이 공유)
    private client: any = null;
    private grpcPackage: any = null;

    // 세션 관리: roomId → 세션 정보
    private sessions: Map<string, GrpcConnectionContext> = new Map();

    // 설정
    private readonly REQUEST_TIMEOUT = 30000; // 30초

    constructor(private configService: ConfigService) { }

    /**
     * 모듈 초기화 시 gRPC 클라이언트 생성
     */
    async onModuleInit() {
        await this.initGrpcClient();
    }

    /**
     * gRPC 클라이언트 초기화
     */
    private async initGrpcClient(): Promise<void> {
        const protoPath = path.join(__dirname, 'proto', 'rag_service.proto');
        const grpcHost = this.configService.get<string>('RAG_GRPC_HOST') || 'localhost';
        const grpcPort = this.configService.get<number>('RAG_GRPC_PORT') || 50051;
        const serverAddress = `${grpcHost}:${grpcPort}`;

        this.logger.log(`\n========== [gRPC 클라이언트 초기화] ==========`);
        this.logger.log(`Proto Path: ${protoPath}`);
        this.logger.log(`Server Address: ${serverAddress}`);

        try {
            // Proto 파일 로드
            const packageDefinition = await protoLoader.load(protoPath, {
                keepCase: true,
                longs: String,
                enums: String,
                defaults: true,
                oneofs: true,
                includeDirs: [path.join(__dirname, 'proto')],
            });

            this.grpcPackage = grpc.loadPackageDefinition(packageDefinition);

            // RagService 클라이언트 생성
            const RagService = (this.grpcPackage.aura as any).rag.RagService;

            this.client = new RagService(
                serverAddress,
                grpc.credentials.createInsecure(),
                {
                    'grpc.max_receive_message_length': 50 * 1024 * 1024, // 50MB
                    'grpc.max_send_message_length': 50 * 1024 * 1024,
                    'grpc.keepalive_time_ms': 10000,
                    'grpc.keepalive_timeout_ms': 5000,
                    'grpc.keepalive_permit_without_calls': 1,
                }
            );

            this.logger.log(`[gRPC] 클라이언트 생성 완료: ${serverAddress}`);
            this.logger.log(`==========================================\n`);

            // 연결 테스트 (Ping)
            await this.ping();

        } catch (error) {
            this.logger.error(`[gRPC] 클라이언트 초기화 실패: ${error.message}`);
            // 초기화 실패해도 앱 시작은 계속 진행 (나중에 재연결 시도)
        }
    }

    /**
     * Health Check (Ping)
     */
    async ping(): Promise<boolean> {
        if (!this.client) {
            this.logger.warn('[gRPC] 클라이언트가 초기화되지 않음');
            return false;
        }

        return new Promise((resolve) => {
            const deadline = new Date(Date.now() + 5000); // 5초 타임아웃

            this.client.Ping(
                { client_id: 'livekit-backend' },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    if (error) {
                        this.logger.error(`[gRPC Ping] 실패: ${error.message}`);
                        resolve(false);
                    } else {
                        this.logger.log(`[gRPC Ping] 성공 - 버전: ${response.server_version}`);
                        resolve(response.alive);
                    }
                }
            );
        });
    }

    /**
     * RAG 서버에 연결 (세션 생성)
     * WebSocket connect()와 동일한 인터페이스
     */
    async connect(roomId: string): Promise<void> {
        // 이미 세션이 있는 경우 스킵
        const existing = this.sessions.get(roomId);
        if (existing && existing.connected) {
            this.logger.warn(`[gRPC 연결 스킵] 이미 세션 존재: ${roomId}`);
            return;
        }

        if (!this.client) {
            this.logger.error(`[gRPC 연결 실패] 클라이언트가 초기화되지 않음`);
            throw new Error('gRPC client not initialized');
        }

        this.logger.log(`\n========== [gRPC 세션 생성] ==========`);
        this.logger.log(`Room ID: ${roomId}`);
        this.logger.log(`현재 활성 세션 수: ${this.sessions.size}`);

        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + 10000); // 10초 타임아웃

            this.client.CreateSession(
                {
                    room_id: roomId,
                    room_name: roomId,
                    participants: [],
                    metadata: {},
                },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    if (error) {
                        this.logger.error(`[gRPC 세션 생성 실패] ${roomId}: ${error.message}`);
                        reject(new Error(`gRPC CreateSession failed: ${error.message}`));
                        return;
                    }

                    if (!response.success) {
                        this.logger.error(`[gRPC 세션 생성 실패] ${roomId}: ${response.error_message}`);
                        reject(new Error(response.error_message || 'CreateSession failed'));
                        return;
                    }

                    // 세션 정보 저장
                    this.sessions.set(roomId, {
                        sessionId: response.session_id,
                        connected: true,
                        createdAt: new Date(),
                    });

                    this.logger.log(`[gRPC 세션 생성 성공] ${roomId}`);
                    this.logger.log(`  Session ID: ${response.session_id}`);
                    this.logger.log(`현재 활성 세션 수: ${this.sessions.size}`);
                    this.logger.log(`======================================\n`);

                    resolve();
                }
            );
        });
    }

    /**
     * 일반 발언 전송 (statement)
     * WebSocket sendStatement()와 동일한 인터페이스
     */
    async sendStatement(roomId: string, text: string, speaker: string): Promise<void> {
        if (!this.isConnected(roomId)) {
            this.logger.warn(`[gRPC 스킵] 세션 없음: ${roomId} (statement)`);
            return;
        }

        if (!this.client) {
            this.logger.warn(`[gRPC 스킵] 클라이언트 없음 (statement)`);
            return;
        }

        const startTime = Date.now();
        this.logger.log(`[gRPC 발언 전송] ${roomId} - 화자: ${speaker}, "${text.substring(0, 30)}..."`);

        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + this.REQUEST_TIMEOUT);

            this.client.StoreStatement(
                {
                    room_id: roomId,
                    text: text,
                    speaker_name: speaker,
                    speaker_id: speaker,
                    confidence: 1.0,
                    is_final: true,
                },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    const latency = Date.now() - startTime;

                    if (error) {
                        this.logger.error(`[gRPC 발언 저장 실패] ${roomId}: ${error.message} (${latency}ms)`);
                        // 발언 저장 실패해도 에러를 throw하지 않음 (WebSocket과 동일)
                        resolve();
                        return;
                    }

                    if (response.success) {
                        this.logger.log(`[gRPC 발언 저장 완료] ${roomId} - ID: ${response.statement_id} (${latency}ms)`);
                    } else {
                        this.logger.warn(`[gRPC 발언 저장 실패] ${roomId}: ${response.error_message} (${latency}ms)`);
                    }

                    resolve();
                }
            );
        });
    }

    /**
     * 질문 전송 및 응답 대기 (question)
     * WebSocket sendQuestion()와 동일한 인터페이스
     */
    async sendQuestion(roomId: string, text: string): Promise<string> {
        if (!this.isConnected(roomId)) {
            this.logger.error(`[gRPC 에러] 세션 없음: ${roomId} (question)`);
            throw new Error(`gRPC session not found for: ${roomId}`);
        }

        if (!this.client) {
            this.logger.error(`[gRPC 에러] 클라이언트 없음 (question)`);
            throw new Error('gRPC client not initialized');
        }

        const startTime = Date.now();
        this.logger.log(`[gRPC 질문 전송] ${roomId} - "${text.substring(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + this.REQUEST_TIMEOUT);

            this.client.AskQuestion(
                {
                    room_id: roomId,
                    question: text,
                    user_id: 'voice-bot',
                    user_name: 'Voice Bot',
                },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    const latency = Date.now() - startTime;

                    if (error) {
                        this.logger.error(`[gRPC 질문 실패] ${roomId}: ${error.message} (${latency}ms)`);
                        reject(new Error(`gRPC AskQuestion failed: ${error.message}`));
                        return;
                    }

                    const answer = response.answer || '';
                    this.logger.log(`[gRPC 답변 수신] ${roomId} - "${answer.substring(0, 50)}..." (${latency}ms, confidence: ${response.confidence})`);

                    resolve(answer);
                }
            );
        });
    }

    /**
     * 세션 연결 상태 확인 (특정 roomId)
     */
    isConnected(roomId: string): boolean {
        const session = this.sessions.get(roomId);
        return session !== undefined && session.connected;
    }

    /**
     * 연결 해제 (세션 종료)
     * WebSocket disconnect()와 동일한 인터페이스
     */
    async disconnect(roomId: string): Promise<void> {
        const session = this.sessions.get(roomId);
        if (!session) {
            this.logger.log(`[gRPC 세션 종료] ${roomId} - 세션 없음`);
            return;
        }

        if (!this.client) {
            this.sessions.delete(roomId);
            return;
        }

        this.logger.log(`[gRPC 세션 종료] ${roomId}`);

        return new Promise((resolve) => {
            const deadline = new Date(Date.now() + 10000);

            this.client.EndSession(
                {
                    room_id: roomId,
                    generate_report: false,
                },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    if (error) {
                        this.logger.warn(`[gRPC 세션 종료 에러] ${roomId}: ${error.message}`);
                    } else if (response.success) {
                        this.logger.log(`[gRPC 세션 종료 완료] ${roomId}`);
                    }

                    // 성공/실패 여부와 관계없이 로컬 세션 삭제
                    this.sessions.delete(roomId);
                    this.logger.log(`현재 활성 세션 수: ${this.sessions.size}`);

                    resolve();
                }
            );
        });
    }

    /**
     * 모듈 종료 시 모든 세션 정리
     */
    async onModuleDestroy() {
        this.logger.log(`[gRPC 모듈 종료] 모든 세션 종료 중... (세션: ${this.sessions.size}개)`);

        // 모든 세션 종료
        const disconnectPromises = Array.from(this.sessions.keys()).map(roomId =>
            this.disconnect(roomId)
        );

        await Promise.all(disconnectPromises);

        // 클라이언트 종료
        if (this.client) {
            this.client.close();
            this.client = null;
        }

        this.logger.log(`[gRPC 모듈 종료] 완료`);
    }

    /**
     * 연결 상태 반환 (특정 roomId)
     */
    getConnectionStatus(roomId: string): { connected: boolean; roomId: string } {
        return {
            connected: this.isConnected(roomId),
            roomId,
        };
    }

    /**
     * 전체 세션 현황 반환
     */
    getAllConnectionsStatus(): { total: number; clients: string[] } {
        return {
            total: this.sessions.size,
            clients: Array.from(this.sessions.keys()),
        };
    }

    /**
     * 회의 종료 API 호출 (HTTP POST - gRPC에 없는 기능은 HTTP 유지)
     * POST /meetings/{room_name}/end
     */
    async endMeeting(roomName: string): Promise<{ success: boolean; message?: string }> {
        // gRPC EndSession 사용
        try {
            await this.disconnect(roomName);
            return { success: true };
        } catch (error: any) {
            return { success: false, message: error.message };
        }
    }

    /**
     * 회의 시작 및 파일 임베딩 API 호출 (HTTP POST)
     * gRPC에서 지원하지 않는 파일 업로드는 HTTP 유지
     */
    async startMeeting(roomName: string, payload: any): Promise<{ success: boolean; message?: string }> {
        const ragBaseUrl = this.configService.get<string>('RAG_API_URL') || 'http://localhost:8000';
        const endpoint = `${ragBaseUrl}/meetings/${roomName}/start`;

        this.logger.log(`[gRPC/HTTP 회의 시작] POST ${endpoint} - Payload: ${JSON.stringify(payload)}`);

        try {
            const axios = await import('axios');
            const response = await axios.default.post(endpoint, payload);
            this.logger.log(`[gRPC/HTTP 회의 시작 성공] ${roomName} - 응답: ${JSON.stringify(response.data)}`);

            // gRPC 세션도 생성
            await this.connect(roomName);

            return { success: true, message: response.data };
        } catch (error: any) {
            this.logger.error(`[gRPC/HTTP 회의 시작 실패] ${roomName}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 회의 컨텍스트 조회 (gRPC 전용)
     */
    async getMeetingContext(roomId: string, maxTranscripts: number = 10): Promise<any> {
        if (!this.client) {
            throw new Error('gRPC client not initialized');
        }

        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + this.REQUEST_TIMEOUT);

            this.client.GetMeetingContext(
                {
                    room_id: roomId,
                    max_transcripts: maxTranscripts,
                },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    if (error) {
                        reject(new Error(`gRPC GetMeetingContext failed: ${error.message}`));
                        return;
                    }
                    resolve(response);
                }
            );
        });
    }

    /**
     * 리포트 생성 (gRPC 전용)
     */
    async generateReport(roomId: string, format: string = 'REPORT_FORMAT_MARKDOWN'): Promise<any> {
        if (!this.client) {
            throw new Error('gRPC client not initialized');
        }

        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + 60000); // 60초 타임아웃 (리포트 생성은 오래 걸릴 수 있음)

            this.client.GenerateReport(
                {
                    room_id: roomId,
                    format: format,
                    include_sections: ['summary', 'transcripts', 'action_items'],
                },
                { deadline },
                (error: grpc.ServiceError | null, response: any) => {
                    if (error) {
                        reject(new Error(`gRPC GenerateReport failed: ${error.message}`));
                        return;
                    }

                    if (!response.success) {
                        reject(new Error(response.error_message || 'GenerateReport failed'));
                        return;
                    }

                    resolve(response);
                }
            );
        });
    }
}
