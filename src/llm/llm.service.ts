import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

type SearchResult = {
    title: string;
    url: string;
    content: string;
    address?: string;
    roadAddress?: string;
    mapx?: string;
    mapy?: string;
    placeId?: string;
    mapUrl?: string;
    directionUrl?: string;
};
type SearchType = 'local' | 'news' | 'web' | 'encyc' | 'it' | 'law' | 'finance' | 'education';

@Injectable()
export class LlmService {
    private readonly logger = new Logger(LlmService.name);
    private bedrockClient: BedrockRuntimeClient;
    private readonly modelId = 'anthropic.claude-3-haiku-20240307-v1:0';

    // Rate limiting
    private lastRequestTimeByKey = new Map<string, number>();
    private isProcessingByKey = new Map<string, boolean>(); // 방별 동시 요청 방지
    private readonly MIN_REQUEST_INTERVAL = 1500; // 최소 1.5초 간격 (응답 속도 개선)
    private readonly MAX_RETRIES = 3; // 재시도 횟수 증가
    private readonly SEARCH_TIMEOUT_MS = 4000; // 검색 타임아웃 (ms)
    private readonly SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5분 캐시
    private searchCache = new Map<string, { expiresAt: number; results: SearchResult[] }>();
    private lastSearchCategory: string | null = null;
    private lastSearchType: SearchType | null = null;
    private readonly naverMapKeyId: string;
    private readonly naverMapKey: string;

    constructor(private configService: ConfigService) {
        this.bedrockClient = new BedrockRuntimeClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
        this.naverMapKeyId = this.configService.get<string>('NAVER_MAP_API_KEY_ID') || '';
        this.naverMapKey = this.configService.get<string>('NAVER_MAP_API_KEY') || '';
        if (this.naverMapKeyId && this.naverMapKey) {
            const maskedId = this.naverMapKeyId.slice(-4);
            this.logger.log(`[MapKey] NAVER_MAP_API_KEY_ID=****${maskedId} keyLen=${this.naverMapKey.length}`);
        } else {
            this.logger.warn('[MapKey] NAVER_MAP_API_KEY_ID/API_KEY is missing');
        }
    }

    async sendMessage(
        userMessage: string,
        searchDomain?: 'weather' | 'naver' | null,
        queueKey?: string
    ): Promise<{
        text: string;
        searchResults?: SearchResult[];
    }> {
        if (userMessage.includes('회의')) {
            return {
                text: 'TODO: 회의록 RAG 연동 예정입니다.',
            };
        }

        const key = this.normalizeQueueKey(queueKey);

        // 동시 요청 방지: 이미 처리 중이면 대기
        while (this.isProcessingByKey.get(key)) {
            this.logger.log(`[LLM 대기] 다른 요청 처리 중... (key=${key})`);
            await this.sleep(100);
        }

        // 쿨다운 체크 (rate limiting)
        const now = Date.now();
        const lastRequestTime = this.lastRequestTimeByKey.get(key) || 0;
        const timeSinceLastRequest = now - lastRequestTime;
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
            const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            this.logger.log(`[LLM 대기] ${waitTime}ms 쿨다운 (key=${key})`);
            await this.sleep(waitTime);
        }

        this.isProcessingByKey.set(key, true);
        this.lastRequestTimeByKey.set(key, Date.now());

