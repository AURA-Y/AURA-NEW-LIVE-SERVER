import { Injectable, Logger } from '@nestjs/common';
import {
    CognitiveState,
    EntropyLevel,
    ParticipantCell,
    PerplexityAction,
    PerplexitySession,
    PropagationResult,
    WFCConstraint,
} from './perplexity.types';

// ============================================================
// WFC Engine Service
// Wave Function Collapse 기반 흐름 제어 엔진
// ============================================================

@Injectable()
export class WFCEngineService {
    private readonly logger = new Logger(WFCEngineService.name);

    // 기본 Constraints (규칙)
    private readonly DEFAULT_CONSTRAINTS: WFCConstraint[] = [
        {
            id: 'confusion_intervention',
            name: '혼란 감지 개입',
            description: '참여자의 40% 이상이 혼란 상태일 때 AI 개입',
            condition: (session) => {
                const participants = Array.from(session.participants.values());
                if (participants.length === 0) return false;
                const confusedCount = participants.filter(
                    p => p.observedState === 'confused'
                ).length;
                return confusedCount / participants.length >= 0.4;
            },
            action: {
                type: 'AI_INTERVENTION',
                reason: '많은 분들이 어려워하시는 것 같습니다. 제가 설명해드릴까요?',
                targetParticipants: [],
            },
            priority: 100,
            cooldownMs: 60000, // 1분 쿨다운
        },
        {
            id: 'single_confusion_assist',
            name: '개인 혼란 지원',
            description: '한 참여자가 연속 3회 혼란 상태일 때 개인 지원',
            condition: (session) => {
                const participants = Array.from(session.participants.values());
                return participants.some(p => p.confusionCount >= 3);
            },
            action: {
                type: 'AI_INTERVENTION',
                reason: '혹시 이해가 안 되는 부분이 있으신가요?',
                targetParticipants: [],
            },
            priority: 80,
            cooldownMs: 45000,
        },
        {
            id: 'peer_teaching_opportunity',
            name: 'Peer Teaching 기회',
            description: '한 명이 이해하고 다른 이들이 혼란일 때 Peer Teaching 제안',
            condition: (session) => {
                const participants = Array.from(session.participants.values());
                if (participants.length < 2) return false;

                const understood = participants.filter(
                    p => p.observedState === 'understood' || p.observedState === 'contributing'
                );
                const confused = participants.filter(
                    p => p.observedState === 'confused'
                );

                return understood.length >= 1 && confused.length >= 1;
            },
            action: {
                type: 'PEER_TEACHING',
                teacher: '',
                learners: [],
                topic: '',
            },
            priority: 70,
            cooldownMs: 120000, // 2분 쿨다운
        },
        {
            id: 'high_entropy_summary',
            name: '고엔트로피 요약',
            description: '세션 엔트로피가 높을 때 요약 요청',
            condition: (session) => {
                return session.entropyLevel === 'high' && session.sessionEntropy > 0.7;
            },
            action: {
                type: 'SUMMARY_REQUEST',
                topics: [],
                reason: '다양한 의견이 오가고 있네요. 지금까지 내용을 정리해볼까요?',
            },
            priority: 60,
            cooldownMs: 180000, // 3분 쿨다운
        },
        {
            id: 'disengagement_boost',
            name: '이탈 참여자 독려',
            description: '참여자가 이탈 상태일 때 참여 유도',
            condition: (session) => {
                const participants = Array.from(session.participants.values());
                return participants.some(
                    p => p.observedState === 'disengaged' && Date.now() - p.lastUpdate > 30000
                );
            },
            action: {
                type: 'ENGAGEMENT_BOOST',
                targetParticipants: [],
                suggestion: '님은 어떻게 생각하세요?',
            },
            priority: 50,
            cooldownMs: 90000,
        },
        {
            id: 'all_understood_advance',
            name: '전원 이해 시 진행',
            description: '모든 참여자가 이해했을 때 다음 토픽으로 전환',
            condition: (session) => {
                const participants = Array.from(session.participants.values());
                if (participants.length === 0) return false;

                const understoodCount = participants.filter(
                    p => p.observedState === 'understood'
                ).length;

                return understoodCount === participants.length;
            },
            action: {
                type: 'FOLLOW_UP_QUESTION',
                question: '모두 이해하신 것 같네요! 더 깊이 들어가볼까요?',
                context: 'topic_mastered',
            },
            priority: 40,
            cooldownMs: 60000,
        },
    ];

