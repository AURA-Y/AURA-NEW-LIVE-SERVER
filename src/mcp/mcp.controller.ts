/**
 * MCP Controller
 * 다이어그램 생성 API 엔드포인트
 * 설계 보드 상태 관리
 */

import { Controller, Post, Body, Get, Param, Logger, Inject } from '@nestjs/common';
import { McpService } from './mcp.service';
import { ToolInput } from './types/tool.types';
import { RAG_CLIENT, IRagClient } from '../rag/rag-client.interface';

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
   * 컨텍스트 기반 다이어그램 생성 (병렬 처리로 속도 개선)
   * POST /mcp/diagram/generate-from-context
   */
  @Post('diagram/generate-from-context')
  async generateFromContext(@Body() dto: GenerateFromContextDto) {
    const startTime = Date.now();
    this.logger.log(`[Generate From Context] room: ${dto.roomId}, types: ${dto.diagramTypes?.join(', ')}`);

    try {
      // 1. RAG 버퍼에서 트랜스크립트 가져오기
      const transcript = this.ragClient.getFormattedTranscript(dto.roomId);

      if (!transcript || transcript.trim().length === 0) {
        return {
          success: false,
          error: '회의 내용이 없습니다. 대화가 진행된 후 다시 시도해주세요.',
        };
      }

      const diagramTypes = dto.diagramTypes || ['flowchart', 'erd'];
      const diagrams: Record<string, string> = {};

      // 2. 병렬로 다이어그램 생성 (속도 개선)
      const generatePromises = diagramTypes.map(async (type) => {
        const input: ToolInput = {
          transcript,
          context: { roomId: dto.roomId },
        };

        const result = await this.mcpService.generateDiagram(type, input);

        if (result.success && result.output?.markdown) {
          return { type, mermaid: result.output.markdown };
        }
        return { type, mermaid: null };
      });

      const results = await Promise.all(generatePromises);

      for (const { type, mermaid } of results) {
        if (mermaid) {
          diagrams[type] = mermaid;
        }
      }

      const elapsed = Date.now() - startTime;
      this.logger.log(`[Generate From Context] 완료 - ${elapsed}ms, 생성된 다이어그램: ${Object.keys(diagrams).join(', ')}`);

      return {
        success: true,
        diagrams,
        context: {
          roomId: dto.roomId,
          transcript,
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
   * 다이어그램 설명 요청
   * POST /mcp/explain-diagram
   */
  @Post('explain-diagram')
  async explainDiagram(@Body() dto: ExplainDiagramDto) {
    this.logger.log(`[Explain Diagram] type: ${dto.diagramType}, room: ${dto.roomId}`);

    // 향후 LLM 연동으로 설명 생성 가능
    return {
      success: true,
      explanation: `${dto.diagramType} 다이어그램이 생성되었습니다.`,
    };
  }
}
