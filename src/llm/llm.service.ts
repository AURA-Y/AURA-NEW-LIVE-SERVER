import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { RAG_CLIENT, IRagClient } from '../rag/rag-client.interface';
import { SearchService, SearchResult, SearchType } from './search.service';
import { MapService } from './map.service';

@Injectable()
export class LlmService {
    private readonly logger = new Logger(LlmService.name);
    private bedrockClient: BedrockRuntimeClient;
    private readonly modelId = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
    private readonly restApiUrl: string;
    private readonly topicCache = new Map<string, string>();

    private lastRequestTime = 0;
    private isProcessing = false;
    private readonly MIN_REQUEST_INTERVAL = 1500;
    private readonly MAX_RETRIES = 3;

    // sendMessagePure용 rate limiting (다이어그램 생성 등)
    private lastPureRequestTime = 0;
    private pureRequestQueue: Promise<any> = Promise.resolve();
    private readonly PURE_MIN_INTERVAL = 300; // 0.3초로 단축 (병렬 처리 허용)
    private readonly PURE_MAX_RETRIES = 2;

    constructor(
        private configService: ConfigService,
        @Inject(RAG_CLIENT) private ragClient: IRagClient,
        private searchService: SearchService,
        private mapService: MapService,
    ) {
        this.restApiUrl =
            (this.configService.get<string>('REST_API_URL') ||
                this.configService.get<string>('BACKEND_API_URL') ||
                'http://localhost:3002').replace(/\/+$/, '');

        this.bedrockClient = new BedrockRuntimeClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
    }

    // ============================================================
    // Public API
    // ============================================================

    async sendMessage(
        userMessage: string,
        searchDomain?: 'weather' | 'naver' | null,
        roomId?: string
    ): Promise<{ text: string; searchResults?: SearchResult[] }> {
        // 회의록 관련 질문이고 roomId가 있으면 RAG 서버에 질문
        const meetingKeywords = [
            '회의', '미팅', '액션', '액션아이템', '할 일', '할일', 'todo', 'action',
            '결정', '논의', '안건', '발언', '누가', '언제', '요약', '정리',
        ];
        const isMeetingQuery = meetingKeywords.some(kw => userMessage.toLowerCase().includes(kw));
        
        if (isMeetingQuery && roomId) {
            const resolvedRoomId = await this.getRoomIdByTopic(roomId);
    
            try {
                // RAG 연결이 없으면 시도해서 붙여본다
                if (!this.ragClient.isConnected(resolvedRoomId)) {
                    try {
                        await this.ragClient.connect(resolvedRoomId);
                    } catch (err) {
                        this.logger.warn(`[RAG] 연결 시도 실패: ${resolvedRoomId} (${(err as Error).message})`);
                    }
                }

                if (!this.ragClient.isConnected(resolvedRoomId)) {
                    this.logger.warn(`[RAG] 연결되지 않음: ${resolvedRoomId}`);
                    return { text: '회의록 기능을 사용할 수 없습니다.' };
                }
                this.logger.log(`[RAG 질문] Room: ${resolvedRoomId}, 질문: "${userMessage}"`);
                const ragAnswer = await this.ragClient.sendQuestion(resolvedRoomId, userMessage);
                return { text: ragAnswer };
            } catch (error) {
                this.logger.error(`[RAG 에러] ${error.message}`);
                return { text: '회의록을 조회하는 중 오류가 발생했습니다.' };
            }
        }

        // 동시 요청 방지
        while (this.isProcessing) {
            await this.sleep(100);
        }

        // 쿨다운 체크
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
            await this.sleep(this.MIN_REQUEST_INTERVAL - timeSinceLastRequest);
        }

        this.isProcessing = true;
        this.lastRequestTime = Date.now();

