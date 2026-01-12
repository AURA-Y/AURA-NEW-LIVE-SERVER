import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';
import { RagQuestionResponse } from './rag-client.interface';

interface PendingRequest {
    resolve: (value: string) => void;
    reject: (reason: any) => void;
    timer: NodeJS.Timeout;
    startTime: number;
}

interface PendingRequestWithSources {
    resolve: (value: RagQuestionResponse) => void;
    reject: (reason: any) => void;
    timer: NodeJS.Timeout;
    startTime: number;
}

interface PendingStatement {
    text: string;
    speaker: string;
    timestamp: number;
    retryCount: number;
    startTime?: number | null;  // ★ 발언 시작 시간 (동시발화 순서 보장용)
}

interface PendingReportRequest {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: NodeJS.Timeout;
    startTime: number;
}

interface ConnectionContext {
    ws: WebSocket;
    pendingRequests: Map<string, PendingRequest>;
    pendingRequestsWithSources: Map<string, PendingRequestWithSources>;
    reconnectTimer: NodeJS.Timeout | null;
    reconnectAttempts: number;
}

@Injectable()
export class RagClientService implements OnModuleDestroy {
    private readonly logger = new Logger(RagClientService.name);

    // 다중 연결 지원: roomId별로 WebSocket 관리
    private connections: Map<string, ConnectionContext> = new Map();

    private readonly REQUEST_TIMEOUT = 30000; // 30초
    private readonly RECONNECT_DELAY = 10000; // 10초 (3초→10초로 증가)
    private readonly MAX_RECONNECT_ATTEMPTS = 3; // 최대 3회 재시도
    private readonly MAX_STATEMENT_RETRY = 3; // 발언 전송 최대 재시도 횟수
    private readonly STATEMENT_BUFFER_MAX_SIZE = 100; // 버퍼 최대 크기
    private readonly STATEMENT_BUFFER_MAX_AGE = 60000; // 버퍼 최대 보관 시간 (1분)

    // 발언 버퍼: 연결 안 됐을 때 발언 임시 저장
    private statementBuffers: Map<string, PendingStatement[]> = new Map();

