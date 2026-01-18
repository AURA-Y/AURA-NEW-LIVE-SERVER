import { Injectable, Logger } from '@nestjs/common';
import { Room } from '@livekit/rtc-node';
import { LlmService } from '../llm/llm.service';

interface ProcessedTranscript {
    refinedText: string;
    keywords: string[];
}

interface BufferedTranscript {
    speaker: string;
    text: string;
    timestamp: number;
}

@Injectable()
export class TimelineService {
    private readonly logger = new Logger(TimelineService.name);

    // 방별 1분 컨텍스트 버퍼
    private contextBuffers: Map<string, BufferedTranscript[]> = new Map();

    // 버퍼 유지 시간 (1분)
    private readonly BUFFER_DURATION_MS = 60 * 1000;

    constructor(private readonly llmService: LlmService) {}

    /**
     * 1분이 지난 발언들 정리
     */
    private cleanExpiredContext(roomId: string): BufferedTranscript[] {
        const buffer = this.contextBuffers.get(roomId) || [];
        const now = Date.now();
        const validEntries = buffer.filter(
            entry => (now - entry.timestamp) < this.BUFFER_DURATION_MS
        );
        this.contextBuffers.set(roomId, validEntries);
        return validEntries;
    }

    /**
     * 컨텍스트에 발언 추가
     */
    private addToContext(roomId: string, speaker: string, text: string): void {
        const buffer = this.contextBuffers.get(roomId) || [];
        buffer.push({
            speaker,
            text,
            timestamp: Date.now(),
        });
        this.contextBuffers.set(roomId, buffer);
    }

    /**
     * 컨텍스트를 문자열로 변환 (LLM 프롬프트용)
     */
    private formatContext(buffer: BufferedTranscript[]): string {
        if (buffer.length === 0) return '';
        return buffer.map(entry => `${entry.speaker}: ${entry.text}`).join('\n');
    }

    /**
     * 방 종료 시 버퍼 정리
     */
    clearBuffer(roomId: string): void {
        this.contextBuffers.delete(roomId);
        this.logger.log(`[Timeline] 버퍼 정리: ${roomId}`);
    }

