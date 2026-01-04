import { Injectable, Logger } from '@nestjs/common';

export interface IntentAnalysis {
    isCallIntent: boolean;       // 호출 의도 (웨이크워드)
    isQuestionIntent: boolean;   // 질문 의도 (의문사, 명령어)
    isBotRelated: boolean;       // 봇 관련 발화
    confidence: number;          // 신뢰도 (0-1)
    matchedPatterns: string[];   // 매칭된 패턴들
    normalizedText: string;      // STT 보정/정규화된 텍스트
    hasQuestionWord: boolean;    // 의문사 포함 여부
    hasCommandWord: boolean;     // 명령어 포함 여부
    hasQuestionPattern: boolean; // 질문 종결 패턴 여부
    hasRequestPattern: boolean;  // 요청/정중 표현 패턴 여부
    isWeatherIntent: boolean;    // 날씨 관련 질문
    searchDomain?: 'weather' | 'naver' | null; // 검색 도메인
}

@Injectable()
export class IntentClassifierService {
    private readonly logger = new Logger(IntentClassifierService.name);

    // 웨이크워드 (호출 의도)
    private readonly WAKE_WORDS = [
        '헤이 빅스', '빅스야', '빅스비', '빅스비야', '페이비스', '헤이픽스',
        '믹스야', '익수야', '익사', '빅쓰', '빅세야', '빅세오', '익쇠야'
    ];
    private readonly WAKE_WORD_MAX_TOKENS = 3;

    // 의문사 (질문 의도)
    private readonly QUESTION_WORDS = [
        '뭐', '무엇', '어디', '언제', '누구', '누가', '왜', '어떻게', '어떤', '몇',
        '어느', '얼마', '무슨', '어찌', '하', '이', '그', '저'
    ];

    // 연속된 문장에서도 잡히는 의문사 (1글자 제외)
    private readonly QUESTION_WORDS_INLINE = [
        '뭐', '무엇', '어디', '언제', '누구', '누가', '왜', '어떻게', '어떤', '몇',
        '어느', '얼마', '무슨', '어찌'
    ];

    // 명령어 (질문 의도)
    private readonly COMMAND_WORDS = [
        '알려줘', '말해줘', '보여줘', '찾아줘', '검색해줘', '물어봐',
        '알려', '말해', '보여', '찾아', '검색해', '설명해줘', '설명해',
        '가르쳐줘', '가르쳐', '추천해줘', '추천해', '해줘', '해봐',
        '알려줄래', '알려줄래요', '말해줄래', '말해줄래요', '보여줄래', '보여줄래요',
        '찾아줄래', '찾아줄래요', '추천해줄래', '추천해줄래요',
        '줄래', '해줄래', '해줄래요', '해줘요', '해 주세요', '해주세요',
        '부탁해', '부탁해요', '부탁드립니다',
        '해줄 수', '해줄수', '가능해', '가능해요', '가능하니', '가능하나요',
        '해도 돼', '해도돼', '해도 될까', '해도될까'
    ];

    // 봇 호칭 (봇 관련)
    private readonly BOT_REFERENCES = [
        '너', '니가', '당신', '자네', '네가', '넌', '쟤', '얘',
        '빅스', '빅스야', '빅스비', '빅스비야', '헤이 빅스',
        '믹스', '믹스야', '익수', '익수야', '익사', '빅쓰',
        '빅세', '빅세야', '빅세오', '익쇠', '익쇠야'
    ];

    // 날씨 관련 키워드
    private readonly WEATHER_KEYWORDS = [
        '날씨', '기온', '온도', '기상', '일기예보', '날씨예보', '기상예보',
        '비', '눈', '바람', '구름', '흐림', '맑음', '화창', '흐리',
        '습도', '강수', '강수량', '강설량', '적설량',
        '미세먼지', '초미세먼지', '대기질', '황사',
        '태풍', '장마', '폭염', '한파', '더위', '추위', '덥', '춥',
        '우산', '외투', '반팔', '긴팔', '옷차림',
        '영하', '영상', '섭씨', '도씨', '도수'
    ];

    // 질문 패턴 (문장 종결)
    private readonly QUESTION_PATTERNS = [
        /\?$/,           // 물음표로 끝남
        /[가-힣]+[ㄴㄹ]지$/,   // ~ㄴ지, ~ㄹ지
        /[가-힣]+까$/,        // ~까 (어떨까, 뭘까)
        /[가-힣]+니$/,        // ~니 (뭐니, 어디니)
        /[가-힣]+나$/,        // ~나 (뭐하나)
        /[가-힣]+냐$/,        // ~냐 (뭐냐)
        /뭐야$/, /뭐지$/, /뭐냐$/, /뭔데$/, /뭔지$/,
        /어때$/, /어때요$/, /어떤데$/,
        /어떻게해$/, /어떻게 해$/, /어떻게돼$/, /어떻게 돼$/,
        /언제야$/, /어디야$/, /누구야$/, /왜야$/, /몇이야$/, /얼마야$/,
        /일까$/, /일까요$/, /인가요$/, /인가$/, /인가요$/,
    ];

