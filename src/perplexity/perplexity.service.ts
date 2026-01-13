import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { WFCEngineService } from './wfc-engine.service';
import {
    CognitiveState,
    EntropyReportPayload,
    PerplexityAction,
    PerplexityMessage,
    PerplexitySession,
    PropagationResult,
    StateUpdatePayload,
} from './perplexity.types';

// ============================================================
// Perplexity Service
// WFC 기반 Perplexity 모드 메인 서비스
// ============================================================

@Injectable()
export class PerplexityService {
    private readonly logger = new Logger(PerplexityService.name);
    private sessions: Map<string, PerplexitySession> = new Map();

    // 전파 간격 (최소 500ms)
    private readonly MIN_PROPAGATION_INTERVAL_MS = 500;
    // 최대 트랜스크립트 저장 수
    private readonly MAX_TRANSCRIPTS = 50;

    constructor(
        private wfcEngine: WFCEngineService,
        private llmService: LlmService,
    ) {}

    // ============================================================
    // Session Management
    // ============================================================

    /**
     * Perplexity 세션 시작
     */
    startSession(roomId: string): PerplexitySession {
        const session: PerplexitySession = {
            roomId,
            isActive: true,
            startTime: Date.now(),
            participants: new Map(),
            topics: new Map(),
            currentTopic: null,
            sessionEntropy: 1,
            entropyLevel: 'high',
            actionHistory: [],
            lastPropagation: 0,
            recentTranscripts: [],
        };

        this.sessions.set(roomId, session);
        this.logger.log(`[Perplexity] Session started for room: ${roomId}`);

        return session;
    }

    /**
     * Perplexity 세션 종료
     */
    endSession(roomId: string): PerplexitySession | null {
        const session = this.sessions.get(roomId);
        if (!session) return null;

        session.isActive = false;
        this.logger.log(`[Perplexity] Session ended for room: ${roomId}`);

        // 세션 정보 반환 후 삭제
        this.sessions.delete(roomId);
        return session;
    }

    /**
     * 세션 조회
     */
    getSession(roomId: string): PerplexitySession | null {
        return this.sessions.get(roomId) || null;
    }

    /**
     * 세션 활성 여부
     */
    isSessionActive(roomId: string): boolean {
        const session = this.sessions.get(roomId);
        return session?.isActive ?? false;
    }

    // ============================================================
    // Participant Management
    // ============================================================

    /**
     * 참여자 추가/업데이트
     */
    addParticipant(roomId: string, participantId: string, participantName: string): void {
        const session = this.sessions.get(roomId);
        if (!session) return;

        if (!session.participants.has(participantId)) {
            const cell = this.wfcEngine.createParticipantCell(participantId, participantName);
            session.participants.set(participantId, cell);
            this.logger.log(`[Perplexity] Participant added: ${participantName} (${participantId})`);
        }
    }

    /**
     * 참여자 제거
     */
    removeParticipant(roomId: string, participantId: string): void {
        const session = this.sessions.get(roomId);
        if (!session) return;

        session.participants.delete(participantId);
        this.logger.log(`[Perplexity] Participant removed: ${participantId}`);
    }

    // ============================================================
    // State Updates (from Frontend)
    // ============================================================

    /**
     * 프론트엔드에서 상태 업데이트 수신
     */
    handleStateUpdate(roomId: string, payload: StateUpdatePayload): PropagationResult | null {
        const session = this.sessions.get(roomId);
        if (!session || !session.isActive) return null;

        const { participantId, state, entropy, confidence } = payload;
        const cell = session.participants.get(participantId);

        if (!cell) {
            this.logger.warn(`[Perplexity] Unknown participant: ${participantId}`);
            return null;
        }

        // 상태 collapse
        if (state) {
            const updatedCell = this.wfcEngine.collapseState(cell, state, confidence);
            session.participants.set(participantId, updatedCell);
        }

        // 전파 실행 (쿨다운 체크)
        return this.tryPropagate(session);
    }

