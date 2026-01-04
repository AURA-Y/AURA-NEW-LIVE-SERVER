import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { RagClientService } from '../rag/rag-client.service';

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
    newsHighlight?: string;
};

@Injectable()
export class LlmService {
    private readonly logger = new Logger(LlmService.name);
    private bedrockClient: BedrockRuntimeClient;
    private readonly modelId = 'anthropic.claude-3-haiku-20240307-v1:0';

    private lastRequestTime = 0;
    private isProcessing = false;
    private readonly MIN_REQUEST_INTERVAL = 1500;
    private readonly MAX_RETRIES = 3;
    private readonly SEARCH_TIMEOUT_MS = 4000;
    private readonly SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
    private searchCache = new Map<string, { expiresAt: number; results: SearchResult[] }>();
    private lastSearchCategory: string | null = null;
    private readonly naverMapKeyId: string;
    private readonly naverMapKey: string;

    // 의미없는 키워드 필터링용
    private readonly MEANINGLESS_KEYWORDS = [
        '어', '음', '그', '저', '아', '응', '네', '예', '뭐', '야',
        '.', '..', '...', '?', '!', ',',
    ];

    // 카테고리별 키워드
    private readonly CATEGORY_KEYWORDS: Record<string, { keywords: string[]; searchType: 'local' | 'news' }> = {
        '카페': {
            keywords: ['카페', '커피', '커피숍', '카페테리아', '스타벅스', '투썸', '이디야', '할리스', '블루보틀', '카공'],
            searchType: 'local',
        },
        '맛집': {
            keywords: ['맛집', '식당', '레스토랑', '밥집', '음식점', '맛있는', '먹을만한', '저녁', '점심', '아침', '브런치'],
            searchType: 'local',
        },
        '술집': {
            keywords: ['술집', '바', '포차', '호프', '이자카야', '와인바', '칵테일', '소주', '맥주', '회식'],
            searchType: 'local',
        },
        '분식': {
            keywords: ['분식', '떡볶이', '김밥', '라면', '튀김', '순대', '어묵'],
            searchType: 'local',
        },
        '치킨': {
            keywords: ['치킨', 'BBQ', 'BHC', '교촌', '굽네', '네네', '페리카나'],
            searchType: 'local',
        },
        '피자': {
            keywords: ['피자', '도미노', '피자헛', '파파존스', '미스터피자'],
            searchType: 'local',
        },
        '빵집': {
            keywords: ['빵집', '베이커리', '제과점', '빵', '케이크', '파리바게뜨', '뚜레쥬르', '성심당'],
            searchType: 'local',
        },
        '디저트': {
            keywords: ['디저트', '케이크', '마카롱', '아이스크림', '젤라또', '와플', '크로플', '타르트'],
            searchType: 'local',
        },
        '쇼핑': {
            keywords: ['쇼핑', '백화점', '마트', '아울렛', '몰', '매장', '가게', '상점'],
            searchType: 'local',
        },
        '팝업': {
            keywords: ['팝업', '팝업스토어', '팝업 스토어', '한정', '오픈'],
            searchType: 'local',
        },
        '전시': {
            keywords: ['전시', '전시회', '갤러리', '미술관', '박물관', '아트'],
            searchType: 'local',
        },
        '날씨': {
            keywords: ['날씨', '기온', '온도', '비', '눈', '바람', '흐림', '맑음', '습도', '미세먼지', '우산', '더워', '추워', '덥', '춥', '기상', '일기예보'],
            searchType: 'news',
        },
        '뉴스': {
            keywords: ['뉴스', '소식', '기사', '속보', '이슈', '사건', '사고'],
            searchType: 'news',
        },
        '주식': {
            keywords: ['주식', '주가', '코스피', '코스닥', '나스닥', '증시', '투자', '종목'],
            searchType: 'news',
        },
        '스포츠': {
            keywords: ['스포츠', '축구', '야구', '농구', '배구', '경기', '결과', '스코어', '승패'],
            searchType: 'news',
        },
        '영화': {
            keywords: ['영화', '개봉', '상영', '박스오피스', '영화관', 'CGV', '롯데시네마', '메가박스'],
            searchType: 'news',
        },
    };

