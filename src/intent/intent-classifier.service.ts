import { Injectable, Logger } from '@nestjs/common';

export interface IntentAnalysis {
    isCallIntent: boolean;
    isQuestionIntent: boolean;
    isBotRelated: boolean;
    confidence: number;
    matchedPatterns: string[];
    normalizedText: string;
    hasQuestionWord: boolean;
    hasCommandWord: boolean;
    hasQuestionPattern: boolean;
    hasRequestPattern: boolean;
    isWeatherIntent: boolean;
    searchDomain?: 'weather' | 'naver' | null;
    searchType?: 'local' | 'news' | null;
    category?: string | null;
    extractedKeyword?: string | null;
    needsLlmCorrection: boolean;
}

@Injectable()
export class IntentClassifierService {
    private readonly logger = new Logger(IntentClassifierService.name);

    // =====================================================
    // 웨이크워드 관련
    // =====================================================

    private readonly WAKE_WORDS_EXACT = [
        '빅스야', '빅스비', '빅스비야', '헤이 빅스', '헤이빅스',
    ];

    private readonly WAKE_WORDS_VARIANTS = [
        // ㅂ↔ㅁ↔ㅍ↔ㄱ 혼동
        '믹스야', '픽스야', '빅사야', '믹사야', '핔스야', '밐스야', '긱스야', '긱쓰야',
        // ㅅ↔ㅆ↔ㅈ↔ㅊ 혼동
        '빅쓰야', '빅쓰', '빅쯔야', '빅즈야', '빅츠야', '빅쓰요',
        // 모음 혼동
        '빅수야', '비수야', '빅소야', '벅스야', '벅수야', '빅서야', '빅시야',
        // 받침 탈락/변형
        '빅세야', '빅세오', '빅세', '빅새야', '빅쎄야', '빅쎄',
        '익수야', '익사', '익쇠야', '익스야', '이수야', '잌스야', '익수', '익스',
        // 띄어쓰기 변형
        '빅스 야', '빅 스야', '빅스아', '빅스 아', '빅 스 야',
        // 헤이빅스 변형
        '헤이 빅쓰', '해이빅스', '해빅스', '헤빅스', '헤이빅쓰',
        '에이빅스', '에이 빅스', '헤이 빅사', '헤이 믹스', '해이 빅스',
        '혜이빅스', '혜빅스', '헤이 빅세', '해 빅스', '헤이빅사',
        // 기타
        '페이비스', '헤이픽스', '페이빅스', '픽스야', '픽스',
        '빅스요', '빅스 요', '빅쓰요',
    ];

    private readonly WAKE_WORDS = [...this.WAKE_WORDS_EXACT, ...this.WAKE_WORDS_VARIANTS];
    private readonly WAKE_WORD_MAX_TOKENS = 3;

    // =====================================================
    // STT 보정 패턴 (대폭 확장)
    // =====================================================

    private readonly STT_CORRECTIONS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
        // === 영어 혼입 ===
        { pattern: /\b(hay|hey|hae|he)\s*(box|bix|bics|bicks|vix)\b/gi, replacement: '헤이 빅스', label: 'en_heybix' },
        { pattern: /\b(k|ka)\s*(bix|bics)\b/gi, replacement: '헤이 빅스', label: 'en_kabix' },
        { pattern: /\b(pay|pae|pai)\s*(bix|bics)\b/gi, replacement: '페이비스', label: 'en_paybix' },
        { pattern: /\bbix\b|\bvix\b|\bbicks\b/gi, replacement: '빅스', label: 'en_bix' },
        { pattern: /\bmix\s*(ya|ah)?\b/gi, replacement: '빅스야', label: 'en_mix' },

        // === 헤이빅스 변형 ===
        { pattern: /^(헤이|해이|해|헤|에이|혜이|혜)\s*(빅스|빅쓰|믹스|빅사|빅세|픽스|빅수|비수)/gi, replacement: '헤이 빅스', label: 'heybix' },
        { pattern: /헤이\s*빅스비온/gi, replacement: '헤이 빅스 오늘', label: 'heybix_on' },

