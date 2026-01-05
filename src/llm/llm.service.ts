import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { RagClientService } from '../rag/rag-client.service';
import { SearchService, SearchResult, SearchType } from './search.service';
import { MapService } from './map.service';

@Injectable()
export class LlmService {
    private readonly logger = new Logger(LlmService.name);
    private bedrockClient: BedrockRuntimeClient;
    private readonly modelId = 'anthropic.claude-3-haiku-20240307-v1:0';

    private lastRequestTime = 0;
    private isProcessing = false;
    private readonly MIN_REQUEST_INTERVAL = 1500;
    private readonly MAX_RETRIES = 3;

    constructor(
        private configService: ConfigService,
        private ragClientService: RagClientService,
        private searchService: SearchService,
        private mapService: MapService,
    ) {
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
                    this.logger.log(`[검색 스킵] 카테고리/키워드 없음`);
                    return { 
                        text: '네, 무엇을 도와드릴까요? 무엇이든 검색해드릴게요!',
                        searchResults: undefined 
                    };
                }

                this.logger.log(`[검색] type=${searchType}, query="${query}"`);
                searchResults = await this.searchService.search(query, searchType);
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
                return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 "${location}" "${timeWord}" 날씨를 물어봤습니다.

## 응답 규칙
1. **${location}** 날씨만 답변 (다른 지역 절대 금지)
2. **${timeWord}** 정보만 답변
3. 2문장 이내로 간결하게
4. 기호 금지: ° → "도", % → "퍼센트"

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
                return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 "${location}" 근처 ${matchedCategory}을 찾고 있습니다.

## 응답 규칙
1. 검색 결과 중 **첫 번째 장소 1개만** 추천
2. 상호명을 정확히 말하기
3. 주소 간단히 언급
4. 2문장 이내
5. 마지막에 "해당 지점까지 경로를 채팅창으로 공유드릴게요" 추가

## 검색 결과 (첫 번째만 사용)
${JSON.stringify(searchResults[0])}`;
            }

            case '팝업':
            case '전시': {
                return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 "${location}" 근처 ${matchedCategory} 정보를 찾고 있습니다.

## 응답 규칙
1. 어떤 ${matchedCategory}이 열리는지 언급
2. 장소가 있으면 위치 언급
3. 2-3문장 이내
${hasLocation ? '4. 마지막에 "해당 위치까지 경로를 채팅창으로 공유드릴게요" 추가' : ''}

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            case '영화': {
                const movieNews = searchResults.filter(r => !r.address && !r.roadAddress);
                const movieTheaters = searchResults.filter(r => r.address || r.roadAddress);
                const hasTheater = movieTheaters.length > 0;

                return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 영화 관련 정보를 찾고 있습니다.

## 응답 규칙
1. 최근 인기/개봉 영화 1-2개 소개 (영화 제목만)
2. "근처 영화관도 알려드릴게요!" 추가
3. 3문장 이내
${hasTheater ? '4. 마지막에 "해당 영화관까지 경로를 채팅창으로 공유드릴게요" 추가' : ''}

## 주의사항
- 줄거리/리뷰 내용 절대 금지

## 검색 결과 - 영화 뉴스
${JSON.stringify(movieNews.slice(0, 2), null, 2)}

## 검색 결과 - 근처 영화관
${JSON.stringify(movieTheaters.slice(0, 1), null, 2)}`;
            }

            case '뉴스':
            case '주식':
            case '스포츠': {
                return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 ${matchedCategory} 정보를 물어봤습니다.

## 응답 규칙
1. 검색 결과를 요약해서 전달
2. 2-3문장 이내
3. 장소 관련 표현 금지

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            case '백과': {
                return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 특정 개념/정의에 대해 물어봤습니다.

## 응답 규칙
1. 검색 결과를 쉽게 요약해서 설명
2. 2-3문장 이내로 핵심만
3. 장소 관련 표현 금지

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2), null, 2)}`;
            }

            default: {
                if (searchResults.length === 0) {
                    return `당신은 화상회의 AI 비서 '아우라'입니다.

## 응답 규칙
- 사용자가 무엇을 원하는지 친절하게 물어보기
- 1-2문장 이내`;
                }

                if (hasLocation) {
                    return `당신은 화상회의 AI 비서 '아우라'입니다.

## 응답 규칙
1. 검색 결과 중 **1개만** 추천
2. 2문장 이내
3. 마지막에 "해당 지점까지 경로를 채팅창으로 공유드릴게요" 추가

## 검색 결과
${JSON.stringify(searchResults[0])}`;
                }

                return `당신은 화상회의 AI 비서 '아우라'입니다.

## 응답 규칙
- 검색 결과를 간단히 요약
- 2문장 이내

## 검색 결과
${JSON.stringify(searchResults.slice(0, 2))}`;
            }
        }
    }

    private buildNoResultPrompt(category: string, location: string): string {
        return `당신은 화상회의 AI 비서 '아우라'입니다.

사용자가 "${location}" 근처 ${category}을 찾았지만 검색 결과가 없습니다.

## 응답 규칙
- 결과가 없다고 안내
- 다른 검색어나 지역을 제안
- 1-2문장 이내`;
    }

    // ============================================================
    // Response Builders
    // ============================================================

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