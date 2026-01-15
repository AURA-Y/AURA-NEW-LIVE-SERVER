import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    ConverseCommand,
    ContentBlock,
    ToolUseBlock,
    ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { RAG_CLIENT, IRagClient, RagQuestionResponse } from '../rag/rag-client.interface';
import { SearchService, SearchResult } from '../llm/search.service';

/**
 * 회의 내용 출처 (팩트체크용)
 */
export interface MeetingSource {
    text: string;
    speaker: string | null;
}

/**
 * Agent 도구 정의
 */
const AGENT_TOOLS = [
    {
        toolSpec: {
            name: 'search_web',
            description: '실시간 정보가 필요할 때 사용 (뉴스, 날씨, 주식, 스포츠, 백과사전 등). 웹에서 최신 정보를 검색합니다.',
            inputSchema: {
                json: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '검색할 키워드나 질문',
                        },
                    },
                    required: ['query'],
                },
            },
        },
    },
    {
        toolSpec: {
            name: 'search_local',
            description: '주변 장소 검색에 사용 (맛집, 카페, 술집, 편의시설 등). 특정 지역의 장소를 검색합니다.',
            inputSchema: {
                json: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '검색할 장소 유형 (예: 맛집, 카페, 치킨집)',
                        },
                        location: {
                            type: 'string',
                            description: '지역명 (예: 판교, 강남, 홍대). 없으면 null',
                        },
                    },
                    required: ['query'],
                },
            },
        },
    },
    {
        toolSpec: {
            name: 'query_meeting',
            description: `현재 회의/대화 내용을 확인할 때 사용. 다음 상황에서 반드시 사용:
- 이전 대화 참조: "방금", "아까", "전에", "이전에" 언급된 내용
- 과거 발언 확인: "뭐라고 했지?", "물어본 거", "대답한 거"
- 팩트 체크: "맞아?", "그랬어?", "진짜?"
- 대명사 참조: "그거", "그게 뭐야" (대화 맥락 참조)
예: "방금 물어본 거", "아까 그거", "전에 뭐라고 했더라"`,
            inputSchema: {
                json: {
                    type: 'object',
                    properties: {
                        question: {
                            type: 'string',
                            description: '이전 대화/회의 내용에 대한 질문',
                        },
                    },
                    required: ['question'],
                },
            },
        },
    },
    {
        toolSpec: {
            name: 'direct_response',
            description: '검색 없이 직접 답변할 수 있을 때 사용. 일반 대화, 인사, 간단한 질문, 의견 제시 등.',
            inputSchema: {
                json: {
                    type: 'object',
                    properties: {
                        response_type: {
                            type: 'string',
                            enum: ['chat', 'recommendation', 'opinion', 'explanation', 'greeting'],
                            description: '응답 유형',
                        },
                    },
                    required: ['response_type'],
                },
            },
        },
    },
    {
        toolSpec: {
            name: 'ask_clarification',
            description: '사용자 의도가 불명확하거나 여러 해석이 가능할 때 사용. 틀린 답변을 하는 것보다 되물어보는 것이 낫다.',
            inputSchema: {
                json: {
                    type: 'object',
                    properties: {
                        ambiguity_reason: {
                            type: 'string',
                            description: '의도가 불명확한 이유',
                        },
                        possible_interpretations: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '가능한 해석들 (최대 3개)',
                        },
                    },
                    required: ['ambiguity_reason'],
                },
            },
        },
    },
];

/**
 * 대화 턴 인터페이스
 */
export interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    speaker?: string;
}

/**
 * Agent 판단 결과
 */
export interface AgentDecision {
    tool: 'search_web' | 'search_local' | 'query_meeting' | 'direct_response' | 'ask_clarification';
    params: Record<string, any>;
    reasoning?: string;
}

/**
 * Agent 라우터 서비스
 * LLM Function Calling을 사용하여 사용자 요청의 의도를 파악하고 적절한 행동을 결정
 */
@Injectable()
export class AgentRouterService {
    private readonly logger = new Logger(AgentRouterService.name);
    private bedrockClient: BedrockRuntimeClient;
    private readonly modelId = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

    constructor(
        private configService: ConfigService,
        @Inject(RAG_CLIENT) private ragClient: IRagClient,
        private searchService: SearchService,
    ) {
        this.bedrockClient = new BedrockRuntimeClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
    }