        try {
            const messages = [{ role: "user", content: userMessage }];
            return await this.processWithTools(messages, 0, undefined, searchDomain, true);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * 순수 LLM 호출 (검색 없이)
     */
    async sendMessagePure(prompt: string, maxTokens = 500): Promise<string> {
        // 최소 간격만 유지하고 병렬 요청 허용 (다이어그램 생성 속도 개선)
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastPureRequestTime;
        if (timeSinceLastRequest < this.PURE_MIN_INTERVAL) {
            await this.sleep(this.PURE_MIN_INTERVAL - timeSinceLastRequest);
        }
        this.lastPureRequestTime = Date.now();

        return await this.sendMessagePureWithRetry(prompt, maxTokens, 0);
    }

    /**
     * sendMessagePure 내부 재시도 로직
     */
    private async sendMessagePureWithRetry(prompt: string, maxTokens: number, retryCount: number): Promise<string> {
        try {
            const payload = {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: maxTokens,
                messages: [{ role: "user", content: prompt }],
            };

            const command = new InvokeModelCommand({
                modelId: this.modelId,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(payload),
            });

            const response = await this.bedrockClient.send(command);
            const body = JSON.parse(new TextDecoder().decode(response.body));
            const text = body.content?.[0]?.text || '';

            return text.trim();
        } catch (error) {
            const isThrottled = error.name === 'ThrottlingException' ||
                error.message?.includes('Too many requests');

            if (isThrottled && retryCount < this.PURE_MAX_RETRIES) {
                const backoffTime = Math.pow(2, retryCount + 1) * 1000; // 2초, 4초
                this.logger.warn(`[LLM Pure 재시도] ${backoffTime}ms 후 재시도 (${retryCount + 1}/${this.PURE_MAX_RETRIES})`);
                await this.sleep(backoffTime);
                return this.sendMessagePureWithRetry(prompt, maxTokens, retryCount + 1);
            }

            this.logger.error(`[LLM Pure 호출 에러] ${error.message}`);
            throw error;
        }
    }

    /**
     * 컨텍스트 기반 응답 생성
     * 플로우차트 등 현재 화면 상태에 대해 질문에 답변
     */
    async answerWithContext(
        question: string,
        contextStr: string,
        mode: string = '컨텍스트'
    ): Promise<string> {
        const prompt = `당신은 회의 지원 AI 아우라입니다. 현재 ${mode} 화면에 대해 사용자의 질문에 답변해주세요.

${contextStr}

사용자 질문: "${question}"

응답 가이드:
- 현재 화면에 보이는 내용을 기반으로 답변하세요
- 화면에 없는 정보는 추측하지 마세요
- 음성으로 읽기 좋게 자연스럽게 작성하세요`;

        try {
            const response = await this.sendMessagePure(prompt, 300);
            return response || `${mode}에 대해 말씀해주세요.`;
        } catch (error) {
            this.logger.error(`[answerWithContext] 에러: ${error.message}`);
            return `죄송합니다. ${mode} 분석 중 오류가 발생했습니다.`;
        }
    }

    /**
     * 검색 계획 수립 (SearchService 위임)
     */
    async buildSearchPlan(rawQuery: string) {
        return this.searchService.buildSearchPlan(rawQuery);
    }

    /**
     * 경로 정보 조회 (MapService 위임)
     */
    async getRouteInfo(result: SearchResult) {
        return this.mapService.getRouteInfo(result);
    }

    /**
     * 정적 지도 이미지 (MapService 위임)
     */
    async getStaticMapImage(params: {
        origin: { lng: string; lat: string };
        destination: { lng: string; lat: string };
        width: number;
        height: number;
        path?: { lng: string; lat: string }[];
        distanceMeters?: number;
    }) {
        return this.mapService.getStaticMapImage(params);
    }

    // ============================================================
    // Core Processing
    // ============================================================

    /**
     * topic → roomId 조회 (1) 캐시 확인 (2) REST API 호출
     */
    private async getRoomIdByTopic(topicOrId: string): Promise<string> {
        if (!topicOrId) return topicOrId;
        // 이미 id처럼 보이면 그대로 사용
        const hasDash = topicOrId.includes('-');
        if (topicOrId.length >= 30 && hasDash) return topicOrId;

        // 캐시
        const cached = this.topicCache.get(topicOrId);
        if (cached) return cached;

        if (!this.restApiUrl) return topicOrId;

        try {
            const resp = await fetch(
                `${this.restApiUrl}/restapi/rooms/topic/${encodeURIComponent(topicOrId)}`,
                { method: 'GET' }
            );
            if (!resp.ok) {
                this.logger.warn(`[RAG] topic→roomId 조회 실패: ${topicOrId} (${resp.status})`);
                return topicOrId;
            }
            const data = await resp.json();
            if (data?.roomId) {
                this.logger.log(`[RAG] topic "${topicOrId}" → roomId ${data.roomId}`);
                this.topicCache.set(topicOrId, data.roomId);
                return data.roomId;
            }
        } catch (err) {
            this.logger.warn(`[RAG] topic→roomId 조회 에러: ${(err as Error).message}`);
        }
        return topicOrId;
    }

    private async processWithTools(
        messages: any[],
        retryCount: number,
        searchResults?: SearchResult[],
        searchDomain?: 'weather' | 'naver' | null,
        forceSearch = false
    ): Promise<{ text: string; searchResults?: SearchResult[] }> {

        // 검색 실행
        if (forceSearch && !searchResults) {
            const latestUser = [...messages].reverse().find(m => m.role === 'user');
            const rawQuery = typeof latestUser?.content === 'string' ? latestUser.content : '';
            const trimmedQuery = rawQuery.trim();

            if (trimmedQuery.length > 5) {
                const { query, searchType } = await this.searchService.buildSearchPlan(trimmedQuery);
                
                if (searchType === 'none') {
                    this.logger.log(`[검색 스킵] LLM 직접 응답으로 진행`);
                    // 검색 없이 LLM이 자체 지식으로 응답
                    searchResults = [];
                } else {
                    this.logger.log(`[검색] type=${searchType}, query="${query}"`);
                    searchResults = await this.searchService.search(query, searchType);

                    // 검색했는데 결과가 없으면 → LLM 자체 지식으로 답변
                    if (!searchResults || searchResults.length === 0) {
                        this.logger.log(`[검색 결과 없음] LLM 자체 지식으로 답변 시도`);
                        searchResults = [];
                    }
                }
            }
        }

        // 프롬프트 생성
        const latestUser = [...messages].reverse().find(m => m.role === 'user');
        const userMessage = typeof latestUser?.content === 'string' ? latestUser.content : '';
        const systemPrompt = this.buildSystemPrompt(userMessage, searchResults || []);

        const messagesWithSearch = searchResults && searchResults.length > 0
            ? [...messages, {
                role: "user",
                content: `[검색 결과]\n${searchResults.map(r => `- ${r.title}: ${r.content}`).join('\n')}`
            }]
            : messages;

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 400,
            system: systemPrompt,
            messages: messagesWithSearch,
        };

        const command = new InvokeModelCommand({
            modelId: this.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
        });

        try {
            const response = await this.bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const textBlock = responseBody.content?.find((b: any) => b.type === 'text');
            let finalMessage = textBlock?.text || "죄송합니다, 응답을 생성할 수 없습니다.";

            // 검색 결과가 있는 경우 응답 형식 결정
            if (searchResults && searchResults.length > 0) {
                const hasLocation = searchResults.some(r => r.address || r.roadAddress);
                
                if (hasLocation) {
                    const placeResult = searchResults.find(r => r.address || r.roadAddress);
                    if (placeResult) {
                        finalMessage = this.buildPlaceRecommendation(placeResult);
                    }
                } else {
                    finalMessage = this.validateAndBuildNewsResponse(finalMessage, searchResults);
                }
            }

            this.logger.log(`[LLM 응답] ${finalMessage.substring(0, 80)}...`);
            return { text: finalMessage, searchResults };

        } catch (error) {
            const isThrottled = error.name === 'ThrottlingException' ||
                error.message?.includes('Too many requests');

            if (isThrottled && retryCount < this.MAX_RETRIES) {
                const backoffTime = Math.pow(2, retryCount + 1) * 2000;
                this.logger.warn(`[LLM 재시도] ${backoffTime}ms`);
                await this.sleep(backoffTime);
                return this.processWithTools(messages, retryCount + 1, searchResults, searchDomain);
            }

            this.logger.error(`[LLM 에러] ${error.message}`);
            throw error;
        }
    }