    /**
     * 엔트로피 리포트 수신 (배치 업데이트)
     */
    handleEntropyReport(roomId: string, payload: EntropyReportPayload): PropagationResult | null {
        const session = this.sessions.get(roomId);
        if (!session || !session.isActive) return null;

        // ★ 텍스트 기반 상태 보호 시간 (5초)
        const TEXT_STATE_PROTECTION_MS = 5000;
        const now = Date.now();

        // 각 참여자 상태 업데이트
        let hasStateUpdate = false;
        for (const update of payload.participantStates) {
            const cell = session.participants.get(update.participantId);
            if (cell && update.state) {
                // ★ 텍스트 기반 상태가 최근에 설정되었으면 오디오 기반 업데이트 스킵
                if (cell.textInferredAt > 0 && (now - cell.textInferredAt) < TEXT_STATE_PROTECTION_MS) {
                    this.logger.debug(`[Perplexity] ENTROPY_REPORT 스킵 - 텍스트 기반 상태 보호 중: ${update.participantId} (${cell.observedState})`);
                    continue;
                }

                hasStateUpdate = true;
                const confidence = update.confidence ?? 0.7; // 기본 신뢰도 0.7 (텍스트보다 낮게)
                const updatedCell = this.wfcEngine.collapseState(
                    cell,
                    update.state,
                    confidence
                );
                session.participants.set(update.participantId, updatedCell);
                this.logger.debug(`[Perplexity] State updated: ${update.participantId} -> ${update.state} (confidence: ${confidence})`);
            }
        }

        // 상태 업데이트가 있을 때만 로그
        if (hasStateUpdate) {
            this.logger.log(`[Perplexity] Entropy report processed: ${payload.participantStates.length} participants, sessionEntropy: ${payload.sessionEntropy?.toFixed(2)}`);
        }

        // 세션 엔트로피 업데이트
        this.wfcEngine.updateSessionEntropy(session);

        // 전파 실행
        return this.tryPropagate(session);
    }

    /**
     * 트랜스크립트 추가 (발화 내용)
     */
    addTranscript(roomId: string, participantId: string, text: string): CognitiveState | null {
        const session = this.sessions.get(roomId);
        if (!session || !session.isActive) {
            this.logger.warn(`[Perplexity] addTranscript 실패 - 세션 없음 또는 비활성: ${roomId}`);
            return null;
        }

        // 트랜스크립트 저장
        session.recentTranscripts.push({
            participantId,
            text,
            timestamp: Date.now(),
        });

        // 최대 개수 유지
        if (session.recentTranscripts.length > this.MAX_TRANSCRIPTS) {
            session.recentTranscripts.shift();
        }

        this.logger.log(`[Perplexity] Transcript 저장: "${text.substring(0, 30)}..." (총 ${session.recentTranscripts.length}개)`);

        // 텍스트 기반 상태 추론
        const inferredState = this.inferStateFromTranscript(text);
        if (inferredState) {
            const cell = session.participants.get(participantId);
            if (cell) {
                const updatedCell = this.wfcEngine.collapseState(cell, inferredState, 0.9);
                // ★ 텍스트 기반 상태 추론 시간 기록 (ENTROPY_REPORT 보호용)
                updatedCell.textInferredAt = Date.now();
                session.participants.set(participantId, updatedCell);
                this.logger.log(`[Perplexity] 텍스트 기반 상태 추론: ${participantId} → ${inferredState} (보호 활성화)`);
            } else {
                this.logger.warn(`[Perplexity] 참여자 없음: ${participantId}`);
            }
        }

        return inferredState;
    }

