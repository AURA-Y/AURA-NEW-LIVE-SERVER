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
        // TODO.. rag service 연결 필요
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
        searchType: 'local' | 'news' | 'hybrid';
        category: string | null;
    }> {
        const base = this.normalizeSearchQuery(rawQuery) || rawQuery.trim();

        // 1. 날씨
        const weatherKeywords = ['날씨', '기온', '온도', '비', '눈', '미세먼지', '우산', '더워', '추워'];
        if (weatherKeywords.some(kw => base.includes(kw))) {
            const location = this.extractLocation(base) || '서울';
            const timeWord = base.includes('내일') ? '내일' :
                base.includes('모레') ? '모레' :
                    base.includes('이번주') ? '이번주' : '오늘';
            const query = `${location} ${timeWord} 날씨`;
            this.logger.log(`[검색 계획] 날씨 → query="${query}"`);
            return { query, cacheKey: `weather|${query}`, searchType: 'news', category: '날씨' };
        }

        // 2. 팝업/전시/영화 (hybrid)
        const hybridKeywords = ['팝업', '팝업스토어', '전시', '전시회', '영화', '공연', '콘서트', '페스티벌', '축제'];
        const hybridMatch = hybridKeywords.find(kw => base.includes(kw));
        if (hybridMatch) {
            const location = this.extractLocation(base);
            const query = location ? `${location} ${hybridMatch}` : hybridMatch;
            this.logger.log(`[검색 계획] 하이브리드 → query="${query}"`);
            return { query, cacheKey: `hybrid|${query}`, searchType: 'hybrid', category: hybridMatch };
        }

        // 3. 장소 (local)
        const localKeywords = ['카페', '맛집', '식당', '술집', '빵집', '디저트', '치킨', '피자', '분식'];
        const localMatch = localKeywords.find(kw => base.includes(kw));
        if (localMatch) {
            const location = this.extractLocation(base);
            const query = location ? `${location} ${localMatch}` : localMatch;
            this.logger.log(`[검색 계획] 장소 → query="${query}"`);
            return { query, cacheKey: `local|${query}`, searchType: 'local', category: localMatch };
        }

        // 4. 그 외 (news 폴백)
        const fallbackCategory = this.pickCategoryLabel(rawQuery, []);
        const query = base
            .replace(/[을를이가은는에서의으로]/g, ' ')
            .replace(/알려줘|추천해줘|찾아줘|검색해줘/g, '')
            .replace(/\s+/g, ' ')
            .trim() || base;
        this.logger.log(`[검색 계획] 폴백 → query="${query}"`);
        return { query, cacheKey: `news|${query}`, searchType: 'news', category: fallbackCategory };
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

            // 장소 검색이면 단일 추천 형식
            if (searchResults && searchResults.length > 0) {
                const hasLocation = searchResults.some(r => r.address || r.roadAddress);
                if (hasLocation) {
                    // 장소 검색 → 단일 추천 (안전)
                    finalMessage = this.buildSingleRecommendation(searchResults[0]);
                } else {
                    // 뉴스/날씨 등 → 할루시네이션 검증
                    finalMessage = this.validateSearchAnswer(finalMessage, searchResults);
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
        // 날씨
        const weatherKeywords = ['날씨', '기온', '온도', '비', '눈', '미세먼지', '우산', '더워', '추워'];
        if (weatherKeywords.some(kw => userMessage.includes(kw))) {
            const location = this.extractLocation(userMessage) || '서울';
            const timeWord = userMessage.includes('내일') ? '내일' :
                userMessage.includes('모레') ? '모레' :
                    userMessage.includes('이번주') ? '이번주' : '오늘';

            return `당신은 화상회의 AI 비서입니다.

사용자가 "${location}" "${timeWord}" 날씨를 물어봤습니다.

## 응답 규칙
1. **${location}** 날씨만 답변 (다른 지역 절대 금지)
2. **${timeWord}** 정보만 답변 (다른 날짜 금지)
3. 2문장 이내
4. 기호 금지: ° → "도", % → "퍼센트"

## 응답 예시
"${location} ${timeWord}은 아침 영하 4도, 낮 5도예요. 따뜻하게 입으세요!"

## 검색 결과
${searchResults.map(r => r.content || r.title).join('\n').slice(0, 500)}`;
        }

        // 팝업/전시/영화 (hybrid)
        const hybridKeywords = ['팝업', '전시', '영화', '공연', '콘서트', '페스티벌'];
        if (hybridKeywords.some(kw => userMessage.includes(kw))) {
            const location = this.extractLocation(userMessage) || '서울';
            const category = hybridKeywords.find(kw => userMessage.includes(kw)) || '팝업';
            const hasLocation = searchResults.some(r => r.address || r.roadAddress);

            return `당신은 화상회의 AI 비서입니다.

사용자가 "${location}" 근처 ${category} 정보를 물어봤습니다.

## 응답 규칙
1. 최신 정보: 어떤 ${category}이 열리는지 (뉴스에서)
2. 장소 정보: 위치가 있으면 주소 언급
3. ${hasLocation ? '마지막에 "해당 위치까지 경로를 채팅창으로 공유드릴게요" 추가' : ''}
4. 2-3문장 이내

## 응답 예시
"${location}에서 지금 OOO ${category}이 열리고 있어요. OO역 근처에 있어요.${hasLocation ? ' 해당 위치까지 경로를 채팅창으로 공유드릴게요!' : ''}"

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
        }

        // 장소 검색
        if (searchResults.length > 0 && (searchResults[0].address || searchResults[0].roadAddress)) {
            return `당신은 화상회의 AI 비서 '빅스'입니다.

## 응답 규칙
1. 검색 결과 중 **1개만** 추천
2. 상호명 정확히 말하기
3. 2문장 이내
4. 마지막에 "해당 지점까지 경로를 채팅창으로 공유드릴게요" 추가

## 검색 결과
${JSON.stringify(searchResults[0])}`;
        }

        // 기본
        return `당신은 화상회의 AI 비서 '빅스'입니다.

## 응답 규칙
- 1-2문장, 30-80자 이내
- 친근한 존댓말
- 기호 금지: ° → "도", % → "퍼센트"
- 질문한 주제만 답변

${searchResults.length > 0 ? `## 검색 결과\n${JSON.stringify(searchResults.slice(0, 2))}` : ''}`;
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
            return {
                origin: { lng: originLng, lat: originLat },
                destination: { lng: '0', lat: '0', name: result.title || '' },
                distance: 0,
                durationMs: 0,
                directionUrl: result.directionUrl,
            };
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

    private buildSingleRecommendation(result: SearchResult): string {
        const title = result.title || '해당 장소';
        const address = result.roadAddress || result.address || '';
        const newsHighlight = (result as any).newsHighlight;

        let response = `${title}을 추천해요.`;
        if (newsHighlight) {
            response += ` ${newsHighlight}까지 한대요.`;
        }
        if (address) {
            response += ` ${address}에 있어요.`;
        }
        response += ' 해당 지점까지 경로를 채팅창으로 공유드릴게요.';

        return response.replace(/\s+/g, ' ').trim();
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
                const { query, searchType } = await this.buildSearchPlan(intentAnalysis.normalizedText);
                return {
                    shouldRespond: true,
                    correctedText: intentAnalysis.normalizedText,
                    searchKeyword: query,
                    searchType: searchType === 'hybrid' ? 'local' : searchType,
                    category: intentAnalysis.category || null,
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

    // Helpers 섹션에 추가

    /**
     * LLM이 검색 결과에 없는 장소명을 지어내는 것 방지
     */
    private validateSearchAnswer(answer: string, results: SearchResult[]): string {
        // 검색 결과에서 모든 한글 단어 추출
        const sourceText = results.map(r => `${r.title} ${r.content}`).join(' ');
        const sourceWords = new Set(this.extractKoreanPhrases(sourceText));

        // LLM 응답에서 한글 단어 추출
        const answerWords = this.extractKoreanPhrases(answer);

        // 검색 결과에 없는 고유명사가 있는지 확인 (2글자 이상)
        const hasHallucination = answerWords.some(
            word => word.length >= 2 && !sourceWords.has(word)
        );

        if (hasHallucination) {
            this.logger.warn(`[할루시네이션 감지] LLM이 검색 결과에 없는 내용 생성 - 폴백 사용`);
            // 검색 결과 첫 번째 항목으로 안전하게 응답
            if (results.length > 0) {
                return this.buildSingleRecommendation(results[0]);
            }
            return '검색 결과를 확인해주세요.';
        }

        return answer;
    }

    private extractKoreanPhrases(text: string): string[] {
        const matches = text.match(/[가-힣]{2,}/g);
        return matches || [];
    }
}