    /**
     * 대화 맥락을 기반으로 어떤 도구를 사용할지 결정
     */
    async decide(
        userMessage: string,
        conversationHistory: ConversationTurn[],
        meetingContext?: { title?: string; participants?: string[] }
    ): Promise<AgentDecision> {
        const startTime = Date.now();

        // ============================================================
        // 1단계: 패턴 매칭 선처리 (LLM 호출 없이 빠르게 라우팅)
        // ============================================================
        const patternMatch = this.matchPatternForTool(userMessage);
        if (patternMatch) {
            this.logger.log(`[AgentRouter] 패턴 매칭: "${userMessage}" → ${patternMatch.tool}`);
            return patternMatch;
        }

        // ============================================================
        // 2단계: LLM Function Calling으로 도구 선택
        // ============================================================
        try {
            // 대화 히스토리를 컨텍스트로 변환
            const historyContext = this.buildHistoryContext(conversationHistory);
            const meetingInfo = meetingContext?.title
                ? `\n[회의 정보] 제목: ${meetingContext.title}`
                : '';

            const systemPrompt = `[역할]
너는 화상회의에 참여 중인 AI 비서 "아우라"입니다.
- 회의 참여자들의 대화를 듣고 적절히 참여합니다
- 대화 기록을 잘 기억하고, 이전 맥락을 참고해서 답변합니다
- 반드시 존댓말(~입니다, ~습니다, ~세요)만 사용
- 이모티콘/이모지 절대 사용 금지

${historyContext}${meetingInfo}

[도구 선택 기준 - 우선순위대로 적용]
1. **이전 대화/회의 내용 참조** → query_meeting (최우선)
   - "방금", "아까", "전에", "이전에" + 질문/요청
   - "물어본 거", "대답한 거", "말한 거", "했던 거"
   - "뭐라고 했지?", "뭐였지?", "뭐더라?"
   - "그거", "그게" (대화 맥락에서 이전 내용 참조)
   예시: "방금 물어본 거 알려줘", "아까 그거 뭐였지?", "전에 뭐라고 했더라"

2. 실시간 정보 필요 (뉴스, 날씨, 주식 등) → search_web
3. 장소 검색 (맛집, 카페 등) → search_local
4. 일반 대화, 인사, 간단한 질문 → direct_response
5. 의도가 불명확하거나 여러 해석이 가능한 경우 → ask_clarification

[중요]
- 대화 기록을 반드시 확인하고 맥락에 맞게 응답해
- "방금", "아까", "전에" 같은 시간 참조 + 질문은 거의 항상 query_meeting이다!
- 이모티콘/이모지 절대 금지
- 반드시 하나의 도구만 선택해.`;

            const messages = [
                {
                    role: 'user' as const,
                    content: [{ text: userMessage }],
                },
            ];

            const command = new ConverseCommand({
                modelId: this.modelId,
                system: [{ text: systemPrompt }],
                messages,
                toolConfig: {
                    tools: AGENT_TOOLS,
                    toolChoice: { any: {} },  // 반드시 도구 선택 강제
                },
            });

            const response = await this.bedrockClient.send(command);
            const elapsed = Date.now() - startTime;

            // Tool Use 응답 파싱
            const content = response.output?.message?.content || [];
            const toolUse = content.find(
                (block): block is ContentBlock.ToolUseMember => 'toolUse' in block
            );

            if (toolUse && toolUse.toolUse) {
                const tool = toolUse.toolUse;
                this.logger.log(`[AgentRouter] ${elapsed}ms - Tool: ${tool.name}, Params: ${JSON.stringify(tool.input)}`);

                return {
                    tool: tool.name as AgentDecision['tool'],
                    params: tool.input as Record<string, any>,
                };
            }

            // Tool Use가 없으면 기본값 (direct_response)
            this.logger.warn(`[AgentRouter] ${elapsed}ms - No tool selected, defaulting to direct_response`);
            return {
                tool: 'direct_response',
                params: { response_type: 'chat' },
            };

        } catch (error) {
            this.logger.error(`[AgentRouter] Error: ${error.message}`);
            // 에러 시 기본값
            return {
                tool: 'direct_response',
                params: { response_type: 'chat' },
            };
        }
    }

