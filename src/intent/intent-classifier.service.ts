import { Injectable, Logger } from '@nestjs/common';

export interface IntentAnalysis {
    isCallIntent: boolean;
    isQuestionIntent: boolean;
    isBotRelated: boolean;
    isVisionIntent: boolean;  // 화면 공유 Vision 관련 의도
    isIdeaBoardIntent: boolean;  // 아이디어 보드 열기 의도
    isFlowchartIntent: boolean;  // Flowchart 보드 열기 의도
    isCalendarIntent: boolean;  // 캘린더/일정 추천 의도
    confidence: number;
    matchedPatterns: string[];
    normalizedText: string;
    hasQuestionWord: boolean;
    hasCommandWord: boolean;
    hasQuestionPattern: boolean;
    hasRequestPattern: boolean;
    isWeatherIntent: boolean;
    searchDomain?: 'weather' | 'naver' | null;
    searchType?: 'local' | 'news' | 'web' | 'encyc' | 'hybrid' | 'none' | null;
    category?: string | null;
    extractedKeyword?: string | null;
    needsLlmCorrection: boolean;
}

@Injectable()
export class IntentClassifierService {
    private readonly logger = new Logger(IntentClassifierService.name);

    // =====================================================
    // 웨이크워드 관련 (아우라)
    // =====================================================

    private readonly WAKE_WORDS_EXACT = [
        '아우라', '아우라야', '헤이 아우라', '헤이아우라', '페이아우라', '페이 아우라',
    ];

    private readonly WAKE_WORDS_VARIANTS = [
        // ㅜ↔ㅗ 혼동
        '아오라', '아오라야', '오우라', '오우라야',
        // ㅏ↔ㅓ 혼동
        '어우라', '어우라야', '아어라', '아어라야',
        // ㄹ↔ㄴ 혼동
        '아우나', '아우나야', '아우라나',
        // 받침 추가
        '아울라', '아울라야', '아운라', '아운라야',
        // ㄹ↔ㄷ 혼동  
        '아우다', '아우다야',
        // 띄어쓰기 변형
        '아 우라', '아우 라', '아우라 야', '아 우 라',
        // "라" 누락 변형 (STT 오인식)
        '아우 야', '아우야', '아 야',
        // 헤이아우라 변형
        '헤이 아우라야', '해이아우라', '해이 아우라', '해 아우라',
        '헤이 아오라', '헤이 오우라', '헤이 아울라',
        '에이아우라', '에이 아우라', '혜이아우라', '혜이 아우라',
        // 어미 변형
        '아우라요', '아우라 요', '아우라여',
        // 기타 발음 변형
        '아우러', '아우러야', '아우리', '아우리야',
        '아위라', '아위라야', '아웨라', '아웨라야',
    ];

    private readonly WAKE_WORDS = [...this.WAKE_WORDS_EXACT, ...this.WAKE_WORDS_VARIANTS];
    private readonly WAKE_WORD_MAX_TOKENS = 4;

    // =====================================================
    // STT 보정 패턴 (아우라용)
    // =====================================================

    private readonly STT_CORRECTIONS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
        // === 영어 혼입 ===
        { pattern: /\b(hey|hay|hae)\s*(aura|oura|awra)\b/gi, replacement: '헤이 아우라', label: 'en_heyaura' },
        { pattern: /\baura\b|\boura\b|\bawra\b/gi, replacement: '아우라', label: 'en_aura' },

        // === 헤이아우라 변형 ===
        { pattern: /^(헤이|해이|해|헤|에이|혜이|혜)\s*(아우라|아오라|오우라|아울라|어우라)/gi, replacement: '헤이 아우라', label: 'heyaura' },

        // === 모음 혼동 ===
        { pattern: /^(아오라|오우라|어우라)(야|아)?(\s|$)/gi, replacement: '아우라야 ', label: 'vowel_aora' },

        // === 자음 혼동 ===
        { pattern: /^(아울라|아우나|아운라)(야|아)?(\s|$)/gi, replacement: '아우라야 ', label: 'cons_aula' },

        // === 띄어쓰기 ===
        { pattern: /아\s+우\s*라\s*(야|아)?/gi, replacement: '아우라야', label: 'space_aura' },
        { pattern: /아우\s+라\s*(야|아)?/gi, replacement: '아우라야', label: 'space_aura2' },

