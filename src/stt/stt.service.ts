import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import * as speechsdk from 'microsoft-cognitiveservices-speech-sdk';
import { Readable } from 'stream';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ClovaSttAdapter } from './clova-stt.adapter';
import { DagloSttAdapter } from './daglo-stt.adapter';

// 지원하는 STT 프로바이더 타입
type SttProvider = 'deepgram' | 'azure' | 'clova' | 'daglo';

@Injectable()
export class SttService implements OnModuleDestroy {
    private readonly logger = new Logger(SttService.name);
    private deepgramClient: any;
    private azureSpeechConfig: speechsdk.SpeechConfig | null = null;
    private clovaAdapter: ClovaSttAdapter | null = null;
    private dagloAdapter: DagloSttAdapter | null = null;
    private readonly provider: SttProvider;

    // LLM 교정용
    private bedrockClient: BedrockRuntimeClient;
    private readonly llmModelId = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

    // =====================================================
    // 키워드 힌트 (STT 인식률 향상용)
    // =====================================================
    
    // 웨이크워드 힌트 (아우라)
    private readonly WAKE_WORD_HINTS = [
        '아우라', '아우라야', '헤이 아우라', '헤이아우라',
        '아우라 야', '아우라요', '아 우라',
    ];

    // 지역명 힌트
    private readonly LOCATION_HINTS = [
        '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
        '강남', '홍대', '신촌', '잠실', '여의도', '판교', '성수', '이태원',
        '명동', '종로', '압구정', '청담', '삼성', '역삼', '선릉', '건대',
        '합정', '망원', '연남', '을지로', '성북', '혜화', '대학로',
        '분당', '일산', '수원', '용인', '화성', '평택', '안양', '부천',
        '강서', '마포', '서초', '송파', '영등포', '용산', '동대문', '중구',
    ];

    // 카테고리 키워드 힌트
    private readonly CATEGORY_HINTS = [
        // 카페
        '카페', '커피', '커피숍', '스타벅스', '투썸', '이디야', '블루보틀', '카공',
        // 맛집
        '맛집', '식당', '레스토랑', '밥집', '음식점', '저녁', '점심', '브런치',
        // 술집
        '술집', '바', '포차', '호프', '이자카야', '와인바', '회식',
        // 분식/치킨/피자
        '분식', '떡볶이', '김밥', '라면', '치킨', '피자',
        // 빵/디저트
        '빵집', '베이커리', '디저트', '케이크', '마카롱', '아이스크림',
        // 팝업/전시
        '팝업', '팝업스토어', '전시', '전시회', '갤러리',
        // 날씨
        '날씨', '기온', '온도', '미세먼지', '우산',
        // 기타
        '추천', '알려줘', '찾아줘', '검색',
    ];

    // 모든 힌트 합치기
    private readonly ALL_HINTS = [
        ...this.WAKE_WORD_HINTS,
        ...this.LOCATION_HINTS,
        ...this.CATEGORY_HINTS,
    ];

    // 발음 유사 단어 매핑 (STT 오인식 교정용)
    private readonly PHONETIC_CORRECTIONS: Record<string, string> = {
        // 지역명 오인식
        '성숙': '성수',
        '성수기': '성수',
        '성숙하게': '성수 카페',
        '성숙해': '성수',
        '강남역': '강남',
        '홍대입구': '홍대',
        '신촌역': '신촌',
        '합정역': '합정',
        '건대입구': '건대',
        '선릉역': '선릉',
        '역삼역': '역삼',
        '삼성역': '삼성',
        '잠실역': '잠실',
        '여의도역': '여의도',
        '판교역': '판교',
        
        // 카테고리 오인식
        '카패': '카페',
        '커피숍': '카페',
        '캬페': '카페',
        '맛있집': '맛집',
        '마집': '맛집',
        '술 집': '술집',
        '분 식': '분식',
        '떡복이': '떡볶이',
        '팝 업': '팝업',
        '전 시': '전시',
        '날 씨': '날씨',
        
        // 웨이크워드 오인식 (아우라)
        '아 우라': '아우라',
        '아우 라': '아우라',
        '아우라 야': '아우라야',
        '아울라': '아우라',
        '아울라야': '아우라야',
        '아우나': '아우라',
        '아우나야': '아우라야',
        '아우러': '아우라',
        '아우러야': '아우라야',
        '아오라': '아우라',
        '아오라야': '아우라야',
        '오우라': '아우라',
        '오우라야': '아우라야',
        '어우라': '아우라',
        '어우라야': '아우라야',
        '헤이 아울라': '헤이 아우라',
        '헤이 아우나': '헤이 아우라',
        '헤이 오우라': '헤이 아우라',
        '해이아우라': '헤이 아우라',
        '에이아우라': '헤이 아우라',
    };

