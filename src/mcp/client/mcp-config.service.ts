/**
 * MCP Server 설정 관리 서비스
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpClientService } from './mcp-client.service';
import { McpServerConfig } from './mcp.types';

// 기본 MCP 서버 설정
const DEFAULT_SERVERS: McpServerConfig[] = [
  {
    name: 'filesystem',
    command: 'npx',
    args: [
      '-y',
      '@modelcontextprotocol/server-filesystem',
      process.env.MCP_FILESYSTEM_PATH || '/tmp/aura',
    ],
    description: '파일 시스템 접근 (다이어그램 저장)',
  },
  // Slack - 나중에 추가
  // {
  //   name: 'slack',
  //   command: 'npx',
  //   args: ['-y', '@modelcontextprotocol/server-slack'],
  //   env: {
  //     SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
  //     SLACK_TEAM_ID: process.env.SLACK_TEAM_ID || '',
  //   },
  //   description: 'Slack 메시지 전송 및 채널 관리',
  // },
];

@Injectable()
export class McpConfigService implements OnModuleInit {
  private readonly logger = new Logger(McpConfigService.name);
  private servers: McpServerConfig[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly mcpClient: McpClientService,
  ) {}

  async onModuleInit() {
    // 환경변수에서 MCP 서버 설정 로드
    this.loadServersFromEnv();

    // 기본 서버 추가
    this.servers.push(...DEFAULT_SERVERS);

    // 자동 연결 (옵션)
    const autoConnect = this.configService.get<boolean>('MCP_AUTO_CONNECT', false);
    if (autoConnect) {
      await this.connectAll();
    }
  }

  /**
   * 환경변수에서 MCP 서버 설정 로드
   * 형식: MCP_SERVERS='[{"name":"notion","command":"npx",...}]'
   */
  private loadServersFromEnv(): void {
    const serversJson = this.configService.get<string>('MCP_SERVERS');
    if (serversJson) {
      try {
        const servers = JSON.parse(serversJson);
        if (Array.isArray(servers)) {
          this.servers.push(...servers);
          this.logger.log(`Loaded ${servers.length} MCP servers from env`);
        }
      } catch (err) {
        this.logger.error('Failed to parse MCP_SERVERS env:', err);
      }
    }
  }

  /**
   * 서버 설정 추가
   */
  addServer(config: McpServerConfig): void {
    const existing = this.servers.find((s) => s.name === config.name);
    if (existing) {
      this.logger.warn(`MCP server already configured: ${config.name}`);
      return;
    }
    this.servers.push(config);
    this.logger.log(`Added MCP server config: ${config.name}`);
  }

  /**
   * 서버 설정 제거
   */
  removeServer(name: string): void {
    this.servers = this.servers.filter((s) => s.name !== name);
    this.mcpClient.disconnect(name);
  }

  /**
   * 모든 서버에 연결
   */
  async connectAll(): Promise<void> {
    for (const server of this.servers) {
      try {
        await this.mcpClient.connect(server);
      } catch (err) {
        this.logger.error(`Failed to connect to ${server.name}:`, err);
      }
    }
  }

  /**
   * 특정 서버에 연결
   */
  async connectServer(name: string): Promise<void> {
    const config = this.servers.find((s) => s.name === name);
    if (!config) {
      throw new Error(`MCP server not configured: ${name}`);
    }
    await this.mcpClient.connect(config);
  }

  /**
   * 설정된 서버 목록
   */
  getServers(): McpServerConfig[] {
    return [...this.servers];
  }

  /**
   * 서버 설정 조회
   */
  getServer(name: string): McpServerConfig | undefined {
    return this.servers.find((s) => s.name === name);
  }
}