    /**
     * LLM으로 STT 결과 정제 + 키워드 추출 (컨텍스트 활용)
     */
    async processTranscript(transcript: string, context: string): Promise<ProcessedTranscript> {
        const contextSection = context
            ? `## 이전 대화 컨텍스트 (참고용, 수정하지 말 것)
${context}

`
            : '';

        const prompt = `다음은 회의 중 음성인식(STT) 결과입니다.
두 가지 작업을 수행하세요:

1. STT 오인식을 교정하여 자연스러운 문장으로 다듬기
2. 문장에서 중요 키워드 최대 5개 추출

${contextSection}## STT 정제 규칙
- STT 오인식 교정 (기술 용어, 외래어 등)
- 불필요한 추임새 제거 (음, 어, 그...)
- 원래 의미를 유지하면서 자연스럽게 수정
- 이전 대화 컨텍스트를 참고하여 일관된 용어 사용
- 맥락상 불완전한 문장이면 자연스럽게 보완

## STT 오인식 교정 예시

### 기술 용어
- 유아이/유아이엑스/유아이 유엑스/유아이유엑스/UI UX/유 아이 유 엑스 → UI/UX
- 유아이 고도화/유아이엑스 고도화 → UI/UX 고도화
- 리액트/리엑트 → React
- 타입스크립트 → TypeScript
- 도커/독커/독거 → Docker
- 쿠버네티스/후보네티스 → Kubernetes
- 웹소켓 → WebSocket
- 에이피아이 → API
- 엘엘엠 → LLM
- 지피티 → GPT
- 유즈메모/유저메모/유스메모 → useMemo
- 유즈이펙트/유스이펙트 → useEffect
- 프론트엔드 → Frontend
- 라이브킷 → LiveKit
- 클로바/글로바/클로버 → Clova
- 깃허브/깃헙/기트허브 → GitHub
- 슬랙/슬렉/스랙 → Slack
- 스크럼/스크런/스크롬 → 스크럼
- 이알디/ERD → ERD
- 플로우차트/플로차트/플로우 차트 → 플로우차트
- 시퀀스/시컨스/씨퀀스 → 시퀀스 다이어그램
- 아키텍처/아키택처/아키텍쳐 → 아키텍처

### 서비스 용어
- 헤이록/헤이록생/회이록 → 회의록
- 청여자/참야자 → 참여자
- 진행자/진행차 → 진행자
- 액션아이템/액션 아이템/액숀아이템 → 액션 아이템
- 타임라인/타이라인/타임 라인 → 타임라인
- 북마크/북막/북말크 → 북마크
- 캘린더/캘런더/켈린더 → 캘린더
- 회의상태바/회의 상태바/상태바 → 회의 상태바
- 화면분석/화면 분석/화면분석기능 → 화면 분석
- 화면공유/화면 공유 → 화면 공유
- 포스터세션/포스터 세션 → 포스터 세션

### 일반 용어
- 고도와/고도아 → 고도화
- 인식을/인식율 → 인식률
- 생선 속도/성공 속도 → 생성 속도
- 비동작 → 비동기
- 콜백/퀄백 → callback
- 시연/시언 → 시연
- 격차로/격자로 → 격자
- 맞춤와/맞춤아 → 맞춤화

### 참여자 이름
- 태은/태운/테은 → 태은
- 동규/동구/동귀 → 동규
- 지웅/지응/지웅이 → 지웅
- 명기/명기님/명끼 → 명기
- 멘토/멘터/맨토 → 멘토

## 키워드 추출 규칙
- 문장의 핵심 개념을 나타내는 명사/용어만 추출
- 최대 5개까지만 (중요도 순)
- 의미 없는 일반 단어 제외 (있다, 하다, 것, 등)
- 키워드가 없으면 빈 배열

## 정제할 STT 원본 (이것만 정제)
${transcript}

## 출력 형식 (JSON만 출력, 다른 설명 없이)
{"text": "정제된 문장", "keywords": ["키워드1", "키워드2"]}`;

        try {
            const result = await this.llmService.sendMessagePure(prompt, 400);

            // JSON 파싱 시도
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    refinedText: parsed.text || transcript,
                    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 5) : [],
                };
            }
        } catch (error) {
            this.logger.warn(`[Timeline] JSON 파싱 실패, 원본 반환: ${error.message}`);
        }

        // 파싱 실패 시 원본 반환
        return { refinedText: transcript, keywords: [] };
    }

    /**
     * STT 발화를 컨텍스트 기반으로 LLM 정제 후 타임라인으로 전송
     */
    async sendTranscript(
        room: Room,
        roomId: string,
        transcript: string,
        speaker: string,
    ): Promise<void> {
        // 너무 짧은 텍스트는 스킵
        if (transcript.trim().length <= 3) return;

        try {
            // 1. 만료된 컨텍스트 정리 (1분 지난 것들 제거)
            const validContext = this.cleanExpiredContext(roomId);

            // 2. 현재 컨텍스트를 문자열로 변환
            const contextStr = this.formatContext(validContext);

            // 3. 컨텍스트 기반으로 LLM 정제
            const { refinedText, keywords } = await this.processTranscript(
                transcript.trim(),
                contextStr
            );

            // 4. 정제된 텍스트를 버퍼에 추가 (다음 발언의 컨텍스트로 사용)
            this.addToContext(roomId, speaker, refinedText);

            // 5. DataChannel로 전송
            const message = {
                type: 'TIMELINE_TRANSCRIPT_UPDATE',
                speaker,
                text: refinedText,
                keywords,
                originalText: transcript.trim(),
                timestamp: Date.now(),
                roomId,
                contextSize: validContext.length, // 디버깅용: 사용된 컨텍스트 수
            };

            const encoder = new TextEncoder();
            await room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
                reliable: true,
            });

            const keywordStr = keywords.length > 0 ? ` [${keywords.join(', ')}]` : '';
            const contextInfo = validContext.length > 0 ? ` (ctx: ${validContext.length})` : '';
            this.logger.log(`[Timeline] ${speaker}: "${refinedText.substring(0, 30)}..."${keywordStr}${contextInfo}`);
        } catch (error) {
            this.logger.error(`[Timeline] 발화 정제/전송 실패: ${error.message}`);
        }
    }
}