    /**
     * 텍스트에서 상태 추론 (한글 활용형 고려)
     */
    private inferStateFromTranscript(text: string): CognitiveState | null {
        const lower = text.toLowerCase();

        // 혼란 표현 (한글 활용형 고려: 어렵다/어려워/어려운 → "어려")
        if (/모르겠|헷갈|이해가 안|뭐지|어려|복잡|무슨 말|쉽지 않|안 되|힘들/.test(lower)) {
            this.logger.debug(`[Perplexity] 혼란 패턴 감지: "${text.substring(0, 30)}..."`);
            return 'confused';
        }

        // 이해 표현 (한글 활용형 고려: 알겠다/알겠어/알았어 등)
        if (/그렇지|맞아|알겠|알았|이해했|이해됐|아하|오케이|넵|그렇구나|그런 거|그거구나/.test(lower)) {
            this.logger.debug(`[Perplexity] 이해 패턴 감지: "${text.substring(0, 30)}..."`);
            return 'understood';
        }

        // 사고 중 표현
        if (/음+|흠+|잠깐|그러니까|생각해보면|근데|그게/.test(lower)) {
            this.logger.debug(`[Perplexity] 사고 패턴 감지: "${text.substring(0, 30)}..."`);
            return 'thinking';
        }

        // 기여 (질문 또는 설명)
        if (/\?|제 생각에는|왜냐하면|예를 들어|설명하자면/.test(lower)) {
            return 'contributing';
        }

        return null;
    }

    // ============================================================
    // Propagation
    // ============================================================

    /**
     * 전파 시도 (쿨다운 체크)
     */
    private tryPropagate(session: PerplexitySession): PropagationResult | null {
        const now = Date.now();

        // 쿨다운 체크
        if (now - session.lastPropagation < this.MIN_PROPAGATION_INTERVAL_MS) {
            return null;
        }

        session.lastPropagation = now;

        // WFC 전파 실행
        const result = this.wfcEngine.propagate(session);

        // 액션이 있으면 히스토리에 추가
        if (result.actions.length > 0) {
            for (const action of result.actions) {
                session.actionHistory.push({ action, timestamp: now });
                this.logger.log(`[Perplexity] Action generated: ${action.type}`);
            }
        }

        return result;
    }

    // ============================================================
    // Action Generation (LLM 기반)
    // ============================================================