    /**
     * 결정된 도구 실행
     */
    async executeTool(
        decision: AgentDecision,
        roomId: string,
        userMessage: string,
    ): Promise<{ result: string; searchResults?: SearchResult[]; meetingSources?: MeetingSource[] }> {
        const startTime = Date.now();

        try {
            switch (decision.tool) {
                case 'search_web':
                    return await this.executeWebSearch(decision.params.query);

                case 'search_local':
                    return await this.executeLocalSearch(
                        decision.params.query,
                        decision.params.location
                    );

                case 'query_meeting':
                    return await this.executeMeetingQuery(
                        decision.params.question,
                        roomId
                    );

                case 'ask_clarification':
                    // ask_clarification은 되묻는 응답 생성
                    return this.generateClarificationResponse(decision.params);

                case 'direct_response':
                default:
                    // direct_response는 도구 실행 없이 LLM이 직접 응답
                    return { result: '' };
            }
        } catch (error) {
            this.logger.error(`[ToolExecutor] ${decision.tool} failed: ${error.message}`);
            return { result: `도구 실행 중 오류가 발생했습니다: ${error.message}` };
        } finally {
            this.logger.log(`[ToolExecutor] ${decision.tool} - ${Date.now() - startTime}ms`);
        }
    }

    /**
     * 되물어보기 응답 생성
     */
    private generateClarificationResponse(params: Record<string, any>): { result: string } {
        const interpretations = params.possible_interpretations || [];

        // 자연스러운 되묻기 문구
        const clarificationPhrases = [
            '음, 조금 더 구체적으로 말씀해주시겠어요?',
            '어떤 걸 말씀하시는 건지 잘 모르겠어요.',
            '혹시 무엇에 대해 물어보시는 건가요?',
            '조금 더 자세히 설명해주시면 좋겠어요.',
        ];

        let response = clarificationPhrases[Math.floor(Math.random() * clarificationPhrases.length)];

        // 가능한 해석들이 있으면 선택지 제시
        if (interpretations.length >= 2) {
            response = '혹시 ';
            if (interpretations.length === 2) {
                response += `${interpretations[0]}에 대해 물어보시는 건가요, 아니면 ${interpretations[1]}인가요?`;
            } else {
                response += `${interpretations.slice(0, -1).join(', ')} 중에 어떤 건가요? 아니면 ${interpretations[interpretations.length - 1]}인가요?`;
            }
        }

        this.logger.log(`[Clarification] 되묻기 응답 생성: ${response}`);
        return { result: response };
    }

    /**
     * 도구 결과를 바탕으로 최종 응답 생성
     */
    async generateResponse(
        userMessage: string,
        decision: AgentDecision,
        toolResult: { result: string; searchResults?: SearchResult[]; meetingSources?: MeetingSource[] },
        conversationHistory: ConversationTurn[],
    ): Promise<string> {
        // ask_clarification은 이미 생성된 응답을 그대로 반환
        if (decision.tool === 'ask_clarification') {
            return toolResult.result;
        }

        // direct_response이거나 도구 결과가 없으면 직접 응답 생성
        if (decision.tool === 'direct_response' || !toolResult.result) {
            return await this.generateDirectResponse(userMessage, conversationHistory);
        }

        // 회의 내용 조회 (팩트체크) - sources가 있으면 인용 포맷
        if (decision.tool === 'query_meeting' && toolResult.meetingSources?.length) {
            return this.generateFactCheckResponse(
                userMessage,
                toolResult.result,
                toolResult.meetingSources,
                conversationHistory
            );
        }

        // 일반 도구 결과를 포함한 응답 생성
        const historyContext = this.buildHistoryContext(conversationHistory);

        const prompt = `[대화 맥락]
${historyContext}

[사용자 질문]
${userMessage}

[검색/조회 결과]
${toolResult.result}

위 정보를 바탕으로 간결하게 답변하세요.
- 반드시 존댓말(~입니다, ~습니다, ~세요)만 사용
- 2-3문장으로 핵심만
- 이모티콘/이모지 절대 사용 금지`;

        return await this.callLlmPure(prompt);
    }

