import { Injectable, Logger } from '@nestjs/common';
import { EvidenceRepository } from './evidence.repository';
import {
    OpinionResult,
    EvidenceMatchResult,
    VerifiedEvidence,
    DEFAULT_OPINION_CONFIG,
} from './evidence.interface';

/**
 * AI 의견 제시 서비스
 *
 * 대화 내용을 모니터링하고, 검증된 근거가 있을 때만 의견을 제시
 * "검증된 근거가 없으면 침묵" 원칙 적용
 */
@Injectable()
export class OpinionService {
    private readonly logger = new Logger(OpinionService.name);

    // 최근 제시한 의견 추적 (같은 Evidence 반복 방지)
    private recentOpinions: Map<string, { evidenceId: string; timestamp: number }> = new Map();

    // 의견 반복 방지 쿨다운 (밀리초)
    private readonly OPINION_COOLDOWN_MS = 5 * 60 * 1000; // 5분

    constructor(private readonly evidenceRepository: EvidenceRepository) {}

    /**
     * 대화 내용을 분석하여 의견 제시 여부 결정
     *
     * @param roomId 방 ID
     * @param conversationText 현재 대화 텍스트 (여러 발화 결합)
     * @param currentSpeaker 현재 발화자 (AI 의견 제시 대상)
     * @returns OpinionResult
     */
    async analyzeAndRespond(
        roomId: string,
        conversationText: string,
        currentSpeaker?: string,
    ): Promise<OpinionResult> {
        const config = this.evidenceRepository.getConfig();

        // 기능 비활성화 확인
        if (!config.enabled) {
            return {
                shouldSpeak: false,
                confidence: 0,
                silenceReason: 'Opinion feature is disabled',
            };
        }

        // 텍스트 길이 검증
        if (!conversationText || conversationText.trim().length < 10) {
            return {
                shouldSpeak: false,
                confidence: 0,
                silenceReason: 'Conversation text too short',
            };
        }

        // 관련 Evidence 검색
        const matches = this.evidenceRepository.findRelevantEvidence(conversationText);

        if (matches.length === 0) {
            return {
                shouldSpeak: false,
                confidence: 0,
                silenceReason: 'No relevant evidence found',
            };
        }

        // 최고 신뢰도 매칭 선택
        const bestMatch = matches[0];

        // 신뢰도 임계값 검증
        if (bestMatch.confidence < config.minConfidenceThreshold) {
            this.logger.debug(
                `Evidence found but confidence too low: ${bestMatch.confidence}% < ${config.minConfidenceThreshold}%`,
            );
            return {
                shouldSpeak: false,
                confidence: bestMatch.confidence,
                silenceReason: `Confidence ${bestMatch.confidence}% below threshold ${config.minConfidenceThreshold}%`,
            };
        }

        // 쿨다운 확인 (같은 방에서 같은 Evidence 반복 방지)
        if (this.isOnCooldown(roomId, bestMatch.evidence.id)) {
            return {
                shouldSpeak: false,
                confidence: bestMatch.confidence,
                silenceReason: 'Same evidence recently shared in this room',
            };
        }

        // 응답 생성
        const response = this.generateOpinionResponse(bestMatch, currentSpeaker);

        // 쿨다운 등록
        this.registerOpinion(roomId, bestMatch.evidence.id);

        this.logger.log(
            `Opinion triggered: ${bestMatch.evidence.topic} (confidence: ${bestMatch.confidence}%)`,
        );

        return {
            shouldSpeak: true,
            response,
            evidence: bestMatch.evidence,
            confidence: bestMatch.confidence,
        };
    }

    /**
     * 의견 응답 텍스트 생성
     * 제안형/조언형 포맷으로 자연스럽게 의견 제시
     */
    private generateOpinionResponse(
        match: EvidenceMatchResult,
        speaker?: string,
    ): string {
        const evidence = match.evidence;

        // 다양한 시작 문구 (자연스러운 제안형)
        const openers = [
            `현재 논의 중인 ${evidence.topic}에 대해서 말씀드리자면,`,
            `지금 말씀하신 내용과 관련해서,`,
            `참고로 말씀드리면,`,
        ];
        const opener = openers[Math.floor(Math.random() * openers.length)];

        let response = opener + ' ';

        // 출처 유형에 따른 표현 (제안형으로)
        switch (evidence.sourceType) {
            case 'large_survey':
                if (evidence.participantCount) {
                    const formattedCount = this.formatParticipantCount(evidence.participantCount);
                    response += `${formattedCount} 이상이 참여한 ${evidence.sourceName}에 따르면 `;
                } else {
                    response += `${evidence.sourceName} 통계를 보면 `;
                }
                break;

            case 'official_announcement':
                response += `${evidence.sourceName}에서 발표한 내용을 보면 `;
                break;

            case 'standard_organization':
                response += `${evidence.sourceName} 권장사항을 참고하시면 `;
                break;

            case 'academic_paper':
                response += `${evidence.sourceName} 연구 결과를 보면 `;
                break;

            case 'statistics_agency':
                response += `${evidence.sourceName} 통계에 따르면, `;
                break;

            default:
                response += `${evidence.sourceName}에 따르면 `;
        }

        // 사실 내용 추가
        response += evidence.fact + '.';

        // 제안형 마무리 (카테고리에 따라 다양하게)
        const closers = this.getClosingPhrase(evidence.category);
        response += ' ' + closers;

        return response;
    }

