import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

interface PendingRequest {
    resolve: (value: string) => void;
    reject: (reason: any) => void;
    timer: NodeJS.Timeout;
    startTime: number;
}

interface ConnectionContext {
    ws: WebSocket;
    pendingRequests: Map<string, PendingRequest>;
    reconnectTimer: NodeJS.Timeout | null;
}

@Injectable()
export class RagClientService implements OnModuleDestroy {
    private readonly logger = new Logger(RagClientService.name);

    // 다중 연결 지원: roomId별로 WebSocket 관리
    private connections: Map<string, ConnectionContext> = new Map();

    private readonly REQUEST_TIMEOUT = 30000; // 30초
    private readonly RECONNECT_DELAY = 3000; // 3초

    constructor(private configService: ConfigService) { }

    /**
     * RAG 서버에 연결 (특정 roomId용)
     */
    async connect(roomId: string): Promise<void> {
        // 이미 연결된 경우 스킵
        const existing = this.connections.get(roomId);
        if (existing && existing.ws.readyState === WebSocket.OPEN) {
            this.logger.warn(`[RAG 연결 스킵] 이미 연결됨: ${roomId}`);
            return;
        }

        const baseUrl = this.configService.get<string>('RAG_WEBSOCKET_URL') || 'ws://localhost:8000';
        const wsUrl = `${baseUrl}/ws/agent/${roomId}`;

        this.logger.log(`\n========== [RAG 연결 시도] ==========`);
        this.logger.log(`Room ID: ${roomId}`);
        this.logger.log(`WebSocket URL: ${wsUrl}`);
        this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);

        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(wsUrl);