    /**
     * 팩트체크 응답 생성 (출처 인용 포함)
     * 예: "전에 하신 발언을 보니 ~~ 주제에 대해서 ~~~~라고 발언하신 기록이 있습니다."
     */
    private async generateFactCheckResponse(
        userMessage: string,
        ragAnswer: string,
        sources: MeetingSource[],
        conversationHistory: ConversationTurn[]
    ): Promise<string> {
        // 출처 정보 포맷팅
        const sourcesText = sources
            .filter(s => s.text && s.text.length > 0)
            .slice(0, 3) // 상위 3개만
            .map((s, i) => {
                const speaker = s.speaker || '참여자';
                return `${i + 1}. ${speaker}: "${s.text}"`;
            })
            .join('\n');

        const historyContext = this.buildHistoryContext(conversationHistory);

        const prompt = `[대화 맥락]
${historyContext}

[사용자 질문]
${userMessage}

[RAG 답변]
${ragAnswer}

[관련 발언 기록]
${sourcesText}

위 정보를 바탕으로 팩트체크 응답을 생성해줘.

응답 형식:
- "전에 하신 발언을 보니" 또는 "과거 회의 기록을 보니" 로 시작
- 누가 무엇을 말했는지 인용 ("~~라고 발언하신 기록이 있습니다")
- 반드시 존댓말(~입니다, ~습니다, ~세요)만 사용
- 2-3문장으로 핵심만
- 이모티콘/이모지 절대 사용 금지

예시:
"전에 하신 발언을 보니, 김팀장님께서 토큰 유효시간은 4시간으로 하자고 제안하신 기록이 있습니다."`;

        return await this.callLlmPure(prompt);
    }

    // ============================================================
    // Private Methods
    // ============================================================

    private buildHistoryContext(history: ConversationTurn[]): string {
        if (!history || history.length === 0) {
            return '[대화 기록 없음]';
        }

        // 전체 대화 히스토리 포함 (최대 30턴)
        const lines = history.map(turn => {
            const speaker = turn.role === 'user' ? (turn.speaker || '사용자') : '아우라';
            return `${speaker}: ${turn.content}`;
        });

        return `[대화 기록 (${history.length}턴)]\n${lines.join('\n')}`;
    }

    private async executeWebSearch(query: string): Promise<{ result: string; searchResults?: SearchResult[] }> {
        try {
            const results = await this.searchService.search(query, 'web');

            if (!results || results.length === 0) {
                return { result: '검색 결과가 없습니다.' };
            }

            // 상위 3개 결과 요약
            const summary = results.slice(0, 3).map((r, i) =>
                `${i + 1}. ${r.title}: ${r.content?.substring(0, 100) || ''}`
            ).join('\n');

            return { result: summary, searchResults: results };
        } catch (error) {
            this.logger.error(`[WebSearch] Failed: ${error.message}`);
            return { result: '검색 중 오류가 발생했습니다.' };
        }
    }

    private async executeLocalSearch(
        query: string,
        location?: string
    ): Promise<{ result: string; searchResults?: SearchResult[] }> {
        try {
            const searchQuery = location ? `${location} ${query}` : query;
            const results = await this.searchService.search(searchQuery, 'local');

            if (!results || results.length === 0) {
                return { result: '주변 장소를 찾을 수 없습니다.' };
            }

            // 상위 3개 장소 요약
            const summary = results.slice(0, 3).map((r, i) =>
                `${i + 1}. ${r.title}${r.address ? ` (${r.address})` : ''}`
            ).join('\n');

            return { result: summary, searchResults: results };
        } catch (error) {
            this.logger.error(`[LocalSearch] Failed: ${error.message}`);
            return { result: '장소 검색 중 오류가 발생했습니다.' };
        }
    }

    private async executeMeetingQuery(
        question: string,
        roomId: string
    ): Promise<{ result: string; meetingSources?: MeetingSource[] }> {
        try {
            // RAG 연결 확인 및 시도
            if (!this.ragClient.isConnected(roomId)) {
                try {
                    await this.ragClient.connect(roomId);
                } catch (err) {
                    this.logger.warn(`[RAG] Connection failed: ${roomId}`);
                }
            }

            if (!this.ragClient.isConnected(roomId)) {
                return { result: '회의 기록에 접근할 수 없습니다.' };
            }

            // sources 포함된 응답 요청 (팩트체크용)
            const response = await this.ragClient.sendQuestionWithSources(roomId, question);

            this.logger.log(`[MeetingQuery] 답변: "${response.answer.substring(0, 50)}...", 출처: ${response.sources.length}개`);

            return {
                result: response.answer,
                meetingSources: response.sources,
            };
        } catch (error) {
            this.logger.error(`[MeetingQuery] Failed: ${error.message}`);
            return { result: '회의 내용 조회 중 오류가 발생했습니다.' };
        }
    }

