/**
 * AI 의견 제시 기능 - Evidence 인터페이스 정의
 *
 * 검증된 근거가 있을 때만 AI가 의견을 제시할 수 있도록
 * 사전 검증된 Evidence DB를 사용
 */

/**
 * 신뢰할 수 있는 출처 유형
 */
export type EvidenceSourceType =
    | 'official_announcement'   // Google, Microsoft, AWS 등 공식 발표
    | 'large_survey'            // StackOverflow, JetBrains 등 대규모 설문 (10,000명+)
    | 'academic_paper'          // IEEE, ACM 등 peer-reviewed 논문
    | 'standard_organization'   // OWASP, IETF RFC, W3C 표준
    | 'statistics_agency';      // Statista, Gartner 등 통계 기관

/**
 * 검증된 Evidence 항목
 */
export interface VerifiedEvidence {
    /** 고유 ID */
    id: string;

    /** 주제/토픽 (매칭에 사용) */
    topic: string;

    /** 관련 키워드 목록 (토픽 매칭 보조) */
    keywords: string[];

    /** 검증된 사실 내용 */
    fact: string;

    /** 출처명 */
    sourceName: string;

    /** 출처 유형 */
    sourceType: EvidenceSourceType;

    /** 출처 URL (확인 가능한 링크) */
    sourceUrl: string;

    /** 검증 날짜 (YYYY-MM 형식) */
    verifiedDate: string;

    /** 설문 참여자 수 (large_survey인 경우) */
    participantCount?: number;

    /** 카테고리 (개발, 보안, 인프라 등) */
    category: string;

    /** 활성화 여부 */
    isActive: boolean;
}

/**
 * Evidence 매칭 결과
 */
export interface EvidenceMatchResult {
    /** 매칭된 Evidence */
    evidence: VerifiedEvidence;

    /** 매칭 신뢰도 (0-100) */
    confidence: number;

    /** 매칭된 키워드 */
    matchedKeywords: string[];
}

/**
 * AI 의견 제시 결과
 */
export interface OpinionResult {
    /** 의견 제시 여부 */
    shouldSpeak: boolean;

    /** 생성된 응답 (shouldSpeak가 true인 경우) */
    response?: string;

    /** 사용된 Evidence (shouldSpeak가 true인 경우) */
    evidence?: VerifiedEvidence;

    /** 매칭 신뢰도 */
    confidence: number;

    /** 침묵 사유 (shouldSpeak가 false인 경우) */
    silenceReason?: string;
}

/**
 * Opinion Service 설정
 */
export interface OpinionConfig {
    /** 최소 신뢰도 임계값 (기본: 95) */
    minConfidenceThreshold: number;

    /** Evidence 최대 유효 기간 (월 단위, 기본: 24) */
    maxEvidenceAgeMonths: number;

    /** 최소 설문 참여자 수 (large_survey인 경우, 기본: 10000) */
    minSurveyParticipants: number;

    /** 활성화 여부 */
    enabled: boolean;
}

/**
 * 기본 설정값
 */
export const DEFAULT_OPINION_CONFIG: OpinionConfig = {
    minConfidenceThreshold: 95,
    maxEvidenceAgeMonths: 24,
    minSurveyParticipants: 10000,
    enabled: true,
};
