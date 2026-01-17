import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface ISOQualityMetric {
    name: string;
    score: number; // 0-100
    description: string;
}

export interface AICodeSuggestion {
    category: string; // 'improvement' | 'bug' | 'security' | 'performance'
    severity: 'high' | 'medium' | 'low';
    suggestion: string;
}

export interface VisionAnalysisResult {
    text: string;
    confidence: number;
    analysisType: 'code' | 'document' | 'chart' | 'image' | 'general';
    // ISO 25010 품질 평가 (code 타입일 때만)
    isoQualityMetrics?: ISOQualityMetric[];
    // AI 제안 (code 타입일 때만)
    aiSuggestions?: AICodeSuggestion[];
    // 출처/근거
    sources?: string[];
}

export interface VisionContext {
    cursorPosition?: { x: number; y: number };
    highlightedText?: string;
    screenWidth: number;
    screenHeight: number;
}

@Injectable()
export class VisionService {
    private readonly logger = new Logger(VisionService.name);
    private bedrockClient: BedrockRuntimeClient;

    // Claude Haiku 4.5 - 빠르면서도 정확한 Vision 분석
    private readonly modelId = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

    // Rate limiting
    private lastRequestTime = 0;
    private isProcessing = false;
    private readonly MIN_REQUEST_INTERVAL = 2000; // 2초 간격
    private readonly MAX_RETRIES = 3;

    constructor(private configService: ConfigService) {
        this.bedrockClient = new BedrockRuntimeClient({
            region: this.configService.get<string>('AWS_REGION') || 'ap-northeast-2',
            credentials: {
                accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
                secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
            },
        });
    }

    /**
     * 수동 화면 분석 (화면 분석 버튼 클릭 시)
     * - 코드 품질 분석
     * - ISO 25010 평가
     * - AI 제안 생성
     */
    async analyzeScreenForQuality(
        imageBase64: string,
        context?: VisionContext
    ): Promise<VisionAnalysisResult> {
        const totalStartTime = Date.now();
        this.logger.log(`\n========== [코드 품질 분석 시작] ==========`);
        this.logger.log(`이미지 크기: ${(imageBase64.length / 1024).toFixed(1)}KB`);

        // 동시 요청 방지
        if (this.isProcessing) {
            this.logger.warn(`[Vision] 이미 처리 중... 대기`);
        }
        while (this.isProcessing) {
            await this.sleep(100);
        }

        // 쿨다운 체크
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
            const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            this.logger.log(`[Vision] 쿨다운 대기: ${waitTime}ms`);
            await this.sleep(waitTime);
        }

        this.isProcessing = true;
        this.lastRequestTime = Date.now();