    private async generateDirectResponse(
        userMessage: string,
        conversationHistory: ConversationTurn[]
    ): Promise<string> {
        const historyContext = this.buildHistoryContext(conversationHistory);

        const prompt = `[대화 맥락]
${historyContext}

[사용자]
${userMessage}

화상회의 AI 비서 "아우라"로서 답변하세요.
- 대화 기록을 참고해서 맥락에 맞게 응답
- 반드시 존댓말(~입니다, ~습니다, ~세요)만 사용
- 1-2문장으로 간결하게
- 이모티콘/이모지 절대 사용 금지`;

        return await this.callLlmPure(prompt);
    }

    private async callLlmPure(prompt: string): Promise<string> {
        try {
            const command = new ConverseCommand({
                modelId: this.modelId,
                messages: [
                    {
                        role: 'user',
                        content: [{ text: prompt }],
                    },
                ],
                inferenceConfig: {
                    maxTokens: 300,
                    temperature: 0.7,
                },
            });

            const response = await this.bedrockClient.send(command);
            const content = response.output?.message?.content || [];
            const textBlock = content.find(
                (block): block is ContentBlock.TextMember => 'text' in block
            );

            return textBlock?.text || '응답을 생성할 수 없습니다.';
        } catch (error) {
            this.logger.error(`[LLM] Pure call failed: ${error.message}`);
            return '죄송합니다, 응답을 생성하지 못했어요.';
        }
    }

    // ============================================================
    // 패턴 매칭 선처리 (LLM 호출 없이 빠르게 라우팅)
    // ============================================================

    /**
     * 확실한 패턴은 LLM 없이 바로 도구 선택
     * @returns AgentDecision if pattern matched, null otherwise
     */
    private matchPatternForTool(text: string): AgentDecision | null {
        // ---------------------------------------------------------
        // query_meeting 패턴: 이전 대화/회의 내용 참조
        // ---------------------------------------------------------
        const queryMeetingPatterns = [
            // 시간 참조 + 대화 동작
            // "방금 물어본 거", "아까 말한 거", "전에 대답한 거"
            /(방금|아까|전에|이전에|저번에|좀\s*전에).{0,10}(물어|질문|말한|말씀|대답|답변|얘기|이야기|설명)/,

            // 시간 참조 + "거/것" (했던 거, 한 거)
            // "방금 한 거", "아까 했던 거"
            /(방금|아까|전에|이전에|저번에).{0,10}(했던|한)\s*(거|것|게)/,

            // "뭐라고 했" 패턴
            // "뭐라고 했지?", "뭐라고 했어?", "뭐라 했더라"
            /뭐라고?\s*(했|한|하셨)/,

            // "뭐였/뭐더라" 패턴
            // "그거 뭐였지?", "뭐였더라?"
            /뭐(였|더라|였더라|야|예요|에요)/,

            // 시간 참조 + "그거/그게"
            // "아까 그거", "방금 그게 뭐야"
            /(방금|아까|전에|이전에).{0,5}(그거|그게|그것)/,

            // 다시/한번 더 + 말해/알려
            // "다시 말해줘", "한번 더 알려줘"
            /(다시|한번\s*더|다시\s*한번).{0,5}(말해|알려|설명해)/,

            // 직접적인 참조
            // "아까 그 얘기", "전에 그 내용"
            /(아까|방금|전에).{0,5}(그\s*)(얘기|이야기|내용|질문|대화)/,
        ];

        for (const pattern of queryMeetingPatterns) {
            if (pattern.test(text)) {
                return {
                    tool: 'query_meeting',
                    params: { question: text },
                };
            }
        }

        // ---------------------------------------------------------
        // 추가 패턴들 (필요시 확장)
        // ---------------------------------------------------------

        // 장소 검색 패턴 (지역명 + 장소 유형)
        // "판교 맛집", "강남 카페" 등은 기존 intent-classifier가 처리하므로 여기선 스킵

        return null;
    }
}
