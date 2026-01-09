/**
 * MCP Client Service
 * 외부 MCP 서버와 통신하는 클라이언트
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, ChildProcess } from 'child_process';
import {
  McpServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  InitializeResult,
  ToolsListResult,
  ToolCallParams,
  ToolCallResult,
  McpToolDefinition,
  McpConnectionState,
} from './mcp.types';

interface McpConnection {
  config: McpServerConfig;
  process: ChildProcess;
  state: McpConnectionState;
  tools: McpToolDefinition[];
  pendingRequests: Map<string | number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>;
  requestId: number;
  buffer: string;
}

@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private connections: Map<string, McpConnection> = new Map();

  async onModuleDestroy() {
    // 모든 연결 종료
    for (const [name, conn] of this.connections) {
      this.logger.log(`Closing MCP connection: ${name}`);
      conn.process.kill();
    }
    this.connections.clear();
  }

  /**
   * MCP 서버에 연결
   */
  async connect(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      this.logger.warn(`MCP server already connected: ${config.name}`);
      return;
    }

    this.logger.log(`Connecting to MCP server: ${config.name}`);

    const proc = spawn(config.command, config.args || [], {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const connection: McpConnection = {
      config,
      process: proc,
      state: 'connecting',
      tools: [],
      pendingRequests: new Map(),
      requestId: 0,
      buffer: '',
    };

    this.connections.set(config.name, connection);

    // stdout 처리 (MCP 응답)
    proc.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(config.name, data);
    });

    // stderr 처리 (로그)
    proc.stderr?.on('data', (data: Buffer) => {
      this.logger.debug(`[${config.name}] ${data.toString()}`);
    });

    // 프로세스 종료 처리
    proc.on('close', (code) => {
      this.logger.log(`MCP server ${config.name} exited with code ${code}`);
      connection.state = 'disconnected';
    });

    proc.on('error', (err) => {
      this.logger.error(`MCP server ${config.name} error:`, err);
      connection.state = 'error';
    });

    // Initialize 핸드셰이크
    try {
      await this.initialize(config.name);
      connection.state = 'connected';

      // 도구 목록 가져오기
      const tools = await this.listTools(config.name);
      connection.tools = tools;

      this.logger.log(
        `MCP server ${config.name} connected with ${tools.length} tools`,
      );
    } catch (error) {
      connection.state = 'error';
      throw error;
    }
  }

  /**
   * MCP 서버 연결 해제
   */
  disconnect(serverName: string): void {
    const conn = this.connections.get(serverName);
    if (conn) {
      conn.process.kill();
      this.connections.delete(serverName);
      this.logger.log(`Disconnected from MCP server: ${serverName}`);
    }
  }

  /**
   * 도구 호출
   */
  async callTool(
    serverName: string,
    toolName: string,
    args?: Record<string, any>,
  ): Promise<ToolCallResult> {
    const params: ToolCallParams = {
      name: toolName,
      arguments: args,
    };

    return this.sendRequest(serverName, 'tools/call', params);
  }

  /**
   * 사용 가능한 도구 목록 조회
   */
  async listTools(serverName: string): Promise<McpToolDefinition[]> {
    const result: ToolsListResult = await this.sendRequest(
      serverName,
      'tools/list',
    );
    return result.tools;
  }

  /**
   * 연결된 모든 서버의 도구 목록
   */
  getAllTools(): Map<string, McpToolDefinition[]> {
    const result = new Map<string, McpToolDefinition[]>();
    for (const [name, conn] of this.connections) {
      if (conn.state === 'connected') {
        result.set(name, conn.tools);
      }
    }
    return result;
  }

  /**
   * 연결 상태 확인
   */
  getConnectionState(serverName: string): McpConnectionState {
    return this.connections.get(serverName)?.state || 'disconnected';
  }

  /**
   * Initialize 핸드셰이크
   */
  private async initialize(serverName: string): Promise<InitializeResult> {
    const params: InitializeParams = {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: true },
      },
      clientInfo: {
        name: 'aura-mcp-client',
        version: '1.0.0',
      },
    };

    const result = await this.sendRequest<InitializeResult>(
      serverName,
      'initialize',
      params,
    );

    // initialized 알림 전송
    await this.sendNotification(serverName, 'notifications/initialized');

    return result;
  }

  /**
   * JSON-RPC 요청 전송
   */
  private sendRequest<T = any>(
    serverName: string,
    method: string,
    params?: Record<string, any>,
  ): Promise<T> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return Promise.reject(new Error(`MCP server not connected: ${serverName}`));
    }

    const id = ++conn.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      conn.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify(request) + '\n';
      conn.process.stdin?.write(message, (err) => {
        if (err) {
          conn.pendingRequests.delete(id);
          reject(err);
        }
      });

      // 타임아웃 설정 (30초)
      setTimeout(() => {
        if (conn.pendingRequests.has(id)) {
          conn.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * JSON-RPC 알림 전송 (응답 없음)
   */
  private sendNotification(
    serverName: string,
    method: string,
    params?: Record<string, any>,
  ): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return Promise.reject(new Error(`MCP server not connected: ${serverName}`));
    }

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const message = JSON.stringify(notification) + '\n';
      conn.process.stdin?.write(message, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * stdout 데이터 처리
   */
  private handleStdout(serverName: string, data: Buffer): void {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    conn.buffer += data.toString();

    // 줄바꿈으로 메시지 분리
    const lines = conn.buffer.split('\n');
    conn.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response: JsonRpcResponse = JSON.parse(line);
        this.handleResponse(serverName, response);
      } catch (err) {
        this.logger.warn(`Failed to parse MCP response: ${line}`);
      }
    }
  }

  /**
   * JSON-RPC 응답 처리
   */
  private handleResponse(serverName: string, response: JsonRpcResponse): void {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    const pending = conn.pendingRequests.get(response.id);
    if (!pending) {
      this.logger.warn(`Unknown response id: ${response.id}`);
      return;
    }

    conn.pendingRequests.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }
}