        try {
            const result = await this.callVisionAPIForQuality(imageBase64, context, 0);
            const totalElapsed = Date.now() - totalStartTime;
            this.logger.log(`[코드 품질 분석 완료] 총 소요시간: ${totalElapsed}ms`);
            this.logger.log(`ISO 메트릭: ${result.isoQualityMetrics?.length || 0}개, AI 제안: ${result.aiSuggestions?.length || 0}개`);
            return result;
        } catch (error) {
            const totalElapsed = Date.now() - totalStartTime;
            this.logger.error(`[코드 품질 분석 실패] ${totalElapsed}ms 후 에러: ${error.message}`);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * 화면 공유 이미지 분석
     */
    async analyzeScreenShare(
        imageBase64: string,
        userQuestion: string,
        context?: VisionContext
    ): Promise<VisionAnalysisResult> {
        const totalStartTime = Date.now();
        this.logger.log(`\n========== [Vision 분석 시작] ==========`);
        this.logger.log(`질문: "${userQuestion}"`);
        this.logger.log(`이미지 크기: ${(imageBase64.length / 1024).toFixed(1)}KB`);
        if (context?.cursorPosition) {
            this.logger.log(`커서 위치: (${context.cursorPosition.x}, ${context.cursorPosition.y})`);
        }

        // 동시 요청 방지
        if (this.isProcessing) {
            this.logger.warn(`[Vision] 이미 처리 중... 대기`);
        }
        while (this.isProcessing) {
            await this.sleep(100);
        }

        // 쿨다운 체크
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
            const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            this.logger.log(`[Vision] 쿨다운 대기: ${waitTime}ms`);
            await this.sleep(waitTime);
        }

        this.isProcessing = true;
        this.lastRequestTime = Date.now();

        try {
            const result = await this.callVisionAPI(imageBase64, userQuestion, context, 0);
            const totalElapsed = Date.now() - totalStartTime;
            this.logger.log(`[Vision 완료] 총 소요시간: ${totalElapsed}ms`);
            this.logger.log(`응답 길이: ${result.text.length}자, 타입: ${result.analysisType}`);
            return result;
        } catch (error) {
            const totalElapsed = Date.now() - totalStartTime;
            this.logger.error(`[Vision 실패] ${totalElapsed}ms 후 에러: ${error.message}`);
            throw error;
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * 코드 품질 분석을 위한 Vision API 호출
     */
    private async callVisionAPIForQuality(
        imageBase64: string,
        context: VisionContext | undefined,
        retryCount: number
    ): Promise<VisionAnalysisResult> {
        const systemPrompt = `You are a code quality expert. Respond ONLY with JSON.

FORMAT (respond with ONLY this, nothing else):
\`\`\`json
{
  "summary": "Korean advice ~요/~예요 (max 50 chars)",
  "isoMetrics": [
    {"name": "Maintainability", "score": 85, "description": "Korean max 30 chars"},
    {"name": "Security", "score": 60, "description": "Korean max 30 chars"}
  ],
  "suggestions": [
    {"category": "security", "severity": "high", "suggestion": "Korean max 60 chars"}
  ],
  "sources": ["ISO/IEC 25010:2011"]
}
\`\`\`

ABSOLUTE RULES:
1. Start with \`\`\`json
2. End with \`\`\`
3. NO explanatory text before or after
4. Max 2-3 metrics, 2-3 suggestions
5. Korean language only for text fields`;

        const userContent = this.buildVisionUserContent(
            imageBase64,
            "Analyze the code and respond with ONLY the JSON format specified in the system prompt. Do not add any explanations.",
            context
        );

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 1000,  // JSON만 반환하도록 토큰 축소
            temperature: 0.3,  // 더 결정론적으로 (JSON 형식 준수)
            system: systemPrompt,
            messages: [{
                role: "user",
                content: userContent
            }],
        };

        const command = new InvokeModelCommand({
            modelId: this.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
        });

        try {
            this.logger.log(`[Vision API] 코드 품질 분석 호출 시작`);
            const startTime = Date.now();

            const response = await this.bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const textBlock = responseBody.content?.find((b: any) => b.type === 'text');
            const responseText = textBlock?.text || "{}";

            const elapsed = Date.now() - startTime;
            this.logger.log(`[Vision API] 완료 - ${elapsed}ms`);

            // JSON 파싱 시도 - 여러 방법으로 시도
            let analysisData;
            try {
                let jsonText = responseText;

                // 방법 1: 마크다운 코드 블록 찾기
                const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (codeBlockMatch) {
                    jsonText = codeBlockMatch[1];
                }

                // 방법 2: 첫 번째 { 부터 마지막 } 까지 추출
                const firstBrace = jsonText.indexOf('{');
                const lastBrace = jsonText.lastIndexOf('}');

                if (firstBrace === -1 || lastBrace === -1) {
                    throw new Error('JSON 객체를 찾을 수 없음');
                }

                jsonText = jsonText.substring(firstBrace, lastBrace + 1).trim();

                // 파싱 시도
                analysisData = JSON.parse(jsonText);

                // 필수 필드 검증
                if (!analysisData.summary) {
                    throw new Error('summary 필드 누락');
                }

            } catch (parseError) {
                this.logger.error(`[Vision API] JSON 파싱 완전 실패: ${parseError.message}`);
                this.logger.error(`[Vision API] 원본 응답:\n${responseText}`);

                // 파싱 실패 시 기본 응답 (원문 표시 안 함!)
                return {
                    text: "코드 분석을 완료했어요. 상세보기를 눌러주세요!",
                    confidence: 0.75,
                    analysisType: 'code',
                    isoQualityMetrics: [],
                    aiSuggestions: [],
                    sources: ['ISO/IEC 25010:2011'],
                };
            }

            // ISO 메트릭 변환
            const isoQualityMetrics: ISOQualityMetric[] = analysisData.isoMetrics?.map((m: any) => ({
                name: m.name,
                score: m.score,
                description: m.description,
            })) || [];

            // AI 제안 변환
            const aiSuggestions: AICodeSuggestion[] = analysisData.suggestions?.map((s: any) => ({
                category: s.category,
                severity: s.severity,
                suggestion: s.suggestion,
            })) || [];

            return {
                text: analysisData.summary || "코드 분석을 완료했어요.",
                confidence: 0.9,
                analysisType: 'code',
                isoQualityMetrics,
                aiSuggestions,
                sources: analysisData.sources || ['ISO/IEC 25010:2011'],
            };

        } catch (error) {
            const isThrottled = error.name === 'ThrottlingException' ||
                error.message?.includes('Too many requests');

            if (isThrottled && retryCount < this.MAX_RETRIES) {
                const backoffTime = Math.pow(2, retryCount + 1) * 2000;
                this.logger.warn(`[Vision API 재시도] ${backoffTime}ms 후`);
                await this.sleep(backoffTime);
                return this.callVisionAPIForQuality(imageBase64, context, retryCount + 1);
            }

            this.logger.error(`[Vision API 에러] ${error.message}`);
            throw error;
        }
    }

    /**
     * Claude Vision API 호출
     */
    private async callVisionAPI(
        imageBase64: string,
        userQuestion: string,
        context: VisionContext | undefined,
        retryCount: number
    ): Promise<VisionAnalysisResult> {
        // 포커스 모드 체크 (로깅용)
        const hasFocusKeyword = this.FOCUS_KEYWORDS.some(kw => userQuestion.includes(kw));
        const focusMode = hasFocusKeyword && context?.cursorPosition;
        if (focusMode) {
            this.logger.log(`[Vision] 포커스 모드 활성화 - 커서 주변만 분석`);
        }

        const systemPrompt = this.buildVisionSystemPrompt(context, userQuestion);
        const userContent = this.buildVisionUserContent(imageBase64, userQuestion, context);

        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 500,  // 간결한 응답 (약 150-200자)
            system: systemPrompt,
            messages: [{
                role: "user",
                content: userContent
            }],
        };

        const command = new InvokeModelCommand({
            modelId: this.modelId,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(payload),
        });

        try {
            this.logger.log(`[Vision API] 호출 시작 - 질문: "${userQuestion.substring(0, 50)}..."`);
            const startTime = Date.now();

            const response = await this.bedrockClient.send(command);
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const textBlock = responseBody.content?.find((b: any) => b.type === 'text');
            const responseText = textBlock?.text || "화면을 분석할 수 없습니다.";

            const elapsed = Date.now() - startTime;
            this.logger.log(`[Vision API] 완료 - ${elapsed}ms`);

            // 분석 타입 추론
            const analysisType = this.inferAnalysisType(userQuestion, responseText);

            return {
                text: responseText,
                confidence: 0.9,
                analysisType,
            };

        } catch (error) {
            const isThrottled = error.name === 'ThrottlingException' ||
                error.message?.includes('Too many requests');

            if (isThrottled && retryCount < this.MAX_RETRIES) {
                const backoffTime = Math.pow(2, retryCount + 1) * 2000;
                this.logger.warn(`[Vision API 재시도] ${backoffTime}ms 후`);
                await this.sleep(backoffTime);
                return this.callVisionAPI(imageBase64, userQuestion, context, retryCount + 1);
            }

            this.logger.error(`[Vision API 에러] ${error.message}`);
            throw error;
        }
    }