    constructor(private configService: ConfigService) {
        const requestedProvider = (this.configService.get<string>('STT_PROVIDER') || 'deepgram').toLowerCase();

        // 지원하는 프로바이더 확인
        const supportedProviders: SttProvider[] = ['deepgram', 'azure', 'clova', 'daglo'];
        this.provider = supportedProviders.includes(requestedProvider as SttProvider)
            ? (requestedProvider as SttProvider)
            : 'deepgram';

        if (this.provider !== requestedProvider) {
            this.logger.warn(`[STT] Unsupported provider "${requestedProvider}", defaulting to "${this.provider}"`);
        }

        // 프로바이더별 초기화
        if (this.provider === 'daglo') {
            const apiToken = this.configService.get<string>('DAGLO_API_KEY');
            if (!apiToken) {
                this.logger.error('[Daglo STT] DAGLO_API_KEY가 설정되지 않았습니다!');
            } else {
                this.dagloAdapter = new DagloSttAdapter(apiToken);
                // 초기화는 첫 요청 시 lazy로 수행
                this.logger.log('[Daglo STT] 어댑터 생성 완료 (lazy 초기화)');
            }
        } else if (this.provider === 'clova') {
            const clientId = this.configService.get<string>('CLOVA_CLIENT_ID');
            const clientSecret = this.configService.get<string>('CLOVA_CLIENT_SECRET');
            if (!clientSecret) {
                this.logger.error('[Clova STT] CLOVA_CLIENT_SECRET이 설정되지 않았습니다!');
            } else {
                this.clovaAdapter = new ClovaSttAdapter(clientId || '', clientSecret);
                // 초기화는 첫 요청 시 lazy로 수행
                this.logger.log('[Clova STT] 어댑터 생성 완료 (lazy 초기화)');
            }
        } else if (this.provider === 'azure') {
            const azureKey = this.configService.get<string>('AZURE_SPEECH_KEY');
            const azureRegion = this.configService.get<string>('AZURE_SPEECH_REGION') || 'koreacentral';
            if (!azureKey) {
                this.logger.error('[Azure STT] AZURE_SPEECH_KEY가 설정되지 않았습니다!');
            } else {
                this.azureSpeechConfig = speechsdk.SpeechConfig.fromSubscription(azureKey, azureRegion);
                this.azureSpeechConfig.speechRecognitionLanguage = 'ko-KR';

                // Azure 구문 목록에 힌트 추가
                // Note: Azure에서는 PhraseListGrammar로 런타임에 추가
            }
        } else {
            // Deepgram (기본값)
            const apiKey = this.configService.get<string>('DEEPGRAM_API_KEY');
            if (!apiKey) {
                this.logger.error('[Deepgram] API 키가 설정되지 않았습니다!');
            }
            this.deepgramClient = createClient(apiKey);
        }

        // Bedrock 클라이언트 초기화
        const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
        const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');
        const region = this.configService.get<string>('AWS_REGION') || 'ap-northeast-2';
        if (accessKeyId && secretAccessKey) {
            const maskedKey = accessKeyId.slice(-4);
            this.logger.log(`[AWS] STT Bedrock static credentials (****${maskedKey})`);
        } else {
            this.logger.warn('[AWS] STT Bedrock static credentials missing; using default credential chain');
        }
        this.bedrockClient = new BedrockRuntimeClient({
            region,
            ...(accessKeyId && secretAccessKey
                ? {
                      credentials: {
                          accessKeyId,
                          secretAccessKey,
                      },
                  }
                : {}),
        });

        this.logger.log(`[STT] Provider: ${this.provider}, Hints: ${this.ALL_HINTS.length}개`);
    }