        // === "라" 누락 (STT 오인식) ===
        { pattern: /^아우\s*야/gi, replacement: '아우라야', label: 'missing_ra' },
        { pattern: /^아\s*야/gi, replacement: '아우라야', label: 'missing_ura' },

        // === 어미 변형 ===
        { pattern: /아우라(아|여)(\s|$)/gi, replacement: '아우라야 ', label: 'auraa' },
        { pattern: /아우라\s*요/gi, replacement: '아우라야', label: 'aurayo' },

        // === 일반 오타 ===
        { pattern: /달씨/gi, replacement: '날씨', label: 'weather' },
        { pattern: /너씨/gi, replacement: '날씨', label: 'weather2' },
        { pattern: /날시/gi, replacement: '날씨', label: 'weather3' },

        // === 축약형 → 확장형 (STT가 축약형으로 인식할 때) ===
        { pattern: /그니까/gi, replacement: '그러니까', label: 'contraction1' },
        { pattern: /긍까/gi, replacement: '그러니까', label: 'contraction2' },
        { pattern: /근까/gi, replacement: '그러니까', label: 'contraction3' },
        { pattern: /어케/gi, replacement: '어떻게', label: 'contraction4' },
        { pattern: /어뜨케/gi, replacement: '어떻게', label: 'contraction5' },
        { pattern: /이케/gi, replacement: '이렇게', label: 'contraction6' },
        { pattern: /저케/gi, replacement: '저렇게', label: 'contraction7' },
        { pattern: /그케/gi, replacement: '그렇게', label: 'contraction8' },

        // === 발음 교정 ===
        { pattern: /어떠게/gi, replacement: '어떻게', label: 'pron1' },
        { pattern: /어떠케/gi, replacement: '어떻게', label: 'pron2' },
        { pattern: /머라고/gi, replacement: '뭐라고', label: 'pron3' },
        { pattern: /머래/gi, replacement: '뭐래', label: 'pron4' },
        { pattern: /됬/gi, replacement: '됐', label: 'pron5' },
        { pattern: /햇/gi, replacement: '했', label: 'pron6' },
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
        '아우라', '아우라야',
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
    // Vision Intent 패턴 (화면 공유 분석)
    // =====================================================

    private readonly VISION_KEYWORDS: string[] = [
        // 동작 키워드
        '봐', '보고', '보면서', '봐줘', '봐봐', '보여',
        '설명', '해명', '분석', '해석', '읽어', '알려',
        '뭐야', '뭔지', '뭘지', '뭐냐', '어때', '어떻게',
        // 대상 키워드
        '화면', '스크린', '공유', '이거', '이게', '저거', '저게', '여기',
        '코드', '에러', '오류', '버그', '문제', '이슈',
    ];

    private readonly VISION_PATTERNS: RegExp[] = [
        // "화면" + 동사 (유연하게)
        /화면.{0,10}(봐|보고|보면|설명|해명|분석|해석|읽|알려|뭐)/,
        /화면\s*을?\s*(봐|보고|보면서|설명|해명|분석)/,

        // "이거/이게/저거" + 동사 패턴
        /이거\s*.{0,5}(봐|보|설명|해명|분석|뭐야|뭐냐|뭘지|어때|봐줘|알려)/,
        /이게\s*(뭐야|뭘지|뭐냐|뭔지|어때)/,
        /저거\s*.{0,5}(뭐|어떻|설명|보|분석)/,
        /저게\s*(뭐야|뭘지|뭔지)/,

        // "여기" 패턴
        /여기\s*.{0,5}(보|봐|설명|뭐|분석)/,
        /여기서.*?(어떻|뭐|설명|분석)/,

        // "지금 보이는/보는" 패턴
        /지금\s*(보이|보는|보여).{0,10}(설명|분석|뭐|알려)/,
        /(보이|보여)\s*주.{0,5}(는|고\s*있).{0,10}(설명|분석|뭐)/,

        // 설명/분석 요청
        /(설명|분석|해석|해명).{0,5}해\s*(줘|줄래|주세요|봐)/,

        // 코드/에러 관련
        /이?\s*(코드|함수|변수|클래스|메서드).{0,5}(는|이|가)?\s*(뭐|어떻|설명|분석)/,
        /이?\s*(에러|오류|버그|문제|이슈).{0,10}(봐|분석|설명|해결|뭐)/,
        /이?\s*(그래프|차트|표|데이터).{0,5}(는|을)?\s*(뭐|어떻|해석|분석|설명)/,
        /이?\s*(문서|문단|부분|내용).{0,5}(는|을)?\s*(뭐|어떻|요약|설명)/,

        // "~보고 ~해줘" 패턴
        /.{0,5}보고.{0,10}(설명|해명|분석|알려|말해).{0,3}(줘|줄래|주세요)?/,

        // 스크린/공유 관련
        /(스크린|공유).{0,10}(봐|보고|설명|분석)/,
    ];

