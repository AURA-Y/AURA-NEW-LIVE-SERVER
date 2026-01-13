import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';

// ============================================================
// Types
// ============================================================

export interface StudyQuiz {
    id: string;
    question: string;
    options: string[];
    correctIndex: number;
    explanation: string;
    points: number;
    topic: string;
}

export interface StudyParticipant {
    participantId: string;
    participantName: string;
    score: number;
    correctAnswers: number;
    totalAnswers: number;
    streak: number;
    lastAnswerCorrect: boolean;
}

export interface StudyContext {
    isActive: boolean;
    startTime: number;
    duration: number; // 초 단위
    topic: string;
    participants: Map<string, StudyParticipant>;
    currentQuiz: StudyQuiz | null;
    quizHistory: StudyQuiz[];
    conversationKeywords: string[];
    lastQuizTime: number;
    quizCount: number;
    followUpPending: boolean;
    followUpQuestion: string | null;
}

export interface FollowUpResult {
    shouldAsk: boolean;
    question: string;
    context: string;
}

// ============================================================
// Service
// ============================================================

@Injectable()
export class StudyModeService {
    private readonly logger = new Logger(StudyModeService.name);
    private studyContexts: Map<string, StudyContext> = new Map();

    // 퀴즈 생성 간격 (최소 60초)
    private readonly MIN_QUIZ_INTERVAL_MS = 60000;
    // 최대 퀴즈 수
    private readonly MAX_QUIZZES_PER_SESSION = 10;

    constructor(private llmService: LlmService) {}

    // ============================================================
    // Study Mode Management
    // ============================================================

    /**
     * 스터디 모드 시작
     */
    startStudyMode(roomId: string, topic: string, durationSeconds: number = 300): StudyContext {
        const context: StudyContext = {
            isActive: true,
            startTime: Date.now(),
            duration: durationSeconds,
            topic,
            participants: new Map(),
            currentQuiz: null,
            quizHistory: [],
            conversationKeywords: [],
            lastQuizTime: 0,
            quizCount: 0,
            followUpPending: false,
            followUpQuestion: null,
        };

        this.studyContexts.set(roomId, context);
        this.logger.log(`[Study Mode] Started for room ${roomId}, topic: ${topic}, duration: ${durationSeconds}s`);
        return context;
    }

    /**
     * 스터디 모드 종료
     */
    endStudyMode(roomId: string): StudyContext | null {
        const context = this.studyContexts.get(roomId);
        if (!context) return null;

        context.isActive = false;
        this.logger.log(`[Study Mode] Ended for room ${roomId}`);
        return context;
    }

    /**
     * 스터디 모드 상태 확인
     */
    getStudyContext(roomId: string): StudyContext | null {
        return this.studyContexts.get(roomId) || null;
    }

    /**
     * 참여자 추가/업데이트
     */
    addParticipant(roomId: string, participantId: string, name: string): void {
        const context = this.studyContexts.get(roomId);
        if (!context) return;

        if (!context.participants.has(participantId)) {
            context.participants.set(participantId, {
                participantId,
                participantName: name,
                score: 0,
                correctAnswers: 0,
                totalAnswers: 0,
                streak: 0,
                lastAnswerCorrect: false,
            });
        }
    }

    // ============================================================
    // Quiz Generation
    // ============================================================