        // === 초성 혼동 ===
        { pattern: /^(믹스|픽스|밐스|핔스|긱스|긱쓰)(야|아)?(\s|$)/gi, replacement: '빅스야 ', label: 'cho_mix' },

        // === 중성 혼동 ===
        { pattern: /^(빅수|비수|빅소|벅스|벅수|빅서|비스|빅시)(야|아)?(\s|$)/gi, replacement: '빅스야 ', label: 'jung_bisu' },

        // === 종성 혼동/탈락 ===
        { pattern: /^(빅세|빅쎄|빅새|빅쩨)(야|오|아)?(\s|$)/gi, replacement: '빅스야 ', label: 'jong_se' },
        { pattern: /^(익수|익사|익쇠|익스|이수|잌스)(야|아)?(\s|$)/gi, replacement: '빅스야 ', label: 'jong_ik' },
        { pattern: /^(빅쓰|빅쯔|빅즈|빅츠)(야|아)?(\s|$)/gi, replacement: '빅스야 ', label: 'jong_ss' },

        // === 띄어쓰기 ===
        { pattern: /빅\s+스\s*(야|아)/gi, replacement: '빅스야', label: 'space1' },
        { pattern: /빅\s*스\s*비\s*(야|아)?/gi, replacement: '빅스비야', label: 'space2' },

        // === 특수 변형 ===
        { pattern: /에이\s*빅스(야|아)?/gi, replacement: '빅스야', label: 'ay_bix' },
        { pattern: /에이\s*비수(야|아)?/gi, replacement: '빅스야', label: 'ay_bisu' },
        { pattern: /빅스(아|여)(\s|$)/gi, replacement: '빅스야 ', label: 'bixa' },
        { pattern: /빅스\s*요/gi, replacement: '빅스야', label: 'bixyo' },
        { pattern: /(페이|패이)\s*(비스|빅스)/gi, replacement: '페이비스', label: 'paybis' },
        { pattern: /헤이\s*픽스/gi, replacement: '헤이픽스', label: 'heypix' },
        { pattern: /^픽스(야|아)?(\s|$)/gi, replacement: '빅스야 ', label: 'pix' },

