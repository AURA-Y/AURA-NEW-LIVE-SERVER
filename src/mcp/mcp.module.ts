/**
 * MCP (Model Context Protocol) Module
 *
 * 구성:
 * 1. 내부 다이어그램 도구 (Bedrock Claude)
 * 2. 외부 MCP 서버 클라이언트 (filesystem 등)
 * 3. 설계 보드 상태 관리
 */

import { Module } from '@nestjs/common';
import { McpService } from './mcp.service';
import { McpController } from './mcp.controller';
import { McpClientService } from './client/mcp-client.service';
import { McpConfigService } from './client/mcp-config.service';
import { LlmModule } from '../llm/llm.module';
import { RagModule } from '../rag/rag.module';
import { LivekitModule } from '../livekit/livekit.module';

@Module({
  imports: [LlmModule, RagModule, LivekitModule],
  controllers: [McpController],
  providers: [
    McpService,
    McpClientService,
    McpConfigService,
  ],
  exports: [McpService, McpClientService],
})
export class McpModule {}