    // =====================================================
    // 아이디어 보드 열기 패턴
    // =====================================================
    private readonly IDEA_BOARD_PATTERNS: RegExp[] = [
        /아이디어\s*(모드|보드)?\s*(열어|시작|켜|오픈|해|해줘|하자)/,
        /아이디어\s*(회의|브레인스토밍)?\s*(시작|해|하자|할까)/,
        /브레인\s*스토밍\s*(시작|열어|하자|해)/,
        /아이디어\s*(정리|모으|수집).{0,5}(시작|하자|해)/,
        /(아이디어|브레인스토밍)\s*(좀)?\s*(해볼까|할까|하자)/,
    ];

    // =====================================================
    // Flowchart/설계 보드 열기 패턴
    // =====================================================
    private readonly FLOWCHART_BOARD_PATTERNS: RegExp[] = [
        // 설계 보드 패턴 (메인)
        /설계\s*(보드|모드)?\s*(열어|시작|켜|오픈|해|해줘|하자|열어줘|켜줘)/,
        /설계\s*(보드|모드)/,  // "설계 보드" 단독으로도 인식
        // 다이어그램 패턴
        /(다이어그램|diagram)\s*(보드|모드)?\s*(열어|시작|켜|오픈|해|해줘|하자|열어줘|켜줘|그려)/i,
        /다이어그램\s*(그려|만들어|보여)/,
        // 플로우차트 패턴
        /(flowchart|플로우차트|플로차트|플로우 차트)\s*(모드|보드)?\s*(열어|시작|켜|오픈|해|해줘|하자)/i,
        /(flow|플로우)\s*(보드|차트)?\s*(열어|시작|켜|오픈|해|해줘|하자)/i,
        // STT 오인식 패턴
        /(플로차트|프로차트|플러차트|플로우 차트)\s*(열어|시작|켜|오픈|해|해줘|하자|켜줘|켜져)/,
        /순서도\s*(열어|시작|켜|오픈|해|해줘|하자|그려)/,
        /(cdr|시디알|씨디알)\s*(분석|파싱)?\s*(시작|하자|해)/i,
        // 구조도/흐름도 패턴
        /(구조도|흐름도|시퀀스)\s*(그려|열어|시작|만들어|보여)/,
        // 시스템 설계 패턴
        /시스템\s*(설계|구조)\s*(보여|그려|열어|시작)/,
    ];

