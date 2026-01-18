/**
 * MCP Controller
 * 다이어그램 생성 API 엔드포인트
 * 설계 보드 상태 관리
 */

import { Controller, Post, Body, Get, Param, Logger, Inject, forwardRef } from '@nestjs/common';
import { McpService } from './mcp.service';
import { ToolInput } from './types/tool.types';
import { RAG_CLIENT, IRagClient } from '../rag/rag-client.interface';
import { LlmService } from '../llm/llm.service';
import { VoiceBotService } from '../livekit/voice-bot.service';

// 요청 DTO
interface GenerateDiagramDto {
  type: 'flowchart' | 'sequence' | 'erd' | 'architecture' | 'kanban';
  transcript: string;
  roomId?: string;
}

interface SaveDiagramDto {
  type: string;
  mermaidCode: string;
  roomId?: string;
}

interface BoardStateNotification {
  type: 'DESIGN_BOARD_OPENED' | 'DESIGN_BOARD_CLOSED' | 'DESIGN_BOARD_TAB_CHANGED' | 'DESIGN_BOARD_UPDATED';
  roomId: string;
  state: {
    isOpen: boolean;
    activeTab: string | null;
    selectedTabs: string[];
    diagramData: Record<string, string>;
    lastUpdated: string;
  };
  participantId?: string;
}

interface AutoSpeakDto {
  roomId: string;
  enabled: boolean;
  triggers?: ('board_open' | 'tab_change' | 'diagram_update')[];
}

interface ExplainDiagramDto {
  roomId: string;
  diagramType: string;
  mermaidCode: string;
}

interface GenerateFromContextDto {
  roomId: string;
  diagramTypes?: ('flowchart' | 'erd' | 'sequence' | 'architecture')[];
}

// 자동 발화 상태 저장 (메모리)
const autoSpeakSettings: Map<string, { enabled: boolean; triggers: string[] }> = new Map();

