import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  ProactiveInsight,
  AnalysisContext,
  ProactiveConfig,
  DEFAULT_PROACTIVE_CONFIG,
} from './proactive.interface';
import * as crypto from 'crypto';

/**
 * Proactive Analysis Service
 * 화면 컨텍스트 + 음성 발화를 분석하여 사용자에게 도움될 인사이트를 감지
 */
@Injectable()
export class ProactiveAnalysisService {
  private readonly logger = new Logger(ProactiveAnalysisService.name);
  private bedrockClient: BedrockRuntimeClient;

  // Claude Sonnet 3.5 (고품질 분석용)
  private readonly modelId = 'anthropic.claude-3-5-sonnet-20240620-v1:0';

  private readonly config: ProactiveConfig = DEFAULT_PROACTIVE_CONFIG;

  // 쿨다운 추적: type -> lastTimestamp
  private insightCooldowns: Map<string, number> = new Map();

  constructor(private configService: ConfigService) {
    this.bedrockClient = new BedrockRuntimeClient({
      region: this.configService.get<string>('AWS_REGION') || 'us-east-1',
      credentials: {
        accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID') || '',
        secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY') || '',
      },
    });

    this.logger.log(`[Proactive] 서비스 초기화 완료 (모델: ${this.modelId})`);
  }

  /**
   * 화면 + 발화 컨텍스트 분석
   */
  async analyze(context: AnalysisContext): Promise<ProactiveInsight[]> {
    const { screenTexts, recentConversation } = context;

    // 분석할 데이터가 없으면 스킵
    if (screenTexts.length === 0 && recentConversation.length === 0) {
      this.logger.debug('[Proactive] 분석할 컨텍스트 없음, 스킵');
      return [];
    }

    this.logger.log(
      `[Proactive] 분석 시작 - 화면 ${screenTexts.length}개, 발화 ${recentConversation.length}턴`
    );

    try {
      const prompt = this.buildAnalysisPrompt(context);
      const insights = await this.callLLM(prompt);

      // 필터링: 신뢰도 체크 및 쿨다운 적용
      const filteredInsights = this.filterInsights(insights);

      if (filteredInsights.length > 0) {
        this.logger.log(
          `[Proactive] 인사이트 ${filteredInsights.length}개 감지: ${filteredInsights.map(i => `${i.type}(${i.confidence}%)`).join(', ')}`
        );
      } else {
        this.logger.debug('[Proactive] 유효한 인사이트 없음');
      }

      return filteredInsights;
    } catch (error) {
      this.logger.error(`[Proactive] 분석 실패: ${error.message}`);
      return [];
    }
  }

  /**
   * LLM 분석 프롬프트 생성
   */
  private buildAnalysisPrompt(context: AnalysisContext): string {
    const { screenTexts, recentConversation, roomTopic } = context;

    // 화면 텍스트 포맷팅 (최근 3개만)
    const screenSection = screenTexts.length > 0
      ? screenTexts.slice(-3).map((text, i) =>
          `[화면 ${i + 1}]\n${text.substring(0, 2000)}`
        ).join('\n\n')
      : '(화면 텍스트 없음)';

    // 대화 포맷팅 (최근 5턴만)
    const conversationSection = recentConversation.length > 0
      ? recentConversation.slice(-5).join('\n')
      : '(최근 발화 없음)';

    return `[역할]
당신은 화상회의에 참여 중인 AI 비서입니다.
사용자가 공유한 화면과 대화를 실시간으로 모니터링하고, 사용자에게 도움이 될 만한 정보를 자발적으로 제안합니다.

[핵심 원칙]
당신의 목표는 사용자가 요청하기 전에 먼저 유용한 정보를 제공하는 것입니다.
화면에 보이는 내용과 대화 맥락을 종합적으로 분석하여, 사용자에게 가치 있는 인사이트를 발견하세요.

${roomTopic ? `[회의 주제]: ${roomTopic}\n` : ''}

[공유된 화면 텍스트]
${screenSection}

[최근 대화]
${conversationSection}

[인사이트 발견 가이드]
화면과 대화를 분석하여 다음과 같은 상황에서 인사이트를 제공하세요:

**정보 제공이 유용한 상황:**
- 사용자가 무언가를 찾거나 판단하려는 것 같을 때 (관련 정보 제공)
- 화면에 분석/요약이 도움될 데이터가 있을 때 (핵심 요약)
- 사용자가 질문하거나 고민하는 것 같을 때 (답변이나 관점 제공)
- 화면 내용에 대해 추가 맥락이 도움될 때 (배경 지식, 관련 정보)
- 현재 논의 주제에 대한 보충 정보가 있을 때
- 사용자가 놓치고 있는 중요한 포인트가 있을 때
- 데이터나 콘텐츠에 대한 분석/해석이 유용할 때

**반드시 제안해야 하는 상황:**
- 코드 에러, 버그, 성능 이슈가 보일 때
- 민감 정보(API 키, 비밀번호, 개인정보)가 노출되어 있을 때
- 사용자가 명백히 잘못된 정보를 믿고 있을 때
- 더 효율적인 방법이나 도구가 있을 때

**타입 지정:**
상황에 맞는 type을 자유롭게 지정하세요:
- insight: 일반적인 인사이트, 분석, 요약
- suggestion: 제안, 추천
- answer: 질문에 대한 답변
- warning: 경고, 주의사항
- tip: 팁, 더 나은 방법
- info: 추가 정보, 배경 지식
- 기타 상황에 맞는 type 자유롭게 사용

[응답 규칙]
- 신뢰도 70% 이상인 경우만 제안
- 제목 20자 이내, 본문 3문장 이내
- 구체적이고 실행 가능한 내용
- 최대 2개까지

[응답 형식]
반드시 JSON 배열로만 응답. 설명 없이 JSON만.
확실하지 않으면 빈 배열 [] 반환.

형식:
[
  {
    "type": "상황에 맞는 타입",
    "title": "간결한 제목",
    "content": "화면과 대화 맥락을 기반으로 한 유용한 정보",
    "confidence": 70-100
  }
]

인사이트가 없으면: []`;
  }