    // ============================================================
    // 엔트로피 계산
    // ============================================================

    /**
     * 단일 셀의 엔트로피 계산
     * entropy = (가능한 상태 수) / (전체 상태 수)
     */
    calculateCellEntropy(cell: ParticipantCell): number {
        const totalStates = 6; // CognitiveState 종류
        return cell.possibleStates.length / totalStates;
    }

    /**
     * 세션 전체 엔트로피 계산
     */
    calculateSessionEntropy(session: PerplexitySession): number {
        const participants = Array.from(session.participants.values());
        if (participants.length === 0) return 0;

        let totalEntropy = 0;
        participants.forEach(p => {
            totalEntropy += p.entropy;
        });

        return totalEntropy / participants.length;
    }

    /**
     * 엔트로피 레벨 결정
     */
    getEntropyLevel(entropy: number): EntropyLevel {
        if (entropy < 0.33) return 'low';
        if (entropy < 0.66) return 'medium';
        return 'high';
    }

    // ============================================================
    // 상태 Collapse
    // ============================================================

    /**
     * 관찰 결과를 바탕으로 상태 Collapse
     */
    collapseState(
        cell: ParticipantCell,
        observedState: CognitiveState,
        confidence: number
    ): ParticipantCell {
        const updatedCell = { ...cell };

        // 높은 신뢰도면 즉시 collapse
        if (confidence >= 0.7) {
            updatedCell.observedState = observedState;
            updatedCell.possibleStates = [observedState];
            updatedCell.entropy = 0;
        }
        // 중간 신뢰도면 가능성 축소
        else if (confidence >= 0.5) {
            updatedCell.possibleStates = updatedCell.possibleStates.filter(
                s => s === observedState || this.isCompatibleState(s, observedState)
            );
            if (updatedCell.possibleStates.length === 1) {
                updatedCell.observedState = updatedCell.possibleStates[0];
                updatedCell.entropy = 0;
            } else {
                updatedCell.entropy = updatedCell.possibleStates.length / 6;
            }
        }
        // 낮은 신뢰도면 힌트로만 사용
        else {
            if (!updatedCell.possibleStates.includes(observedState)) {
                updatedCell.possibleStates.push(observedState);
            }
            updatedCell.entropy = updatedCell.possibleStates.length / 6;
        }

        // 혼란 카운트 업데이트
        if (observedState === 'confused') {
            updatedCell.confusionCount++;
        } else if (observedState === 'understood' || observedState === 'contributing') {
            updatedCell.confusionCount = Math.max(0, updatedCell.confusionCount - 1);
        }

        updatedCell.confidence = confidence;
        updatedCell.lastUpdate = Date.now();

        return updatedCell;
    }

    /**
     * 상태 호환성 체크 (인접 가능한 상태)
     */
    private isCompatibleState(state1: CognitiveState, state2: CognitiveState): boolean {
        const compatibilityMap: Record<CognitiveState, CognitiveState[]> = {
            confused: ['thinking', 'absorbing'],
            absorbing: ['thinking', 'confused', 'understood'],
            thinking: ['confused', 'absorbing', 'contributing', 'understood'],
            contributing: ['thinking', 'understood'],
            understood: ['absorbing', 'contributing'],
            disengaged: ['confused', 'absorbing'],
        };

        return compatibilityMap[state1]?.includes(state2) ?? false;
    }

    // ============================================================
    // Constraint Propagation
    // ============================================================