    // hybrid 검색이 필요한 카테고리 (뉴스 + 장소 둘 다 필요)
    private readonly HYBRID_CATEGORIES = ['팝업', '전시', '영화'];

    constructor(
        private configService: ConfigService,
        private ragClientService: RagClientService,
    ) {
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
            this.logger.log(`[MapKey] NAVER_MAP_API_KEY_ID=****${maskedId}`);
        } else {
            this.logger.warn('[MapKey] NAVER_MAP_API_KEY_ID/API_KEY is missing');
        }
    }

    // ============================================================
    // Public API
    // ============================================================

    async sendMessage(
        userMessage: string,
        searchDomain?: 'weather' | 'naver' | null,
        roomId?: string
    ): Promise<{ text: string; searchResults?: SearchResult[] }> {
        // 회의 관련 질문이고 roomId가 있으면 RAG 서버에 질문
        if (userMessage.includes('회의') && roomId) {
            try {
                if (!this.ragClientService.isConnected(roomId)) {
                    this.logger.warn(`[RAG] 연결되지 않음: ${roomId}`);
                    return { text: '회의록 기능을 사용할 수 없습니다.' };
                }
                this.logger.log(`[RAG 질문] Room: ${roomId}, 질문: "${userMessage}"`);
                const ragAnswer = await this.ragClientService.sendQuestion(roomId, userMessage);
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

    public async buildSearchPlan(rawQuery: string): Promise<{
        query: string;
        cacheKey: string;
        searchType: 'local' | 'news' | 'hybrid' | 'none';
        category: string | null;
    }> {
        const base = this.normalizeSearchQuery(rawQuery) || rawQuery.trim();
        const lowerBase = base.toLowerCase();

        // 1. CATEGORY_KEYWORDS에서 매칭되는 카테고리 찾기
        let matchedCategory: string | null = null;
        let matchedKeyword: string | null = null;
        let baseSearchType: 'local' | 'news' | null = null;

        for (const [category, config] of Object.entries(this.CATEGORY_KEYWORDS)) {
            for (const keyword of config.keywords) {
                if (lowerBase.includes(keyword.toLowerCase())) {
                    matchedCategory = category;
                    matchedKeyword = keyword;
                    baseSearchType = config.searchType;
                    break;
                }
            }
            if (matchedCategory) break;
        }

        // 2. 카테고리가 없으면 검색하지 않음
        if (!matchedCategory) {
            // 의미없는 쿼리인지 체크
            const cleanedQuery = base
                .replace(/[을를이가은는에서의으로]/g, ' ')
                .replace(/알려줘|추천해줘|찾아줘|검색해줘/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (this.isMeaninglessQuery(cleanedQuery)) {
                this.logger.log(`[검색 계획] 의미없는 쿼리 → 검색 안함`);
                return { query: '', cacheKey: '', searchType: 'none', category: null };
            }

            // 최소 길이 체크 (한글 2글자 이상)
            const koreanChars = (cleanedQuery.match(/[가-힣]/g) || []).length;
            if (koreanChars < 2) {
                this.logger.log(`[검색 계획] 쿼리 너무 짧음 → 검색 안함`);
                return { query: '', cacheKey: '', searchType: 'none', category: null };
            }

            this.logger.log(`[검색 계획] 카테고리 없음 → 검색 안함 (query="${cleanedQuery}")`);
            return { query: '', cacheKey: '', searchType: 'none', category: null };
        }

        // 3. 위치 추출
        const location = this.extractLocation(base);

        // 4. 검색 타입 결정
        let searchType: 'local' | 'news' | 'hybrid' = baseSearchType!;
        
        // hybrid 카테고리는 뉴스 + 장소 둘 다 검색
        if (this.HYBRID_CATEGORIES.includes(matchedCategory)) {
            searchType = 'hybrid';
        }

        // 5. 쿼리 생성
        let query: string;
        
        if (matchedCategory === '날씨') {
            // 날씨는 특별 처리
            const weatherLocation = location || '서울';
            const timeWord = base.includes('내일') ? '내일' :
                base.includes('모레') ? '모레' :
                base.includes('이번주') ? '이번주' : '오늘';
            query = `${weatherLocation} ${timeWord} 날씨`;
        } else if (searchType === 'local' || searchType === 'hybrid') {
            // 장소 검색: 위치 + 카테고리
            query = location ? `${location} ${matchedCategory}` : matchedCategory;
        } else {
            // 뉴스 검색: 키워드 기반
            query = base
                .replace(/[을를이가은는에서의으로]/g, ' ')
                .replace(/알려줘|추천해줘|찾아줘|검색해줘/g, '')
                .replace(/\s+/g, ' ')
                .trim() || matchedKeyword!;
        }

        this.logger.log(`[검색 계획] ${matchedCategory}(${searchType}) → query="${query}"`);
        return { 
            query, 
            cacheKey: `${searchType}|${query}`, 
            searchType, 
            category: matchedCategory 
        };
    }

    /**
     * 의미없는 쿼리인지 체크
     */
    private isMeaninglessQuery(query: string): boolean {
        const trimmed = query.trim();
        
        // 빈 문자열
        if (!trimmed) return true;
        
        // 의미없는 키워드만 있는 경우
        const words = trimmed.split(/\s+/);
        const meaningfulWords = words.filter(word => {
            const cleaned = word.replace(/[.,?!]/g, '');
            return cleaned.length > 0 && !this.MEANINGLESS_KEYWORDS.includes(cleaned);
        });
        
        return meaningfulWords.length === 0;
    }

    // ============================================================
    // Search Methods
    // ============================================================

    private async searchWithNaver(
        query: string,
        type: 'local' | 'news',
        display: number,
        sort: 'sim' | 'date' | 'comment' | 'random'
    ): Promise<SearchResult[]> {
        const clientId = this.configService.get<string>('NAVER_CLIENT_ID');
        const clientSecret = this.configService.get<string>('NAVER_CLIENT_SECRET');
        if (!clientId || !clientSecret) {
            this.logger.warn('[Naver 검색] API 키 없음');
            return [];
        }

        const endpoint = type === 'local'
            ? 'https://openapi.naver.com/v1/search/local.json'
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

        return items.map((item: any) => {
            const title = this.stripHtml(item.title || '');
            const itemUrl = item.link || item.originallink || '';
            const description = this.stripHtml(item.description || '');
            const roadAddress = item.roadAddress || '';
            const address = item.address || '';
            const mapx = item.mapx || '';
            const mapy = item.mapy || '';
            const placeId = item.id ? String(item.id) : '';
            const content = type === 'local' ? (roadAddress || address || description) : description;
            const mapUrl = type === 'local' && title
                ? `https://map.naver.com/v5/search/${encodeURIComponent(title)}`
                : '';
            const directionUrl = this.buildNaverDirectionUrl(mapx, mapy, title, placeId);

            return {
                title,
                url: itemUrl,
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
    }

    private async searchHybrid(query: string, display: number): Promise<{
        newsResults: SearchResult[];
        localResults: SearchResult[];
    }> {
        const [newsResults, localResults] = await Promise.all([
            this.searchWithNaver(query, 'news', display, 'date'),
            this.searchWithNaver(query, 'local', display, 'comment'),
        ]);
        this.logger.log(`[하이브리드 검색] 뉴스: ${newsResults.length}개, 장소: ${localResults.length}개`);
        return { newsResults, localResults };
    }

    private mergeHybridResults(
        newsResults: SearchResult[],
        localResults: SearchResult[]
    ): SearchResult[] {
        const merged: SearchResult[] = [];

        // 장소 우선 (길찾기 가능)
        if (localResults.length > 0) {
            const primary = localResults[0];
            const newsHighlight = newsResults.length > 0
                ? this.extractNewsHighlight(newsResults[0])
                : null;
            merged.push({ ...primary, newsHighlight: newsHighlight || undefined });
        }

        // 뉴스도 포함
        for (const news of newsResults.slice(0, 1)) {
            if (!merged.some(m => m.title === news.title)) {
                merged.push(news);
            }
        }

        return merged.slice(0, 3);
    }

    private extractNewsHighlight(newsResult: SearchResult): string | null {
        const content = newsResult.content || '';
        const patterns = [
            /(\d{1,2}월\s*\d{1,2}일까지)/,
            /(\d{1,2}월\s*\d{1,2}일부터\s*\d{1,2}월\s*\d{1,2}일까지)/,
            /(\d+일까지)/,
            /(\d{1,2}월\s*\d{1,2}일)/,
            /(이번\s*주|이번\s*달|올해)/,
        ];
        for (const pattern of patterns) {
            const match = content.match(pattern);
            if (match) return match[1];
        }
        return content.slice(0, 50).trim() || null;
    }

    // ============================================================
    // Core Processing
    // ============================================================

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
                const { query, cacheKey, searchType } = await this.buildSearchPlan(trimmedQuery);
                
                // searchType이 'none'이면 검색하지 않음
                if (searchType === 'none') {
                    this.logger.log(`[검색 스킵] 카테고리/키워드 없음`);
                    return { 
                        text: '네, 무엇을 도와드릴까요? 카페, 맛집, 날씨 등을 물어보시면 검색해드릴게요!',
                        searchResults: undefined 
                    };
                }

                this.logger.log(`[검색] type=${searchType}, query="${query}"`);

                const cached = this.getCachedSearch(cacheKey);
                if (cached) {
                    searchResults = cached;
                    this.logger.log(`[캐시 히트] ${cached.length}개`);
                } else {
                    try {
                        searchResults = await this.executeSearch(query, searchType);
                        this.setCachedSearch(cacheKey, searchResults || []);
                    } catch (error) {
                        this.logger.warn(`[검색 실패] ${error.message}`);
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
                    // 장소 검색 → 단일 추천 형식 (경로 안내 포함)
                    const placeResult = searchResults.find(r => r.address || r.roadAddress);
                    if (placeResult) {
                        finalMessage = this.buildPlaceRecommendation(placeResult);
                    }
                } else {
                    // 뉴스/정보 검색 → 정보 전달 형식 (경로 안내 없음)
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

    private async executeSearch(query: string, searchType: 'local' | 'news' | 'hybrid'): Promise<SearchResult[]> {
        const timeoutMs = this.SEARCH_TIMEOUT_MS;

        if (searchType === 'hybrid') {
            const { newsResults, localResults } = await Promise.race([
                this.searchHybrid(query, 2),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
                )
            ]);
            return this.mergeHybridResults(newsResults, localResults);
        }

        const sort = searchType === 'local' ? 'comment' as const : 'date' as const;
        const results = await Promise.race([
            this.searchWithNaver(query, searchType, 2, sort),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Search timeout')), timeoutMs)
            )
        ]);

        this.logger.log(`[검색 완료] ${results.length}개`);
        return results.slice(0, 2);
    }

    // ============================================================
    // System Prompt Builder
    // ============================================================

    private buildSystemPrompt(userMessage: string, searchResults: SearchResult[]): string {
        const lowerMessage = userMessage.toLowerCase();
        
        // 매칭된 카테고리 찾기
        let matchedCategory: string | null = null;
        for (const [category, config] of Object.entries(this.CATEGORY_KEYWORDS)) {
            if (config.keywords.some(kw => lowerMessage.includes(kw.toLowerCase()))) {
                matchedCategory = category;
                break;
            }
        }

        const location = this.extractLocation(userMessage) || '서울';
        const hasLocation = searchResults.some(r => r.address || r.roadAddress);

        // 카테고리별 프롬프트 생성
        switch (matchedCategory) {
            case '날씨': {
                const timeWord = userMessage.includes('내일') ? '내일' :
                    userMessage.includes('모레') ? '모레' :
                    userMessage.includes('이번주') ? '이번주' : '오늘';
                return `당신은 화상회의 AI 비서 '빅스'입니다.

사용자가 "${location}" "${timeWord}" 날씨를 물어봤습니다.

## 응답 규칙
1. **${location}** 날씨만 답변 (다른 지역 절대 금지)
2. **${timeWord}** 정보만 답변
3. 2문장 이내로 간결하게
4. 기호 금지: ° → "도", % → "퍼센트"

## 응답 예시
"${location} ${timeWord}은 아침 영하 4도, 낮 5도예요. 따뜻하게 입으세요!"

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
                // 장소 검색 (local)
                if (!hasLocation || searchResults.length === 0) {
                    return this.buildNoResultPrompt(matchedCategory, location);
                }
                return `당신은 화상회의 AI 비서 '빅스'입니다.

사용자가 "${location}" 근처 ${matchedCategory}을 찾고 있습니다.

## 응답 규칙
1. 검색 결과 중 **첫 번째 장소 1개만** 추천
2. 상호명을 정확히 말하기
3. 주소 간단히 언급
4. 2문장 이내
5. 마지막에 "해당 지점까지 경로를 채팅창으로 공유드릴게요" 추가

## 응답 예시
"네, [상호명]을 추천해요. [주소]에 있어요. 해당 지점까지 경로를 채팅창으로 공유드릴게요."

## 검색 결과 (첫 번째만 사용)
${JSON.stringify(searchResults[0])}`;
            }

            case '팝업':
            case '전시':
            case '영화': {
                // 하이브리드 검색 (뉴스 + 장소)
                return `당신은 화상회의 AI 비서 '빅스'입니다.

사용자가 "${location}" 근처 ${matchedCategory} 정보를 찾고 있습니다.

## 응답 규칙
1. 어떤 ${matchedCategory}이 열리는지 언급 (뉴스 정보)
2. 장소가 있으면 위치 언급
3. 2-3문장 이내
${hasLocation ? '4. 마지막에 "해당 위치까지 경로를 채팅창으로 공유드릴게요" 추가' : ''}

## 응답 예시
"${location}에서 [${matchedCategory}명]이 열리고 있어요. [위치/기간] 정보예요.${hasLocation ? ' 해당 위치까지 경로를 채팅창으로 공유드릴게요.' : ''}"

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            case '뉴스':
            case '주식':
            case '스포츠': {
                // 뉴스/정보 검색
                return `당신은 화상회의 AI 비서 '빅스'입니다.

사용자가 ${matchedCategory} 정보를 물어봤습니다.

## 응답 규칙
1. 검색 결과를 요약해서 전달
2. 2-3문장 이내
3. "추천해요", "경로를 공유" 등 장소 관련 표현 절대 금지
4. 정보 전달 형식으로 자연스럽게

## 응답 예시
"최근 [주제] 소식이에요. [요약 내용]이라고 하네요."

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            default: {
                // 카테고리 없음 또는 검색 결과 없음
                if (searchResults.length === 0) {
                    return `당신은 화상회의 AI 비서 '빅스'입니다.

## 응답 규칙
- 사용자가 무엇을 원하는지 친절하게 물어보기
- 1-2문장 이내
- 예시로 "카페, 맛집, 날씨" 등을 안내

## 응답 예시
"네, 무엇을 도와드릴까요? 카페, 맛집, 날씨 등을 물어보시면 검색해드릴게요!"`;
                }

                // 검색 결과는 있지만 카테고리 불명
                if (hasLocation) {
                    return `당신은 화상회의 AI 비서 '빅스'입니다.

## 응답 규칙
1. 검색 결과 중 **1개만** 추천
2. 상호명 정확히 말하기
3. 2문장 이내
4. 마지막에 "해당 지점까지 경로를 채팅창으로 공유드릴게요" 추가

## 검색 결과
${JSON.stringify(searchResults[0])}`;
                }

                return `당신은 화상회의 AI 비서 '빅스'입니다.

## 응답 규칙
- 검색 결과를 간단히 요약
- 2문장 이내
- 친근한 존댓말

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2))}`;
            }
        }
    }

    /**
     * 검색 결과 없을 때 프롬프트
     */
    private buildNoResultPrompt(category: string, location: string): string {
        return `당신은 화상회의 AI 비서 '빅스'입니다.

사용자가 "${location}" 근처 ${category}을 찾았지만 검색 결과가 없습니다.

## 응답 규칙
- 결과가 없다고 안내
- 다른 검색어나 지역을 제안
- 1-2문장 이내

## 응답 예시
"${location} 근처 ${category} 검색 결과가 없어요. 다른 지역이나 키워드로 다시 검색해볼까요?"`;
    }

    // ============================================================
    // Response Builders
    // ============================================================

    /**
     * 장소 추천 응답 생성 (address/roadAddress가 있는 경우에만 사용)
     */
    private buildPlaceRecommendation(result: SearchResult): string {
        const title = result.title || '해당 장소';
        const address = result.roadAddress || result.address || '';
        const newsHighlight = (result as any).newsHighlight;

        let response = `네, ${title}을 추천해요.`;
        if (newsHighlight) {
            response += ` ${newsHighlight}까지 한대요.`;
        }
        if (address) {
            response += ` ${address}에 있어요.`;
        }
        response += ' 해당 지점까지 경로를 채팅창으로 공유드릴게요.';

        return response.replace(/\s+/g, ' ').trim();
    }

    /**
     * 뉴스/정보 응답 검증 및 생성 (장소가 아닌 경우)
     */
    private validateAndBuildNewsResponse(llmResponse: string, results: SearchResult[]): string {
        // "추천해요", "경로를 공유" 등 장소 관련 표현이 있으면 제거
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

        // 응답이 너무 짧거나 비어있으면 기본 응답 생성
        if (!cleaned || cleaned.length < 10) {
            if (results.length > 0) {
                const firstResult = results[0];
                return `${firstResult.title}에 대한 소식이에요. ${firstResult.content.slice(0, 80)}`;
            }
            return '관련 정보를 찾았어요. 검색 결과를 확인해주세요.';
        }

        return cleaned;
    }

    /**
     * 기존 buildSingleRecommendation은 deprecated - buildPlaceRecommendation 사용
     */
    private buildSingleRecommendation(result: SearchResult): string {
        // 장소인 경우만 추천 형식 사용
        if (result.address || result.roadAddress) {
            return this.buildPlaceRecommendation(result);
        }
        // 장소가 아니면 정보 전달 형식
        return this.validateAndBuildNewsResponse('', [result]);
    }

    // ============================================================
    // Route & Map
    // ============================================================

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
            this.logger.warn('[길찾기] NAVER_MAP_ORIGIN 없음');
            return null;
        }
        const [originLng, originLat] = origin.split(',').map(v => v.trim());
        if (!originLng || !originLat) return null;

        let destLng: string, destLat: string;
        if (result.mapx && result.mapy) {
            destLng = String(Number(result.mapx) / 10000000);
            destLat = String(Number(result.mapy) / 10000000);
        } else {
            // 좌표가 없으면 경로 정보 없음 (장소가 아닌 경우)
            return null;
        }

        const directionUrl = this.buildDirectionUrlFromCoords(
            originLat, originLng, destLat, destLng,
            result.title || '목적지', result.placeId
        );

        // Directions API
        if (this.naverMapKeyId && this.naverMapKey) {
            try {
                const apiUrl = new URL('https://maps.apigw.ntruss.com/map-direction/v1/driving');
                apiUrl.searchParams.set('start', `${originLng},${originLat}`);
                apiUrl.searchParams.set('goal', `${destLng},${destLat}`);
                apiUrl.searchParams.set('option', 'trafast');

                const resp = await fetch(apiUrl.toString(), {
                    headers: {
                        'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                        'X-NCP-APIGW-API-KEY': this.naverMapKey,
                    },
                });

                if (resp.ok) {
                    const body = await resp.json();
                    const summary = body?.route?.trafast?.[0]?.summary;
                    const path = body?.route?.trafast?.[0]?.path;
                    if (summary) {
                        return {
                            origin: { lng: originLng, lat: originLat },
                            destination: { lng: destLng, lat: destLat, name: result.title || '' },
                            distance: Number(summary.distance || 0),
                            durationMs: Number(summary.duration || 0),
                            directionUrl,
                            path: Array.isArray(path)
                                ? path.map((p: number[]) => ({ lng: String(p[0]), lat: String(p[1]) }))
                                : undefined,
                        };
                    }
                }
            } catch (e) {
                this.logger.warn(`[길찾기 API 실패] ${e.message}`);
            }
        }

        // 직선 거리 추정
        const distance = this.computeDistanceMeters(
            { lng: originLng, lat: originLat },
            { lng: destLng, lat: destLat }
        );
        const estimatedDistance = Math.round(distance * 1.3);
        const estimatedDuration = Math.round(estimatedDistance / 30 * 3.6 * 1000);

        return {
            origin: { lng: originLng, lat: originLat },
            destination: { lng: destLng, lat: destLat, name: result.title || '' },
            distance: estimatedDistance,
            durationMs: estimatedDuration,
            directionUrl,
        };
    }

    async getStaticMapImage(params: {
        origin: { lng: string; lat: string };
        destination: { lng: string; lat: string };
        width: number;
        height: number;
        path?: { lng: string; lat: string }[];
        distanceMeters?: number;
    }): Promise<{ buffer: Buffer; contentType: string } | null> {
        if (!this.naverMapKeyId || !this.naverMapKey) return null;

        const { origin, destination, width, height, path, distanceMeters } = params;
        const rawPath = path && path.length > 1 ? path : [origin, destination];
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
        url.searchParams.append('markers', `type:d|size:mid|color:0x1d4ed8|pos:${origin.lng} ${origin.lat}|label:출발`);
        url.searchParams.append('markers', `type:d|size:mid|color:0xf97316|pos:${destination.lng} ${destination.lat}|label:도착`);

        if (rawPath.length > 1) {
            const pathParts = rawPath.map(p => `pos:${p.lng} ${p.lat}`).join('|');
            url.searchParams.append('path', `weight:5|color:0x2563eb|${pathParts}`);
        }

        const response = await fetch(url.toString(), {
            headers: {
                'X-NCP-APIGW-API-KEY-ID': this.naverMapKeyId,
                'X-NCP-APIGW-API-KEY': this.naverMapKey,
            },
        });

        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return { buffer: Buffer.from(arrayBuffer), contentType: 'image/png' };
    }

    // ============================================================
    // Helpers
    // ============================================================

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private stripHtml(text: string): string {
        return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }

    private extractLocation(text: string): string | null {
        const locations = [
            '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
            '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
            '강남', '홍대', '신촌', '잠실', '여의도', '판교', '성수', '이태원',
            '명동', '종로', '압구정', '청담', '삼성', '역삼', '선릉', '건대',
            '합정', '망원', '연남', '을지로', '성북', '혜화', '대학로',
            '분당', '일산', '수원', '용인', '화성', '평택', '안양', '부천',
        ];
        for (const loc of locations) {
            if (text.includes(loc)) return loc;
        }
        return null;
    }

    private normalizeSearchQuery(rawQuery: string): string {
        return rawQuery.trim()
            .replace(/^(와|과|그리고|또|좀|아|어|야)\s+/g, '')
            .replace(/\b(추천해줘|추천해 줘|알려줘|알려 줘|찾아줘|찾아 줘|보여줘|보여 줘)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private pickCategoryLabel(query: string, results: SearchResult[]): string | null {
        const text = `${query} ${results.map(r => r.title).join(' ')}`.toLowerCase();
        if (text.includes('카페') || text.includes('커피')) return '카페';
        if (text.includes('맛집') || text.includes('식당') || text.includes('레스토랑')) return '맛집';
        if (text.includes('팝업')) return '팝업';
        if (text.includes('전시')) return '전시';
        return null;
    }

    private buildNaverDirectionUrl(mapx: string, mapy: string, title: string, placeId?: string): string | null {
        const origin = this.configService.get<string>('NAVER_MAP_ORIGIN');
        if (!origin || !mapx || !mapy) return null;

        const [originX, originY] = origin.split(',').map(v => v.trim());
        if (!originX || !originY) return null;

        const parsedMapx = Number(mapx);
        const parsedMapy = Number(mapy);
        if (Number.isNaN(parsedMapx) || Number.isNaN(parsedMapy)) return null;

        const destLng = (parsedMapx / 10000000).toString();
        const destLat = (parsedMapy / 10000000).toString();
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${originY},${originX}`)}&destination=${encodeURIComponent(`${destLat},${destLng}`)}&travelmode=transit`;
    }

    private buildDirectionUrlFromCoords(
        originLat: string, originLng: string,
        destLat: string, destLng: string,
        name: string, placeId?: string
    ): string {
        return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${originLat},${originLng}`)}&destination=${encodeURIComponent(`${destLat},${destLng}`)}&travelmode=transit`;
    }

    private computeBounds(points: { lng: string; lat: string }[]) {
        let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
        for (const p of points) {
            const lng = Number(p.lng), lat = Number(p.lat);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
            minLng = Math.min(minLng, lng);
            maxLng = Math.max(maxLng, lng);
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        }
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
        destination: { lng: string; lat: string }
    ): number {
        const R = 6371000;
        const lat1 = Number(origin.lat) * Math.PI / 180;
        const lat2 = Number(destination.lat) * Math.PI / 180;
        const deltaLat = (Number(destination.lat) - Number(origin.lat)) * Math.PI / 180;
        const deltaLng = (Number(destination.lng) - Number(origin.lng)) * Math.PI / 180;
        const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private getCachedSearch(cacheKey: string): SearchResult[] | null {
        const cached = this.searchCache.get(cacheKey);
        if (!cached || Date.now() > cached.expiresAt) {
            this.searchCache.delete(cacheKey);
            return null;
        }
        return cached.results;
    }

    private setCachedSearch(cacheKey: string, results: SearchResult[]): void {
        this.searchCache.set(cacheKey, {
            expiresAt: Date.now() + this.SEARCH_CACHE_TTL_MS,
            results,
        });
    }

    // ============================================================
    // Voice Intent Processing (for voice-bot.service.ts)
    // ============================================================

    async processVoiceIntent(
        rawTranscript: string,
        intentAnalysis: {
            isCallIntent: boolean;
            confidence: number;
            normalizedText: string;
            category?: string | null;
            extractedKeyword?: string | null;
            searchType?: 'local' | 'news' | null;
            needsLlmCorrection: boolean;
        },
    ): Promise<{
        shouldRespond: boolean;
        correctedText: string;
        searchKeyword: string | null;
        searchType: 'local' | 'news' | null;
        category: string | null;
    }> {
        if (intentAnalysis.isCallIntent && intentAnalysis.confidence >= 0.6) {
            if (!intentAnalysis.extractedKeyword) {
                const { query, searchType, category } = await this.buildSearchPlan(intentAnalysis.normalizedText);
                
                // searchType이 'none'이면 키워드 없음
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
                    searchType: searchType === 'hybrid' ? 'local' : searchType,
                    category: category || null,
                };
            }
            return {
                shouldRespond: true,
                correctedText: intentAnalysis.normalizedText,
                searchKeyword: intentAnalysis.extractedKeyword,
                searchType: intentAnalysis.searchType || 'news',
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
        searchType: 'local' | 'news' | null;
        category: string | null;
    }> {
        const prompt = `화상회의 음성인식 결과를 분석하세요.

## 웨이크워드
표준: 빅스야, 빅스비, 헤이빅스
변형: 믹스야, 익수야, 빅세야, 빅쓰, 픽스야, 비수야, 긱스야, 익쇠야, 해빅스, 에이빅스 등

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
                searchType: result.searchType === 'local' ? 'local' : (result.searchType === 'news' ? 'news' : null),
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

    /**
     * LLM이 검색 결과에 없는 장소명을 지어내는 것 방지
     * @deprecated validateAndBuildNewsResponse 사용
     */
    private validateSearchAnswer(answer: string, results: SearchResult[]): string {
        // 장소인 경우 buildPlaceRecommendation 사용
        const hasLocation = results.some(r => r.address || r.roadAddress);
        if (hasLocation) {
            const placeResult = results.find(r => r.address || r.roadAddress);
            if (placeResult) {
                return this.buildPlaceRecommendation(placeResult);
            }
        }
        
        // 뉴스/정보인 경우
        return this.validateAndBuildNewsResponse(answer, results);
    }

    private extractKoreanPhrases(text: string): string[] {
        const matches = text.match(/[가-힣]{2,}/g);
        return matches || [];
    }
}