@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(
    private readonly mcpService: McpService,
    @Inject(RAG_CLIENT) private readonly ragClient: IRagClient,
    private readonly llmService: LlmService,
    @Inject(forwardRef(() => VoiceBotService))
    private readonly voiceBotService: VoiceBotService,
  ) {}

  /**
   * 다이어그램 생성
   * POST /mcp/diagram/generate
   */
  @Post('diagram/generate')
  async generateDiagram(@Body() dto: GenerateDiagramDto) {
    this.logger.log(`Generating ${dto.type} diagram for room: ${dto.roomId}`);

    const input: ToolInput = {
      transcript: dto.transcript,
      context: {
        roomId: dto.roomId,
      },
    };

    const result = await this.mcpService.generateDiagram(dto.type, input);

    return result;
  }

  /**
   * 다이어그램 파일 저장 (filesystem MCP)
   * POST /mcp/diagram/save
   */
  @Post('diagram/save')
  async saveDiagram(@Body() dto: SaveDiagramDto) {
    this.logger.log(`Saving ${dto.type} diagram to file`);

    const result = await this.mcpService.generateAndSaveToFile(
      dto.type,
      dto.mermaidCode,
      dto.roomId,
    );

    return result;
  }

  /**
   * 사용 가능한 도구 목록
   * GET /mcp/tools
   */
  @Get('tools')
  getTools() {
    return {
      internal: this.mcpService.getInternalTools(),
      external: Object.fromEntries(this.mcpService.getExternalTools()),
    };
  }

  /**
   * 키워드로 다이어그램 생성
   * POST /mcp/diagram/generate-by-keyword
   */
  @Post('diagram/generate-by-keyword')
  async generateByKeyword(
    @Body() dto: { keyword: string; transcript: string; roomId?: string },
  ) {
    const tool = this.mcpService.findDiagramToolByKeyword(dto.keyword);

    if (!tool) {
      return {
        success: false,
        error: `키워드와 매칭되는 도구를 찾을 수 없습니다: ${dto.keyword}`,
      };
    }

    const input: ToolInput = {
      transcript: dto.transcript,
      context: {
        roomId: dto.roomId,
      },
    };

    const result = await this.mcpService.generateDiagram(tool.name, input);

    return {
      ...result,
      matchedTool: tool.name,
    };
  }

  // ============================================================
  // 설계 보드 상태 관리 엔드포인트
  // ============================================================

  /**
   * 설계 보드 상태 알림
   * POST /mcp/board-state
   */
  @Post('board-state')
  async notifyBoardState(@Body() notification: BoardStateNotification) {
    this.logger.debug(`[Board State] ${notification.type} - room: ${notification.roomId}`);

    // 현재는 로깅만 수행, 향후 Voice Bot 연동 가능
    return {
      success: true,
      shouldSpeak: false,
      action: 'acknowledge',
    };
  }

  /**
   * 자동 발화 모드 설정
   * POST /mcp/auto-speak
   */
  @Post('auto-speak')
  async setAutoSpeak(@Body() dto: AutoSpeakDto) {
    this.logger.log(`[Auto Speak] room: ${dto.roomId}, enabled: ${dto.enabled}`);

    autoSpeakSettings.set(dto.roomId, {
      enabled: dto.enabled,
      triggers: dto.triggers || ['board_open', 'tab_change', 'diagram_update'],
    });

    return { success: true };
  }

  /**
   * 회의 컨텍스트 조회 (RAG 버퍼)
   * GET /mcp/meeting-context/:roomId
   */
  @Get('meeting-context/:roomId')
  async getMeetingContext(@Param('roomId') roomId: string) {
    try {
      const buffer = this.ragClient.getBufferContent(roomId);
      const transcript = this.ragClient.getFormattedTranscript(roomId);

      if (!buffer || buffer.length === 0) {
        return {
          success: true,
          context: {
            roomId,
            transcript: '',
            participants: [],
            lastUpdated: new Date().toISOString(),
          },
        };
      }

      // 참여자 추출
      const participants = [...new Set(buffer.map((s) => s.speaker))];

      return {
        success: true,
        context: {
          roomId,
          transcript,
          participants,
          lastUpdated: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error(`[Meeting Context] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 트랜스크립트 조회
   * GET /mcp/transcript/:roomId
   */
  @Get('transcript/:roomId')
  async getTranscript(@Param('roomId') roomId: string) {
    try {
      const transcript = this.ragClient.getFormattedTranscript(roomId);

      return {
        success: true,
        transcript,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 다이어그램 컨텍스트 조회 (설계보드 자동 생성용)
   * GET /mcp/diagram-contexts/:roomId
   */
  @Get('diagram-contexts/:roomId')
  async getDiagramContexts(@Param('roomId') roomId: string) {
    try {
      const summary = this.voiceBotService.getDiagramContextsSummary(roomId);

      if (!summary) {
        return {
          success: false,
          error: '방을 찾을 수 없습니다.',
        };
      }

      return {
        success: true,
        contexts: summary,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`[Diagram Contexts] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * LLM이 트랜스크립트 분석해서 적합한 다이어그램 타입 결정
   */
  private async analyzeDiagramTypes(transcript: string): Promise<string[]> {
    const prompt = `다음 회의 내용을 분석하여 어떤 다이어그램이 적합한지 판단해주세요.

가능한 다이어그램 타입:
- flowchart: 프로세스, 워크플로우, 순서, 단계가 있는 경우
- erd: 엔티티, 테이블, 데이터 모델, 관계가 있는 경우
- sequence: API 호출, 시스템 간 통신, 요청-응답 패턴이 있는 경우
- architecture: 시스템 구조, 컴포넌트, 서비스 구성이 있는 경우

회의 내용:
${transcript}

응답 형식 (JSON 배열만 출력):
["flowchart", "erd"]

주의:
- 내용이 해당 다이어그램에 적합한 경우에만 포함
- 빈 배열 가능 (적합한 다이어그램 없음)
- 반드시 JSON 배열만 출력`;

    try {
      const response = await this.llmService.sendMessagePure(prompt, 200);
      const jsonMatch = response.match(/\[.*\]/s);
      if (jsonMatch) {
        const types = JSON.parse(jsonMatch[0]) as string[];
        const validTypes = ['flowchart', 'erd', 'sequence', 'architecture'];
        return types.filter(t => validTypes.includes(t));
      }
    } catch (error) {
      this.logger.warn(`[Diagram Type Analysis] 실패: ${error.message}`);
    }
    return [];
  }

  /**
   * 컨텍스트 기반 다이어그램 생성 (키워드 컨텍스트 우선, LLM 분석 fallback)
   * POST /mcp/diagram/generate-from-context
   */
  @Post('diagram/generate-from-context')
  async generateFromContext(@Body() dto: GenerateFromContextDto) {
    const startTime = Date.now();
    this.logger.log(`[Generate From Context] room: ${dto.roomId}`);

    try {
      // 1. 로컬 버퍼에서 트랜스크립트 가져오기
      const transcript = this.ragClient.getFormattedTranscript(dto.roomId);

      if (!transcript || transcript.trim().length === 0) {
        return {
          success: false,
          error: '회의 내용이 없습니다. 대화가 진행된 후 다시 시도해주세요.',
        };
      }

      // 2. 다이어그램 컨텍스트 조회 (키워드 기반)
      const diagramContexts = this.voiceBotService.getDiagramContexts(dto.roomId);
      const diagramContextsSummary = this.voiceBotService.getDiagramContextsSummary(dto.roomId);

      // 3. 키워드 컨텍스트가 있는 타입 확인
      const typesWithContext: string[] = [];
      const typesWithoutContext: string[] = [];

      const allTypes = ['flowchart', 'sequence', 'erd', 'architecture'] as const;

      if (diagramContextsSummary) {
        for (const type of allTypes) {
          if (diagramContextsSummary[type].hasContent) {
            typesWithContext.push(type);
          }
        }
      }

      this.logger.log(
        `[Generate From Context] 키워드 컨텍스트 있는 타입: ${typesWithContext.join(', ') || '없음'}`,
      );

      // 4. 키워드 컨텍스트 없으면 LLM 분석으로 fallback
      let diagramTypes: string[] = [];

      if (typesWithContext.length > 0) {
        diagramTypes = typesWithContext;
      } else {
        // LLM 분석
        diagramTypes = await this.analyzeDiagramTypes(transcript);
        this.logger.log(
          `[Generate From Context] LLM 분석 결과: ${diagramTypes.join(', ') || '없음'}`,
        );
      }

      if (diagramTypes.length === 0) {
        return {
          success: true,
          diagrams: {},
          suggestedTypes: [],
          context: {
            roomId: dto.roomId,
            transcript,
            lastUpdated: new Date().toISOString(),
          },
          message: '현재 회의 내용으로는 다이어그램 생성에 적합한 내용이 부족합니다.',
        };
      }

      const diagrams: Record<string, string> = {};

      // 5. 순차적으로 다이어그램 생성
      for (const type of diagramTypes) {
        // 키워드 컨텍스트가 있으면 포커스된 트랜스크립트 사용
        let targetTranscript = transcript;

        if (diagramContexts && typesWithContext.includes(type)) {
          const focusedTranscript = this.voiceBotService.buildFocusedTranscript(
            dto.roomId,
            type as 'flowchart' | 'sequence' | 'erd' | 'architecture',
          );
          if (focusedTranscript) {
            targetTranscript = focusedTranscript;
            this.logger.log(
              `[Generate From Context] ${type}: 포커스된 트랜스크립트 사용 (${focusedTranscript.length}자)`,
            );
          }
        }

        const input: ToolInput = {
          transcript: targetTranscript,
          context: {
            roomId: dto.roomId,
            // 키워드 정보 전달 (프롬프트 최적화용)
            keywords: diagramContextsSummary?.[type]?.keywords || [],
            useFocusedContext: typesWithContext.includes(type),
          },
        };

        const result = await this.mcpService.generateDiagram(type, input);

        if (result.success && result.output?.markdown) {
          diagrams[type] = result.output.markdown;
        }
      }

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `[Generate From Context] 완료 - ${elapsed}ms, 생성된 다이어그램: ${Object.keys(diagrams).join(', ') || '없음'}`,
      );

      return {
        success: true,
        diagrams,
        suggestedTypes: diagramTypes,
        context: {
          roomId: dto.roomId,
          transcript,
          keywords: diagramContextsSummary,
          lastUpdated: new Date().toISOString(),
        },
        elapsed,
      };
    } catch (error) {
      this.logger.error(`[Generate From Context] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 다이어그램 설명 요청 (LLM + TTS)
   * POST /mcp/explain-diagram
   */
  @Post('explain-diagram')
  async explainDiagram(@Body() dto: ExplainDiagramDto) {
    this.logger.log(`[Explain Diagram] type: ${dto.diagramType}, room: ${dto.roomId}`);

    try {
      const prompt = `다음 ${dto.diagramType} 다이어그램을 간단하게 설명해주세요. 2-3문장으로 핵심만 설명하세요.

다이어그램 코드:
${dto.mermaidCode}

설명:`;

      const explanation = await this.llmService.sendMessagePure(prompt, 300);

      return {
        success: true,
        explanation: explanation.trim(),
      };
    } catch (error) {
      this.logger.error(`[Explain Diagram] Error: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }
}