    // =====================================================
    // 공개 API (교정 포함)
    // =====================================================

    /**
     * 버퍼에서 음성 인식 + 후처리 교정
     */
    async transcribeFromBuffer(audioBuffer: Buffer, fileName: string): Promise<string> {
        const rawTranscript = await this.rawTranscribeFromBuffer(audioBuffer, fileName);
        return this.postProcess(rawTranscript);
    }

    /**
     * 스트림에서 음성 인식 + 후처리 교정
     */
    async transcribeStream(audioStream: Readable): Promise<string> {
        const rawTranscript = await this.rawTranscribeStream(audioStream);
        return this.postProcess(rawTranscript);
    }

    /**
     * 버퍼 스트림에서 음성 인식 + 후처리 교정
     */
    async transcribeFromBufferStream(audioBuffer: Buffer, fileName: string): Promise<string> {
        const rawTranscript = await this.rawTranscribeFromBufferStream(audioBuffer, fileName);
        return this.postProcess(rawTranscript);
    }

    // =====================================================
    // 후처리 (발음 교정 + LLM 교정)
    // =====================================================

    /**
     * STT 결과 후처리
     * 1. 발음 유사 단어 교정 (빠름)
     * 2. LLM 문맥 교정 (정확)
     */
    private async postProcess(rawTranscript: string): Promise<string> {
        if (!rawTranscript || rawTranscript.trim().length === 0) {
            return rawTranscript;
        }

        // 1단계: 빠른 발음 교정
        let corrected = this.applyPhoneticCorrections(rawTranscript);
        
        // 2단계: 웨이크워드가 있거나 의미가 불분명한 경우 LLM 교정
        const needsLlmCorrection = this.shouldUseLlmCorrection(corrected);
        
        if (needsLlmCorrection) {
            try {
                const llmCorrected = await this.correctWithLlm(corrected);
                if (llmCorrected && llmCorrected.length > 0) {
                    this.logger.log(`[STT 교정] "${rawTranscript}" → "${llmCorrected}"`);
                    return llmCorrected;
                }
            } catch (error) {
                this.logger.warn(`[LLM 교정 실패] ${error.message}`);
            }
        }

        if (corrected !== rawTranscript) {
            this.logger.log(`[발음 교정] "${rawTranscript}" → "${corrected}"`);
        }

        return corrected;
    }

    /**
     * 발음 유사 단어 교정 (빠른 룰 기반)
     */
    private applyPhoneticCorrections(text: string): string {
        let result = text;

        // 정확히 매칭되는 단어 교정
        for (const [wrong, correct] of Object.entries(this.PHONETIC_CORRECTIONS)) {
            const regex = new RegExp(wrong, 'gi');
            result = result.replace(regex, correct);
        }

        // 띄어쓰기 정규화
        result = result.replace(/\s+/g, ' ').trim();

        return result;
    }

