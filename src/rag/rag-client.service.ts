import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';

interface PendingRequest {
    resolve: (value: string) => void;
    reject: (reason: any) => void;
    timer: NodeJS.Timeout;
    startTime: number; // 레이턴시 측정용
}

@Injectable()
export class RagClientService implements OnModuleDestroy {
    private readonly logger = new Logger(RagClientService.name);
    private ws: WebSocket | null = null;
    private clientId: string | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pendingRequests: Map<string, PendingRequest> = new Map();

    private readonly REQUEST_TIMEOUT = 30000; // 30초
    private readonly RECONNECT_DELAY = 3000; // 3초

    constructor(private configService: ConfigService) { }

    /**
     * RAG 서버에 연결
     */
    async connect(clientId: string): Promise<void> {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.logger.warn(`[RAG 연결 스킵] 이미 연결됨: ${this.clientId}`);
            return;
        }

        this.clientId = clientId;
        const baseUrl = this.configService.get<string>('RAG_WEBSOCKET_URL') || 'ws://localhost:8000';
        const wsUrl = `${baseUrl}/ws/agent/${clientId}`;

        this.logger.log(`\n========== [RAG 연결 시도] ==========`);
        this.logger.log(`Client ID: ${clientId}`);
        this.logger.log(`WebSocket URL: ${wsUrl}`);

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(wsUrl);

                const connectionTimeout = setTimeout(() => {
                    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                        this.logger.error('[RAG 연결 타임아웃] 10초 내 응답 없음');
                        this.ws.close();
                        reject(new Error('RAG connection timeout'));
                    }
                }, 10000);

                this.ws.on('open', () => {
                    clearTimeout(connectionTimeout);
                    this.logger.log(`[RAG 연결 성공] ${clientId}`);
                    this.logger.log(`========================================\n`);
                    resolve();
                });

                this.ws.on('message', (data: WebSocket.Data) => {
                    this.handleMessage(data);
                });

                this.ws.on('error', (error) => {
                    this.logger.error(`[RAG WebSocket 에러] ${error.message}`);
                });

                this.ws.on('close', (code, reason) => {
                    this.logger.warn(`[RAG 연결 종료] Code: ${code}, Reason: ${reason || 'UNKNOWN'}`);
                    this.ws = null;

                    // 의도적인 종료가 아니면 재연결 시도
                    if (code !== 1000 && this.clientId) {
                        this.scheduleReconnect();
                    }
                });

            } catch (error) {
                this.logger.error(`[RAG 연결 실패] ${error.message}`);
                reject(error);
            }
        });
    }

    /**
     * 메시지 수신 처리
     */
    private handleMessage(data: WebSocket.Data) {
        try {
            const message = JSON.parse(data.toString());
            const messageType = message.type;

            // 응답 시간 계산
            const requestKey = message.text || 'unknown';
            const pending = this.pendingRequests.get(requestKey);

            if (pending) {
                const latency = Date.now() - pending.startTime;
                this.logger.log(`[RAG 응답 수신] 타입: ${messageType}, 레이턴시: ${latency}ms`);
            }

            if (messageType === 'answer') {
                // 질문에 대한 답변
                const questionText = message.text;
                const answer = message.answer || '';

                if (pending) {
                    const latency = Date.now() - pending.startTime;
                    this.logger.log(`[RAG 답변] "${questionText}" → "${answer.substring(0, 50)}..." (${latency}ms)`);

                    clearTimeout(pending.timer);
                    this.pendingRequests.delete(questionText);
                    pending.resolve(answer);
                }
            } else if (messageType === 'stored') {
                // 발언 저장 완료
                this.logger.log(`[RAG 저장 완료] 화자: ${message.speaker}, 내용: "${message.text}"`);
            } else if (messageType === 'document_processed') {
                this.logger.log(`[RAG 문서 처리 완료] 파일: ${message.file}, 청크: ${message.chunks}개`);
            } else {
                this.logger.log(`[RAG 메시지] 타입: ${messageType}`);
            }

        } catch (error) {
            this.logger.error(`[RAG 메시지 파싱 에러] ${error.message}`);
        }
    }

    /**
     * 재연결 스케줄링
     */
    private scheduleReconnect() {
        if (this.reconnectTimer) {
            return; // 이미 재연결 대기 중
        }

        this.logger.log(`[RAG 재연결] ${this.RECONNECT_DELAY / 1000}초 후 재시도...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.clientId) {
                this.connect(this.clientId).catch(err => {
                    this.logger.error(`[RAG 재연결 실패] ${err.message}`);
                });
            }
        }, this.RECONNECT_DELAY);
    }

    /**
     * 일반 발언 전송 (statement)
     */
    async sendStatement(text: string, speaker: string): Promise<void> {
        if (!this.isConnected()) {
            this.logger.warn('[RAG 스킵] WebSocket 연결 안 됨 (statement)');
            return;
        }

        const message = {
            type: 'statement',
            text,
            speaker,
            confidence: 1.0,
        };

        this.logger.log(`[RAG 발언 전송] 화자: ${speaker}, "${text.substring(0, 30)}..."`);
        this.ws!.send(JSON.stringify(message));
    }

    /**
     * 질문 전송 및 응답 대기 (question)
     */
    async sendQuestion(text: string): Promise<string> {
        if (!this.isConnected()) {
            this.logger.error('[RAG 에러] WebSocket 연결 안 됨 (question)');
            throw new Error('RAG WebSocket not connected');
        }

        const startTime = Date.now();
        this.logger.log(`[RAG 질문 전송] "${text.substring(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            // 타임아웃 타이머 설정
            const timer = setTimeout(() => {
                this.pendingRequests.delete(text);
                const latency = Date.now() - startTime;
                this.logger.error(`[RAG 타임아웃] ${this.REQUEST_TIMEOUT / 1000}초 초과 (총 ${latency}ms)`);
                reject(new Error('RAG request timeout'));
            }, this.REQUEST_TIMEOUT);

            // 요청 등록
            this.pendingRequests.set(text, {
                resolve,
                reject,
                timer,
                startTime,
            });

            // 메시지 전송
            const message = {
                type: 'question',
                text,
                confidence: 1.0,
            };

            this.ws!.send(JSON.stringify(message));
        });
    }

    /**
     * WebSocket 연결 상태 확인
     */
    private isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * 연결 해제
     */
    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // 대기 중인 모든 요청 거부
        for (const [key, pending] of this.pendingRequests.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('RAG client disconnected'));
        }
        this.pendingRequests.clear();

        if (this.ws) {
            this.logger.log('[RAG 연결 해제]');
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }

        this.clientId = null;
    }

    /**
     * 모듈 종료 시 정리
     */
    async onModuleDestroy() {
        await this.disconnect();
    }

    /**
     * 연결 상태 반환
     */
    getConnectionStatus(): { connected: boolean; clientId: string | null } {
        return {
            connected: this.isConnected(),
            clientId: this.clientId,
        };
    }
}