    /**
     * AI 개입 응답 생성 (문맥 기반)
     */
    async generateInterventionResponse(
        roomId: string,
        action: PerplexityAction
    ): Promise<string | null> {
        const session = this.sessions.get(roomId);
        if (!session) return null;

        // 최근 발화 문맥 구성 (화자 포함)
        const recentTranscripts = session.recentTranscripts.slice(-8);
        const conversationContext = recentTranscripts.length > 0
            ? recentTranscripts.map(t => {
                const participant = session.participants.get(t.participantId);
                const name = participant?.participantName || t.participantId;
                return `${name}: "${t.text}"`;
            }).join('\n')
            : '(아직 대화 없음)';

        // 참여자 상태 요약
        const participantStates = Array.from(session.participants.values())
            .map(p => `${p.participantName}: ${p.observedState || '파악중'}`)
            .join(', ');

        let prompt = '';

        // 공통 지시
        const instruction = `
당신은 스터디 세션의 진행자입니다.
아래 대화 문맥과 참여자 상태를 보고, 상황에 맞는 자연스러운 한 문장만 출력하세요.
설명이나 이유 없이 말할 문장만 출력하세요.

[최근 대화]
${conversationContext}

[참여자 상태]
${participantStates}
`.trim();

        switch (action.type) {
            case 'AI_INTERVENTION':
                prompt = `${instruction}

[상황] 일부 참여자가 어려워하고 있습니다. 대화 내용을 보고 어떤 부분이 어려운지 파악해서 도움을 제안하세요.
예시 형식: "혹시 [구체적 주제] 부분이 헷갈리시나요? 제가 다시 설명해드릴까요?"`;
                break;

            case 'FOLLOW_UP_QUESTION':
                prompt = `${instruction}

[상황] 모두가 현재 주제를 이해한 것 같습니다. 대화 내용을 보고 더 깊이 탐구할 수 있는 심화 질문을 하세요.
예시 형식: "그럼 [관련 개념]은 어떻게 될까요?" 또는 "실제로 적용하면 어떤 점이 달라질까요?"`;
                break;

            case 'PEER_TEACHING':
                prompt = `${instruction}

[상황] ${action.teacher}님이 이해하고 있고, 다른 분들이 어려워합니다. ${action.teacher}님께 설명을 부탁하세요.
예시 형식: "${action.teacher}님, 혹시 [해당 주제]에 대해 설명해주실 수 있을까요?"`;
                break;

            case 'SUMMARY_REQUEST':
                prompt = `${instruction}

[상황] 다양한 의견이 오가고 있습니다. 지금까지 논의된 내용을 정리하자고 제안하세요.
예시 형식: "잠깐, [주제]에 대해 정리하고 넘어갈까요?"`;
                break;

            case 'ENGAGEMENT_BOOST':
                const disengagedName = action.suggestion?.split('님')[0] || '참여자';
                prompt = `${instruction}

[상황] ${disengagedName}님이 잠시 집중이 흐트러진 것 같습니다. 자연스럽게 참여를 유도하세요.
예시 형식: "${disengagedName}님은 어떻게 생각하세요?" 또는 "${disengagedName}님도 비슷한 경험 있으신가요?"`;
                break;

            default:
                return null;
        }

        try {
            this.logger.debug(`[Perplexity] 문맥 기반 프롬프트 생성 - 최근 발화 ${recentTranscripts.length}개`);
            const response = await this.llmService.sendMessagePure(prompt, 100);
            // 따옴표 제거 및 첫 문장만 추출
            const cleaned = response.trim().replace(/^["']|["']$/g, '').split('\n')[0];
            this.logger.log(`[Perplexity] 생성된 응답: "${cleaned}"`);
            return cleaned;
        } catch (error) {
            this.logger.error(`[Perplexity] LLM response failed: ${error.message}`);
            return null;
        }
    }

    // ============================================================
    // Message Handling
    // ============================================================

    /**
     * 프론트엔드 메시지 처리
     */
    async handleMessage(
        roomId: string,
        message: PerplexityMessage
    ): Promise<{ action?: PerplexityAction; response?: string } | null> {
        switch (message.type) {
            case 'PERPLEXITY_START':
                this.startSession(roomId);
                return null;

            case 'PERPLEXITY_END':
                this.endSession(roomId);
                return null;

            case 'STATE_UPDATE':
                const stateResult = this.handleStateUpdate(
                    roomId,
                    message.payload as StateUpdatePayload
                );
                if (stateResult?.actions.length) {
                    const action = stateResult.actions[0];
                    const response = await this.generateInterventionResponse(roomId, action);
                    return { action, response: response || undefined };
                }
                return null;

            case 'ENTROPY_REPORT':
                const entropyResult = this.handleEntropyReport(
                    roomId,
                    message.payload as EntropyReportPayload
                );
                if (entropyResult?.actions.length) {
                    const action = entropyResult.actions[0];
                    const response = await this.generateInterventionResponse(roomId, action);
                    return { action, response: response || undefined };
                }
                return null;

            case 'TRANSCRIPT':
                const { participantId, text } = message.payload as { participantId: string; text: string };
                const inferredState = this.addTranscript(roomId, participantId, text);

                // 상태가 추론되었으면 propagation 실행
                if (inferredState) {
                    this.logger.log(`[Perplexity] Transcript → ${inferredState} (${participantId})`);
                    const transcriptSession = this.sessions.get(roomId);
                    if (transcriptSession) {
                        this.wfcEngine.updateSessionEntropy(transcriptSession);
                        const propagateResult = this.tryPropagate(transcriptSession);
                        if (propagateResult?.actions.length) {
                            const action = propagateResult.actions[0];
                            const response = await this.generateInterventionResponse(roomId, action);
                            return { action, response: response || undefined };
                        }
                    }
                }
                return null;

            default:
                return null;
        }
    }

    // ============================================================
    // Reports
    // ============================================================

    /**
     * 현재 세션 상태 요약
     */
    getSessionSummary(roomId: string): {
        isActive: boolean;
        participantCount: number;
        entropy: number;
        entropyLevel: string;
        actionCount: number;
        duration: number;
    } | null {
        const session = this.sessions.get(roomId);
        if (!session) return null;

        return {
            isActive: session.isActive,
            participantCount: session.participants.size,
            entropy: session.sessionEntropy,
            entropyLevel: session.entropyLevel,
            actionCount: session.actionHistory.length,
            duration: Date.now() - session.startTime,
        };
    }
}