    /**
     * LLM 교정이 필요한지 판단
     */
    private shouldUseLlmCorrection(text: string): boolean {
        const lowerText = text.toLowerCase();

        // 고유명사 패턴이 있으면 교정 안 함 (오교정 방지)
        const properNounPatterns = [
            /대학교/, /대학/, /고등학교/, /중학교/, /초등학교/,
            /회사/, /기업/, /그룹/, /주식회사/,
        ];
        if (properNounPatterns.some(p => p.test(text))) {
            this.logger.debug(`[LLM 교정 스킵] 고유명사 패턴 발견`);
            return false;
        }

        // 웨이크워드 패턴이 있으면 교정 (아우라)
        const wakePatterns = [
            /아울라/, /아우나/, /아우러/, /아오라/, /오우라/, /어우라/,  // 아우라는 제외 (정확하면 교정 불필요)
        ];
        if (wakePatterns.some(p => p.test(lowerText))) {
            return true;
        }

        // 명백한 오타 패턴이 있으면 교정
        const hasWeirdWord = /성숙|캬페|마집|떡복/.test(lowerText);
        if (hasWeirdWord) {
            return true;
        }

        return false;
    }

    /**
     * LLM으로 문맥 기반 교정
     */
    private async correctWithLlm(rawText: string): Promise<string> {
        const prompt = `음성인식(STT) 결과를 교정해주세요.

## 배경
- 화상회의에서 AI 비서 "아우라"를 호출하는 음성입니다
- 웨이크워드: "아우라야", "헤이 아우라" 등
- 주로 장소 검색(카페, 맛집 등)이나 날씨를 물어봅니다

## 교정 규칙 (중요!)
1. 웨이크워드 오인식만 교정 (아울라야→아우라야)
2. 고유명사(학교명, 회사명, 사람이름)는 절대 변경 금지!
3. "성숙"→"성수"처럼 명백한 오타만 교정
4. 확실하지 않으면 원본 유지

## 절대 변경하지 말 것
- 대학교 이름 (상명대, 성균관대, 한양대 등)
- 회사 이름 (크래프톤, 삼성, 네이버 등)
- 사람 이름

## 자주 오인식되는 패턴
- "아울라야/아우나야/오우라야" → "아우라야"
- "성숙" → "성수" (지역명인 경우만)
- "캬페/카패" → "카페"

## 입력 (STT 원본)
"${rawText}"

## 출력 규칙
1. 오인식된 단어만 교정
2. 문맥상 자연스러운 문장으로
3. 교정된 문장만 출력 (설명 없이)
4. 교정할 내용이 없으면 원본 그대로 출력

## 출력 (교정된 문장만)`;

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 100,
            messages: [{ role: "user", content: prompt }],
        };

        const command = new InvokeModelCommand({
            modelId: this.llmModelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
        });

        const response = await this.bedrockClient.send(command);
        const body = JSON.parse(new TextDecoder().decode(response.body));
        const corrected = body.content?.[0]?.text?.trim() || rawText;