    /**
     * 포커스 키워드 감지 (커서 주변만 분석)
     */
    private readonly FOCUS_KEYWORDS = ['이거', '이게', '이 부분', '여기', '저거', '저기', '이쪽', '저쪽'];

    /**
     * 커서 위치를 상대적 위치 설명으로 변환
     */
    private getCursorRegionDescription(x: number, y: number, width: number, height: number): string {
        const relX = x / width;  // 0~1 (왼쪽~오른쪽)
        const relY = y / height; // 0~1 (위~아래)

        // 세로 위치
        let verticalPos: string;
        if (relY < 0.33) verticalPos = '상단';
        else if (relY < 0.66) verticalPos = '중앙';
        else verticalPos = '하단';

        // 가로 위치
        let horizontalPos: string;
        if (relX < 0.33) horizontalPos = '왼쪽';
        else if (relX < 0.66) horizontalPos = '중앙';
        else horizontalPos = '오른쪽';

        // 조합
        if (verticalPos === '중앙' && horizontalPos === '중앙') {
            return '화면 정중앙';
        }
        return `화면 ${verticalPos} ${horizontalPos}`;
    }

    /**
     * Vision 시스템 프롬프트 생성
     */
    private buildVisionSystemPrompt(context?: VisionContext, userQuestion?: string): string {
        // 커서 위치를 상대적 위치로 변환
        let cursorInfo = '';
        let cursorRegion = '';
        if (context?.cursorPosition) {
            cursorRegion = this.getCursorRegionDescription(
                context.cursorPosition.x,
                context.cursorPosition.y,
                context.screenWidth,
                context.screenHeight
            );
            cursorInfo = `[커서 위치: ${cursorRegion} (${context.cursorPosition.x}, ${context.cursorPosition.y})]`;
        }

        const highlightInfo = context?.highlightedText
            ? `[선택된 텍스트: "${context.highlightedText}"]`
            : '';

        // 포커스 키워드 감지 → 커서 주변만 분석
        const hasFocusKeyword = userQuestion && this.FOCUS_KEYWORDS.some(kw => userQuestion.includes(kw));
        const focusMode = hasFocusKeyword && context?.cursorPosition;

        if (focusMode) {
            // 커서 주변 집중 분석 모드
            return `당신은 화면을 보고 있는 동료 '아우라'예요.

## 🎯 중요: "${cursorRegion}" 영역만 분석하세요!
사용자가 커서로 특정 부분을 가리키고 있어요.
${cursorInfo}

## 절대 규칙
1. **${cursorRegion}에 있는 요소만** 설명하세요
2. 화면 다른 영역(특히 중앙 영상 내용)은 무시하세요
3. 커서 근처의 텍스트, 버튼, UI 요소를 우선 확인하세요

## 응답 규칙
- 커서가 가리키는 요소만 **1-2문장**으로 설명
- "~요", "~예요" 말투
- 다른 부분은 절대 언급하지 마세요`;
        }

        // 일반 분석 모드 (Step-by-step)
        return `당신은 화면을 보고 있는 동료 '아우라'예요.

${cursorInfo} ${highlightInfo}

## 분석 순서 (내부적으로 수행, 출력은 최종 답변만)
1. 화면의 텍스트 먼저 읽기 (제목, 자막, UI 라벨, 버튼 등)
2. 텍스트로 맥락 파악 (무슨 앱/사이트/영상인지)
3. 시각적 요소 파악 (이미지, 그래프, 코드 등)
4. 종합해서 사용자 질문에 답변

## 응답 규칙
- **2-3문장**으로 핵심만 (내부 분석 과정은 출력 X)
- "~요", "~예요" 말투로 친근하게
- 화면에 보이는 텍스트를 활용해서 정확하게 설명

## 응답 예시
- "유튜브 영상이네요. '하얀 아뜰리에' 채널에서 박물관 굿즈 만드는 영상이에요. 봉황 문양 파우치를 보여주고 있네요."
- "VS Code에서 TypeScript 코드예요. 웹소켓 연결하는 부분이고, 32번 줄에서 에러 처리하고 있어요."`;
    }

