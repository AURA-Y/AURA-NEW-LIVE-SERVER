import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';

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

    // 다중 연결 지원: clientId별로 WebSocket 관리
    private connections: Map<string, ConnectionContext> = new Map();

    private readonly REQUEST_TIMEOUT = 30000; // 30초
    private readonly RECONNECT_DELAY = 3000; // 3초

    constructor(private configService: ConfigService) { }

    /**
     * RAG 서버에 연결 (특정 clientId용)
     */
    async connect(clientId: string): Promise<void> {
        // 이미 연결된 경우 스킵
        const existing = this.connections.get(clientId);
        if (existing && existing.ws.readyState === WebSocket.OPEN) {
            this.logger.warn(`[RAG 연결 스킵] 이미 연결됨: ${clientId}`);
            return;
        }

        const baseUrl = this.configService.get<string>('RAG_WEBSOCKET_URL') || 'ws://localhost:8000';
        const wsUrl = `${baseUrl}/ws/agent/${clientId}`;

        this.logger.log(`\n========== [RAG 연결 시도] ==========`);
        this.logger.log(`Client ID: ${clientId}`);
        this.logger.log(`WebSocket URL: ${wsUrl}`);
        this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);

        return new Promise((resolve, reject) => {
            try {
                const ws = new WebSocket(wsUrl);

                const connectionTimeout = setTimeout(() => {
                    if (ws.readyState !== WebSocket.OPEN) {
                        this.logger.error(`[RAG 연결 타임아웃] ${clientId} - 10초 내 응답 없음`);
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
                    this.connections.set(clientId, context);

                    this.logger.log(`[RAG 연결 성공] ${clientId}`);
                    this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);
                    this.logger.log(`========================================\n`);
                    resolve();
                });

                ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(clientId, data);
                });

                ws.on('error', (error) => {
                    this.logger.error(`[RAG WebSocket 에러] ${clientId}: ${error.message}`);
                });

                ws.on('close', (code, reason) => {
                    this.logger.warn(`[RAG 연결 종료] ${clientId} - Code: ${code}, Reason: ${reason || 'UNKNOWN'}`);

                    // 의도적인 종료가 아니면 재연결 시도
                    if (code !== 1000) {
                        this.scheduleReconnect(clientId);
                    } else {
                        // 정상 종료 시 연결 정보 삭제
                        this.connections.delete(clientId);
                    }
                });

            } catch (error) {
                this.logger.error(`[RAG 연결 실패] ${clientId}: ${error.message}`);
                reject(error);
            }
        });
    }

    /**
     * 메시지 수신 처리 (clientId별)
     */
    private handleMessage(clientId: string, data: WebSocket.Data) {
        try {
            const message = JSON.parse(data.toString());
            const messageType = message.type;

            const context = this.connections.get(clientId);
            if (!context) {
                this.logger.warn(`[RAG 메시지] 컨텍스트 없음: ${clientId}`);
                return;
            }

            const requestKey = message.text || 'unknown';
            const pending = context.pendingRequests.get(requestKey);

            if (pending) {
                const latency = Date.now() - pending.startTime;
                this.logger.log(`[RAG 응답 수신] ${clientId} - 타입: ${messageType}, 레이턴시: ${latency}ms`);
            }

            if (messageType === 'answer') {
                const questionText = message.text;
                const answer = message.answer || '';

                if (pending) {
                    const latency = Date.now() - pending.startTime;
                    this.logger.log(`[RAG 답변] ${clientId} - "${questionText}" → "${answer.substring(0, 50)}..." (${latency}ms)`);

                    clearTimeout(pending.timer);
                    context.pendingRequests.delete(questionText);
                    pending.resolve(answer);
                }
            } else if (messageType === 'stored') {
                this.logger.log(`[RAG 저장 완료] ${clientId} - 화자: ${message.speaker}, 내용: "${message.text}"`);
            } else if (messageType === 'document_processed') {
                this.logger.log(`[RAG 문서 처리 완료] ${clientId} - 파일: ${message.file}, 청크: ${message.chunks}개`);
            } else {
                this.logger.log(`[RAG 메시지] ${clientId} - 타입: ${messageType}`);
            }

        } catch (error) {
            this.logger.error(`[RAG 메시지 파싱 에러] ${clientId}: ${error.message}`);
        }
    }

    /**
     * 재연결 스케줄링 (특정 clientId용)
     */
    private scheduleReconnect(clientId: string) {
        const context = this.connections.get(clientId);
        if (context?.reconnectTimer) {
            return; // 이미 재연결 대기 중
        }

        this.logger.log(`[RAG 재연결] ${clientId} - ${this.RECONNECT_DELAY / 1000}초 후 재시도...`);

        const timer = setTimeout(() => {
            const ctx = this.connections.get(clientId);
            if (ctx) {
                ctx.reconnectTimer = null;
            }
            this.connect(clientId).catch(err => {
                this.logger.error(`[RAG 재연결 실패] ${clientId}: ${err.message}`);
            });
        }, this.RECONNECT_DELAY);

        if (context) {
            context.reconnectTimer = timer;
        }
    }

    /**
     * 일반 발언 전송 (statement)
     */
    async sendStatement(clientId: string, text: string, speaker: string): Promise<void> {
        if (!this.isConnected(clientId)) {
            this.logger.warn(`[RAG 스킵] WebSocket 연결 안 됨: ${clientId} (statement)`);
            return;
        }

        const context = this.connections.get(clientId)!;
        const message = {
            type: 'statement',
            text,
            speaker,
            confidence: 1.0,
        };

        this.logger.log(`[RAG 발언 전송] ${clientId} - 화자: ${speaker}, "${text.substring(0, 30)}..."`);
        context.ws.send(JSON.stringify(message));
    }

    /**
     * 질문 전송 및 응답 대기 (question)
     */
    async sendQuestion(clientId: string, text: string): Promise<string> {
        if (!this.isConnected(clientId)) {
            this.logger.error(`[RAG 에러] WebSocket 연결 안 됨: ${clientId} (question)`);
            throw new Error(`RAG WebSocket not connected for: ${clientId}`);
        }

        const context = this.connections.get(clientId)!;
        const startTime = Date.now();
        this.logger.log(`[RAG 질문 전송] ${clientId} - "${text.substring(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                context.pendingRequests.delete(text);
                const latency = Date.now() - startTime;
                this.logger.error(`[RAG 타임아웃] ${clientId} - ${this.REQUEST_TIMEOUT / 1000}초 초과 (총 ${latency}ms)`);
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
     * WebSocket 연결 상태 확인 (특정 clientId)
     */
    isConnected(clientId: string): boolean {
        const context = this.connections.get(clientId);
        return context !== undefined && context.ws.readyState === WebSocket.OPEN;
    }

    /**
     * 연결 해제 (특정 clientId)
     */
    async disconnect(clientId: string): Promise<void> {
        const context = this.connections.get(clientId);
        if (!context) {
            this.logger.warn(`[RAG 연결 해제 스킵] 연결 없음: ${clientId}`);
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
        this.logger.log(`[RAG 연결 해제] ${clientId}`);
        context.ws.close(1000, 'Client disconnect');
        this.connections.delete(clientId);

        this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);
    }

    /**
     * 모듈 종료 시 모든 연결 정리
     */
    async onModuleDestroy() {
        this.logger.log(`[RAG 모듈 종료] 모든 연결 해제 중... (${this.connections.size}개)`);

        const disconnectPromises = Array.from(this.connections.keys()).map(clientId =>
            this.disconnect(clientId)
        );

        await Promise.all(disconnectPromises);
        this.logger.log(`[RAG 모듈 종료] 완료`);
    }

    /**
     * 연결 상태 반환 (특정 clientId)
     */
    getConnectionStatus(clientId: string): { connected: boolean; clientId: string } {
        return {
            connected: this.isConnected(clientId),
            clientId,
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
}