    // =====================================================
    // 캘린더/일정 추천 패턴
    // =====================================================
    private readonly CALENDAR_PATTERNS: RegExp[] = [
        // 일정 잡기/추천 패턴
        /일정\s*(잡|추천|찾|조율|조정|맞춰|정|확인).{0,5}(아|어|줘|줄래|주세요|해|할까)?/,
        /(회의|미팅|약속|모임)\s*(일정|시간|날짜).{0,5}(잡|추천|찾|조율|조정|맞춰|정|확인)/,
        // 언제 가능/비어있는 시간 패턴
        /(언제|몇\s*시|몇\s*일).{0,10}(가능|되|비어|괜찮|시간)/,
        /(빈\s*시간|가능한\s*시간|비어\s*있는\s*시간|공통\s*시간).{0,5}(찾|알려|추천|확인|언제)/,
        // 참여자 일정 확인 패턴
        /(참여자|참석자|멤버|모두|다\s*같이|우리).{0,10}(일정|시간|스케줄).{0,5}(확인|알려|맞춰|조율)/,
        /(다들|모두|참석자).{0,5}(언제|몇\s*시).{0,5}(가능|되|괜찮)/,
        // 스케줄 관련
        /스케줄\s*(조율|조정|확인|추천|잡|맞춰)/,
        /(캘린더|달력|일정표).{0,5}(확인|봐|보여|열어|분석)/,
        // 날짜/시간 추천
        /(날짜|시간|일시).{0,5}(추천|잡|정|알려|찾)/,
        /(다음\s*주|이번\s*주|내일|모레).{0,10}(가능|되|비어|시간)/,
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
        'ㄹ': ['ㄴ', 'ㄷ'],
        'ㄴ': ['ㄹ', 'ㅁ'],
        'ㅁ': ['ㅂ', 'ㄴ'],
        'ㅂ': ['ㅁ', 'ㅍ', 'ㅃ'],
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
        const targets = ['아우라', '아우라야', '헤이아우라'];
        const threshold = 0.65;

        for (const token of tokens) {
            if (token.length < 2) continue;

            for (const target of targets) {
                const similarity = this.jamoSimilarity(token, target);
                if (similarity >= threshold) {
                    return { matched: true, word: target, similarity };
                }
            }

            // "헤이 아우라" 분리된 경우
            if (['헤이', '해이', '에이', '혜이', '해', '헤'].includes(token)) {
                const nextIdx = tokens.indexOf(token) + 1;
                if (nextIdx < tokens.length) {
                    const nextSim = this.jamoSimilarity(tokens[nextIdx], '아우라');
                    if (nextSim >= 0.5) {
                        return { matched: true, word: '헤이 아우라', similarity: nextSim };
                    }
                }
            }
        }

        return { matched: false, word: '', similarity: 0 };
    }

    private mightHaveWakeWord(text: string): boolean {
        const first40 = text.slice(0, 40).toLowerCase();

        const patterns = [
            /아[우오어][라나다]/,
            /헤이|해이|에이|혜이|해\s|헤\s/,
            /aura|oura|awra/i,
        ];

        return patterns.some(p => p.test(first40));
    }

    private readonly WAKE_WORD_PATTERNS: RegExp[] = [
        /^아[우오어][라나다][야아요]?/,
        /^헤이?\s*아[우오][라나]/,
        /^[해헤에혜][이]?\s*아[우오]/,
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

        // 13. Vision Intent 체크 (화면 공유 분석)
        const isVisionIntent = this.VISION_PATTERNS.some(pattern => {
            if (pattern.test(lowerNormalized)) {
                matchedPatterns.push(`Vision: ${pattern.source.substring(0, 20)}...`);
                return true;
            }
            return false;
        });

        // 14. 아이디어 보드 열기 Intent 체크
        const isIdeaBoardIntent = this.IDEA_BOARD_PATTERNS.some(pattern => {
            if (pattern.test(lowerNormalized)) {
                matchedPatterns.push(`IdeaBoard: ${pattern.source.substring(0, 20)}...`);
                return true;
            }
            return false;
        });

        // 16. Flowchart 보드 열기 Intent 체크
        const isFlowchartIntent = this.FLOWCHART_BOARD_PATTERNS.some(pattern => {
            if (pattern.test(lowerNormalized)) {
                matchedPatterns.push(`Flowchart: ${pattern.source.substring(0, 20)}...`);
                return true;
            }
            return false;
        });

        // 17. 캘린더/일정 추천 Intent 체크
        const isCalendarIntent = this.CALENDAR_PATTERNS.some(pattern => {
            if (pattern.test(lowerNormalized)) {
                matchedPatterns.push(`Calendar: ${pattern.source.substring(0, 20)}...`);
                return true;
            }
            return false;
        });

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
            isVisionIntent,
            isIdeaBoardIntent,
            isFlowchartIntent,
            isCalendarIntent,
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

        this.logger.debug(`[의도 분석] "${text.substring(0, 30)}..." → call=${isCallIntent}, vision=${isVisionIntent}, idea=${isIdeaBoardIntent}, flowchart=${isFlowchartIntent}, calendar=${isCalendarIntent}, conf=${confidence.toFixed(2)}, cat=${category}, keyword=${extractedKeyword}`);

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