    /**
     * Vision 사용자 메시지 생성 (이미지 + 텍스트)
     */
    private buildVisionUserContent(
        imageBase64: string,
        userQuestion: string,
        context?: VisionContext
    ): any[] {
        const content: any[] = [];

        // 1. 이미지 추가
        content.push({
            type: "image",
            source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageBase64.replace(/^data:image\/\w+;base64,/, ''), // data URL prefix 제거
            }
        });

        // 2. 컨텍스트 정보 + 질문
        let questionText = userQuestion;

        if (context?.highlightedText) {
            questionText = `[선택된 텍스트: "${context.highlightedText}"]\n\n${userQuestion}`;
        }

        if (context?.cursorPosition) {
            questionText = `[커서 위치: (${context.cursorPosition.x}, ${context.cursorPosition.y})]\n\n${questionText}`;
        }

        content.push({
            type: "text",
            text: questionText
        });

        return content;
    }

    /**
     * 분석 타입 추론
     */
    private inferAnalysisType(
        question: string,
        response: string
    ): 'code' | 'document' | 'chart' | 'image' | 'general' {
        const lowerQ = question.toLowerCase();
        const lowerR = response.toLowerCase();

        // 코드 관련
        if (
            lowerQ.includes('코드') || lowerQ.includes('함수') || lowerQ.includes('변수') ||
            lowerR.includes('함수') || lowerR.includes('코드') || lowerR.includes('import') ||
            lowerR.includes('class') || lowerR.includes('function')
        ) {
            return 'code';
        }

        // 차트/그래프 관련
        if (
            lowerQ.includes('그래프') || lowerQ.includes('차트') || lowerQ.includes('통계') ||
            lowerR.includes('그래프') || lowerR.includes('차트') || lowerR.includes('증가') ||
            lowerR.includes('감소') || lowerR.includes('추이')
        ) {
            return 'chart';
        }

        // 문서 관련
        if (
            lowerQ.includes('문서') || lowerQ.includes('계약') || lowerQ.includes('보고서') ||
            lowerR.includes('문단') || lowerR.includes('조항') || lowerR.includes('내용')
        ) {
            return 'document';
        }

        // 이미지 관련
        if (
            lowerQ.includes('이미지') || lowerQ.includes('사진') || lowerQ.includes('그림') ||
            lowerQ.includes('디자인')
        ) {
            return 'image';
        }

        return 'general';
    }

    /**
     * 이미지 압축 및 검증
     */
    validateAndCompressImage(imageBase64: string): {
        valid: boolean;
        compressed?: string;
        error?: string;
    } {
        try {
            // Base64 데이터 추출 (data URL prefix 제거)
            const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

            // 크기 체크 (1MB 제한)
            const sizeInBytes = (base64Data.length * 3) / 4;
            const sizeInMB = sizeInBytes / (1024 * 1024);

            if (sizeInMB > 5) {
                return {
                    valid: false,
                    error: `이미지가 너무 큽니다 (${sizeInMB.toFixed(2)}MB). 최대 5MB까지 지원됩니다.`
                };
            }

            this.logger.log(`[이미지 검증] 크기: ${sizeInMB.toFixed(2)}MB`);

            return {
                valid: true,
                compressed: base64Data,
            };
        } catch (error) {
            return {
                valid: false,
                error: `이미지 처리 중 오류: ${error.message}`
            };
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