        try {
            return await this.sendWithRetry(userMessage, 0, searchDomain ?? 'naver');
        } finally {
            this.isProcessingByKey.set(key, false);
        }
    }

    private normalizeQueueKey(queueKey?: string): string {
        const trimmed = queueKey?.trim();
        return trimmed && trimmed.length > 0 ? trimmed : 'default';
    }

    private async sendWithRetry(userMessage: string, retryCount = 0, searchDomain?: 'weather' | 'naver' | null): Promise<{
        text: string;
        searchResults?: SearchResult[];
    }> {
        this.logger.log(`[LLM 요청] 메시지: ${userMessage.substring(0, 50)}... (도메인: ${searchDomain || 'auto'})`);

        const messages = [
            {
                role: "user",
                content: userMessage,
            },
        ];

        // Tool use로 검색 결과 통합
        const finalResponse = await this.processWithTools(messages, retryCount, undefined, searchDomain, true);
        return finalResponse;
    }

    private async processWithTools(
        messages: any[],
        retryCount: number,
        searchResults?: SearchResult[],
        searchDomain?: 'weather' | 'naver' | null,
        forceSearch = false
    ): Promise<{
        text: string;
        searchResults?: SearchResult[];
    }> {
        if (forceSearch && !searchResults) {
            const latestUser = [...messages].reverse().find((msg) => msg.role === 'user');
            const rawQuery = typeof latestUser?.content === 'string' ? latestUser.content : '';
            const trimmedQuery = rawQuery.trim();
            if (trimmedQuery.length <= 5) {
                this.logger.log('[검색 스킵] 짧은 쿼리');
            } else {
                const { query, cacheKey, searchType, category } = await this.buildSearchPlan(trimmedQuery);
                this.logger.log(`[검색 계획] type=${searchType} category=${category || '기타'} query="${query}"`);
                let tavilyResults: any = null;
                const cached = this.getCachedSearch(cacheKey);
                if (cached) {
                    tavilyResults = { answer: null, results: cached };
                    searchResults = cached;
                } else {
                    const searchOptions = {
                        display: 2,
                        sort: searchType === 'local'
                            ? 'comment' as const
                            : searchType === 'news'
                                ? 'date' as const
                                : 'sim' as const,
                    };
                    const timeoutMs = this.SEARCH_TIMEOUT_MS;
                    const startTime = Date.now();
                    try {
                        tavilyResults = await Promise.race([
                            this.searchWithNaver(query, searchType, searchOptions.display, searchOptions.sort),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
                            )
                        ]);
                    } catch (error) {
                        const elapsed = Date.now() - startTime;
                        const isTimeout = error?.message?.includes('Search timeout');
                        if (isTimeout) {
                            const retryTimeoutMs = 6000;
                            this.logger.warn(`[검색 타임아웃] timeout=${timeoutMs}ms elapsed=${elapsed}ms - 1회 재시도 (${retryTimeoutMs}ms)`);
                            let retryStart = 0;
                            try {
                                retryStart = Date.now();
                                tavilyResults = await Promise.race([
                                    this.searchWithNaver(query, searchType, searchOptions.display, searchOptions.sort),
                                    new Promise((_, reject) =>
                                        setTimeout(() => reject(new Error('Search timeout')), retryTimeoutMs)
                                    )
                                ]);
                                const retryElapsed = Date.now() - retryStart;
                                this.logger.log(`[검색 재시도 완료] ${retryElapsed}ms`);
                            } catch (retryError) {
                                const retryElapsed = retryStart ? Date.now() - retryStart : 0;
                                this.logger.warn(`[검색 재시도 실패] timeout=${retryTimeoutMs}ms elapsed=${retryElapsed}ms - ${retryError.message}`);
                                tavilyResults = { answer: null, results: [] };
                            }
                        } else {
                            this.logger.warn(`[검색 실패] ${error.message}`);
                            tavilyResults = { answer: null, results: [] };
                        }
                    }

                    if (Array.isArray(tavilyResults)) {
                        tavilyResults = { answer: null, results: tavilyResults };
                    }
                    this.logger.log(`[검색 완료] ${tavilyResults.results?.length || 0}개 결과`);

                    const filtered = this.filterSearchResults(query, tavilyResults.results || []);
                    searchResults = filtered.slice(0, 2).map((r: any) => ({
                        title: r.title,
                        url: r.url,
                        content: r.content?.substring(0, 200),
                        address: r.address,
                        roadAddress: r.roadAddress,
                        mapx: r.mapx,
                        mapy: r.mapy,
                        mapUrl: r.mapUrl,
                        directionUrl: r.directionUrl,
                    }));
                    this.setCachedSearch(cacheKey, searchResults);
                }
            }
        }

        const messagesWithSearch = searchResults
            ? [
                ...messages,
                {
                    role: "user",
                    content: `[검색 결과 - 최신순]\n${searchResults.map((r) => `- ${r.title}\n${r.url}\n${r.content}`).join('\n')}`
                }
            ]
            : messages;

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 400,
            system: `You are a friendly Korean voice assistant. Talk like a real person having a casual conversation.

DEFAULT LOCATION: 서울
- 위치 없으면 무조건 서울 기준: "날씨 어때?" → "서울은 지금..."

SPEAKING STYLE (음성 출력):
- 친구처럼 편하게 대화하세요 (반말 금지, 존댓말 but 친근하게)
- 1~2문장, 30~80자 내외
- 핵심만 말하기: "네, ~해요" ❌ → 바로 답변 ✅
- 자연스러운 추임새: ~네요, ~요, ~죠, ~잖아요

RECOMMENDATION FORMAT:
- 검색 결과가 1개 이상이면 1개만 추천 (가장 관련도 높은 1개)
- 반드시 상호명/지점명을 그대로 언급
- 마지막에 "해당 지점까지 경로를 채팅창으로 공유드릴게요" 포함
- 과장 금지, 검색 결과에 없는 내용 추가 금지

NUMBERS (기호 절대 금지):
- 온도: "영하 3도" / "영상 5도"
- 퍼센트: "20퍼센트"
- 돈: "1만원" / "150달러"
- 시간: "3시 반" / "오전 9시"
- 거리: "5킬로"

BAD EXAMPLES ❌:
"서울 날씨는 -3°C이고 습도는 60%입니다. 외출 시 따뜻하게 입으세요."
"네, 알려드리겠습니다. 애플 주가는 $150.50입니다."

GOOD EXAMPLES ✅:
"영하 3도, 습도 60퍼센트예요. 따뜻하게 입으세요!"
"애플 주가 150달러네요"
"서울은 지금 맑고 영상 5도예요"

SEARCH: Use provided search results when available. If search results are missing, use tavily_search.
SEARCH RULES:
- Only use information contained in the provided search results.
- Do NOT invent names, places, or entities not present in the search results.
- If search results are provided, paraphrase naturally but never add new proper nouns or places.`,
            messages: messagesWithSearch,
            tools: searchResults ? [] : [
                {
                    name: "tavily_search",
                    description: "Search the web for current information. Use this when you need up-to-date facts, news, or information you don't have.",
                    input_schema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The search query"
                            }
                        },
                        required: ["query"]
                    }
                }
            ]
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

            // Tool use 체크
            if (responseBody.stop_reason === 'tool_use') {
                const toolUseBlock = responseBody.content.find((block: any) => block.type === 'tool_use');

                if (toolUseBlock && toolUseBlock.name === 'tavily_search') {
                    const { query, cacheKey, searchType, category } = await this.buildSearchPlan(toolUseBlock.input.query);
                    this.logger.log(`[검색 계획] type=${searchType} category=${category || '기타'} query="${query}"`);
                    this.logger.log(`[Naver 검색] "${query}"`);

                    // 검색 도메인 설정
                    const searchOptions = {
                        display: 2,
                        sort: searchType === 'local'
                            ? 'comment' as const
                            : searchType === 'news'
                                ? 'date' as const
                                : 'sim' as const,
                    };

                    // Tavily 검색 실행
                    let tavilyResults: any = null;
                    const timeoutMs = this.SEARCH_TIMEOUT_MS;
                    const startTime = Date.now();
                    try {
                        const cached = this.getCachedSearch(cacheKey);
                        if (cached) {
                            tavilyResults = { answer: null, results: cached };
                        } else {
                            tavilyResults = await Promise.race([
                                this.searchWithNaver(query, searchType, searchOptions.display, searchOptions.sort),
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
                                )
                            ]);
                        }
                    } catch (error) {
                        const elapsed = Date.now() - startTime;
                        const isTimeout = error?.message?.includes('Search timeout');
                        if (isTimeout) {
                            const retryTimeoutMs = 6000;
                            this.logger.warn(`[검색 타임아웃] timeout=${timeoutMs}ms elapsed=${elapsed}ms - 1회 재시도 (${retryTimeoutMs}ms)`);
                            let retryStart = 0;
                            try {
                                retryStart = Date.now();
                                tavilyResults = await Promise.race([
                                    this.searchWithNaver(query, searchType, searchOptions.display, searchOptions.sort),
                                    new Promise((_, reject) =>
                                        setTimeout(() => reject(new Error('Search timeout')), retryTimeoutMs)
                                    )
                                ]);
                                const retryElapsed = Date.now() - retryStart;
                                this.logger.log(`[검색 재시도 완료] ${retryElapsed}ms`);
                            } catch (retryError) {
                                const retryElapsed = retryStart ? Date.now() - retryStart : 0;
                                this.logger.warn(`[검색 재시도 실패] timeout=${retryTimeoutMs}ms elapsed=${retryElapsed}ms - ${retryError.message}`);
                                tavilyResults = { answer: null, results: [] };
                            }
                        } else {
                            this.logger.warn(`[검색 실패] ${error.message}`);
                            tavilyResults = { answer: null, results: [] };
                        }
                    }

                    if (Array.isArray(tavilyResults)) {
                        tavilyResults = { answer: null, results: tavilyResults };
                    }
                    this.logger.log(`[검색 완료] ${tavilyResults.results?.length || 0}개 결과`);

                    // 검색 결과를 프론트엔드로 전송할 형식으로 저장
                    const filteredResults = this.filterSearchResults(query, tavilyResults.results || []);
                    const formattedSearchResults = filteredResults.slice(0, 2).map((r: any) => ({
                        title: r.title,
                        url: r.url,
                        content: r.content?.substring(0, 200),
                        address: r.address,
                        roadAddress: r.roadAddress,
                        mapx: r.mapx,
                        mapy: r.mapy,
                        mapUrl: r.mapUrl,
                        directionUrl: r.directionUrl,
                    }));
                    this.setCachedSearch(cacheKey, formattedSearchResults);

                    // Tool 결과를 Claude에게 전달
                    messages.push({
                        role: "assistant",
                        content: responseBody.content
                    });
                    messages.push({
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: toolUseBlock.id,
                                content: JSON.stringify({
                                    answer: tavilyResults.answer || '검색 결과를 가져오지 못했습니다.',
                                    results: formattedSearchResults
                                })
                            }
                        ]
                    });

                    // 재귀 호출로 최종 답변 받기 (검색 결과 전달)
                    return this.processWithTools(messages, retryCount, formattedSearchResults, searchDomain);
                }
            }

            // 최종 텍스트 응답
            const textBlock = responseBody.content.find((block: any) => block.type === 'text');
            const assistantMessage = textBlock?.text || responseBody.content[0]?.text || "죄송합니다, 응답을 생성할 수 없습니다.";
            const validatedMessage = searchResults
                ? this.validateSearchAnswer(assistantMessage, searchResults)
                : assistantMessage;
            let finalMessage = searchResults && this.shouldUseTitleOnlyFallback(searchResults)
                ? this.buildTitleOnlyRecommendation(searchResults, this.getCategoryHint(messages, searchResults))
                : validatedMessage;
            if (searchResults && searchResults.length > 0 && searchDomain === 'naver') {
                if (this.lastSearchType === 'local') {
                    finalMessage = this.buildSingleRecommendation(searchResults[0]);
                } else if (this.lastSearchType === 'encyc') {
                    finalMessage = this.buildEncycSummary(finalMessage, searchResults);
                } else if (this.lastSearchType === 'news' && this.lastSearchCategory === '공연') {
                    finalMessage = this.buildMovieListSummary(searchResults);
                } else if (this.lastSearchType === 'web' && this.lastSearchCategory === '공연') {
                    const lastUserText = this.getLastUserText(messages);
                    if (this.isMovieQuery(lastUserText)) {
                        finalMessage = this.buildMovieListSummary(searchResults);
                        const cinemaLink = await this.buildNearbyCinemaLink();
                        if (cinemaLink) {
                            finalMessage = `${finalMessage}\n근처 영화관 예약 페이지: ${cinemaLink}`;
                        }
                    }
                }
            }

            this.logger.log(`[LLM 응답] ${finalMessage.substring(0, 100)}...`);
            return {
                text: finalMessage,
                searchResults: searchResults
            };

        } catch (error) {
            // Rate limit/Throttling 에러 시 재시도
            const isThrottled = error.name === 'ThrottlingException' ||
                                error.message?.includes('Too many requests') ||
                                error.message?.includes('throttl');

            if (isThrottled && retryCount < this.MAX_RETRIES) {
                const backoffTime = Math.pow(2, retryCount + 1) * 2000; // 4초, 8초 (지수 백오프)
                this.logger.warn(`[LLM 재시도] ${backoffTime}ms 후 재시도 (${retryCount + 1}/${this.MAX_RETRIES})`);
                await this.sleep(backoffTime);
                return this.processWithTools(messages, retryCount + 1, searchResults, searchDomain);
            }

            this.logger.error(`[LLM 에러] ${error.name}: ${error.message}`);
            throw error;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async searchWithNaver(query: string, type: SearchType, display: number, sort: 'sim' | 'date' | 'comment' | 'random'): Promise<SearchResult[]> {
        const clientId = this.configService.get<string>('NAVER_CLIENT_ID');
        const clientSecret = this.configService.get<string>('NAVER_CLIENT_SECRET');
        if (!clientId || !clientSecret) {
            this.logger.warn('[Naver 검색] NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET이 설정되지 않았습니다.');
            return [];
        }

        const endpoint = type === 'local'
            ? 'https://openapi.naver.com/v1/search/local.json'
            : type === 'encyc'
                ? 'https://openapi.naver.com/v1/search/encyc.json'
                : type === 'web' || type === 'it' || type === 'law' || type === 'finance' || type === 'education'
                    ? 'https://openapi.naver.com/v1/search/webkr.json'
                    : 'https://openapi.naver.com/v1/search/news.json';
        const url = new URL(endpoint);
        url.searchParams.set('query', query);
        url.searchParams.set('display', String(display));
        url.searchParams.set('sort', sort);

        const response = await fetch(url.toString(), {
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret,
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Naver search failed: ${response.status} ${text}`);
        }

        const body = await response.json();
        const items = Array.isArray(body.items) ? body.items : [];

        const mapped = items.map((item: any) => {
            const title = this.stripHtml(item.title || '');
            const url = item.link || item.originallink || '';
            const description = this.stripHtml(item.description || '');
            const roadAddress = typeof item.roadAddress === 'string' ? item.roadAddress : '';
            const address = typeof item.address === 'string' ? item.address : '';
            const mapx = typeof item.mapx === 'string' ? item.mapx : '';
            const mapy = typeof item.mapy === 'string' ? item.mapy : '';
            const placeId = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : '';
            const content = type === 'local'
                ? (roadAddress || address || description || '')
                : description;
            const mapUrl = type === 'local' && title
                ? `https://map.naver.com/v5/search/${encodeURIComponent(title)}`
                : '';
            const directionUrl = this.buildNaverDirectionUrl(mapx, mapy, title, placeId);
            return {
                title,
                url,
                content,
                address: address || undefined,
                roadAddress: roadAddress || undefined,
                mapx: mapx || undefined,
                mapy: mapy || undefined,
                placeId: placeId || undefined,
                mapUrl: mapUrl || undefined,
                directionUrl: directionUrl || undefined,
            };
        });
        this.logger.log(`[Naver 검색 결과] ${JSON.stringify(mapped).substring(0, 800)}`);
        return mapped;
    }

    private pickSearchType(query: string): SearchType {
        const normalized = query.toLowerCase();
        const localKeywords = [
            '카페', '커피', '브런치', '베이커리', '빵집', '디저트', '빙수', '로스터리',
            '맛집', '식당', '레스토랑', '분식', '치킨', '피자', '국밥', '갈비', '횟집', '초밥', '샤브', '밀면', '냉면',
            '술집', '바', '포차', '와인바', '펍',
            '쇼핑', '백화점', '아울렛', '마트', '매장', '가게', '편집샵', '쇼룸', '플래그십', '편의점',
            '전시', '전시회', '갤러리', '미술관', '박물관', '팝업', '팝업스토어', '플리마켓', '공연', '연극', '뮤지컬', '콘서트', '영화관', '극장',
            '호텔', '숙소', '펜션', '리조트', '게스트하우스', '캠핑', '여행', '관광', '코스',
            '근처', '주변', '역', '맛있는', '가까운',
        ];
        const newsKeywords = [
            '뉴스', '속보', '이슈', '사건', '사고', '재난', '정치', '대통령', '국회', '정부', '법안', '선거',
            '경제', '환율', '물가', '금리', '주가', '증시', '코스피', '코스닥', '비트코인', '가상화폐', '코인',
            '기업', '실적', '투자', '상장', '인수', '합병', '파산', '재무',
            '흥행',
        ];
        const entertainmentKeywords = [
            '영화', '개봉', '상영', '개봉작', '예매', '박스오피스',
        ];
        const medicalKeywords = [
            '약', '약물', '약품', '성분', '효능', '효과', '부작용', '복용', '용량', '금기', '질병', '증상', '진단', '치료',
            '감기', '독감', '두통', '통증', '해열', '진통', '진통제', '항생제', '소염', '알레르기', '처방', '의학', '병원', '약국',
            '타이라놀', '아세트아미노펜',
        ];
        const definitionKeywords = [
            '뜻', '의미', '정의', '설명', '개요', '원리', '역사', '유래', '특징', '비교',
        ];
        const itKeywords = [
            '개발', '프로그래밍', '코드', '버그', '에러', '서버', 'api', 'db', '데이터베이스', '네트워크',
            '프론트엔드', '백엔드', '리액트', '노드', '자바스크립트', '타입스크립트', '도커', '쿠버네티스',
            '인공지능', 'ai', 'ml', '모델', '클라우드', '배포', '깃', '깃허브',
        ];
        const lawKeywords = [
            '법', '법률', '판결', '규정', '계약', '소송', '위반', '처벌', '벌금', '민사', '형사', '이혼',
            '상속', '임대차', '노동법', '특허', '저작권',
        ];
        const financeKeywords = [
            '금융', '대출', '이자', '보험', '연금', '주식', '채권', '적금', '예금', '부동산', '세금', '세무',
            '펀드', '자산', '투자', '환율', '코인', '가상화폐',
        ];
        const educationKeywords = [
            '교육', '공부', '학습', '강의', '자격증', '시험', '전형', '입시', '대학교', '커리큘럼',
            '수능', '내신', '토익', '학원',
        ];

        if (localKeywords.some((word) => normalized.includes(word))) {
            return 'local';
        }
        if (newsKeywords.some((word) => normalized.includes(word))) {
            return 'news';
        }
        if (entertainmentKeywords.some((word) => normalized.includes(word))) {
            return 'web';
        }
        if (medicalKeywords.some((word) => normalized.includes(word)) || definitionKeywords.some((word) => normalized.includes(word))) {
            return 'encyc';
        }
        if (itKeywords.some((word) => normalized.includes(word))) {
            return 'it';
        }
        if (lawKeywords.some((word) => normalized.includes(word))) {
            return 'law';
        }
        if (financeKeywords.some((word) => normalized.includes(word))) {
            return 'finance';
        }
        if (educationKeywords.some((word) => normalized.includes(word))) {
            return 'education';
        }
        return 'web';
    }

    private stripHtml(text: string): string {
        return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }

    private filterSearchResults(query: string, results: SearchResult[]): SearchResult[] {
        const normalized = this.normalizeSearchQuery(query);
        const keywords = this.extractKoreanPhrases(normalized);
        if (keywords.length === 0) {
            return results;
        }
        const filtered = results.filter((r) => {
            const haystack = `${r.title} ${r.content}`.toLowerCase();
            return keywords.some((kw) => haystack.includes(kw));
        });
        return filtered.length > 0 ? filtered : results;
    }

    private validateSearchAnswer(answer: string, results: SearchResult[]): string {
        const sourceText = results.map((r) => `${r.title} ${r.content}`).join(' ');
        const extracted = this.extractKoreanPhrases(answer);
        const sourceSet = new Set(this.extractKoreanPhrases(sourceText));
        const hasNewProperNoun = extracted.some((token) => token.length >= 2 && !sourceSet.has(token));

        if (hasNewProperNoun) {
            const fallback = results
                .map((r) => `${r.title}: ${r.content}`)
                .join(' ');
            return fallback || '검색 결과를 요약할 수 없습니다.';
        }

        return answer;
    }

    private shouldUseTitleOnlyFallback(results: SearchResult[]): boolean {
        if (!results.length) {
            return false;
        }
        return results.every((r) => !r.content || r.content.trim().length === 0);
    }

    private buildTitleOnlyRecommendation(results: SearchResult[], category: string | null): string {
        const names = results
            .map((r) => r.title)
            .filter(Boolean)
            .slice(0, 2);
        if (!names.length) {
            return '검색 결과를 요약할 수 없습니다.';
        }
        const joined = names.join(', ');
        const label = category && category !== '기타' ? category : '추천';
        return `${label}로는 ${joined}를 추천드려요.`;
    }

    private getCategoryHint(messages: any[], results: SearchResult[]): string | null {
        if (this.lastSearchCategory) {
            return this.lastSearchCategory;
        }
        const userText = [...messages].reverse().find((msg) => msg.role === 'user')?.content;
        const base = typeof userText === 'string' ? userText : '';
        return this.pickCategoryLabel(base, results);
    }

    private extractKoreanPhrases(text: string): string[] {
        const matches = text.match(/[가-힣]{2,}/g);
        return matches ? matches : [];
    }

    private async buildSearchPlan(rawQuery: string): Promise<{ query: string; cacheKey: string; searchType: SearchType; category: string | null }> {
        const base = this.normalizeSearchQuery(rawQuery) || rawQuery.trim();
        const fallback = this.buildSearchQuery(rawQuery);
        const fallbackCategory = this.pickCategoryLabel(rawQuery, []);
        const system = [
            'You are a search query planner for Korean user requests.',
            'Return only a JSON object with keys: searchType, category, and query.',
            'searchType must be one of: local, news, web, encyc, it, law, finance, education.',
            'Use local for places/food/shops, news for current events, encyc for definitions/medical terms.',
            'Use web for entertainment topics like movies/releases/box office unless the user explicitly asks for news.',
            'Use it/law/finance/education when the topic matches those domains; otherwise use web.',
            'category must be one of: 카페, 맛집, 술집, 쇼핑, 전시, 팝업, 공연, 여행, 숙소, 의학, 법률, IT, 금융, 교육, 기타.',
            'query must be short Korean nouns (e.g., "성수동 카페").',
            'Remove verbs, particles, and filler words.',
            'No extra text, no markdown.',
        ].join(' ');
        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 120,
            system,
            messages: [
                {
                    role: "user",
                    content: rawQuery,
                },
            ],
        };

        try {
            const command = new InvokeModelCommand({
                modelId: this.modelId,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(payload),
            });
            const response = await this.bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const textBlock = responseBody.content.find((block: any) => block.type === 'text');
            const rawText = (textBlock?.text || '').trim();
            const jsonText = rawText.match(/\{[\s\S]*\}/)?.[0];
            if (!jsonText) {
                throw new Error('Search plan JSON not found');
            }
            const parsed = JSON.parse(jsonText);
            let searchType: SearchType = ['local', 'news', 'web', 'encyc', 'it', 'law', 'finance', 'education'].includes(parsed.searchType)
                ? parsed.searchType
                : this.pickSearchType(base);
            let query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
            if (!query) {
                throw new Error('Empty plan query');
            }
            const category = typeof parsed.category === 'string' ? parsed.category.trim() : fallbackCategory;
            if (searchType === 'local') {
                query = this.normalizeLocalQuery(query);
                query = this.ensureCategoryInQuery(query, category);
            } else if (searchType === 'news') {
                query = this.formatNewsQuery(query);
            } else {
                query = this.formatGeneralQuery(query);
            }
            const cacheKey = `${base}|${searchType}|${query}`;
            this.lastSearchCategory = category || fallbackCategory;
            this.lastSearchType = searchType;
            return { query, cacheKey, searchType, category };
        } catch (error) {
            this.logger.warn(`[검색 계획 실패] ${error.message}`);
            this.lastSearchCategory = fallbackCategory;
            this.lastSearchType = fallback.searchType;
            return { ...fallback, category: fallbackCategory };
        }
    }

    private formatNewsQuery(rawQuery: string): string {
        const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const normalized = this.normalizeSearchQuery(rawQuery) || rawQuery.trim();
        return `${normalized} ${kstDate} 최신`;
    }

    private formatGeneralQuery(rawQuery: string): string {
        return this.normalizeSearchQuery(rawQuery) || rawQuery.trim();
    }

    private buildNaverDirectionUrl(mapx: string, mapy: string, title: string, placeId?: string): string | null {
        const origin = this.configService.get<string>('NAVER_MAP_ORIGIN');
        if (!origin || !mapx || !mapy) {
            return null;
        }
        const name = title ? encodeURIComponent(title) : '목적지';
        const [originX, originY] = origin.split(',').map((v) => v.trim());
        if (!originX || !originY) {
            return null;
        }
        const parsedMapx = Number(mapx);
        const parsedMapy = Number(mapy);
        if (Number.isNaN(parsedMapx) || Number.isNaN(parsedMapy)) {
            return `https://map.naver.com/v5/directions/${originY},${originX},${encodeURIComponent('현재 위치')}/${mapy},${mapx},${name}`;
        }
        const destLng = (parsedMapx / 10000000).toString();
        const destLat = (parsedMapy / 10000000).toString();
        const googleOrigin = `${originY},${originX}`;
        const googleDest = `${destLat},${destLng}`;
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(googleOrigin)}&destination=${encodeURIComponent(googleDest)}&travelmode=transit`;
    }

    async getRouteInfo(result: SearchResult): Promise<{
        origin: { lng: string; lat: string };
        destination: { lng: string; lat: string; name: string };
        distance: number;
        durationMs: number;
        directionUrl?: string;
        path?: { lng: string; lat: string }[];
    } | null> {
        const origin = this.configService.get<string>('NAVER_MAP_ORIGIN') || '';
        if (!origin) {
            this.logger.warn('[길찾기] NAVER_MAP_ORIGIN이 설정되지 않았습니다.');
            return null;
        }
        const [originLng, originLat] = origin.split(',').map((v) => v.trim());
        if (!originLng || !originLat) {
            this.logger.warn('[길찾기] NAVER_MAP_ORIGIN 형식이 잘못되었습니다.');
            return null;
        }

        // mapx, mapy가 있으면 바로 사용 (Geocoding API 불필요)
        let destLng: string;
        let destLat: string;

        if (result.mapx && result.mapy) {
            // Naver Local Search에서 받은 좌표 직접 사용
            // Katech 좌표계 -> WGS84 변환 (Naver Map 좌표는 이미 변환된 상태)
            destLng = String(Number(result.mapx) / 10000000);
            destLat = String(Number(result.mapy) / 10000000);
            this.logger.log(`[길찾기] Local Search 좌표 사용: ${destLng}, ${destLat}`);
        } else {
            this.logger.warn('[길찾기] 좌표 정보 없음 - Directions API 호출 불가');
            // directionUrl만 반환 (거리/시간 없이)
            return {
                origin: { lng: originLng, lat: originLat },
                destination: { lng: '0', lat: '0', name: result.title || '' },
                distance: 0,
                durationMs: 0,
                directionUrl: result.directionUrl,
            };
        }

        const directionUrl = this.buildDirectionUrlFromCoords(
            originLat,
            originLng,
            destLat,
            destLng,
            result.title || result.roadAddress || result.address || '목적지',
            result.placeId,
        );

        try {
            // Directions API 호출 (API 키가 있을 때만)
            if (this.naverMapKeyId && this.naverMapKey) {
                const maskedId = this.naverMapKeyId.slice(-4);
                this.logger.log(`[길찾기] Using Map Key ID=****${maskedId} keyLen=${this.naverMapKey.length}`);
                const directionApiUrl = new URL('https://maps.apigw.ntruss.com/map-direction/v1/driving');
                directionApiUrl.searchParams.set('start', `${originLng},${originLat}`);
                directionApiUrl.searchParams.set('goal', `${destLng},${destLat}`);
                directionApiUrl.searchParams.set('option', 'trafast');

                const dirResp = await fetch(directionApiUrl.toString(), {
                    headers: {
                        'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                        'X-NCP-APIGW-API-KEY': this.naverMapKey,
                    },
                });

                if (!dirResp.ok) {
                    const dirText = await dirResp.text();
                    this.logger.warn(`[길찾기] Directions API 실패: ${dirResp.status} ${dirText}`);
                    this.logger.warn(`[길찾기] API 키 없이 계속 진행 (directionUrl만 사용)`);
                } else {
                    const dirBody = await dirResp.json();
                    const summary = dirBody?.route?.trafast?.[0]?.summary;
                    const path = dirBody?.route?.trafast?.[0]?.path;
                    if (summary) {
                        this.logger.log(`[길찾기] 성공: ${summary.distance}m, ${summary.duration}ms`);
                        const parsedPath = Array.isArray(path)
                            ? path.map((point) => ({
                                lng: String(point[0]),
                                lat: String(point[1]),
                            }))
                            : undefined;
                        return {
                            origin: { lng: originLng, lat: originLat },
                            destination: { lng: destLng, lat: destLat, name: result.title || '' },
                            distance: Number(summary.distance || 0),
                            durationMs: Number(summary.duration || 0),
                            directionUrl,
                            path: parsedPath,
                        };
                    }
                }
            } else {
                this.logger.warn('[길찾기] Directions API 키 없음 - 기본 정보만 반환');
            }

            // Directions API 실패 또는 키 없음 -> 추정치 반환
            // 직선 거리 기반 추정 (실제로는 도로 거리가 더 김)
            const R = 6371000; // 지구 반지름 (m)
            const lat1 = Number(originLat) * Math.PI / 180;
            const lat2 = Number(destLat) * Math.PI / 180;
            const deltaLat = (Number(destLat) - Number(originLat)) * Math.PI / 180;
            const deltaLng = (Number(destLng) - Number(originLng)) * Math.PI / 180;

            const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                     Math.cos(lat1) * Math.cos(lat2) *
                     Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const straightDistance = R * c;

            // 도로 거리는 직선 거리의 약 1.3배로 추정
            const estimatedDistance = Math.round(straightDistance * 1.3);
            // 평균 속도 30km/h로 추정
            const estimatedDuration = Math.round(estimatedDistance / 30 * 3.6 * 1000);

            this.logger.log(`[길찾기] 추정: ${estimatedDistance}m, ${estimatedDuration}ms (직선거리 기반)`);

            return {
                origin: { lng: originLng, lat: originLat },
                destination: { lng: destLng, lat: destLat, name: result.title || '' },
                distance: estimatedDistance,
                durationMs: estimatedDuration,
                directionUrl,
                path: undefined,
            };
        } catch (error) {
            this.logger.warn(`[길찾기] 실패: ${error.message}`);
            return null;
        }
    }

    private buildDirectionUrlFromCoords(
        originLat: string,
        originLng: string,
        destLat: string,
        destLng: string,
        name: string,
        placeId?: string,
    ): string {
        const googleOrigin = `${originLat},${originLng}`;
        const googleDest = `${destLat},${destLng}`;
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(googleOrigin)}&destination=${encodeURIComponent(googleDest)}&travelmode=transit`;
    }

    async getStaticMapImage(params: {
        origin: { lng: string; lat: string };
        destination: { lng: string; lat: string };
        width: number;
        height: number;
        path?: { lng: string; lat: string }[];
        distanceMeters?: number;
    }): Promise<{ buffer: Buffer; contentType: string } | null> {
        if (!this.naverMapKeyId || !this.naverMapKey) {
            this.logger.warn('[StaticMap] NAVER_MAP_API_KEY_ID/API_KEY가 없습니다.');
            return null;
        }

        const maskedId = this.naverMapKeyId.slice(-4);
        this.logger.log(`[StaticMap] Using Map Key ID=****${maskedId} keyLen=${this.naverMapKey.length}`);

        const { origin, destination, width, height, path, distanceMeters } = params;
        const rawPath = Array.isArray(path) && path.length > 1
            ? path
            : [origin, destination];
        const bounds = this.computeBounds(rawPath);
        const centerLng = (bounds.minLng + bounds.maxLng) / 2;
        const centerLat = (bounds.minLat + bounds.maxLat) / 2;

        const distance = distanceMeters ?? this.computeDistanceMeters(origin, destination);
        const level = this.pickStaticMapLevel(distance);

        const url = new URL('https://maps.apigw.ntruss.com/map-static/v2/raster');
        url.searchParams.set('w', String(width));
        url.searchParams.set('h', String(height));
        url.searchParams.set('format', 'png');
        url.searchParams.set('scale', '2');
        url.searchParams.set('center', `${centerLng},${centerLat}`);
        url.searchParams.set('level', String(level));
        url.searchParams.set('maptype', 'basic');

        url.searchParams.append(
            'markers',
            `type:d|size:mid|color:0x1d4ed8|pos:${origin.lng} ${origin.lat}|label:출발`,
        );
        url.searchParams.append(
            'markers',
            `type:d|size:mid|color:0xf97316|pos:${destination.lng} ${destination.lat}|label:도착`,
        );

        if (rawPath.length > 1) {
            const pathParts = rawPath
                .map((point) => `pos:${point.lng} ${point.lat}`)
                .join('|');
            url.searchParams.append(
                'path',
                `weight:5|color:0x2563eb|${pathParts}`,
            );
        }

        const response = await fetch(url.toString(), {
            headers: {
                'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                'X-NCP-APIGW-API-KEY': this.naverMapKey,
            },
        });

        if (!response.ok) {
            const text = await response.text();
            this.logger.warn(`[StaticMap] 실패: ${response.status} ${text}`);
            return null;
        }

        const arrayBuffer = await response.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: response.headers.get('content-type') || 'image/png',
        };
    }

    private computeBounds(points: { lng: string; lat: string }[]) {
        let minLng = Number.POSITIVE_INFINITY;
        let maxLng = Number.NEGATIVE_INFINITY;
        let minLat = Number.POSITIVE_INFINITY;
        let maxLat = Number.NEGATIVE_INFINITY;
        points.forEach((point) => {
            const lng = Number(point.lng);
            const lat = Number(point.lat);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        });
        return { minLng, maxLng, minLat, maxLat };
    }

    private pickStaticMapLevel(distanceMeters: number): number {
        if (distanceMeters > 15000) return 11;
        if (distanceMeters > 8000) return 12;
        if (distanceMeters > 4000) return 13;
        if (distanceMeters > 2000) return 14;
        return 15;
    }

    private computeDistanceMeters(
        origin: { lng: string; lat: string },
        destination: { lng: string; lat: string },
    ): number {
        const R = 6371000;
        const lat1 = Number(origin.lat) * Math.PI / 180;
        const lat2 = Number(destination.lat) * Math.PI / 180;
        const deltaLat = (Number(destination.lat) - Number(origin.lat)) * Math.PI / 180;
        const deltaLng = (Number(destination.lng) - Number(origin.lng)) * Math.PI / 180;
        const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    private buildSingleRecommendation(result: SearchResult): string {
        const title = result.title || '해당 장소';
        const address = result.roadAddress || result.address || result.content || '';
        const addressText = address ? `${address}에 있어요. ` : '';
        return `${title}을 추천해요. ${addressText}해당 지점까지 경로를 채팅창으로 공유드릴게요.`.replace(/\s+/g, ' ').trim();
    }

    private buildEncycSummary(message: string, results: SearchResult[]): string {
        const trimmed = message?.trim();
        let summary = trimmed && trimmed !== '검색 결과를 요약할 수 없습니다.'
            ? trimmed
            : results
                .map((r) => `${r.title}: ${r.content}`)
                .join(' ');
        summary = summary.replace(/\s+/g, ' ').trim();
        const parts = summary.match(/[^.!?]+[.!?]+/g) || [summary];
        if (parts.length > 2) {
            summary = parts.slice(0, 2).join(' ');
        }
        if (summary.length > 180) {
            summary = summary.slice(0, 180).trim();
        }
        const cleanSummary = summary.replace(/\s+/g, ' ').trim();
        return `${cleanSummary}\n해당 정보를 채팅창으로 공유드릴게요.`.trim();
    }

    private buildMovieListSummary(results: SearchResult[]): string {
        const titles = this.extractMovieTitles(results)
            .slice(0, 3);
        if (!titles.length) {
            return '최근 개봉 영화 정보를 찾지 못했어요.\n해당 정보를 채팅창으로 공유드릴게요.';
        }
        return `최근 개봉 영화로는 ${titles.join(', ')}가 있어요.\n해당 정보를 채팅창으로 공유드릴게요.`;
    }

    private extractMovieTitles(results: SearchResult[]): string[] {
        const candidates: string[] = [];
        for (const result of results) {
            const sanitized = this.sanitizeTitle(result.title);
            if (!sanitized) continue;
            const parts = sanitized
                .split(/[:\-\|·]/g)
                .map((p) => p.replace(/\b(top|rank|순위|랭킹|추천|정보|정리|최신|개봉|상영)\b/gi, '').trim())
                .filter(Boolean);
            if (parts.length === 0) {
                candidates.push(sanitized);
                continue;
            }
            for (const part of parts) {
                if (part.length >= 2 && part.length <= 20) {
                    candidates.push(part);
                }
            }
        }
        const seen = new Set<string>();
        const unique = candidates.filter((title) => {
            const key = title.replace(/\s+/g, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return unique.length ? unique : results.map((r) => this.sanitizeTitle(r.title)).filter(Boolean);
    }

    private sanitizeTitle(title: string): string {
        return title
            .replace(/^\[[^\]]+\]\s*/g, '')
            .replace(/\b(오늘|이번|최근|현재|국내|한국)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private getLastUserText(messages: any[]): string {
        const lastUser = [...messages].reverse().find((msg) => msg.role === 'user');
        return typeof lastUser?.content === 'string' ? lastUser.content : '';
    }

    private isMovieQuery(text: string): boolean {
        const normalized = text.toLowerCase();
        return ['영화', '개봉', '상영', '개봉작', '예매', '박스오피스'].some((word) => normalized.includes(word));
    }

    private async buildNearbyCinemaLink(): Promise<string | null> {
        const origin = this.configService.get<string>('NAVER_MAP_ORIGIN');
        if (!origin) {
            return null;
        }
        const [originLng, originLat] = origin.split(',').map((v) => v.trim());
        let query = '영화관';

        const region = await this.reverseGeocodeRegion(originLng, originLat);
        const area = region?.area2 || region?.area3 || region?.area1;
        if (area) {
            query = `${area} 영화관`;
        }

        try {
            const results = await this.searchWithNaver(query, 'local', 1, 'sim');
            return results[0]?.mapUrl || null;
        } catch (error) {
            this.logger.warn(`[영화관 검색 실패] ${error.message}`);
            return null;
        }
    }

    private async reverseGeocodeRegion(
        lng: string,
        lat: string
    ): Promise<{ area1?: string; area2?: string; area3?: string } | null> {
        if (!this.naverMapKeyId || !this.naverMapKey) {
            return null;
        }
        const url = new URL('https://naveropenapi.apigw.ntruss.com/map-reversegeocode/v2/gc');
        url.searchParams.set('coords', `${lng},${lat}`);
        url.searchParams.set('orders', 'legalcode');
        url.searchParams.set('output', 'json');

        const response = await fetch(url.toString(), {
            headers: {
                'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                'X-NCP-APIGW-API-KEY': this.naverMapKey,
            },
        });
        if (!response.ok) {
            return null;
        }
        const body = await response.json();
        const region = body?.results?.[0]?.region;
        return {
            area1: region?.area1?.name,
            area2: region?.area2?.name,
            area3: region?.area3?.name,
        };
    }

    private buildSearchQuery(rawQuery: string): { query: string; cacheKey: string; searchType: SearchType } {
        const trimmed = this.normalizeSearchQuery(rawQuery);
        const searchType = this.pickSearchType(trimmed);
        if (searchType === 'local') {
            const category = this.pickCategoryLabel(rawQuery, []);
            const query = this.ensureCategoryInQuery(this.normalizeLocalQuery(rawQuery), category);
            const cacheKey = `${trimmed}|${searchType}|${query}`;
            this.lastSearchType = searchType;
            return { query, cacheKey, searchType };
        }
        const query = searchType === 'news'
            ? this.formatNewsQuery(trimmed)
            : this.formatGeneralQuery(trimmed);
        const cacheKey = `${trimmed}|${searchType}|${query}`;
        this.lastSearchType = searchType;
        return { query, cacheKey, searchType };
    }

    private pickCategoryLabel(query: string, results: SearchResult[]): string | null {
        const text = `${query} ${results.map((r) => r.title).join(' ')}`.toLowerCase();
        if (text.includes('카페') || text.includes('커피') || text.includes('브런치') || text.includes('베이커리')) return '카페';
        if (text.includes('맛집') || text.includes('식당') || text.includes('레스토랑') || text.includes('분식')) return '맛집';
        if (text.includes('술집') || text.includes('바') || text.includes('포차') || text.includes('와인바')) return '술집';
        if (text.includes('팝업') || text.includes('팝업스토어')) return '팝업';
        if (text.includes('전시') || text.includes('갤러리') || text.includes('미술관') || text.includes('박물관')) return '전시';
        if (text.includes('공연') || text.includes('연극') || text.includes('뮤지컬') || text.includes('콘서트') || text.includes('영화') || text.includes('영화관') || text.includes('극장')) return '공연';
        if (text.includes('쇼핑') || text.includes('백화점') || text.includes('아울렛') || text.includes('매장') || text.includes('가게') || text.includes('편집샵')) return '쇼핑';
        if (text.includes('여행') || text.includes('관광') || text.includes('코스')) return '여행';
        if (text.includes('숙소') || text.includes('호텔') || text.includes('펜션') || text.includes('리조트') || text.includes('게스트하우스')) return '숙소';
        if (text.includes('약') || text.includes('의학') || text.includes('질병') || text.includes('부작용') || text.includes('효능') || text.includes('진통')) return '의학';
        if (text.includes('법') || text.includes('판결') || text.includes('규정') || text.includes('계약') || text.includes('소송')) return '법률';
        if (text.includes('개발') || text.includes('프로그래밍') || text.includes('코드') || text.includes('it') || text.includes('ai') || text.includes('서버')) return 'IT';
        if (text.includes('금리') || text.includes('주가') || text.includes('환율') || text.includes('투자') || text.includes('대출')) return '금융';
        if (text.includes('교육') || text.includes('공부') || text.includes('학습') || text.includes('자격증') || text.includes('시험')) return '교육';
        return null;
    }

    private ensureCategoryInQuery(query: string, category: string | null): string {
        if (!category) {
            return query;
        }
        const categoryKeywords: Record<string, string[]> = {
            카페: ['카페', '커피', '브런치', '베이커리', '디저트'],
            맛집: ['맛집', '식당', '레스토랑', '분식'],
            술집: ['술집', '바', '포차', '와인바', '펍'],
            쇼핑: ['쇼핑', '백화점', '아울렛', '편집샵', '매장'],
            전시: ['전시', '갤러리', '미술관', '박물관'],
            팝업: ['팝업', '팝업스토어'],
            공연: ['공연', '뮤지컬', '콘서트', '연극'],
            여행: ['여행', '관광', '여행지'],
            숙소: ['숙소', '호텔', '펜션', '리조트'],
        };
        const keywords = categoryKeywords[category];
        if (!keywords) {
            return query;
        }
        if (keywords.some((word) => query.includes(word))) {
            return query;
        }
        return `${query} ${keywords[0]}`.trim();
    }

    private normalizeSearchQuery(rawQuery: string): string {
        const trimmed = rawQuery.trim();
        const cleaned = trimmed
            .replace(/^(와|과|그리고|또|좀|아|어|야)\s+/g, '')
            .replace(/\b(추천해줘|추천해 줘|알려줘|알려 줘|찾아줘|찾아 줘|보여줘|보여 줘)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned || trimmed;
    }

    private normalizeLocalQuery(rawQuery: string): string {
        const trimmed = rawQuery.trim();
        const cleaned = trimmed
            .replace(/^(와|과|그리고|또|좀|아|어|야)\s+/g, '')
            .replace(/\b(추천해줘|추천해 줘|알려줘|알려 줘|찾아줘|찾아 줘|보여줘|보여 줘)\b/g, '')
            .replace(/\b(카페\s*거래|카페거래)\b/g, '카페')
            .replace(/\b(카페거리|거리)\b/g, '')
            .replace(/거래(에서|에)?/g, '')
            .replace(/\b(에서|에는|에서의|에서만|에서도|에|의|으로|로)\b/g, '')
            .replace(/\b(카페)\s+\1\b/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned || trimmed;
    }

    private getCachedSearch(cacheKey: string): SearchResult[] | null {
        const cached = this.searchCache.get(cacheKey);
        if (!cached) {
            return null;
        }
        if (Date.now() > cached.expiresAt) {
            this.searchCache.delete(cacheKey);
            return null;
        }
        return cached.results;
    }

    private setCachedSearch(cacheKey: string, results: SearchResult[]): void {
        this.searchCache.set(cacheKey, { expiresAt: Date.now() + this.SEARCH_CACHE_TTL_MS, results });
    }
}