    // 요청/정중 표현 패턴 (강한 질문 의도)
    private readonly REQUEST_PATTERNS = [
        /해\s?줄래(요)?$/, /해\s?줘(요)?$/, /해\s?주세요$/, /해주세요$/,
        /해\s?주실래(요)?$/, /해\s?주실\s?수\s?있(나요|어요|니|냐)?$/,
        /해\s?줄\s?수\s?있(나요|어요|니|냐)?$/, /가능하(나요|니|냐|죠|지)?$/,
        /될까요$/, /되나요$/, /되니$/, /되냐$/,
        /해도\s?돼(요)?$/, /해도\s?될까$/,
        /할래(요)?$/, /할\s?수\s?있(나요|어요|니|냐)?$/,
        /주실래(요)?$/, /줄래(요)?$/
    ];

    // STT 오탈자 보정 (웨이크워드 중심)
    private readonly STT_CORRECTIONS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
        { pattern: /hay\s?box/gi, replacement: '헤이 빅스', label: 'haybox' },
        { pattern: /hey\s?box/gi, replacement: '헤이 빅스', label: 'heybox' },
        { pattern: /hae\s?bix|hae\s?bics|hae\s?bixs|hey\s?bix|hay\s?bix|he\s?bix|hebix|haebix|haebics/gi, replacement: '헤이 빅스', label: 'haebix 변형' },
        { pattern: /k\s?bix|ka\s?bix|kabix|kabics/gi, replacement: '헤이 빅스', label: 'kabix 변형' },
        { pattern: /pay\s?bix|pae\s?bix|pai\s?bix/gi, replacement: '페이비스', label: 'paybix 변형' },
        { pattern: /헤이빅스|헤빅스|해빅스|해믹스|헤믹스|해빙수|해밋스|헤이 빅쓰|헤이빅쓰/gi, replacement: '헤이 빅스', label: '헤이빅스 변형' },
        { pattern: /에이비수야|에이빅스야/gi, replacement: '빅스야', label: '에이빅스야 변형' },
        { pattern: /^에이\s?빅스야/gi, replacement: '빅스야', label: '에이빅스야' },
        { pattern: /^(빅세오|빅세야|빅세|익쇠야|익쇠|믹스야|믹스|빅쓰|빅소)/gi, replacement: '빅스야', label: '빅스야 시작 변형' },
        { pattern: /(^|\s)(빅세오|빅세야|빅세|익쇠야|익쇠|믹스야|믹스|빅쓰|빅소)(야)?/gi, replacement: '$1빅스야', label: '빅스야 패턴' },
        { pattern: /빅스비야|빅스비|빅스비야?/gi, replacement: '빅스비야', label: '빅스비 변형' },
        { pattern: /비수야|빅수야|빅쓰야|빅야|빅스요|믹스야|익수야|익사|익수|믹스|빅세야|빅세오|빅세|익쇠야|익쇠/gi, replacement: '빅스야', label: '빅스야 변형' },
        { pattern: /빅스아|빅스 아/gi, replacement: '빅스야', label: '빅스아 변형' },
        { pattern: /긱스야|긱스|긱쓰야|긱쓰/gi, replacement: '빅스야', label: '긱스야 변형' },
        { pattern: /헤이픽스|헤이 픽스|픽스야|픽스/gi, replacement: '헤이픽스', label: '픽스 변형' },
        { pattern: /페이비스|페이 빅스|페이빅스/gi, replacement: '페이비스', label: '페이비스 변형' },
        { pattern: /달씨/gi, replacement: '날씨', label: '날씨 오탈자' },
        { pattern: /헤이 빅스비온날씨/gi, replacement: '헤이 빅스 오늘날씨', label: '오늘날씨 보정' },
    ];

    private normalizeText(text: string, matchedPatterns: string[]): string {
        let normalized = text.trim();
        for (const rule of this.STT_CORRECTIONS) {
            if (rule.pattern.test(normalized)) {
                normalized = normalized.replace(rule.pattern, rule.replacement);
                matchedPatterns.push(`보정: ${rule.label}`);
            }
            rule.pattern.lastIndex = 0;
        }
        return normalized.toLowerCase().trim();
    }

    private isWakeWordInLeadingTokens(text: string, wakeWord: string): boolean {
        const index = text.indexOf(wakeWord);
        if (index < 0) {
            return false;
        }
        const before = text.slice(0, index).trim();
        if (!before) {
            return true;
        }
        const tokens = before.split(/\s+/).filter(Boolean);
        return tokens.length < this.WAKE_WORD_MAX_TOKENS;
    }

    /**
     * 텍스트의 의도를 분석
     */
    classify(text: string): IntentAnalysis {
        const matchedPatterns: string[] = [];
        const normalizedText = this.normalizeText(text, matchedPatterns);
        let confidence = 0;

        // 1. 웨이크워드 체크 (호출 의도)
        const isCallIntent = this.WAKE_WORDS.some(word => {
            if (this.isWakeWordInLeadingTokens(normalizedText, word.toLowerCase())) {
                matchedPatterns.push(`웨이크워드: ${word}`);
                confidence += 0.5;
                return true;
            }
            return false;
        });

        // 2. 의문사 체크 (질문 의도)
        let hasQuestionWord = this.QUESTION_WORDS.some(word => {
            // 단어 경계를 고려한 매칭 (부분 문자열이 아닌 독립 단어)
            const regex = new RegExp(`(^|\\s)${word}($|\\s|[^가-힣])`, 'i');
            if (regex.test(normalizedText)) {
                matchedPatterns.push(`의문사: ${word}`);
                confidence += 0.3;
                return true;
            }
            return false;
        });

        const hasInlineQuestionWord = this.QUESTION_WORDS_INLINE.some(word => {
            if (normalizedText.includes(word)) {
                matchedPatterns.push(`의문사(연속): ${word}`);
                confidence += 0.3;
                return true;
            }
            return false;
        });

        hasQuestionWord = hasQuestionWord || hasInlineQuestionWord;

        // 3. 명령어 체크 (질문 의도)
        const hasCommandWord = this.COMMAND_WORDS.some(word => {
            if (normalizedText.includes(word.toLowerCase())) {
                matchedPatterns.push(`명령어: ${word}`);
                confidence += 0.3;
                return true;
            }
            return false;
        });

        // 4. 질문 패턴 체크
        const hasQuestionPattern = this.QUESTION_PATTERNS.some(pattern => {
            if (pattern.test(normalizedText)) {
                matchedPatterns.push(`패턴: ${pattern.source}`);
                confidence += 0.2;
                return true;
            }
            return false;
        });

        // 4-1. 요청/정중 패턴 체크 (강한 질문 의도)
        const hasRequestPattern = this.REQUEST_PATTERNS.some(pattern => {
            if (pattern.test(normalizedText)) {
                matchedPatterns.push(`요청: ${pattern.source}`);
                confidence += 0.4;
                return true;
            }
            return false;
        });

        // 5. 봇 호칭 체크 (봇 관련)
        const isBotRelated = this.BOT_REFERENCES.some(word => {
            const regex = new RegExp(`(^|\\s)${word}($|\\s|[^가-힣])`, 'i');
            if (regex.test(normalizedText)) {
                matchedPatterns.push(`호칭: ${word}`);
                confidence += 0.2;
                return true;
            }
            return false;
        });

        // 6. 날씨 관련 키워드 체크
        const isWeatherIntent = this.WEATHER_KEYWORDS.some(word => {
            if (normalizedText.includes(word.toLowerCase())) {
                matchedPatterns.push(`날씨: ${word}`);
                confidence += 0.2;
                return true;
            }
            return false;
        });

        // 질문 의도 판단
        const isQuestionIntent = hasQuestionWord || hasCommandWord || hasQuestionPattern || hasRequestPattern;

        // 검색 도메인 결정
        let searchDomain: 'weather' | 'naver' | null = null;
        if (isQuestionIntent) {
            searchDomain = isWeatherIntent ? 'weather' : 'naver';
        }

        // 신뢰도 정규화 (0-1)
        confidence = Math.min(confidence, 1.0);

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
        };

        this.logger.debug(`[의도 분석] "${text.substring(0, 30)}..." → ${JSON.stringify(result)}`);

        return result;
    }

    /**
     * 봇이 응답해야 하는지 판단
     */
    shouldRespond(text: string): boolean {
        const intent = this.classify(text);

        // 호출 의도 또는 (질문 의도 + 봇 관련)이면 응답
        const should = intent.isCallIntent ||
                      (intent.isQuestionIntent && intent.isBotRelated) ||
                      (intent.isQuestionIntent && intent.hasCommandWord) ||
                      (intent.isQuestionIntent && intent.hasQuestionPattern && intent.confidence >= 0.2) ||
                      (intent.isQuestionIntent && intent.hasQuestionWord && intent.confidence >= 0.2) ||
                      (intent.isQuestionIntent && intent.confidence > 0.3);

        this.logger.log(`[응답 판단] "${text.substring(0, 30)}..." → ${should ? '✅ 응답' : '❌ 무시'} (confidence: ${intent.confidence.toFixed(2)})`);

        return should;
    }

    /**
     * SLEEP 상태에서 깨워야 할지 판단
     */
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