    /**
     * 대화 내용 기반 퀴즈 생성
     */
    async generateQuizFromConversation(
        roomId: string,
        recentTranscripts: string[],
    ): Promise<StudyQuiz | null> {
        const context = this.studyContexts.get(roomId);
        if (!context || !context.isActive) return null;

        // 퀴즈 생성 간격 체크
        if (Date.now() - context.lastQuizTime < this.MIN_QUIZ_INTERVAL_MS) {
            return null;
        }

        // 최대 퀴즈 수 체크
        if (context.quizCount >= this.MAX_QUIZZES_PER_SESSION) {
            return null;
        }

        const prompt = `당신은 스터디 퀴즈 출제자입니다. 다음 대화 내용을 바탕으로 4지선다 퀴즈를 1개 만들어주세요.

주제: ${context.topic}

최근 대화:
${recentTranscripts.slice(-10).join('\n')}

다음 JSON 형식으로만 응답하세요:
{
  "question": "문제 내용",
  "options": ["선택지1", "선택지2", "선택지3", "선택지4"],
  "correctIndex": 0,
  "explanation": "정답 해설 (1-2문장)",
  "topic": "관련 키워드"
}

규칙:
- 방금 대화에서 언급된 내용 기반
- 정답이 명확해야 함
- 오답도 그럴듯해야 함
- 난이도는 중간`;

        try {
            const response = await this.llmService.sendMessagePure(prompt, 500);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const quizData = JSON.parse(jsonMatch[0]);
            const quiz: StudyQuiz = {
                id: `quiz-${Date.now()}`,
                question: quizData.question,
                options: quizData.options,
                correctIndex: quizData.correctIndex,
                explanation: quizData.explanation,
                points: 100,
                topic: quizData.topic || context.topic,
            };

            context.currentQuiz = quiz;
            context.lastQuizTime = Date.now();
            context.quizCount++;
            context.quizHistory.push(quiz);

            this.logger.log(`[Study Quiz] Generated: ${quiz.question.substring(0, 50)}...`);
            return quiz;

        } catch (error) {
            this.logger.error(`[Study Quiz] Generation failed: ${error.message}`);
            return null;
        }
    }

    /**
     * 돌발 퀴즈 생성 (특정 키워드 기반)
     */
    async generateSurpriseQuiz(
        roomId: string,
        keyword: string,
    ): Promise<StudyQuiz | null> {
        const context = this.studyContexts.get(roomId);
        if (!context || !context.isActive) return null;

        const prompt = `당신은 스터디 퀴즈 출제자입니다. "${keyword}" 개념에 대한 4지선다 퀴즈를 만들어주세요.

주제: ${context.topic}
키워드: ${keyword}

다음 JSON 형식으로만 응답하세요:
{
  "question": "문제 내용 (${keyword} 관련)",
  "options": ["선택지1", "선택지2", "선택지3", "선택지4"],
  "correctIndex": 0,
  "explanation": "정답 해설 (1-2문장)",
  "topic": "${keyword}"
}

규칙:
- ${keyword}의 핵심 개념을 묻는 문제
- 정답이 명확해야 함
- 오답도 그럴듯해야 함`;

        try {
            const response = await this.llmService.sendMessagePure(prompt, 500);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const quizData = JSON.parse(jsonMatch[0]);
            const quiz: StudyQuiz = {
                id: `quiz-${Date.now()}`,
                question: quizData.question,
                options: quizData.options,
                correctIndex: quizData.correctIndex,
                explanation: quizData.explanation,
                points: 100,
                topic: keyword,
            };

            context.currentQuiz = quiz;
            context.lastQuizTime = Date.now();
            context.quizCount++;
            context.quizHistory.push(quiz);

            this.logger.log(`[Study Quiz] Surprise quiz: ${quiz.question.substring(0, 50)}...`);
            return quiz;

        } catch (error) {
            this.logger.error(`[Study Quiz] Surprise quiz failed: ${error.message}`);
            return null;
        }
    }

    // ============================================================
    // Answer Processing
    // ============================================================