        // 따옴표 제거
        return corrected.replace(/^["']|["']$/g, '').trim();
    }

    // =====================================================
    // Raw STT (교정 없이 원본 반환)
    // =====================================================

    private async rawTranscribeFromBuffer(audioBuffer: Buffer, fileName: string): Promise<string> {
        // Daglo 프로바이더
        if (this.provider === 'daglo') {
            return this.transcribeFromBufferDaglo(audioBuffer, fileName);
        }

        // Clova 프로바이더
        if (this.provider === 'clova') {
            return this.transcribeFromBufferClova(audioBuffer, fileName);
        }

        // Azure 프로바이더
        if (this.provider === 'azure') {
            return this.transcribeFromBufferAzure(audioBuffer, fileName);
        }

        // Deepgram 프로바이더 (기본값)
        this.logger.log(`[파일 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);

        try {
            const { result, error } = await this.deepgramClient.listen.prerecorded.transcribeFile(
                audioBuffer,
                {
                    model: 'nova-3',
                    language: 'ko',
                    smart_format: true,
                    punctuate: true,
                    encoding: 'linear16',
                    sample_rate: 16000,
                    channels: 1,
                    // Deepgram 키워드 힌트
                    keywords: this.ALL_HINTS.slice(0, 100), // Deepgram은 최대 100개
                    // 키워드 부스트 (1.0 ~ 10.0)
                    keyword_boost: 'high',
                }
            );

            if (error) {
                this.logger.error(`[Deepgram 에러] ${error.message}`);
                throw error;
            }

            const transcript = result.results.channels[0].alternatives[0].transcript;
            this.logger.log(`[STT 완료] 전체 결과: ${transcript}`);

            return transcript || '';
        } catch (error) {
            this.logger.error(`[STT 에러] ${error.message}`);
            throw error;
        }
    }

    private async rawTranscribeStream(audioStream: Readable): Promise<string> {
        // Daglo 프로바이더
        if (this.provider === 'daglo') {
            return this.transcribeStreamDaglo(audioStream);
        }

        // Clova 프로바이더
        if (this.provider === 'clova') {
            return this.transcribeStreamClova(audioStream);
        }

        // Azure 프로바이더
        if (this.provider === 'azure') {
            return this.transcribeStreamAzure(audioStream);
        }

        // Deepgram 프로바이더 (기본값)
        return new Promise((resolve, reject) => {
            const transcripts: string[] = [];

            const connection = this.deepgramClient.listen.live({
                model: 'nova-3',
                language: 'ko',
                smart_format: true,
                punctuate: true,
                interim_results: false,
                encoding: 'linear16',
                sample_rate: 16000,
                channels: 1,
                // Deepgram 키워드 힌트
                keywords: this.ALL_HINTS.slice(0, 100),
                keyword_boost: 'high',
            });

            connection.on(LiveTranscriptionEvents.Open, () => {
                this.logger.log('[Deepgram 실시간] 연결 성공');

                audioStream.on('data', (chunk: Buffer) => {
                    connection.send(chunk);
                });

                audioStream.on('end', () => {
                    connection.finish();
                });
            });

            connection.on(LiveTranscriptionEvents.Transcript, (data) => {
                const transcript = data.channel.alternatives[0].transcript;
                if (transcript && transcript.trim().length > 0) {
                    this.logger.log(`[STT 결과] ${transcript}`);
                    transcripts.push(transcript);
                }
            });

            connection.on(LiveTranscriptionEvents.Close, () => {
                this.logger.log('[Deepgram 실시간] 연결 종료');
                const fullTranscript = transcripts.join(' ');
                resolve(fullTranscript);
            });

            connection.on(LiveTranscriptionEvents.Error, (error) => {
                this.logger.error(`[Deepgram 에러] ${error.message}`);
                reject(error);
            });
        });
    }

    private async rawTranscribeFromBufferStream(audioBuffer: Buffer, fileName: string): Promise<string> {
        // Daglo 프로바이더
        if (this.provider === 'daglo') {
            return this.transcribeFromBufferDaglo(audioBuffer, fileName);
        }

        // Clova 프로바이더
        if (this.provider === 'clova') {
            return this.transcribeFromBufferClova(audioBuffer, fileName);
        }

        // Azure 프로바이더
        if (this.provider === 'azure') {
            return this.transcribeFromBufferStreamAzure(audioBuffer, fileName);
        }

        this.logger.log(`[스트림 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        const audioStream = Readable.from([audioBuffer]);
        try {
            const transcript = await this.rawTranscribeStream(audioStream);
            this.logger.log(`[STT 완료] 전체 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[STT 에러] ${error.message}`);
            throw error;
        }
    }

    // =====================================================
    // Azure 전용 메서드
    // =====================================================

    private getAzureSpeechConfig(): speechsdk.SpeechConfig {
        if (!this.azureSpeechConfig) {
            throw new Error('AZURE_SPEECH_KEY is not set');
        }
        return this.azureSpeechConfig;
    }

    private async transcribeFromBufferAzure(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[Azure 파일 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        return this.recognizeOnceAzure(audioBuffer);
    }

    private async transcribeStreamAzure(audioStream: Readable): Promise<string> {
        const chunks: Buffer[] = [];

        return new Promise((resolve, reject) => {
            audioStream.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });
            audioStream.on('end', async () => {
                try {
                    const fullAudio = Buffer.concat(chunks);
                    if (fullAudio.length === 0) {
                        resolve('');
                        return;
                    }
                    const transcript = await this.recognizeOnceAzure(fullAudio);
                    resolve(transcript);
                } catch (error) {
                    reject(error);
                }
            });
            audioStream.on('error', (error) => {
                this.logger.error(`[Azure STT 스트림 에러] ${error.message}`);
                reject(error);
            });
        });
    }

    private async transcribeFromBufferStreamAzure(audioBuffer: Buffer, fileName: string): Promise<string> {
        this.logger.log(`[Azure 스트림 STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);
        const audioStream = Readable.from([audioBuffer]);
        try {
            const transcript = await this.transcribeStreamAzure(audioStream);
            this.logger.log(`[Azure STT 완료] 전체 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[Azure STT 에러] ${error.message}`);
            throw error;
        }
    }

    private async recognizeOnceAzure(audioBuffer: Buffer): Promise<string> {
        const speechConfig = this.getAzureSpeechConfig();
        const format = speechsdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
        const pushStream = speechsdk.AudioInputStream.createPushStream(format);
        const audioConfig = speechsdk.AudioConfig.fromStreamInput(pushStream);
        const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

        // Azure PhraseListGrammar로 키워드 힌트 추가
        const phraseList = speechsdk.PhraseListGrammar.fromRecognizer(recognizer);
        for (const hint of this.ALL_HINTS) {
            phraseList.addPhrase(hint);
        }

        const STT_TIMEOUT_MS = 10000;  // 10초 타임아웃

        return new Promise((resolve, reject) => {
            let resolved = false;
            
            // 타임아웃 설정
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.logger.warn(`[Azure STT] 타임아웃 (${STT_TIMEOUT_MS}ms)`);
                    recognizer.close();
                    resolve('');
                }
            }, STT_TIMEOUT_MS);

            recognizer.recognizeOnceAsync(
                (result) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeoutId);
                    recognizer.close();
                    
                    if (result.reason === speechsdk.ResultReason.RecognizedSpeech) {
                        resolve(result.text || '');
                        return;
                    }
                    if (result.reason === speechsdk.ResultReason.NoMatch) {
                        this.logger.warn('[Azure STT] NoMatch - 음성이 감지되지 않았습니다.');
                        resolve('');
                        return;
                    }
                    if (result.reason === speechsdk.ResultReason.Canceled) {
                        const details = speechsdk.CancellationDetails.fromResult(result);
                        const reason = speechsdk.CancellationReason[details.reason] || details.reason;
                        const code = details.ErrorCode ? speechsdk.CancellationErrorCode[details.ErrorCode] : 'Unknown';
                        this.logger.error(`[Azure STT 취소] reason=${reason} code=${code} details=${details.errorDetails || 'Unknown error'}`);
                        if (details.reason === speechsdk.CancellationReason.EndOfStream) {
                            resolve('');
                            return;
                        }
                        reject(new Error(details.errorDetails || 'Azure STT canceled'));
                        return;
                    }
                    resolve('');
                },
                (error) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeoutId);
                    recognizer.close();
                    reject(error);
                }
            );

            const arrayBuffer = Uint8Array.from(audioBuffer).buffer as ArrayBuffer;
            pushStream.write(arrayBuffer);
            pushStream.close();
        });
    }

    // =====================================================
    // Clova 전용 메서드
    // =====================================================

    private async transcribeFromBufferClova(audioBuffer: Buffer, fileName: string): Promise<string> {
        if (!this.clovaAdapter) {
            throw new Error('Clova STT adapter is not initialized');
        }

        this.logger.log(`[Clova STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);

        try {
            const transcript = await this.clovaAdapter.transcribe(audioBuffer, {
                language: 'ko',
                keywordBoosting: this.ALL_HINTS.slice(0, 50), // 상위 50개 키워드
            });

            this.logger.log(`[Clova STT 완료] 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[Clova STT 에러] ${error.message}`);
            throw error;
        }
    }

    private async transcribeStreamClova(audioStream: Readable): Promise<string> {
        if (!this.clovaAdapter) {
            throw new Error('Clova STT adapter is not initialized');
        }

        this.logger.log(`[Clova STT 스트림 시작]`);

        // Readable을 AsyncGenerator로 변환
        const audioGenerator = async function* (stream: Readable): AsyncGenerator<Buffer> {
            for await (const chunk of stream) {
                yield chunk as Buffer;
            }
        };

        try {
            const transcripts: string[] = [];

            for await (const result of this.clovaAdapter.transcribeStream(audioGenerator(audioStream), {
                language: 'ko',
                keywordBoosting: this.ALL_HINTS.slice(0, 50),
            })) {
                if (result.isFinal && result.text) {
                    this.logger.log(`[Clova STT 결과] ${result.text}`);
                    transcripts.push(result.text);
                }
            }

            const fullTranscript = transcripts.join(' ').trim();
            this.logger.log(`[Clova STT 스트림 완료] 결과: ${fullTranscript}`);
            return fullTranscript;
        } catch (error) {
            this.logger.error(`[Clova STT 스트림 에러] ${error.message}`);
            throw error;
        }
    }

    // =====================================================
    // Daglo 전용 메서드
    // =====================================================

    private async transcribeFromBufferDaglo(audioBuffer: Buffer, fileName: string): Promise<string> {
        if (!this.dagloAdapter) {
            throw new Error('Daglo STT adapter is not initialized');
        }

        this.logger.log(`[Daglo STT 시작] 파일: ${fileName}, 크기: ${audioBuffer.length} bytes`);

        try {
            const transcript = await this.dagloAdapter.transcribe(audioBuffer, {
                language: 'ko-KR',
                encoding: 'LINEAR16',
                sampleRate: 16000,
                interimResults: true,
            });

            this.logger.log(`[Daglo STT 완료] 결과: ${transcript}`);
            return transcript || '';
        } catch (error) {
            this.logger.error(`[Daglo STT 에러] ${error.message}`);
            throw error;
        }
    }

    private async transcribeStreamDaglo(audioStream: Readable): Promise<string> {
        if (!this.dagloAdapter) {
            throw new Error('Daglo STT adapter is not initialized');
        }

        this.logger.log(`[Daglo STT 스트림 시작]`);

        // Readable을 AsyncGenerator로 변환
        const audioGenerator = async function* (stream: Readable): AsyncGenerator<Buffer> {
            for await (const chunk of stream) {
                yield chunk as Buffer;
            }
        };

        try {
            const transcripts: string[] = [];

            for await (const result of this.dagloAdapter.transcribeStream(audioGenerator(audioStream), {
                language: 'ko-KR',
                encoding: 'LINEAR16',
                sampleRate: 16000,
                interimResults: true,
            })) {
                if (result.isFinal && result.text) {
                    this.logger.log(`[Daglo STT 결과] ${result.text}`);
                    transcripts.push(result.text);
                }
            }

            const fullTranscript = transcripts.join(' ').trim();
            this.logger.log(`[Daglo STT 스트림 완료] 결과: ${fullTranscript}`);
            return fullTranscript;
        } catch (error) {
            this.logger.error(`[Daglo STT 스트림 에러] ${error.message}`);
            throw error;
        }
    }

    // =====================================================
    // 모듈 종료 시 정리
    // =====================================================

    onModuleDestroy() {
        if (this.clovaAdapter) {
            this.clovaAdapter.close();
            this.clovaAdapter = null;
            this.logger.log('[Clova STT] 어댑터 종료');
        }
        if (this.dagloAdapter) {
            this.dagloAdapter.close();
            this.dagloAdapter = null;
            this.logger.log('[Daglo STT] 어댑터 종료');
        }
    }
}