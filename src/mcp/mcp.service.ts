/**
 * MCP 통합 서비스
 *
 * 역할 분리:
 * - Bedrock Claude: 다이어그램 생성 (두뇌)
 * - External MCP Servers: 저장/전송/렌더링 (손발)
 */

import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { McpClientService } from './client/mcp-client.service';
import { McpConfigService } from './client/mcp-config.service';
import { allTools, toolMap } from './tools';
import { McpTool, ToolInput, ToolOutput, ToolCategory } from './types/tool.types';
import { ToolCallResult, McpToolDefinition } from './client/mcp.types';

// 내부 도구 실행 결과
export interface InternalToolResult {
  success: boolean;
  output?: ToolOutput;
  error?: string;
}

// 외부 MCP 도구 실행 결과
export interface ExternalToolResult {
  success: boolean;
  content?: string;
  error?: string;
}

// 다이어그램 캐시 항목
interface DiagramCacheEntry {
  result: InternalToolResult;
  timestamp: number;
  transcriptHash: string;
}

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  // 다이어그램 캐시 (5분 TTL)
  private readonly diagramCache = new Map<string, DiagramCacheEntry>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5분

  constructor(
    private readonly llmService: LlmService,
    private readonly mcpClient: McpClientService,
    private readonly mcpConfig: McpConfigService,
  ) {
    // 캐시 정리 (10분마다)
    setInterval(() => this.cleanupCache(), 10 * 60 * 1000);
  }

  private cleanupCache() {
    const now = Date.now();
    for (const [key, entry] of this.diagramCache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        this.diagramCache.delete(key);
      }
    }
  }

  private hashTranscript(transcript: string): string {
    // 간단한 해시 (처음 100자 + 길이)
    return `${transcript.slice(0, 100)}_${transcript.length}`;
  }

  // ============================================
  // 내부 도구 (Bedrock Claude 사용)
  // ============================================

  /**
   * 다이어그램 생성 (Bedrock Claude) - 캐싱 적용
   */
  async generateDiagram(
    toolName: string,
    input: ToolInput,
  ): Promise<InternalToolResult> {
    const tool = toolMap.get(toolName);

    if (!tool) {
      return {
        success: false,
        error: `다이어그램 도구를 찾을 수 없습니다: ${toolName}`,
      };
    }

    // 캐시 키 생성
    const transcriptHash = this.hashTranscript(input.transcript);
    const cacheKey = `${toolName}_${transcriptHash}`;

    // 캐시 확인
    const cached = this.diagramCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.logger.log(`[Cache HIT] ${toolName} 다이어그램`);
      return cached.result;
    }

    const startTime = Date.now();

    try {
      this.logger.log(`[Generate] ${toolName} 다이어그램 생성 시작...`);

      const output = await tool.execute(input, (prompt, maxTokens) =>
        this.llmService.sendMessagePure(prompt, maxTokens),
      );

      const elapsed = Date.now() - startTime;
      this.logger.log(`[Generate] ${toolName} 완료 - ${elapsed}ms`);

      const result: InternalToolResult = {
        success: true,
        output,
      };

      // 캐시 저장
      this.diagramCache.set(cacheKey, {
        result,
        timestamp: Date.now(),
        transcriptHash,
      });

      return result;
    } catch (error) {
      this.logger.error(`Diagram generation failed:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 사용 가능한 내부 다이어그램 도구 목록
   */
  getInternalTools(): Array<{
    name: string;
    description: string;
    category: ToolCategory;
  }> {
    return allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
    }));
  }

  // ============================================
  // 외부 MCP 서버 (유틸리티)
  // ============================================

  /**
   * 외부 MCP 서버 도구 호출
   */
  async callExternalTool(
    serverName: string,
    toolName: string,
    args?: Record<string, any>,
  ): Promise<ExternalToolResult> {
    try {
      this.logger.log(`Calling external tool: ${serverName}/${toolName}`);

      const result: ToolCallResult = await this.mcpClient.callTool(
        serverName,
        toolName,
        args,
      );

      if (result.isError) {
        return {
          success: false,
          error: result.content?.[0]?.text || 'Unknown error',
        };
      }

      // 텍스트 콘텐츠 추출
      const textContent = result.content
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');

      return {
        success: true,
        content: textContent,
      };
    } catch (error) {
      this.logger.error(`External tool call failed:`, error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 외부 MCP 서버 연결
   */
  async connectExternalServer(serverName: string): Promise<void> {
    await this.mcpConfig.connectServer(serverName);
  }

  /**
   * 모든 외부 MCP 서버 연결
   */
  async connectAllExternalServers(): Promise<void> {
    await this.mcpConfig.connectAll();
  }

  /**
   * 외부 MCP 서버 도구 목록
   */
  getExternalTools(): Map<string, McpToolDefinition[]> {
    return this.mcpClient.getAllTools();
  }

  // ============================================
  // 통합 워크플로우
  // ============================================

  /**
   * 다이어그램 생성 후 파일로 저장
   */
  async generateAndSaveToFile(
    diagramType: string,
    transcript: string,
    roomId?: string,
  ): Promise<{
    diagram: InternalToolResult;
    file?: ExternalToolResult;
  }> {
    // 1. Bedrock Claude로 다이어그램 생성
    const diagram = await this.generateDiagram(diagramType, { transcript });

    if (!diagram.success || !diagram.output) {
      return { diagram };
    }

    // 2. Filesystem MCP로 저장 (연결되어 있다면)
    const fsState = this.mcpClient.getConnectionState('filesystem');
    if (fsState !== 'connected') {
      return { diagram };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${roomId || 'meeting'}_${diagramType}_${timestamp}.md`;

    const file = await this.callExternalTool('filesystem', 'write_file', {
      path: filename,
      content: diagram.output.markdown,
    });

    return { diagram, file };
  }

  /**
   * 다이어그램 생성 후 Slack으로 공유
   */
  async generateAndShareToSlack(
    diagramType: string,
    transcript: string,
    slackChannel: string,
  ): Promise<{
    diagram: InternalToolResult;
    slack?: ExternalToolResult;
  }> {
    // 1. Bedrock Claude로 다이어그램 생성
    const diagram = await this.generateDiagram(diagramType, { transcript });

    if (!diagram.success || !diagram.output) {
      return { diagram };
    }

    // 2. Slack MCP로 전송 (연결되어 있다면)
    const slackState = this.mcpClient.getConnectionState('slack');
    if (slackState !== 'connected') {
      return { diagram };
    }

    const slack = await this.callExternalTool('slack', 'slack_post_message', {
      channel_id: slackChannel,
      text: `새 ${diagramType} 다이어그램이 생성되었습니다:\n\n${diagram.output.markdown}`,
    });

    return { diagram, slack };
  }

  // ============================================
  // 키워드 기반 자동 도구 선택
  // ============================================

  /**
   * 키워드로 적절한 다이어그램 도구 찾기
   */
  findDiagramToolByKeyword(keyword: string): McpTool | null {
    const normalizedKeyword = keyword.toLowerCase().trim();

    for (const tool of allTools) {
      // 도구 이름 직접 매칭
      if (tool.name.toLowerCase() === normalizedKeyword) {
        return tool;
      }

      // 키워드 매칭
      for (const kw of tool.keywords) {
        if (
          kw.toLowerCase() === normalizedKeyword ||
          kw.toLowerCase().includes(normalizedKeyword)
        ) {
          return tool;
        }
      }
    }

    return null;
  }
}
