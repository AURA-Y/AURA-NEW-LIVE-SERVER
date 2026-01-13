// ============================================================
// Perplexity Mode - WFC Flow Controller Types (Backend)
// ============================================================

/**
 * 참여자의 인지 상태
 */
export type CognitiveState =
    | 'confused'      // 혼란
    | 'absorbing'     // 흡수 (듣는 중)
    | 'thinking'      // 사고 중
    | 'contributing'  // 기여 (발언 중)
    | 'understood'    // 이해 완료
    | 'disengaged';   // 이탈

/**
 * 토픽 진행 상태
 */
export type TopicState =
    | 'introduced'    // 소개됨
    | 'discussing'    // 논의 중
    | 'clarifying'    // 재설명 중
    | 'mastered'      // 완료
    | 'skipped';      // 건너뜀

/**
 * 엔트로피 레벨
 */
export type EntropyLevel = 'low' | 'medium' | 'high';

/**
 * WFC 셀 (참여자별 상태)
 */
export interface ParticipantCell {
    participantId: string;
    participantName: string;
    possibleStates: CognitiveState[];
    observedState: CognitiveState | null;
    entropy: number;
    confidence: number;
    lastUpdate: number;
    // 추가 메트릭
    speakingRatio: number;      // 발언 비율 (0-1)
    questionCount: number;      // 질문 횟수
    confusionCount: number;     // 혼란 감지 횟수
    // 텍스트 기반 상태 보호
    textInferredAt: number;     // 텍스트 기반 상태 추론 시간 (0이면 없음)
}

/**
 * 토픽 셀
 */
export interface TopicCell {
    topicId: string;
    topicName: string;
    state: TopicState;
    participantUnderstanding: Map<string, number>;
    mentionCount: number;
    lastMention: number;
}

/**
 * WFC Constraint (규칙)
 */
export interface WFCConstraint {
    id: string;
    name: string;
    description: string;
    condition: (session: PerplexitySession) => boolean;
    action: PerplexityAction;
    priority: number;           // 높을수록 우선
    cooldownMs: number;         // 재실행 쿨다운
    lastTriggered?: number;
}

/**
 * Perplexity 모드 액션
 */
export type PerplexityAction =
    | { type: 'AI_INTERVENTION'; reason: string; targetParticipants: string[]; suggestedResponse?: string }
    | { type: 'FOLLOW_UP_QUESTION'; question: string; context: string; targetParticipants?: string[] }
    | { type: 'TOPIC_TRANSITION'; fromTopic: string; toTopic: string; reason: string }
    | { type: 'PEER_TEACHING'; teacher: string; learners: string[]; topic: string }
    | { type: 'SUMMARY_REQUEST'; topics: string[]; reason: string }
    | { type: 'ENGAGEMENT_BOOST'; targetParticipants: string[]; suggestion: string };

/**
 * Perplexity 세션 상태
 */
export interface PerplexitySession {
    roomId: string;
    isActive: boolean;
    startTime: number;
    participants: Map<string, ParticipantCell>;
    topics: Map<string, TopicCell>;
    currentTopic: string | null;
    sessionEntropy: number;
    entropyLevel: EntropyLevel;
    actionHistory: Array<{ action: PerplexityAction; timestamp: number }>;
    lastPropagation: number;
    recentTranscripts: Array<{ participantId: string; text: string; timestamp: number }>;
}

/**
 * 프론트엔드에서 받는 상태 업데이트
 */
export interface StateUpdatePayload {
    participantId: string;
    state: CognitiveState | null;
    entropy: number;
    confidence: number;
}

/**
 * 프론트엔드에서 받는 엔트로피 리포트
 */
export interface EntropyReportPayload {
    sessionEntropy: number;
    participantStates: StateUpdatePayload[];
}

/**
 * DataChannel 메시지 타입 (프론트 ↔ 백엔드)
 */
export interface PerplexityMessage {
    type:
        | 'PERPLEXITY_START'
        | 'PERPLEXITY_END'
        | 'STATE_UPDATE'
        | 'OBSERVATION'
        | 'PROPAGATION'
        | 'ACTION'
        | 'ENTROPY_REPORT'
        | 'TRANSCRIPT';
    payload: unknown;
    senderId: string;
    timestamp: number;
}

/**
 * WFC 전파 결과
 */
export interface PropagationResult {
    triggeredConstraints: string[];
    actions: PerplexityAction[];
    entropyChange: number;
    affectedParticipants: string[];
}
