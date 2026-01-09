/**
 * Architecture Diagram 생성 도구
 * 회의 중 논의된 시스템 아키텍처를 다이어그램으로 변환
 */

import {
  McpTool,
  ToolInput,
  ToolOutput,
  LlmCallFn,
  ArchitectureData,
} from '../types/tool.types';

const ARCHITECTURE_PROMPT = `당신은 회의 내용을 분석하여 시스템 아키텍처 다이어그램 데이터를 생성하는 전문가입니다.

주어진 회의 내용에서 시스템 구성요소와 연결관계를 추출하여 JSON 형식의 아키텍처 데이터로 변환하세요.

## 규칙
1. 노드 타입:
   - client: 클라이언트 (웹, 모바일, 데스크톱)
   - server: 서버/API
   - database: 데이터베이스
   - cache: 캐시 (Redis, Memcached)
   - queue: 메시지 큐 (Kafka, RabbitMQ)
   - external: 외부 서비스 (AWS, GCP, 3rd party)
   - loadbalancer: 로드밸런서/게이트웨이

2. 그룹(group):
   - 논리적 그룹핑 (예: "Frontend", "Backend", "Data Layer")
   - 선택적 속성

3. 연결(Connection):
   - protocol: 통신 프로토콜 (HTTP, gRPC, WebSocket, TCP 등)
   - label: 연결 설명

4. 출력 형식 (반드시 JSON만 출력):
{
  "nodes": [
    { "id": "web", "name": "Web App", "type": "client", "group": "Frontend" },
    { "id": "mobile", "name": "Mobile App", "type": "client", "group": "Frontend" },
    { "id": "lb", "name": "Load Balancer", "type": "loadbalancer" },
    { "id": "api1", "name": "API Server 1", "type": "server", "group": "Backend" },
    { "id": "api2", "name": "API Server 2", "type": "server", "group": "Backend" },
    { "id": "redis", "name": "Redis", "type": "cache", "group": "Data" },
    { "id": "postgres", "name": "PostgreSQL", "type": "database", "group": "Data" },
    { "id": "s3", "name": "AWS S3", "type": "external" }
  ],
  "connections": [
    { "from": "web", "to": "lb", "protocol": "HTTPS" },
    { "from": "mobile", "to": "lb", "protocol": "HTTPS" },
    { "from": "lb", "to": "api1", "protocol": "HTTP" },
    { "from": "lb", "to": "api2", "protocol": "HTTP" },
    { "from": "api1", "to": "redis", "protocol": "TCP", "label": "Session" },
    { "from": "api1", "to": "postgres", "protocol": "TCP" },
    { "from": "api1", "to": "s3", "protocol": "HTTPS", "label": "File Upload" }
  ]
}

회의 내용:
`;

export const architectureTool: McpTool = {
  name: 'architecture',
  description: '시스템 구성요소와 연결을 아키텍처 다이어그램으로 시각화',
  category: 'diagram',
  keywords: ['아키텍처', 'architecture', '시스템', '구성', '인프라', '서버', '구조'],

  async execute(input: ToolInput, llmCall: LlmCallFn): Promise<ToolOutput> {
    const prompt = ARCHITECTURE_PROMPT + input.transcript;

    const response = await llmCall(prompt, 3000);

    // JSON 파싱
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM이 유효한 JSON을 생성하지 못했습니다');
    }

    const data: ArchitectureData = JSON.parse(jsonMatch[0]);

    // 데이터 검증
    if (!data.nodes || data.nodes.length === 0) {
      throw new Error('아키텍처 데이터가 불완전합니다');
    }

    // Markdown 생성 (Mermaid 형식)
    const markdown = generateMermaidArchitecture(data);

    return {
      type: 'architecture',
      data,
      markdown,
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'architecture',
        editable: true,
      },
    };
  },
};

function generateMermaidArchitecture(data: ArchitectureData): string {
  const lines: string[] = ['```mermaid', 'flowchart TB'];

  // 그룹별 노드 분류
  const groups = new Map<string, typeof data.nodes>();
  const ungrouped: typeof data.nodes = [];

  for (const node of data.nodes) {
    if (node.group) {
      if (!groups.has(node.group)) {
        groups.set(node.group, []);
      }
      groups.get(node.group)!.push(node);
    } else {
      ungrouped.push(node);
    }
  }

  // 그룹 정의
  for (const [groupName, nodes] of groups) {
    const safeGroupId = groupName.replace(/\s+/g, '_');
    lines.push(`    subgraph ${safeGroupId}["${groupName}"]`);
    for (const node of nodes) {
      const shape = getNodeShape(node.type);
      lines.push(`        ${node.id}${shape.open}${node.name}${shape.close}`);
    }
    lines.push('    end');
  }

  // 비그룹 노드
  for (const node of ungrouped) {
    const shape = getNodeShape(node.type);
    lines.push(`    ${node.id}${shape.open}${node.name}${shape.close}`);
  }

  lines.push('');

  // 연결 정의
  for (const conn of data.connections) {
    const label = conn.label || conn.protocol || '';
    const labelStr = label ? `|${label}|` : '';
    lines.push(`    ${conn.from} -->${labelStr} ${conn.to}`);
  }

  lines.push('```');
  return lines.join('\n');
}

function getNodeShape(type: string): { open: string; close: string } {
  switch (type) {
    case 'client':
      return { open: '([', close: '])' }; // Stadium shape
    case 'database':
      return { open: '[(', close: ')]' }; // Cylinder
    case 'cache':
      return { open: '[(', close: ')]' }; // Cylinder
    case 'queue':
      return { open: '[[', close: ']]' }; // Subroutine
    case 'loadbalancer':
      return { open: '{{', close: '}}' }; // Hexagon
    case 'external':
      return { open: '((', close: '))' }; // Circle
    default:
      return { open: '[', close: ']' }; // Rectangle
  }
}