    /**
     * 카테고리별 마무리 문구 생성
     */
    private getClosingPhrase(category: string): string {
        const closingPhrases: Record<string, string[]> = {
            security: [
                '보안 관점에서 고려해보시는 건 어떨까요?',
                '이 방식도 검토해보시면 좋을 것 같습니다.',
            ],
            architecture: [
                '아키텍처 설계 시 참고하시면 좋을 것 같아요.',
                '이런 접근 방식도 고려해보시는 건 어떨까요?',
            ],
            development: [
                '개발하실 때 참고하시면 도움이 될 것 같습니다.',
                '비슷한 사례에서 많이 사용하는 방식이에요.',
            ],
            database: [
                'DB 선택하실 때 참고해보시면 좋겠습니다.',
                '최근 트렌드를 보면 이런 선택이 많더라고요.',
            ],
            infrastructure: [
                '인프라 구성 시 고려해보시면 좋을 것 같아요.',
                '운영 환경에서 검증된 방식이라 참고하시면 좋겠습니다.',
            ],
            testing: [
                '테스트 전략 수립 시 참고해보세요.',
                '품질 관리 측면에서 도움이 될 것 같습니다.',
            ],
            default: [
                '참고하시면 도움이 될 것 같습니다.',
                '이런 방식도 고려해보시는 건 어떨까요?',
            ],
        };

        const phrases = closingPhrases[category] || closingPhrases.default;
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    /**
     * 참여자 수 포맷팅
     */
    private formatParticipantCount(count: number): string {
        if (count >= 100000) {
            return `${Math.floor(count / 10000)}만 명`;
        } else if (count >= 10000) {
            return `${Math.floor(count / 1000).toLocaleString()}천 명`;
        } else {
            return `${count.toLocaleString()}명`;
        }
    }

    /**
     * 쿨다운 확인
     */
    private isOnCooldown(roomId: string, evidenceId: string): boolean {
        const key = `${roomId}:${evidenceId}`;
        const recent = this.recentOpinions.get(key);

        if (!recent) return false;

        const elapsed = Date.now() - recent.timestamp;
        return elapsed < this.OPINION_COOLDOWN_MS;
    }

    /**
     * 의견 제시 기록
     */
    private registerOpinion(roomId: string, evidenceId: string): void {
        const key = `${roomId}:${evidenceId}`;
        this.recentOpinions.set(key, {
            evidenceId,
            timestamp: Date.now(),
        });

        // 오래된 기록 정리
        this.cleanupOldRecords();
    }

    /**
     * 오래된 의견 기록 정리
     */
    private cleanupOldRecords(): void {
        const now = Date.now();
        const expiredKeys: string[] = [];

        for (const [key, record] of this.recentOpinions.entries()) {
            if (now - record.timestamp > this.OPINION_COOLDOWN_MS * 2) {
                expiredKeys.push(key);
            }
        }

        for (const key of expiredKeys) {
            this.recentOpinions.delete(key);
        }
    }

    /**
     * 특정 방의 의견 기록 초기화
     */
    clearRoomHistory(roomId: string): void {
        const keysToDelete: string[] = [];

        for (const key of this.recentOpinions.keys()) {
            if (key.startsWith(`${roomId}:`)) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            this.recentOpinions.delete(key);
        }

        this.logger.debug(`Cleared opinion history for room: ${roomId}`);
    }

    /**
     * Evidence 데이터를 DataChannel 전송용 형식으로 변환
     */
    formatForDataChannel(evidence: VerifiedEvidence): {
        type: string;
        topic: string;
        fact: string;
        source: string;
        sourceUrl: string;
        verifiedDate: string;
    } {
        return {
            type: 'AI_OPINION',
            topic: evidence.topic,
            fact: evidence.fact,
            source: evidence.sourceName,
            sourceUrl: evidence.sourceUrl,
            verifiedDate: evidence.verifiedDate,
        };
    }

    /**
     * 기능 활성화/비활성화
     */
    setEnabled(enabled: boolean): void {
        this.evidenceRepository.setConfig({ enabled });
        this.logger.log(`Opinion feature ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * 현재 활성화 상태 확인
     */
    isEnabled(): boolean {
        return this.evidenceRepository.getConfig().enabled;
    }

    /**
     * 신뢰도 임계값 설정
     */
    setConfidenceThreshold(threshold: number): void {
        if (threshold < 0 || threshold > 100) {
            throw new Error('Confidence threshold must be between 0 and 100');
        }
        this.evidenceRepository.setConfig({ minConfidenceThreshold: threshold });
        this.logger.log(`Confidence threshold set to ${threshold}%`);
    }
}