        // === 일반 오타 ===
        { pattern: /달씨/gi, replacement: '날씨', label: 'weather' },
        { pattern: /카페\s*거래/gi, replacement: '카페', label: 'cafe' },
    ];

    // =====================================================
    // 카테고리별 키워드
    // =====================================================

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

    // =====================================================
    // 질문/명령 관련
    // =====================================================

    private readonly QUESTION_WORDS = [
        '뭐', '무엇', '어디', '언제', '누구', '누가', '왜', '어떻게', '어떤', '몇',
        '어느', '얼마', '무슨', '어찌',
    ];

    private readonly COMMAND_WORDS = [
        '알려줘', '말해줘', '보여줘', '찾아줘', '검색해줘', '물어봐',
        '알려', '말해', '보여', '찾아', '검색해', '설명해줘', '설명해',
        '가르쳐줘', '가르쳐', '추천해줘', '추천해', '해줘', '해봐',
        '알려줄래', '말해줄래', '보여줄래', '찾아줄래', '추천해줄래',
        '해줄래', '해줘요', '해주세요', '부탁해', '부탁해요',
    ];

    private readonly BOT_REFERENCES = [
        '너', '니가', '당신', '네가', '넌',
        '빅스', '빅스야', '빅스비', '빅스비야',
    ];

    private readonly QUESTION_PATTERNS = [
        /\?$/, /뭐야$/, /뭐지$/, /뭔데$/, /어때$/, /어때요$/,
        /[가-힣]+까$/, /[가-힣]+니$/, /[가-힣]+나$/, /[가-힣]+냐$/,
    ];

    private readonly REQUEST_PATTERNS = [
        /해\s?줄래(요)?$/, /해\s?줘(요)?$/, /해\s?주세요$/,
        /줄래(요)?$/, /될까요?$/, /되나요?$/,
    ];

    // =====================================================
    // 퍼지 매칭 관련
    // =====================================================

    private decomposeHangul(str: string): string[] {
        const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
        const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
        const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

        const result: string[] = [];
        for (const char of str) {
            const code = char.charCodeAt(0) - 0xAC00;
            if (code < 0 || code > 11171) {
                result.push(char);
                continue;
            }
            result.push(CHO[Math.floor(code / 588)]);
            result.push(JUNG[Math.floor((code % 588) / 28)]);
            const jong = JONG[code % 28];
            if (jong !== ' ') result.push(jong);
        }
        return result;
    }

    private readonly SIMILAR_JAMO: Record<string, string[]> = {
        'ㅂ': ['ㅁ', 'ㅍ', 'ㅃ'],
        'ㅁ': ['ㅂ', 'ㄴ'],
        'ㄱ': ['ㅋ', 'ㄲ'],
        'ㅅ': ['ㅆ', 'ㅈ', 'ㅊ'],
        'ㅈ': ['ㅅ', 'ㅆ', 'ㅊ', 'ㅉ'],
        'ㅜ': ['ㅡ', 'ㅗ'],
        'ㅡ': ['ㅜ', 'ㅣ', 'ㅓ'],
        'ㅗ': ['ㅜ', 'ㅓ'],
        'ㅏ': ['ㅑ', 'ㅐ', 'ㅓ'],
        'ㅓ': ['ㅕ', 'ㅔ', 'ㅏ', 'ㅗ'],
        'ㅣ': ['ㅡ', 'ㅢ'],
    };

    private isSimilarJamo(a: string, b: string): boolean {
        if (a === b) return true;
        return this.SIMILAR_JAMO[a]?.includes(b) || this.SIMILAR_JAMO[b]?.includes(a);
    }

    private jamoSimilarity(a: string, b: string): number {
        const jamoA = this.decomposeHangul(a.toLowerCase());
        const jamoB = this.decomposeHangul(b.toLowerCase());

        const maxLen = Math.max(jamoA.length, jamoB.length);
        const minLen = Math.min(jamoA.length, jamoB.length);

        if (maxLen === 0) return 0;
        if (Math.abs(jamoA.length - jamoB.length) > 3) return 0;

        let matches = 0;
        for (let i = 0; i < minLen; i++) {
            if (jamoA[i] === jamoB[i]) {
                matches += 1;
            } else if (this.isSimilarJamo(jamoA[i], jamoB[i])) {
                matches += 0.6;
            }
        }

        return matches / maxLen;
    }

    private fuzzyMatchWakeWord(text: string): { matched: boolean; word: string; similarity: number } {
        const tokens = text.toLowerCase().split(/\s+/).slice(0, 4);
        const targets = ['빅스야', '빅스비', '헤이빅스'];
        const threshold = 0.6;

        for (const token of tokens) {
            if (token.length < 2) continue;

            for (const target of targets) {
                const similarity = this.jamoSimilarity(token, target);
                if (similarity >= threshold) {
                    return { matched: true, word: target, similarity };
                }
            }

            // "헤이 빅스" 분리된 경우
            if (['헤이', '해이', '에이', '혜이', '해', '헤'].includes(token)) {
                const nextIdx = tokens.indexOf(token) + 1;
                if (nextIdx < tokens.length) {
                    const nextSim = this.jamoSimilarity(tokens[nextIdx], '빅스');
                    if (nextSim >= 0.5) {
                        return { matched: true, word: '헤이 빅스', similarity: nextSim };
                    }
                }
            }
        }

        return { matched: false, word: '', similarity: 0 };
    }

    private mightHaveWakeWord(text: string): boolean {
        const first40 = text.slice(0, 40).toLowerCase();

        const patterns = [
            /[빅믹픽긱비벅익밐핔잌][스쓰수세사쇠즈츠서소시]/,
            /헤이|해이|에이|혜이|해\s|헤\s/,
            /페이비|픽스|bix|vix|mix/i,
        ];

        return patterns.some(p => p.test(first40));
    }

    private readonly WAKE_WORD_PATTERNS: RegExp[] = [
        /^[빅믹픽긱비벅밐핔][스쓰수세사쇠즈츠서소시][야아요]?/,
        /^[익이잌][스쓰수쇠사][야아]?/,
        /^헤이?\s*[빅믹픽][스쓰세사수]/,
        /^[해헤에혜][이]?\s*[빅믹]/,
    ];

    private regexMatchWakeWord(text: string): boolean {
        const normalized = text.toLowerCase().trim();
        return this.WAKE_WORD_PATTERNS.some(p => p.test(normalized));
    }

    // =====================================================
    // 카테고리 및 키워드 추출
    // =====================================================

    private detectCategory(text: string): { category: string | null; searchType: 'local' | 'news' | null } {
        const lowerText = text.toLowerCase();

        for (const [category, config] of Object.entries(this.CATEGORY_KEYWORDS)) {
            for (const keyword of config.keywords) {
                if (lowerText.includes(keyword.toLowerCase())) {
                    return { category, searchType: config.searchType };
                }
            }
        }

        return { category: null, searchType: null };
    }

    private extractKeyword(text: string, category: string | null): string | null {
        // 웨이크워드 제거
        let cleaned = text;
        for (const wake of this.WAKE_WORDS) {
            cleaned = cleaned.replace(new RegExp(wake, 'gi'), '').trim();
        }

        // 명령어 제거
        for (const cmd of this.COMMAND_WORDS) {
            cleaned = cleaned.replace(new RegExp(cmd, 'gi'), '').trim();
        }

        // 조사/어미 제거
        cleaned = cleaned
            .replace(/\b(을|를|이|가|은|는|에서|에|의|으로|로|과|와|도|만|부터|까지|처럼|같은|좀|한번|하나|거|것|데|줘|줄래|해줘)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (!cleaned || cleaned.length < 2) return null;

        return cleaned;
    }

    // =====================================================
    // 메인 로직
    // =====================================================

    private normalizeText(text: string, matchedPatterns: string[]): string {
        let normalized = text.trim();

        for (const rule of this.STT_CORRECTIONS) {
            if (rule.pattern.test(normalized)) {
                const before = normalized;
                normalized = normalized.replace(rule.pattern, rule.replacement);
                if (before !== normalized) {
                    matchedPatterns.push(`보정: ${rule.label}`);
                }
            }
            rule.pattern.lastIndex = 0;
        }

        return normalized.trim();
    }

    private isWakeWordInLeadingTokens(text: string, wakeWord: string): boolean {
        const lowerText = text.toLowerCase();
        const lowerWake = wakeWord.toLowerCase();
        const index = lowerText.indexOf(lowerWake);

        if (index < 0) return false;

        const before = lowerText.slice(0, index).trim();
        if (!before) return true;

        const tokens = before.split(/\s+/).filter(Boolean);
        return tokens.length < this.WAKE_WORD_MAX_TOKENS;
    }

    classify(text: string): IntentAnalysis {
        const matchedPatterns: string[] = [];

        // 1. STT 보정
        const normalizedText = this.normalizeText(text, matchedPatterns);
        const lowerNormalized = normalizedText.toLowerCase();

        let confidence = 0;
        let isCallIntent = false;

        // 2. 정확한 웨이크워드 매칭
        for (const word of this.WAKE_WORDS) {
            if (this.isWakeWordInLeadingTokens(lowerNormalized, word.toLowerCase())) {
                matchedPatterns.push(`웨이크워드(정확): ${word}`);
                confidence += 0.6;
                isCallIntent = true;
                break;
            }
        }

        // 3. 정규식 패턴 매칭
        if (!isCallIntent && this.regexMatchWakeWord(lowerNormalized)) {
            matchedPatterns.push('웨이크워드(정규식)');
            confidence += 0.5;
            isCallIntent = true;
        }

        // 4. 퍼지 매칭
        if (!isCallIntent) {
            const fuzzyResult = this.fuzzyMatchWakeWord(lowerNormalized);
            if (fuzzyResult.matched) {
                matchedPatterns.push(`웨이크워드(퍼지): ${fuzzyResult.word} (${fuzzyResult.similarity.toFixed(2)})`);
                confidence += 0.3 + (fuzzyResult.similarity * 0.2);
                isCallIntent = true;
            }
        }

        // 5. 카테고리 및 검색타입 감지
        const { category, searchType } = this.detectCategory(lowerNormalized);
        if (category) {
            matchedPatterns.push(`카테고리: ${category}`);
        }

        // 6. 키워드 추출
        const extractedKeyword = this.extractKeyword(normalizedText, category);

        // 7. 의문사 체크
        const hasQuestionWord = this.QUESTION_WORDS.some(word => {
            if (lowerNormalized.includes(word)) {
                matchedPatterns.push(`의문사: ${word}`);
                confidence += 0.2;
                return true;
            }
            return false;
        });

        // 8. 명령어 체크
        const hasCommandWord = this.COMMAND_WORDS.some(word => {
            if (lowerNormalized.includes(word.toLowerCase())) {
                matchedPatterns.push(`명령어: ${word}`);
                confidence += 0.25;
                return true;
            }
            return false;
        });

        // 9. 질문 패턴 체크
        const hasQuestionPattern = this.QUESTION_PATTERNS.some(pattern => {
            if (pattern.test(lowerNormalized)) {
                matchedPatterns.push(`패턴: ${pattern.source}`);
                confidence += 0.15;
                return true;
            }
            return false;
        });

        // 10. 요청 패턴 체크
        const hasRequestPattern = this.REQUEST_PATTERNS.some(pattern => {
            if (pattern.test(lowerNormalized)) {
                matchedPatterns.push(`요청: ${pattern.source}`);
                confidence += 0.3;
                return true;
            }
            return false;
        });

        // 11. 봇 호칭 체크
        const isBotRelated = this.BOT_REFERENCES.some(word => {
            const regex = new RegExp(`(^|\\s)${word}($|\\s|[^가-힣])`, 'i');
            if (regex.test(lowerNormalized)) {
                confidence += 0.15;
                return true;
            }
            return false;
        });

        // 12. 날씨 체크 (카테고리로 대체)
        const isWeatherIntent = category === '날씨';

        // 질문 의도 판단
        const isQuestionIntent = hasQuestionWord || hasCommandWord || hasQuestionPattern || hasRequestPattern;

        // 검색 도메인 결정
        let searchDomain: 'weather' | 'naver' | null = null;
        if (isQuestionIntent || isCallIntent) {
            searchDomain = isWeatherIntent ? 'weather' : 'naver';
        }

        // 신뢰도 정규화
        confidence = Math.min(confidence, 1.0);

        // LLM 보정 필요 여부
        const needsLlmCorrection = !isCallIntent &&
            this.mightHaveWakeWord(text) &&
            confidence < 0.5;

        const result: IntentAnalysis = {
            isCallIntent,
            isQuestionIntent,
            isBotRelated,
            confidence,
            matchedPatterns,
            normalizedText,
            hasQuestionWord,
            hasCommandWord,
            hasQuestionPattern,
            hasRequestPattern,
            isWeatherIntent,
            searchDomain,
            searchType,
            category,
            extractedKeyword,
            needsLlmCorrection,
        };

        this.logger.debug(`[의도 분석] "${text.substring(0, 30)}..." → call=${isCallIntent}, conf=${confidence.toFixed(2)}, cat=${category}, keyword=${extractedKeyword}`);

        return result;
    }

    shouldRespond(text: string): boolean {
        const intent = this.classify(text);
        return this.shouldRespondFromAnalysis(intent);
    }

    shouldRespondFromAnalysis(intent: IntentAnalysis): boolean {
        const should = intent.isCallIntent ||
            (intent.isQuestionIntent && intent.isBotRelated) ||
            (intent.isQuestionIntent && intent.hasCommandWord && intent.confidence >= 0.4) ||
            (intent.isQuestionIntent && intent.hasRequestPattern);

        this.logger.log(`[응답 판단] "${intent.normalizedText.substring(0, 30)}..." → ${should ? '✅' : '❌'} (conf: ${intent.confidence.toFixed(2)}, cat: ${intent.category})`);

        return should;
    }

    shouldWakeFromSleep(text: string): boolean {
        const intent = this.classify(text);
        return this.shouldWakeFromSleepAnalysis(intent);
    }

    shouldWakeFromSleepAnalysis(intent: IntentAnalysis): boolean {
        return intent.isCallIntent ||
            intent.hasCommandWord ||
            intent.hasRequestPattern ||
            (intent.hasQuestionWord && intent.hasQuestionPattern) ||
            (intent.isQuestionIntent && intent.confidence >= 0.6);
    }
}