    /**
     * 답변 처리
     */
    processAnswer(
        roomId: string,
        participantId: string,
        answerIndex: number,
    ): { isCorrect: boolean; points: number; explanation: string } | null {
        const context = this.studyContexts.get(roomId);
        if (!context || !context.currentQuiz) return null;

        const participant = context.participants.get(participantId);
        if (!participant) return null;

        const quiz = context.currentQuiz;
        const isCorrect = answerIndex === quiz.correctIndex;
        const points = isCorrect ? quiz.points : 0;

        // 참여자 점수 업데이트
        participant.totalAnswers++;
        if (isCorrect) {
            participant.correctAnswers++;
            participant.score += points;
            participant.streak++;
            participant.lastAnswerCorrect = true;

            // 연속 정답 보너스
            if (participant.streak >= 3) {
                const bonusPoints = 50 * (participant.streak - 2);
                participant.score += bonusPoints;
                this.logger.log(`[Study] ${participant.participantName} streak bonus: +${bonusPoints}`);
            }
        } else {
            participant.streak = 0;
            participant.lastAnswerCorrect = false;
        }

        this.logger.log(`[Study Answer] ${participant.participantName}: ${isCorrect ? 'Correct' : 'Wrong'}, score: ${participant.score}`);

        return {
            isCorrect,
            points: isCorrect ? points + (participant.streak >= 3 ? 50 * (participant.streak - 2) : 0) : 0,
            explanation: quiz.explanation,
        };
    }

    // ============================================================
    // Follow-up Questions (꼬리 질문)
    // ============================================================