  /**
   * Bedrock LLM 호출
   */
  private async callLLM(prompt: string): Promise<ProactiveInsight[]> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 500,
        temperature: 0.3, // 낮은 temperature로 일관된 응답
      },
    });

    const response = await this.bedrockClient.send(command);

    // 응답에서 텍스트 추출
    const textBlock = response.output?.message?.content?.find(
      (block): block is { text: string } => 'text' in block
    );

    if (!textBlock?.text) {
      return [];
    }

    // JSON 파싱
    try {
      const jsonText = this.extractJSON(textBlock.text);
      const parsed = JSON.parse(jsonText);

      if (!Array.isArray(parsed)) {
        return [];
      }

      // 타임스탬프 추가
      return parsed.map(insight => ({
        ...insight,
        timestamp: Date.now(),
      }));
    } catch (parseError) {
      this.logger.warn(`[Proactive] JSON 파싱 실패: ${parseError.message}`);
      return [];
    }
  }

  /**
   * JSON 추출 (마크다운 코드블록 처리)
   */
  private extractJSON(text: string): string {
    // ```json ... ``` 형태 처리
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // [ ... ] 형태 직접 추출
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      return arrayMatch[0];
    }

    return text.trim();
  }

  /**
   * 인사이트 필터링 (신뢰도, 쿨다운)
   */
  private filterInsights(insights: ProactiveInsight[]): ProactiveInsight[] {
    const now = Date.now();
    const filtered: ProactiveInsight[] = [];

    for (const insight of insights) {
      // 신뢰도 체크
      if (insight.confidence < this.config.minConfidenceThreshold) {
        this.logger.debug(
          `[Proactive] 신뢰도 미달로 필터링: ${insight.type} (${insight.confidence}% < ${this.config.minConfidenceThreshold}%)`
        );
        continue;
      }

      // 쿨다운 체크
      const lastTime = this.insightCooldowns.get(insight.type) || 0;
      if (now - lastTime < this.config.cooldownMs) {
        this.logger.debug(
          `[Proactive] 쿨다운으로 필터링: ${insight.type} (${Math.round((this.config.cooldownMs - (now - lastTime)) / 1000)}초 남음)`
        );
        continue;
      }

      // 통과한 인사이트 추가 및 쿨다운 갱신
      filtered.push(insight);
      this.insightCooldowns.set(insight.type, now);

      // 최대 개수 제한
      if (filtered.length >= this.config.maxInsightsPerAnalysis) {
        break;
      }
    }

    return filtered;
  }

  /**
   * 텍스트 해시 생성 (중복 분석 방지용)
   */
  hashTexts(texts: string[]): string {
    const combined = texts.join('||');
    return crypto.createHash('md5').update(combined).digest('hex').substring(0, 16);
  }

  /**
   * 쿨다운 초기화 (방 종료 시)
   */
  clearCooldowns(): void {
    this.insightCooldowns.clear();
    this.logger.debug('[Proactive] 쿨다운 초기화됨');
  }

  /**
   * 설정 조회
   */
  getConfig(): ProactiveConfig {
    return { ...this.config };
  }
}