    // 중간 보고서 요청 대기: roomId → PendingReportRequest
    private pendingReportRequests: Map<string, PendingReportRequest> = new Map();
    private readonly REPORT_TIMEOUT = 60000; // 보고서 생성 타임아웃 (60초)

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
                        pendingRequestsWithSources: new Map(),
                        reconnectTimer: null,
                        reconnectAttempts: 0,
                    };
                    this.connections.set(roomId, context);

                    // 연결 성공 시 재시도 횟수 초기화
                    this.reconnectAttemptCounts.delete(roomId);

                    this.logger.log(`[RAG 연결 성공] ${roomId}`);
                    this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);
                    this.logger.log(`========================================\n`);

                    // 연결 성공 시 버퍼에 있는 발언들 전송
                    this.flushStatementBuffer(roomId);

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
                const sources = message.sources || [];

                // sources 요청 확인 (우선)
                const pendingWithSources = context.pendingRequestsWithSources.get(questionText);
                if (pendingWithSources) {
                    const latency = Date.now() - pendingWithSources.startTime;
                    this.logger.log(`[RAG 답변+출처] ${roomId} - "${questionText}" → "${answer.substring(0, 50)}..." (sources: ${sources.length}개, ${latency}ms)`);

                    clearTimeout(pendingWithSources.timer);
                    context.pendingRequestsWithSources.delete(questionText);
                    pendingWithSources.resolve({
                        answer,
                        sources: sources.map((s: any) => ({
                            text: s.text || '',
                            speaker: s.speaker || null,
                        })),
                    });
                } else if (pending) {
                    // 일반 요청 (기존 로직)
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
            } else if (messageType === 'meeting_report') {
                // 중간 보고서 결과 수신
                const pendingReport = this.pendingReportRequests.get(roomId);
                if (pendingReport) {
                    const latency = Date.now() - pendingReport.startTime;
                    this.logger.log(`[RAG 중간 보고서 수신] ${roomId} - ${latency}ms`);

                    clearTimeout(pendingReport.timer);
                    this.pendingReportRequests.delete(roomId);
                    pendingReport.resolve({
                        success: message.status === 'success',
                        status: message.status,
                        meetingTitle: message.meeting_title,
                        summaryType: message.summary_type,
                        reportContent: message.report_content,
                    });
                } else {
                    this.logger.log(`[RAG 중간 보고서] ${roomId} - 대기 중인 요청 없음 (비동기 수신)`);
                }
            } else {
                this.logger.log(`[RAG 메시지] ${roomId} - 타입: ${messageType}`);
            }

        } catch (error) {
            this.logger.error(`[RAG 메시지 파싱 에러] ${roomId}: ${error.message}`);
        }
    }

    // 재연결 시도 횟수 추적 (context 없어도 유지)
    private reconnectAttemptCounts: Map<string, number> = new Map();
    private reconnectTimers: Map<string, NodeJS.Timeout> = new Map();

    /**
     * 재연결 스케줄링 (특정 roomId용)
     */
    private scheduleReconnect(roomId: string) {
        // 이미 재연결 대기 중이면 스킵
        if (this.reconnectTimers.has(roomId)) {
            return;
        }

        // 현재 재시도 횟수 가져오기
        const currentAttempts = this.reconnectAttemptCounts.get(roomId) || 0;

        // 최대 재시도 횟수 초과 시 포기
        if (currentAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            this.logger.warn(`[RAG 재연결 포기] ${roomId} - 최대 재시도 횟수(${this.MAX_RECONNECT_ATTEMPTS}회) 초과, 연결 정보 삭제`);
            this.connections.delete(roomId);
            this.reconnectAttemptCounts.delete(roomId);
            return;
        }

        // 재시도 횟수 증가
        const newAttempts = currentAttempts + 1;
        this.reconnectAttemptCounts.set(roomId, newAttempts);

        this.logger.log(`[RAG 재연결] ${roomId} - ${this.RECONNECT_DELAY / 1000}초 후 재시도... (${newAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);

        const timer = setTimeout(() => {
            this.reconnectTimers.delete(roomId);
            this.connect(roomId).catch(err => {
                this.logger.error(`[RAG 재연결 실패] ${roomId}: ${err.message}`);
            });
        }, this.RECONNECT_DELAY);

        this.reconnectTimers.set(roomId, timer);
    }

    /**
     * 일반 발언 전송 (statement) - 버퍼링 및 재시도 지원
     * @param startTime 발언 시작 시간 (밀리초 timestamp, 동시발화 순서 보장용)
     */
    async sendStatement(roomId: string, text: string, speaker: string, startTime?: number | null, retryCount: number = 0): Promise<void> {
        // 연결 안 됐으면 버퍼에 저장
        if (!this.isConnected(roomId)) {
            this.addToStatementBuffer(roomId, text, speaker, startTime);
            return;
        }

        const context = this.connections.get(roomId)!;
        const message = {
            type: 'statement',
            text,
            speaker,
            confidence: 1.0,
            startTime: startTime ?? Date.now(),  // ★ 발언 시작 시간 (없으면 현재 시간)
        };

        try {
            context.ws.send(JSON.stringify(message));
            this.logger.log(`[RAG 발언 전송] ${roomId} - 화자: ${speaker}, "${text.substring(0, 30)}..."`);
        } catch (error: any) {
            this.logger.error(`[RAG 발언 전송 실패] ${roomId}: ${error.message}`);

            // 재시도 로직
            if (retryCount < this.MAX_STATEMENT_RETRY) {
                this.logger.log(`[RAG 발언 재시도] ${roomId} - ${retryCount + 1}/${this.MAX_STATEMENT_RETRY}`);
                // 잠시 대기 후 재시도 (exponential backoff)
                const delay = Math.min(1000 * Math.pow(2, retryCount), 5000);
                setTimeout(() => {
                    this.sendStatement(roomId, text, speaker, startTime, retryCount + 1);
                }, delay);
            } else {
                // 최대 재시도 초과 시 버퍼에 저장
                this.logger.warn(`[RAG 발언 재시도 초과] ${roomId} - 버퍼에 저장`);
                this.addToStatementBuffer(roomId, text, speaker, startTime);
            }
        }
    }

    /**
     * 발언을 버퍼에 추가
     */
    private addToStatementBuffer(roomId: string, text: string, speaker: string, startTime?: number | null): void {
        let buffer = this.statementBuffers.get(roomId);
        if (!buffer) {
            buffer = [];
            this.statementBuffers.set(roomId, buffer);
        }

        // 버퍼 크기 제한 체크
        if (buffer.length >= this.STATEMENT_BUFFER_MAX_SIZE) {
            // 가장 오래된 것 제거
            const removed = buffer.shift();
            this.logger.warn(`[RAG 버퍼 오버플로우] ${roomId} - 오래된 발언 제거: "${removed?.text.substring(0, 20)}..."`);
        }

        buffer.push({
            text,
            speaker,
            timestamp: Date.now(),
            retryCount: 0,
            startTime,  // ★ 발언 시작 시간 저장
        });

        this.logger.log(`[RAG 버퍼 저장] ${roomId} - 버퍼 크기: ${buffer.length}, 화자: ${speaker}, "${text.substring(0, 30)}..."`);
    }

    /**
     * 버퍼에 있는 발언들 전송 (연결 성공 시 호출)
     */
    private async flushStatementBuffer(roomId: string): Promise<void> {
        const buffer = this.statementBuffers.get(roomId);
        if (!buffer || buffer.length === 0) {
            return;
        }

        const now = Date.now();
        const validStatements: PendingStatement[] = [];

        // 만료되지 않은 발언만 필터링
        for (const stmt of buffer) {
            if (now - stmt.timestamp <= this.STATEMENT_BUFFER_MAX_AGE) {
                validStatements.push(stmt);
            } else {
                this.logger.warn(`[RAG 버퍼 만료] ${roomId} - 발언 삭제 (${Math.round((now - stmt.timestamp) / 1000)}초 경과): "${stmt.text.substring(0, 20)}..."`);
            }
        }

        if (validStatements.length === 0) {
            this.statementBuffers.delete(roomId);
            return;
        }

        this.logger.log(`[RAG 버퍼 플러시] ${roomId} - ${validStatements.length}개 발언 전송 시작`);

        // 버퍼 비우기
        this.statementBuffers.delete(roomId);

        // 순차적으로 전송 (순서 보장)
        for (const stmt of validStatements) {
            try {
                await this.sendStatement(roomId, stmt.text, stmt.speaker, stmt.startTime, stmt.retryCount);
                // 전송 간 약간의 딜레이 (Rate Limit 방지)
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error: any) {
                this.logger.error(`[RAG 버퍼 플러시 실패] ${roomId}: ${error.message}`);
            }
        }

        this.logger.log(`[RAG 버퍼 플러시 완료] ${roomId}`);
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
     * 질문 전송 및 응답 대기 (sources 포함 - 팩트체크용)
     */
    async sendQuestionWithSources(roomId: string, text: string): Promise<import('./rag-client.interface').RagQuestionResponse> {
        if (!this.isConnected(roomId)) {
            this.logger.error(`[RAG 에러] WebSocket 연결 안 됨: ${roomId} (question+sources)`);
            throw new Error(`RAG WebSocket not connected for: ${roomId}`);
        }

        const context = this.connections.get(roomId)!;
        const startTime = Date.now();
        this.logger.log(`[RAG 질문+출처 요청] ${roomId} - "${text.substring(0, 50)}..."`);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                context.pendingRequestsWithSources.delete(text);
                const latency = Date.now() - startTime;
                this.logger.error(`[RAG 타임아웃] ${roomId} - ${this.REQUEST_TIMEOUT / 1000}초 초과 (총 ${latency}ms)`);
                reject(new Error('RAG request timeout'));
            }, this.REQUEST_TIMEOUT);

            context.pendingRequestsWithSources.set(text, {
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
        // 재연결 타이머 취소
        const reconnectTimer = this.reconnectTimers.get(roomId);
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            this.reconnectTimers.delete(roomId);
        }

        // 재연결 카운터 정리
        this.reconnectAttemptCounts.delete(roomId);

        const context = this.connections.get(roomId);
        if (!context) {
            this.logger.log(`[RAG 연결 해제] ${roomId} - 재연결 대기 취소됨`);
            return;
        }

        // 대기 중인 모든 요청 거부
        for (const [key, pending] of context.pendingRequests.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('RAG client disconnected'));
        }
        context.pendingRequests.clear();

        // 대기 중인 보고서 요청도 거부
        const pendingReport = this.pendingReportRequests.get(roomId);
        if (pendingReport) {
            clearTimeout(pendingReport.timer);
            this.pendingReportRequests.delete(roomId);
            pendingReport.reject(new Error('회의가 종료되었습니다.'));
            this.logger.warn(`[RAG 보고서 요청 취소] ${roomId} - 연결 종료로 인해 취소됨`);
        }

        // WebSocket 종료
        this.logger.log(`[RAG 연결 해제] ${roomId}`);
        context.ws.close(1000, 'Client disconnect');
        this.connections.delete(roomId);

        // 버퍼 정리 (연결 해제 시 남은 발언은 유실됨을 경고)
        const buffer = this.statementBuffers.get(roomId);
        if (buffer && buffer.length > 0) {
            this.logger.warn(`[RAG 버퍼 정리] ${roomId} - ${buffer.length}개 발언 유실`);
            this.statementBuffers.delete(roomId);
        }

        this.logger.log(`현재 활성 연결 수: ${this.connections.size}`);
    }

    /**
     * 모듈 종료 시 모든 연결 정리
     */
    async onModuleDestroy() {
        this.logger.log(`[RAG 모듈 종료] 모든 연결 해제 중... (연결: ${this.connections.size}개, 재연결 대기: ${this.reconnectTimers.size}개, 버퍼: ${this.statementBuffers.size}개)`);

        // 모든 재연결 타이머 취소
        for (const timer of this.reconnectTimers.values()) {
            clearTimeout(timer);
        }
        this.reconnectTimers.clear();
        this.reconnectAttemptCounts.clear();

        // 모든 버퍼 정리
        let totalBufferedStatements = 0;
        for (const [roomId, buffer] of this.statementBuffers.entries()) {
            totalBufferedStatements += buffer.length;
        }
        if (totalBufferedStatements > 0) {
            this.logger.warn(`[RAG 모듈 종료] ${totalBufferedStatements}개 버퍼된 발언 유실`);
        }
        this.statementBuffers.clear();

        // 모든 연결 해제
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
    getAllConnectionsStatus(): { total: number; clients: string[]; bufferedStatements: number } {
        let totalBuffered = 0;
        for (const buffer of this.statementBuffers.values()) {
            totalBuffered += buffer.length;
        }

        return {
            total: this.connections.size,
            clients: Array.from(this.connections.keys()),
            bufferedStatements: totalBuffered,
        };
    }

    /**
     * 특정 방의 버퍼 상태 반환
     */
    getBufferStatus(roomId: string): { buffered: number; oldest?: number } {
        const buffer = this.statementBuffers.get(roomId);
        if (!buffer || buffer.length === 0) {
            return { buffered: 0 };
        }

        const oldest = buffer[0]?.timestamp;
        return {
            buffered: buffer.length,
            oldest: oldest ? Date.now() - oldest : undefined,
        };
    }

    /**
     * 회의 종료 API 호출 (HTTP POST)
     * POST /meetings/{roomId}/end
     */
    async endMeeting(roomId: string): Promise<{ success: boolean; message?: string }> {
        const ragBaseUrl = this.configService.get<string>('RAG_API_URL') || 'http://aura-rag-alb-1169123670.ap-northeast-2.elb.amazonaws.com';
        const endpoint = `${ragBaseUrl}/meetings/${roomId}/end`;

        this.logger.log(`[RAG 회의 종료] POST ${endpoint}`);

        try {
            const axios = await import('axios');
            const response = await axios.default.post(endpoint);
            this.logger.log(`[RAG 회의 종료 성공] ${roomId} - 응답: ${JSON.stringify(response.data)}`);
            return { success: true, message: response.data };
        } catch (error: any) {
            this.logger.error(`[RAG 회의 종료 실패] ${roomId}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 회의 시작 및 파일 임베딩 API 호출 (HTTP POST)
     * POST /meetings/{roomId}/start
     */
    async startMeeting(roomId: string, payload: any): Promise<{ success: boolean; message?: string }> {
        const ragBaseUrl = this.configService.get<string>('RAG_API_URL') || 'http://aura-rag-alb-1169123670.ap-northeast-2.elb.amazonaws.com';
        const endpoint = `${ragBaseUrl}/meetings/${roomId}/start`;

        this.logger.log(`[RAG 회의 시작] POST ${endpoint} - Payload: ${JSON.stringify(payload)}`);

        try {
            const axios = await import('axios');
            // Payload 구조: { description: string, files: { bucket: string; key: string }[] }
            const response = await axios.default.post(endpoint, payload);
            this.logger.log(`[RAG 회의 시작 성공] ${roomId} - 응답: ${JSON.stringify(response.data)}`);
            return { success: true, message: response.data };
        } catch (error: any) {
            this.logger.error(`[RAG 회의 시작 실패] ${roomId}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 중간 보고서 요청 (HTTP POST 후 WebSocket 결과 대기)
     * POST /meetings/{roomId}/report → WebSocket으로 결과 수신
     */
    async requestReport(roomId: string): Promise<{ success: boolean; message?: string; report?: any }> {
        // WebSocket 연결 확인
        if (!this.isConnected(roomId)) {
            this.logger.error(`[RAG 중간 보고서] WebSocket 연결 안 됨: ${roomId}`);
            return { success: false, message: 'WebSocket 연결이 없습니다.' };
        }

        // 이미 대기 중인 요청이 있으면 거부
        if (this.pendingReportRequests.has(roomId)) {
            this.logger.warn(`[RAG 중간 보고서] 이미 요청 진행 중: ${roomId}`);
            return { success: false, message: '이미 보고서 생성 요청이 진행 중입니다.' };
        }

        const ragBaseUrl = this.configService.get<string>('RAG_API_URL') || 'http://aura-rag-alb-1169123670.ap-northeast-2.elb.amazonaws.com';
        const endpoint = `${ragBaseUrl}/meetings/${roomId}/report`;

        this.logger.log(`[RAG 중간 보고서] POST ${endpoint} (결과는 WebSocket 대기)`);

        const startTime = Date.now();

        // WebSocket 결과 대기 Promise 생성
        const resultPromise = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingReportRequests.delete(roomId);
                const elapsed = Date.now() - startTime;
                this.logger.error(`[RAG 중간 보고서 타임아웃] ${roomId} - ${elapsed}ms`);
                reject(new Error('보고서 생성 타임아웃'));
            }, this.REPORT_TIMEOUT);

            this.pendingReportRequests.set(roomId, {
                resolve,
                reject,
                timer,
                startTime,
            });
        });

        try {
            // HTTP POST 요청 (큐에 작업 추가)
            const axios = await import('axios');
            const response = await axios.default.post(endpoint);
            this.logger.log(`[RAG 중간 보고서 요청 전송] ${roomId} - 큐 상태: ${response.data?.status}`);

            // WebSocket에서 결과 대기
            const result = await resultPromise;
            this.logger.log(`[RAG 중간 보고서 완료] ${roomId}`);

            return {
                success: result.success,
                message: result.success ? '보고서 생성 완료' : '보고서 생성 실패',
                report: result,
            };
        } catch (error: any) {
            // 타임아웃 또는 HTTP 요청 실패
            this.pendingReportRequests.delete(roomId);
            this.logger.error(`[RAG 중간 보고서 실패] ${roomId}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    // ============================================================
    // 시연용 목업 데이터 주입 메서드
    // ============================================================

    /**
     * 목업 대화 데이터 주입 (시연용)
     * RAG 버퍼에 가짜 발언들을 추가하여 플로우차트 생성 테스트 가능
     */
    injectMockStatements(roomId: string, utterances: Array<{ speaker: string; text: string }>): { success: boolean; injected: number } {
        this.logger.log(`\n========== [목업 데이터 주입] ==========`);
        this.logger.log(`Room ID: ${roomId}`);
        this.logger.log(`발언 수: ${utterances.length}개`);

        let buffer = this.statementBuffers.get(roomId);
        if (!buffer) {
            buffer = [];
            this.statementBuffers.set(roomId, buffer);
        }

        for (const utterance of utterances) {
            buffer.push({
                text: utterance.text,
                speaker: utterance.speaker,
                timestamp: Date.now(),
                retryCount: 0,
            });
            this.logger.log(`  [+] ${utterance.speaker}: "${utterance.text.substring(0, 50)}..."`);
        }

        this.logger.log(`[목업 주입 완료] 총 버퍼 크기: ${buffer.length}`);
        return { success: true, injected: utterances.length };
    }

    /**
     * 현재 버퍼 내용 조회 (디버깅/시연용)
     */
    getBufferContent(roomId: string): Array<{ speaker: string; text: string; timestamp: number }> {
        const buffer = this.statementBuffers.get(roomId);
        if (!buffer || buffer.length === 0) {
            return [];
        }

        return buffer.map(stmt => ({
            speaker: stmt.speaker,
            text: stmt.text,
            timestamp: stmt.timestamp,
        }));
    }

    /**
     * 버퍼 내용을 포맷된 트랜스크립트로 반환 (플로우차트 생성용)
     */
    getFormattedTranscript(roomId: string): string {
        const buffer = this.statementBuffers.get(roomId);
        if (!buffer || buffer.length === 0) {
            return '';
        }

        return buffer
            .map(stmt => `${stmt.speaker}: ${stmt.text}`)
            .join('\n');
    }

    /**
     * 버퍼 초기화 (시연 리셋용)
     */
    clearBuffer(roomId: string): void {
        this.statementBuffers.delete(roomId);
        this.logger.log(`[버퍼 초기화] ${roomId}`);
    }
}