                const connectionTimeout = setTimeout(() => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        this.logger.error(`[RAG 연결 타임아웃] ${roomId} - 10초 내 응답 없음`);
                        ws.close();
                        reject(new Error('RAG connection timeout'));
                    }
                }, 10000);

                ws.on('open', () => {
                    clearTimeout(connectionTimeout);

                    // 연결 컨텍스트 생성 및 저장
                    const context: ConnectionContext = {
                        ws,
                        pendingRequests: new Map(),
                        reconnectTimer: null,
                    };
                    this.connections.set(roomId, context);

                    this.logger.log(`[RAG 연결 성공] ${roomId}`);
                    this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);
                    this.logger.log(`========================================\n`);
                    resolve();
                });

                ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(roomId, data);
                });

                ws.on('error', (error) => {
                    this.logger.error(`[RAG WebSocket 에러] ${roomId}: ${error.message}`);
                });

                ws.on('close', (code, reason) => {
                    this.logger.warn(`[RAG 연결 종료] ${roomId} - Code: ${code}, Reason: ${reason || 'UNKNOWN'}`);

                    // 의도적인 종료가 아니면 재연결 시도
                    if (code !== 1000) {
                        this.scheduleReconnect(roomId);
                    } else {
                        // 정상 종료 시 연결 정보 삭제
                        this.connections.delete(roomId);
                    }
                });

            } catch (error) {
                this.logger.error(`[RAG 연결 실패] ${roomId}: ${error.message}`);
                reject(error);
            }
        });
    }

    /**
     * 메시지 수신 처리 (roomId별)
     */
    private handleMessage(roomId: string, data: WebSocket.Data) {
        try {
            const message = JSON.parse(data.toString());
            const messageType = message.type;

            const context = this.connections.get(roomId);
            if (!context) {
                this.logger.warn(`[RAG 메시지] 컨텍스트 없음: ${roomId}`);
                return;
            }

            const requestKey = message.text || 'unknown';
            const pending = context.pendingRequests.get(requestKey);

            if (pending) {
                const latency = Date.now() - pending.startTime;
                this.logger.log(`[RAG 응답 수신] ${roomId} - 타입: ${messageType}, 레이턴시: ${latency}ms`);
            }

            if (messageType === 'answer') {
                const questionText = message.text;
                const answer = message.answer || '';

                if (pending) {
                    const latency = Date.now() - pending.startTime;
                    this.logger.log(`[RAG 답변] ${roomId} - "${questionText}" → "${answer.substring(0, 50)}..." (${latency}ms)`);

                    clearTimeout(pending.timer);
                    context.pendingRequests.delete(questionText);
                    pending.resolve(answer);
                }
            } else if (messageType === 'stored') {
                this.logger.log(`[RAG 저장 완료] ${roomId} - 화자: ${message.speaker}, 내용: "${message.text}"`);
            } else if (messageType === 'document_processed') {
                this.logger.log(`[RAG 문서 처리 완료] ${roomId} - 파일: ${message.file}, 청크: ${message.chunks}개`);
            } else {
                this.logger.log(`[RAG 메시지] ${roomId} - 타입: ${messageType}`);
            }

        } catch (error) {
            this.logger.error(`[RAG 메시지 파싱 에러] ${roomId}: ${error.message}`);
        }
    }

    /**
     * 재연결 스케줄링 (특정 roomId용)
     */
    private scheduleReconnect(roomId: string) {
        const context = this.connections.get(roomId);
        if (context?.reconnectTimer) {
            return; // 이미 재연결 대기 중
        }

        this.logger.log(`[RAG 재연결] ${roomId} - ${this.RECONNECT_DELAY / 1000}초 후 재시도...`);

        const timer = setTimeout(() => {
            const ctx = this.connections.get(roomId);
            if (ctx) {
                ctx.reconnectTimer = null;
            }
            this.connect(roomId).catch(err => {
                this.logger.error(`[RAG 재연결 실패] ${roomId}: ${err.message}`);
            });
        }, this.RECONNECT_DELAY);

        if (context) {
            context.reconnectTimer = timer;
        }
    }

    /**
     * 일반 발언 전송 (statement)
     */
    async sendStatement(roomId: string, text: string, speaker: string): Promise<void> {
        if (!this.isConnected(roomId)) {
            this.logger.warn(`[RAG 스킵] WebSocket 연결 안 됨: ${roomId} (statement)`);
            return;
        }

        const context = this.connections.get(roomId)!;
        const message = {
            type: 'statement',
            text,
            speaker,
            confidence: 1.0,
        };

        this.logger.log(`[RAG 발언 전송] ${roomId} - 화자: ${speaker}, "${text.substring(0, 30)}..."`);
        context.ws.send(JSON.stringify(message));
    }

    /**
     * 질문 전송 및 응답 대기 (question)
     */
    async sendQuestion(roomId: string, text: string): Promise<string> {
        if (!this.isConnected(roomId)) {
            this.logger.error(`[RAG 에러] WebSocket 연결 안 됨: ${roomId} (question)`);
            throw new Error(`RAG WebSocket not connected for: ${roomId}`);
        }

        const context = this.connections.get(roomId)!;
        const startTime = Date.now();
        this.logger.log(`[RAG 질문 전송] ${roomId} - "${text.substring(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                context.pendingRequests.delete(text);
                const latency = Date.now() - startTime;
                this.logger.error(`[RAG 타임아웃] ${roomId} - ${this.REQUEST_TIMEOUT / 1000}초 초과 (총 ${latency}ms)`);
                reject(new Error('RAG request timeout'));
            }, this.REQUEST_TIMEOUT);

            context.pendingRequests.set(text, {
                resolve,
                reject,
                timer,
                startTime,
            });

            const message = {
                type: 'question',
                text,
                confidence: 1.0,
            };

            context.ws.send(JSON.stringify(message));
        });
    }

    /**
     * WebSocket 연결 상태 확인 (특정 roomId)
     */
    isConnected(roomId: string): boolean {
        const context = this.connections.get(roomId);
        return context !== undefined && context.ws.readyState === WebSocket.OPEN;
    }

    /**
     * 연결 해제 (특정 roomId)
     */
    async disconnect(roomId: string): Promise<void> {
        const context = this.connections.get(roomId);
        if (!context) {
            this.logger.warn(`[RAG 연결 해제 스킵] 연결 없음: ${roomId}`);
            return;
        }

        // 재연결 타이머 취소
        if (context.reconnectTimer) {
            clearTimeout(context.reconnectTimer);
        }

        // 대기 중인 모든 요청 거부
        for (const [key, pending] of context.pendingRequests.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('RAG client disconnected'));
        }
        context.pendingRequests.clear();

        // WebSocket 종료
        this.logger.log(`[RAG 연결 해제] ${roomId}`);
        context.ws.close(1000, 'Client disconnect');
        this.connections.delete(roomId);

        this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);
    }

    /**
     * 모듈 종료 시 모든 연결 정리
     */
    async onModuleDestroy() {
        this.logger.log(`[RAG 모듈 종료] 모든 연결 해제 중... (${this.connections.size}개)`);

        const disconnectPromises = Array.from(this.connections.keys()).map(roomId =>
            this.disconnect(roomId)
        );

        await Promise.all(disconnectPromises);
        this.logger.log(`[RAG 모듈 종료] 완료`);
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
     * 전체 연결 현황 반환
     */
    getAllConnectionsStatus(): { total: number; clients: string[] } {
        return {
            total: this.connections.size,
            clients: Array.from(this.connections.keys()),
        };
    }

    /**
     * 회의 종료 API 호출 (HTTP POST)
     * POST /meetings/{room_name}/end
     */
    async endMeeting(roomName: string): Promise<{ success: boolean; message?: string }> {
        const ragBaseUrl = this.configService.get<string>('RAG_API_URL') || 'http://aura-rag-alb-1169123670.ap-northeast-2.elb.amazonaws.com';
        const endpoint = `${ragBaseUrl}/meetings/${roomName}/end`;

        this.logger.log(`[RAG 회의 종료] POST ${endpoint}`);

        try {
            const axios = await import('axios');
            const response = await axios.default.post(endpoint);
            this.logger.log(`[RAG 회의 종료 성공] ${roomName} - 응답: ${JSON.stringify(response.data)}`);
            return { success: true, message: response.data };
        } catch (error: any) {
            this.logger.error(`[RAG 회의 종료 실패] ${roomName}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 회의 시작 및 파일 임베딩 API 호출 (HTTP POST)
     * POST /meetings/{room_name}/start
     */
    async startMeeting(roomName: string, payload: any): Promise<{ success: boolean; message?: string }> {
        const ragBaseUrl = this.configService.get<string>('RAG_API_URL') || 'http://aura-rag-alb-1169123670.ap-northeast-2.elb.amazonaws.com';
        const endpoint = `${ragBaseUrl}/meetings/${roomName}/start`;

        this.logger.log(`[RAG 회의 시작] POST ${endpoint} - Payload: ${JSON.stringify(payload)}`);

        try {
            const axios = await import('axios');
            // Payload 구조: { description: string, files: { bucket: string; key: string }[] }
            const response = await axios.default.post(endpoint, payload);
            this.logger.log(`[RAG 회의 시작 성공] ${roomName} - 응답: ${JSON.stringify(response.data)}`);
            return { success: true, message: response.data };
        } catch (error: any) {
            this.logger.error(`[RAG 회의 시작 실패] ${roomName}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }
}