    // ============================================================
    // System Prompt Builder
    // ============================================================

    private buildSystemPrompt(userMessage: string, searchResults: SearchResult[]): string {
        const lowerMessage = userMessage.toLowerCase();
        
        // 카테고리 매칭
        const categoryKeywords: Record<string, string[]> = {
            '날씨': ['날씨', '기온', '온도', '비', '눈', '바람'],
            '카페': ['카페', '커피'],
            '맛집': ['맛집', '식당', '레스토랑', '밥집', '저녁', '점심'],
            '술집': ['술집', '바', '포차', '호프'],
            '팝업': ['팝업', '팝업스토어'],
            '전시': ['전시', '전시회', '갤러리'],
            '영화': ['영화', '개봉', '영화관'],
            '뉴스': ['뉴스', '소식', '기사'],
            '주식': ['주식', '주가', '코스피'],
            '스포츠': ['스포츠', '축구', '야구'],
            '백과': ['정의', '의미', '개념', '효능'],
        };

        let matchedCategory: string | null = null;
        for (const [category, keywords] of Object.entries(categoryKeywords)) {
            if (keywords.some(kw => lowerMessage.includes(kw))) {
                matchedCategory = category;
                break;
            }
        }

        const location = this.searchService.extractLocation(userMessage) || '서울';
        const hasLocation = searchResults.some(r => r.address || r.roadAddress);

        switch (matchedCategory) {
            case '날씨': {
                const timeWord = userMessage.includes('내일') ? '내일' :
                    userMessage.includes('모레') ? '모레' :
                    userMessage.includes('이번주') ? '이번주' : '오늘';
                return `당신은 회의 AI 비서 '아우라'입니다. 자연스럽게 말해요.

"${location}" "${timeWord}" 날씨 물어봤어요.

## 중요! 정보는 반드시 포함
- 기온(숫자), 날씨 상태, 강수 확률 등 **구체적인 수치는 꼭 말하기**
- 기호 금지: ° → "도", % → "퍼센트"

## 말투
- 존댓말로 간결하게 (1~2문장)
- 반드시 존댓말(~입니다, ~습니다) 사용

## 좋은 예시
- "${location} ${timeWord} 맑고 15도예요, 좀 쌀쌀하니까 겉옷 챙기세요~"
- "${timeWord} ${location}은 흐리고 8도래요, 비 올 확률 60퍼센트예요"

## 나쁜 예시 (정보 누락 ❌)
- "좀 추워요" ← 몇 도인지 없음!
- "비 올 것 같아요" ← 확률 없음!

## 검색 결과
${searchResults.map(r => r.content || r.title).join('\n').slice(0, 500)}`;
            }

            case '카페':
            case '맛집':
            case '술집':
            case '분식':
            case '치킨':
            case '피자':
            case '빵집':
            case '디저트':
            case '쇼핑': {
                if (!hasLocation || searchResults.length === 0) {
                    return this.buildNoResultPrompt(matchedCategory, location);
                }
                return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

"${location}" 근처 ${matchedCategory} 추천해달래요.

## 중요! 정보는 반드시 포함
- **가게 이름** 정확히
- **주소** (도로명 또는 지번)
- 마지막에 "경로 보내드리겠습니다" 추가

## 말투
- 존댓말로 간결하게 (1~2문장)
- 반드시 존댓말(~입니다, ~습니다) 사용

## 좋은 예시
- "거기면 스타벅스 강남점 추천드립니다. 테헤란로 152에 있어요. 경로 보내드리겠습니다"
- "블루보틀 성수점 추천해요, 서울숲로 14길이에요. 경로 보내드리겠습니다"

## 나쁜 예시 (정보 누락 ❌)
- "거기 괜찮아요" ← 이름 없음!
- "스타벅스 추천해요" ← 어느 지점? 주소는?

## 검색 결과 (첫 번째만 사용)
${JSON.stringify(searchResults[0])}`;
            }

            case '팝업':
            case '전시': {
                return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

"${location}" 근처 ${matchedCategory} 정보 물어봤어요.

## 말투
- 존댓말로 간결하게 (2~3문장)
- 반드시 존댓말(~입니다, ~습니다) 사용
${hasLocation ? '- 마지막에 "경로 보내드리겠습니다" 추가' : ''}

## 예시
- "[이름] ${matchedCategory} 하고 있어요! [장소]에서요. 경로 보내드리겠습니다"
- "[이름] ${matchedCategory} 괜찮대요, [기간]까지래요"

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            case '영화': {
                const movieNews = searchResults.filter(r => !r.address && !r.roadAddress);
                const movieTheaters = searchResults.filter(r => r.address || r.roadAddress);
                const hasTheater = movieTheaters.length > 0;

                return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

영화 관련 정보 물어봤어요.

## 말투
- 존댓말로 간결하게 (2~3문장)
- 영화 제목만 언급 (줄거리 ❌)
${hasTheater ? '- 영화관 있으면 "근처 영화관도 알려줄게요~" 추가' : ''}

## 예시
- "요즘 [영화] 재밌대요! 근처 영화관도 알려줄게요~"
- "[영화] 개봉했어요, [영화관]에서 하고 있어요"

## 검색 결과 - 영화 뉴스
${JSON.stringify(movieNews.slice(0, 2), null, 2)}

## 검색 결과 - 근처 영화관
${JSON.stringify(movieTheaters.slice(0, 1), null, 2)}`;
            }

            case '뉴스':
            case '주식':
            case '스포츠': {
                return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

${matchedCategory} 정보 물어봤어요.

## 중요! 정보는 반드시 포함
- **구체적인 수치/이름/날짜** 등 핵심 정보 꼭 포함
- 추상적으로 요약하지 말고 실제 데이터 전달

## 말투
- 존댓말로 간결하게 (2~3문장)
- 반드시 존댓말(~입니다, ~습니다) 사용

## 좋은 예시
- "삼성전자 오늘 2.3퍼센트 올라서 7만 2천원이래요"
- "토트넘이 맨시티 2대1로 이겼대요, 손흥민이 1골 넣었어요"

## 나쁜 예시 (정보 누락 ❌)
- "주가가 올랐대요" ← 얼마나?
- "경기 이겼대요" ← 스코어는?

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            case '백과': {
                return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

뭔가에 대해 물어봤어요.

## 중요! 정보는 반드시 포함
- **핵심 정의/설명** 정확히 전달
- 어려운 용어는 쉽게 풀어서, 하지만 내용은 생략하지 않기

## 말투
- 존댓말로 간결하게 (2~3문장)
- 반드시 존댓말(~입니다, ~습니다) 사용

## 좋은 예시
- "타이레놀은 아세트아미노펜 성분 진통제예요, 두통이나 열 날 때 먹어요"
- "GDP는 국내총생산이에요, 나라에서 1년간 만든 물건이랑 서비스 총합이요"

## 나쁜 예시 (정보 누락 ❌)
- "진통제예요" ← 성분은? 용도는?
- "경제 용어예요" ← 뭔지 설명 안 함

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            default: {
                if (searchResults.length === 0) {
                    return `당신은 회의 AI 비서 '아우라'입니다. 말해요.

## 말투
- 존댓말로 간결하게 (1~2문장)
- 존댓말로 간결하게 답변

## 예시
- "네? 뭐 찾아볼까요?"
- "어 뭐 궁금한 거 있어요?"`;
                }

                if (hasLocation) {
                    return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

## 말투  
- 존댓말로 간결하게 (1~2문장)
- 마지막에 "경로 보내드리겠습니다" 추가

## 검색 결과
${JSON.stringify(searchResults[0])}`;
                }

                return `당신은 회의 AI 비서 '아우라'입니다. 존댓말로 답변하세요.

## 말투
- 존댓말로 간결하게 (1~2문장)

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2))}`;
            }
        }
    }

    private buildNoResultPrompt(category: string, location: string): string {
        return `당신은 회의 AI 비서 '아우라'입니다. 말해요.

"${location}" 근처 ${category} 찾아봤는데 결과가 없어요.

## 말투
- 존댓말로 간결하게 (1~2문장)

## 예시
- "음 거기는 ${category} 검색이 잘 안 되네요, 다른 데 찾아볼까요?"
- "아 ${location} ${category}은 안 나오네요... 다른 지역은요?"`;
    }

    // ============================================================
    // Response Builders
    // ============================================================

    private buildPlaceRecommendation(result: SearchResult): string {
        const title = result.title || '그 장소';
        const address = result.roadAddress || result.address || '';
        const newsHighlight = (result as any).newsHighlight;

        let response = `${title} 추천드립니다.`;
        if (newsHighlight) {
            response += ` ${newsHighlight}까지래요.`;
        }
        if (address) {
            response += ` ${address} 쪽이에요.`;
        }
        response += ' 경로 보내드리겠습니다';

        return response.replace(/\s+/g, ' ').trim();
    }

    private validateAndBuildNewsResponse(llmResponse: string, results: SearchResult[]): string {
        const placePatterns = [
            /을?\s*추천해요\.?/g,
            /해당\s*지점까지\s*경로를\s*채팅창으로\s*공유드릴게요\.?/g,
            /경로를\s*공유드릴게요\.?/g,
            /위치까지\s*경로를.*?공유.*?\.?/g,
        ];

        let cleaned = llmResponse;
        for (const pattern of placePatterns) {
            cleaned = cleaned.replace(pattern, '');
        }
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        if (!cleaned || cleaned.length < 10) {
            if (results.length > 0) {
                const firstResult = results[0];
                return `${firstResult.title}에 대한 소식이에요. ${firstResult.content.slice(0, 80)}`;
            }
            return '관련 정보를 찾았어요. 검색 결과를 확인해주세요.';
        }

        return cleaned;
    }

    // ============================================================
    // Voice Intent Processing
    // ============================================================

    async processVoiceIntent(
        rawTranscript: string,
        intentAnalysis: {
            isCallIntent: boolean;
            confidence: number;
            normalizedText: string;
            category?: string | null;
            extractedKeyword?: string | null;
            searchType?: SearchType | null;
            needsLlmCorrection: boolean;
        },
    ): Promise<{
        shouldRespond: boolean;
        correctedText: string;
        searchKeyword: string | null;
        searchType: SearchType | null;
        category: string | null;
    }> {
        if (intentAnalysis.isCallIntent && intentAnalysis.confidence >= 0.6) {
            if (!intentAnalysis.extractedKeyword) {
                const { query, searchType, category } = await this.searchService.buildSearchPlan(intentAnalysis.normalizedText);
                
                if (searchType === 'none') {
                    return {
                        shouldRespond: true,
                        correctedText: intentAnalysis.normalizedText,
                        searchKeyword: null,
                        searchType: null,
                        category: null,
                    };
                }
                
                return {
                    shouldRespond: true,
                    correctedText: intentAnalysis.normalizedText,
                    searchKeyword: query,
                    searchType: searchType,
                    category: category || null,
                };
            }
            return {
                shouldRespond: true,
                correctedText: intentAnalysis.normalizedText,
                searchKeyword: intentAnalysis.extractedKeyword,
                searchType: intentAnalysis.searchType || 'web',
                category: intentAnalysis.category || null,
            };
        }

        if (intentAnalysis.needsLlmCorrection) {
            return this.correctAndExtract(rawTranscript);
        }

        return {
            shouldRespond: false,
            correctedText: intentAnalysis.normalizedText,
            searchKeyword: null,
            searchType: null,
            category: null,
        };
    }

    private async correctAndExtract(rawTranscript: string): Promise<{
        shouldRespond: boolean;
        correctedText: string;
        searchKeyword: string | null;
        searchType: SearchType | null;
        category: string | null;
    }> {
        const prompt = `화상회의 음성인식 결과를 분석하세요.

## 웨이크워드
표준: 아우라야, 헤이아우라, 헤이 아우라
변형: 아울라야, 아우나야, 오우라야, 아오라야 등

## 카테고리
카페, 맛집, 술집, 분식, 치킨, 피자, 빵집, 디저트, 쇼핑, 팝업, 전시, 날씨, 뉴스, 주식, 스포츠, 영화

## 검색타입
- local: 장소/맛집/카페/가게
- news: 뉴스/날씨/정보/주식

## 입력
"${rawTranscript}"

## 출력 (JSON만)
{"hasWakeWord":true/false,"correctedText":"교정문장","searchKeyword":"키워드","searchType":"local/news","category":"카테고리","confidence":0.0-1.0}`;

        try {
            const payload = {
                anthropic_version: "bedrock-2023-05-31",
                max_tokens: 200,
                messages: [{ role: "user", content: prompt }],
            };

            const command = new InvokeModelCommand({
                modelId: this.modelId,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(payload),
            });

            const response = await this.bedrockClient.send(command);
            const body = JSON.parse(new TextDecoder().decode(response.body));
            const text = body.content?.[0]?.text || '{}';

            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('JSON not found');

            const result = JSON.parse(jsonMatch[0]);

            this.logger.log(`[LLM 교정] "${rawTranscript.substring(0, 30)}..." → wake=${result.hasWakeWord}`);

            return {
                shouldRespond: result.hasWakeWord ?? false,
                correctedText: result.correctedText ?? rawTranscript,
                searchKeyword: result.searchKeyword ?? null,
                searchType: ['local', 'news', 'web', 'encyc', 'hybrid', 'none'].includes(result.searchType) ? result.searchType : null,
                category: result.category ?? null,
            };
        } catch (error) {
            this.logger.warn(`[LLM 교정 실패] ${error.message}`);
            return {
                shouldRespond: false,
                correctedText: rawTranscript,
                searchKeyword: null,
                searchType: null,
                category: null,
            };
        }
    }

    // ============================================================
    // Helpers
    // ============================================================

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
