import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type SearchResult = {
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

export type SearchType = 'local' | 'news' | 'web' | 'encyc' | 'hybrid' | 'none';

@Injectable()
export class SearchService {
    private readonly logger = new Logger(SearchService.name);

    private readonly SEARCH_TIMEOUT_MS = 4000;
    private readonly SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
    private searchCache = new Map<string, { expiresAt: number; results: SearchResult[] }>();

    // 의미없는 키워드 필터링용
    private readonly MEANINGLESS_KEYWORDS = [
        '어', '음', '그', '저', '아', '응', '네', '예', '뭐', '야',
        '.', '..', '...', '?', '!', ',',
    ];

    // 인사말 (검색하지 않음)
    private readonly GREETING_KEYWORDS = [
        '안녕', '안녕하세요', '안녕하십니까', '반가워', '반갑습니다',
        '하이', '헬로', '굿모닝', '굿나잇',
        '좋은 아침', '좋은 저녁', '좋은 하루',
        '수고', '수고해', '수고하세요', '고마워', '고맙습니다', '감사합니다',
        '잘자', '잘가', '바이', '바이바이', '또봐', '다음에',
    ];

    // 카테고리별 키워드
    private readonly CATEGORY_KEYWORDS: Record<string, { keywords: string[]; searchType: 'local' | 'news' | 'web' | 'encyc' }> = {
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
        '백과': {
            keywords: ['무엇인가', '정의', '의미', '개념', '역사', '원리', '효능', '효과', '부작용', '성분', '알려줘', '설명해'],
            searchType: 'encyc',
        },
    };

    // hybrid 검색이 필요한 카테고리
    private readonly HYBRID_CATEGORIES = ['팝업', '전시', '영화'];

    // 지역명 목록
    private readonly LOCATIONS = [
        '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
        '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
        '강남', '홍대', '신촌', '잠실', '여의도', '판교', '성수', '이태원',
        '명동', '종로', '압구정', '청담', '삼성', '역삼', '선릉', '건대',
        '합정', '망원', '연남', '을지로', '성북', '혜화', '대학로',
        '분당', '일산', '수원', '용인', '화성', '평택', '안양', '부천',
    ];

    constructor(private configService: ConfigService) {}

    // ============================================================
    // Public API
    // ============================================================

    /**
     * 검색 계획 수립
     */
    async buildSearchPlan(rawQuery: string): Promise<{
        query: string;
        cacheKey: string;
        searchType: SearchType;
        category: string | null;
    }> {
        const base = this.normalizeSearchQuery(rawQuery) || rawQuery.trim();
        const lowerBase = base.toLowerCase();

        // 1. 카테고리 매칭
        let matchedCategory: string | null = null;
        let matchedKeyword: string | null = null;
        let baseSearchType: 'local' | 'news' | 'web' | 'encyc' | null = null;

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

        // 2. 카테고리 없으면 일반 웹 검색
        if (!matchedCategory) {
            const cleanedQuery = base
                .replace(/[을를이가은는에서의으로]/g, ' ')
                .replace(/알려줘|추천해줘|찾아줘|검색해줘|에 대해|대해서/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (this.isMeaninglessQuery(cleanedQuery)) {
                this.logger.log(`[검색 계획] 의미없는 쿼리 → 검색 안함`);
                return { query: '', cacheKey: '', searchType: 'none', category: null };
            }

            if (this.isGreeting(cleanedQuery)) {
                this.logger.log(`[검색 계획] 인사말 → 검색 안함`);
                return { query: '', cacheKey: '', searchType: 'none', category: null };
            }

            const koreanChars = (cleanedQuery.match(/[가-힣]/g) || []).length;
            if (koreanChars < 2) {
                this.logger.log(`[검색 계획] 쿼리 너무 짧음 → 검색 안함`);
                return { query: '', cacheKey: '', searchType: 'none', category: null };
            }

            this.logger.log(`[검색 계획] 일반검색(web) → query="${cleanedQuery}"`);
            return { 
                query: cleanedQuery, 
                cacheKey: `web|${cleanedQuery}`, 
                searchType: 'web', 
                category: '일반' 
            };
        }

        // 3. 위치 추출
        const location = this.extractLocation(base);

        // 4. 검색 타입 결정
        let searchType: SearchType = baseSearchType!;
        if (this.HYBRID_CATEGORIES.includes(matchedCategory)) {
            searchType = 'hybrid';
        }

        // 5. 쿼리 생성
        let query: string;
        
        if (matchedCategory === '날씨') {
            const weatherLocation = location || '서울';
            const timeWord = base.includes('내일') ? '내일' :
                base.includes('모레') ? '모레' :
                base.includes('이번주') ? '이번주' : '오늘';
            query = `${weatherLocation} ${timeWord} 날씨`;
        } else if (searchType === 'local' || searchType === 'hybrid') {
            const searchLocation = location || '서울';
            query = `${searchLocation} ${matchedCategory}`;
        } else {
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
     * 검색 실행 (캐시 포함)
     */
    async search(query: string, searchType: SearchType): Promise<SearchResult[]> {
        if (searchType === 'none') return [];

        const cacheKey = `${searchType}|${query}`;
        const cached = this.getCachedSearch(cacheKey);
        if (cached) {
            this.logger.log(`[캐시 히트] ${cached.length}개`);
            return cached;
        }

        try {
            const results = await this.executeSearch(query, searchType);
            this.setCachedSearch(cacheKey, results || []);
            return results;
        } catch (error) {
            this.logger.warn(`[검색 실패] ${error.message}`);
            return [];
        }
    }

    // ============================================================
    // Search Execution
    // ============================================================

    private async executeSearch(query: string, searchType: SearchType): Promise<SearchResult[]> {
        if (searchType === 'hybrid') {
            const { newsResults, localResults } = await Promise.race([
                this.searchHybrid(query, 2),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Search timeout')), this.SEARCH_TIMEOUT_MS)
                )
            ]);
            return this.mergeHybridResults(newsResults, localResults);
        }

        const sort = searchType === 'local' ? 'comment' as const : 'date' as const;
        const results = await Promise.race([
            this.searchWithNaver(query, searchType as 'local' | 'news' | 'web' | 'encyc', 3, sort),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('Search timeout')), this.SEARCH_TIMEOUT_MS)
            )
        ]);

        this.logger.log(`[검색 완료] ${searchType}: ${results.length}개`);
        return results.slice(0, 3);
    }

    private async searchWithNaver(
        query: string,
        type: 'local' | 'news' | 'web' | 'encyc',
        display: number,
        sort: 'sim' | 'date' | 'comment' | 'random'
    ): Promise<SearchResult[]> {
        const clientId = this.configService.get<string>('NAVER_CLIENT_ID');
        const clientSecret = this.configService.get<string>('NAVER_CLIENT_SECRET');
        if (!clientId || !clientSecret) {
            this.logger.warn('[Naver 검색] API 키 없음');
            return [];
        }

        const endpoints: Record<string, string> = {
            local: 'https://openapi.naver.com/v1/search/local.json',
            news: 'https://openapi.naver.com/v1/search/news.json',
            web: 'https://openapi.naver.com/v1/search/webkr.json',
            encyc: 'https://openapi.naver.com/v1/search/encyc.json',
        };
        
        const endpoint = endpoints[type];
        const url = new URL(endpoint);
        url.searchParams.set('query', query);
        url.searchParams.set('display', String(display));
        
        if (type === 'local' || type === 'news') {
            url.searchParams.set('sort', sort);
        }

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

        if (localResults.length > 0) {
            const primary = localResults[0];
            const newsHighlight = newsResults.length > 0
                ? this.extractNewsHighlight(newsResults[0])
                : null;
            merged.push({ ...primary, newsHighlight: newsHighlight || undefined });
        }

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
    // Cache
    // ============================================================

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
    // Helpers
    // ============================================================

    private isMeaninglessQuery(query: string): boolean {
        const trimmed = query.trim();
        if (!trimmed) return true;
        
        const words = trimmed.split(/\s+/);
        const meaningfulWords = words.filter(word => {
            const cleaned = word.replace(/[.,?!]/g, '');
            return cleaned.length > 0 && !this.MEANINGLESS_KEYWORDS.includes(cleaned);
        });
        
        return meaningfulWords.length === 0;
    }

    private isGreeting(query: string): boolean {
        const trimmed = query.trim().toLowerCase();
        
        for (const greeting of this.GREETING_KEYWORDS) {
            if (trimmed === greeting || trimmed === greeting + '요' || trimmed === greeting + '용') {
                return true;
            }
        }
        
        if (trimmed.length <= 5) {
            for (const greeting of this.GREETING_KEYWORDS) {
                if (trimmed.startsWith(greeting)) {
                    return true;
                }
            }
        }
        
        return false;
    }

    extractLocation(text: string): string | null {
        for (const loc of this.LOCATIONS) {
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

    private stripHtml(text: string): string {
        return text.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }
}