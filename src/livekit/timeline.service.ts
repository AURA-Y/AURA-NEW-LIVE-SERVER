import { Injectable, Logger } from '@nestjs/common';
import { Room } from '@livekit/rtc-node';
import { LlmService } from '../llm/llm.service';

interface ProcessedTranscript {
    refinedText: string;
    keywords: string[];
}

@Injectable()
export class TimelineService {
    private readonly logger = new Logger(TimelineService.name);

    constructor(private readonly llmService: LlmService) {}

    /**
     * LLM으로 STT 결과 정제 + 키워드 추출 (한 번의 호출로 처리)
     */
    async processTranscript(transcript: string): Promise<ProcessedTranscript> {
        const prompt = `다음은 회의 중 음성인식(STT) 결과입니다.
두 가지 작업을 수행하세요:

1. STT 오인식을 교정하여 자연스러운 문장으로 다듬기
2. 문장에서 중요 키워드 최대 5개 추출

## STT 정제 규칙
- STT 오인식 교정 (기술 용어, 외래어 등)
- 불필요한 추임새 제거 (음, 어, 그...)
- 원래 의미를 유지하면서 자연스럽게 수정

## STT 오인식 교정 예시
- 리액트/리엑트 → React
- 타입스크립트 → TypeScript
- 도커/독커/독거 → Docker
- 쿠버네티스/후보네티스 → Kubernetes
- 웹소켓 → WebSocket
- 에이피아이 → API
- 엘엘엠 → LLM
- 지피티 → GPT
- 유즈메모/유저메모 → useMemo
- 유즈이펙트 → useEffect
- 프론트엔드 → Frontend
- 라이브킷 → LiveKit
- 클로바/글로바 → Clova
- 헤이록/헤이록생 → 회의록
- 생선 속도/성공 속도 → 생성 속도
- 비동작 → 비동기
- 콜백/퀄백 → callback
- 청여자 → 참여자

## 키워드 추출 규칙
- 문장의 핵심 개념을 나타내는 명사/용어만 추출
- 최대 5개까지만 (중요도 순)
- 의미 없는 일반 단어 제외 (있다, 하다, 것, 등)
- 키워드가 없으면 빈 배열

## STT 원본
${transcript}

## 출력 형식 (JSON만 출력, 다른 설명 없이)
{"text": "정제된 문장", "keywords": ["키워드1", "키워드2"]}`;

        try {
            const result = await this.llmService.sendMessagePure(prompt, 300);

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
     * STT 발화를 즉시 LLM으로 정제하여 타임라인으로 전송
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
            // LLM으로 문장 정제 + 키워드 추출
            const { refinedText, keywords } = await this.processTranscript(transcript.trim());

            // DataChannel로 전송
            const message = {
                type: 'TIMELINE_TRANSCRIPT_UPDATE',
                speaker,
                text: refinedText,
                keywords,
                originalText: transcript.trim(),
                timestamp: Date.now(),
                roomId,
            };

            const encoder = new TextEncoder();
            await room.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
                reliable: true,
            });

            const keywordStr = keywords.length > 0 ? ` [${keywords.join(', ')}]` : '';
            this.logger.log(`[Timeline] ${speaker}: "${refinedText.substring(0, 30)}..."${keywordStr}`);
        } catch (error) {
            this.logger.error(`[Timeline] 발화 정제/전송 실패: ${error.message}`);
        }
    }
}