    /**
     * 꼬리 질문 생성
     */
    async generateFollowUpQuestion(
        roomId: string,
        previousQuestion: string,
        userAnswer: string,
        wasCorrect: boolean,
    ): Promise<FollowUpResult> {
        const context = this.studyContexts.get(roomId);
        if (!context || !context.isActive) {
            return { shouldAsk: false, question: '', context: '' };
        }

        const prompt = `당신은 스터디 진행자입니다. 방금 질문에 대한 후속 질문을 만들어주세요.

이전 질문: ${previousQuestion}
사용자 답변: ${userAnswer}
정답 여부: ${wasCorrect ? '맞음' : '틀림'}
주제: ${context.topic}

${wasCorrect
    ? '사용자가 정답을 맞췄습니다. 더 심화된 후속 질문을 해주세요.'
    : '사용자가 틀렸습니다. 관련된 기본 개념을 확인하는 질문을 해주세요.'
}

다음 JSON 형식으로 응답하세요:
{
  "shouldAsk": true/false,
  "question": "후속 질문 (1문장)",
  "context": "질문 의도 설명"
}

규칙:
- 자연스럽게 대화를 이어가는 질문
- 너무 어렵거나 쉽지 않게
- 학습에 도움이 되는 질문`;

        try {
            const response = await this.llmService.sendMessagePure(prompt, 300);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { shouldAsk: false, question: '', context: '' };
            }

            const result = JSON.parse(jsonMatch[0]);

            if (result.shouldAsk) {
                context.followUpPending = true;
                context.followUpQuestion = result.question;
            }

            return result;

        } catch (error) {
            this.logger.error(`[Follow-up] Generation failed: ${error.message}`);
            return { shouldAsk: false, question: '', context: '' };
        }
    }

    /**
     * 사용자 답변 평가 (꼬리 질문에 대한)
     */
    async evaluateFollowUpAnswer(
        roomId: string,
        question: string,
        userAnswer: string,
    ): Promise<{ isCorrect: boolean; feedback: string; points: number }> {
        const context = this.studyContexts.get(roomId);
        if (!context) {
            return { isCorrect: false, feedback: '', points: 0 };
        }

        const prompt = `사용자의 답변을 평가해주세요.

질문: ${question}
사용자 답변: ${userAnswer}
주제: ${context.topic}

다음 JSON 형식으로 응답하세요:
{
  "isCorrect": true/false,
  "feedback": "평가 피드백 (1-2문장, 자연스러운 말투)",
  "points": 0-50
}

평가 기준:
- 완벽하면 50점
- 대체로 맞으면 30점
- 부분적으로 맞으면 10점
- 틀리면 0점`;

        try {
            const response = await this.llmService.sendMessagePure(prompt, 200);
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { isCorrect: false, feedback: '답변을 평가할 수 없습니다.', points: 0 };
            }

            const result = JSON.parse(jsonMatch[0]);

            // 점수 반영
            if (result.points > 0) {
                const participants = Array.from(context.participants.values());
                if (participants.length > 0) {
                    // 마지막으로 발화한 참여자에게 점수 부여
                    const lastParticipant = participants[participants.length - 1];
                    lastParticipant.score += result.points;
                }
            }

            context.followUpPending = false;
            context.followUpQuestion = null;

            return result;

        } catch (error) {
            this.logger.error(`[Follow-up Eval] Failed: ${error.message}`);
            return { isCorrect: false, feedback: '평가 중 오류가 발생했습니다.', points: 0 };
        }
    }

    // ============================================================
    // Proactive Intervention (기습 개입)
    // ============================================================

    /**
     * 키워드 감지 (어려운 용어 등)
     */
    detectDifficultKeyword(transcript: string, topic: string): string | null {
        // 어려움을 나타내는 표현들
        const difficultyMarkers = [
            '어렵', '복잡', '헷갈', '모르겠', '이해가 안', '뭐지', '뭐야',
            '설명해', '알려줘', '가르쳐', '정확히', '차이가', '왜'
        ];

        const hasDifficulty = difficultyMarkers.some(marker => transcript.includes(marker));
        if (!hasDifficulty) return null;

        // 전문 용어 추출 (영어 단어 또는 한글 전문용어)
        const technicalTerms = transcript.match(/[A-Z][a-zA-Z]+|[가-힣]{2,}(?:알고리즘|모델|패턴|구조|메모리|프로세스|스레드|함수|클래스|인터페이스|프로토콜)/g);

        if (technicalTerms && technicalTerms.length > 0) {
            return technicalTerms[0];
        }

        return null;
    }

    /**
     * AI 개입 여부 결정
     */
    shouldIntervene(roomId: string, transcript: string): { shouldIntervene: boolean; keyword: string | null; reason: string } {
        const context = this.studyContexts.get(roomId);
        if (!context || !context.isActive) {
            return { shouldIntervene: false, keyword: null, reason: '' };
        }

        const keyword = this.detectDifficultKeyword(transcript, context.topic);

        if (keyword) {
            return {
                shouldIntervene: true,
                keyword,
                reason: `"${keyword}"에 대해 어려워하시는 것 같습니다. 설명해드릴까요?`
            };
        }

        return { shouldIntervene: false, keyword: null, reason: '' };
    }

    // ============================================================
    // Report Generation
    // ============================================================

    /**
     * 스터디 리포트 생성
     */
    generateReport(roomId: string): {
        title: string;
        duration: string;
        participants: StudyParticipant[];
        quizzes: StudyQuiz[];
        summary: string;
    } | null {
        const context = this.studyContexts.get(roomId);
        if (!context) return null;

        const durationMs = Date.now() - context.startTime;
        const durationMin = Math.floor(durationMs / 60000);
        const durationSec = Math.floor((durationMs % 60000) / 1000);

        const participants = Array.from(context.participants.values())
            .sort((a, b) => b.score - a.score);

        return {
            title: context.topic,
            duration: `${durationMin}분 ${durationSec}초`,
            participants,
            quizzes: context.quizHistory,
            summary: this.generateSummaryText(context, participants),
        };
    }

    private generateSummaryText(context: StudyContext, participants: StudyParticipant[]): string {
        const winner = participants[0];
        const totalQuizzes = context.quizHistory.length;
        const avgCorrect = participants.length > 0
            ? participants.reduce((sum, p) => sum + (p.totalAnswers > 0 ? p.correctAnswers / p.totalAnswers : 0), 0) / participants.length
            : 0;

        return `${context.topic} 스터디 완료. 총 ${totalQuizzes}문제 출제, 평균 정답률 ${Math.round(avgCorrect * 100)}%. ${winner ? `우승: ${winner.participantName} (${winner.score}점)` : ''}`;
    }

    // ============================================================
    // Cleanup
    // ============================================================

    /**
     * 스터디 컨텍스트 정리
     */
    cleanup(roomId: string): void {
        this.studyContexts.delete(roomId);
        this.logger.log(`[Study Mode] Cleaned up for room ${roomId}`);
    }
}
