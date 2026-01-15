/**
 * Proactive AI Assistant 인터페이스 정의
 * 화면 이해 모드 + 음성 발화를 분석하여 도움될 정보를 제안
 */

/**
 * 인사이트 타입
 */
export type ProactiveInsightType =
  | 'code_suggestion'    // 코드 개선 제안
  | 'price_comparison'   // 가격 비교 정보
  | 'explanation'        // 설명 제공
  | 'tip'               // 유용한 팁
  | 'warning';          // 경고/주의

/**
 * Proactive 인사이트 (AI가 감지한 도움될 정보)
 */
export interface ProactiveInsight {
  type: ProactiveInsightType;
  title: string;           // 토스트 제목 (짧게, 20자 이내)
  content: string;         // 토스트 본문 (1-2문장)
  confidence: number;      // 신뢰도 0-100
  source?: string;         // 출처 URL (있으면)
  actionable?: {           // 클릭 가능한 액션 (옵션)
    label: string;
    url?: string;
    code?: string;         // 코드 제안인 경우
  };
  timestamp: number;
}

/**
 * 분석 컨텍스트 (LLM에 전달할 정보)
 */
export interface AnalysisContext {
  screenTexts: string[];           // OCR 추출 텍스트 (최근 3개)
  recentConversation: string[];    // 최근 발화 (5턴)
  roomTopic?: string;              // 회의 주제
}

/**
 * Proactive 분석 설정
 */
export interface ProactiveConfig {
  enabled: boolean;
  analysisIntervalMs: number;      // 분석 주기 (기본 8초)
  minConfidenceThreshold: number;  // 최소 신뢰도 (기본 70)
  cooldownMs: number;              // 같은 유형 인사이트 쿨다운 (기본 60초)
  maxInsightsPerAnalysis: number;  // 분석당 최대 인사이트 수 (기본 2)
}

/**
 * RoomContext에 추가될 Proactive 상태
 */
export interface ProactiveAnalysisState {
  enabled: boolean;
  lastAnalysisTime: number;
  lastScreenTextHash: string;      // 중복 분석 방지
  recentInsightTypes: Set<string>; // 쿨다운 추적 (type -> timestamp)
  analysisTimer?: NodeJS.Timeout;
}

/**
 * DataChannel로 전송할 메시지 형식
 */
export interface ProactiveInsightMessage {
  type: 'PROACTIVE_INSIGHT';
  insights: ProactiveInsight[];
  timestamp: number;
}

/**
 * 기본 설정값
 */
export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  enabled: true,
  analysisIntervalMs: 8000,        // 8초
  minConfidenceThreshold: 70,      // 70%
  cooldownMs: 60000,               // 60초
  maxInsightsPerAnalysis: 2,       // 최대 2개
};