    /**
     * 모든 Constraint 평가 및 전파
     */
    propagate(session: PerplexitySession): PropagationResult {
        const result: PropagationResult = {
            triggeredConstraints: [],
            actions: [],
            entropyChange: 0,
            affectedParticipants: [],
        };

        const now = Date.now();
        const initialEntropy = session.sessionEntropy;

        // 우선순위 순으로 정렬
        const sortedConstraints = [...this.DEFAULT_CONSTRAINTS].sort(
            (a, b) => b.priority - a.priority
        );

        for (const constraint of sortedConstraints) {
            // 쿨다운 체크
            if (constraint.lastTriggered && now - constraint.lastTriggered < constraint.cooldownMs) {
                continue;
            }

            // 조건 평가
            if (constraint.condition(session)) {
                this.logger.log(`[WFC] Constraint triggered: ${constraint.name}`);

                // 액션 생성 (동적 파라미터 채우기)
                const action = this.buildAction(constraint, session);

                result.triggeredConstraints.push(constraint.id);
                result.actions.push(action);
                result.affectedParticipants.push(
                    ...this.getAffectedParticipants(action, session)
                );

                // 쿨다운 설정
                constraint.lastTriggered = now;

                // 첫 번째 매칭 constraint만 실행 (한 번에 하나씩)
                break;
            }
        }

        // 엔트로피 변화 계산
        const newEntropy = this.calculateSessionEntropy(session);
        result.entropyChange = newEntropy - initialEntropy;

        return result;
    }

    /**
     * Constraint에 맞는 액션 생성 (동적 파라미터 채우기)
     */
    private buildAction(
        constraint: WFCConstraint,
        session: PerplexitySession
    ): PerplexityAction {
        const participants = Array.from(session.participants.values());
        const baseAction = { ...constraint.action };

        switch (baseAction.type) {
            case 'AI_INTERVENTION': {
                const confused = participants.filter(p => p.observedState === 'confused');
                return {
                    ...baseAction,
                    targetParticipants: confused.map(p => p.participantId),
                };
            }

            case 'PEER_TEACHING': {
                const teacher = participants.find(
                    p => p.observedState === 'understood' || p.observedState === 'contributing'
                );
                const learners = participants.filter(p => p.observedState === 'confused');

                return {
                    ...baseAction,
                    teacher: teacher?.participantName || '',
                    learners: learners.map(p => p.participantName),
                    topic: session.currentTopic || '현재 주제',
                };
            }

            case 'ENGAGEMENT_BOOST': {
                const disengaged = participants.filter(p => p.observedState === 'disengaged');
                return {
                    ...baseAction,
                    targetParticipants: disengaged.map(p => p.participantId),
                    suggestion: `${disengaged[0]?.participantName}${baseAction.suggestion}`,
                };
            }

            case 'SUMMARY_REQUEST': {
                const topics = Array.from(session.topics.values())
                    .filter(t => t.state === 'discussing' || t.state === 'clarifying')
                    .map(t => t.topicName);

                return {
                    ...baseAction,
                    topics: topics.length > 0 ? topics : ['현재 논의 내용'],
                };
            }

            default:
                return baseAction as PerplexityAction;
        }
    }

    /**
     * 액션의 영향을 받는 참여자 목록
     */
    private getAffectedParticipants(
        action: PerplexityAction,
        session: PerplexitySession
    ): string[] {
        switch (action.type) {
            case 'AI_INTERVENTION':
            case 'ENGAGEMENT_BOOST':
                return action.targetParticipants;

            case 'PEER_TEACHING':
                return [action.teacher, ...action.learners];

            case 'FOLLOW_UP_QUESTION':
                return action.targetParticipants || Array.from(session.participants.keys());

            default:
                return Array.from(session.participants.keys());
        }
    }

    // ============================================================
    // 유틸리티
    // ============================================================

    /**
     * 새 참여자 셀 생성
     */
    createParticipantCell(participantId: string, participantName: string): ParticipantCell {
        return {
            participantId,
            participantName,
            possibleStates: ['absorbing', 'thinking', 'confused', 'contributing', 'understood', 'disengaged'],
            observedState: null,
            entropy: 1,
            confidence: 0,
            lastUpdate: Date.now(),
            speakingRatio: 0,
            questionCount: 0,
            confusionCount: 0,
            textInferredAt: 0,
        };
    }

    /**
     * 세션 엔트로피 업데이트
     */
    updateSessionEntropy(session: PerplexitySession): void {
        session.sessionEntropy = this.calculateSessionEntropy(session);
        session.entropyLevel = this.getEntropyLevel(session.sessionEntropy);
    }
}
