/**
 * Flowchart 생성 도구
 * 회의 중 논의된 프로세스/워크플로우를 플로우차트로 변환
 */

import {
  McpTool,
  ToolInput,
  ToolOutput,
  LlmCallFn,
  FlowchartData,
} from '../types/tool.types';

const FLOWCHART_PROMPT = `당신은 회의 내용을 분석하여 플로우차트 데이터를 생성하는 전문가입니다.

주어진 회의 내용에서 프로세스, 워크플로우, 또는 의사결정 흐름을 추출하여 JSON 형식의 플로우차트 데이터로 변환하세요.

## 규칙
1. 노드 타입:
   - start: 시작점 (하나만)
   - end: 종료점 (하나 이상)
   - process: 일반 처리 단계
   - decision: 조건 분기 (예/아니오)
   - io: 입출력 (사용자 입력, API 호출 등)

2. 연결(Edge) 규칙:
   - decision 노드에서 나가는 edge는 label 필수 (예: "Yes", "No", "성공", "실패")
   - 모든 노드는 연결되어야 함
   - 순환(cycle)은 허용되지만 무한루프는 피할 것

3. 출력 형식 (반드시 JSON만 출력):
{
  "nodes": [
    { "id": "node1", "type": "start", "label": "시작" },
    { "id": "node2", "type": "process", "label": "처리 단계" },
    { "id": "node3", "type": "decision", "label": "조건 확인?" },
    { "id": "node4", "type": "end", "label": "종료" }
  ],
  "edges": [
    { "id": "e1", "source": "node1", "target": "node2" },
    { "id": "e2", "source": "node2", "target": "node3" },
    { "id": "e3", "source": "node3", "target": "node4", "label": "Yes" }
  ]
}

회의 내용:
`;

export const flowchartTool: McpTool = {
  name: 'flowchart',
  description: '회의 내용에서 프로세스/워크플로우를 플로우차트로 시각화',
  category: 'diagram',
  keywords: ['플로우차트', 'flowchart', '흐름도', '프로세스', '워크플로우', '순서도', '단계'],

  async execute(input: ToolInput, llmCall: LlmCallFn): Promise<ToolOutput> {
    const prompt = FLOWCHART_PROMPT + input.transcript;

    const response = await llmCall(prompt, 2000);

    // JSON 파싱
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM이 유효한 JSON을 생성하지 못했습니다');
    }

    const data: FlowchartData = JSON.parse(jsonMatch[0]);

    // 데이터 검증
    if (!data.nodes || !data.edges || data.nodes.length === 0) {
      throw new Error('플로우차트 데이터가 불완전합니다');
    }

    // Markdown 생성 (Mermaid 형식)
    const markdown = generateMermaidFlowchart(data);

    return {
      type: 'flowchart',
      data,
      markdown,
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'flowchart',
        editable: true,
      },
    };
  },
};

function generateMermaidFlowchart(data: FlowchartData): string {
  const lines: string[] = ['```mermaid', 'flowchart TD'];

  // 노드 정의
  for (const node of data.nodes) {
    let shape: string;
    switch (node.type) {
      case 'start':
      case 'end':
        shape = `${node.id}((${node.label}))`;
        break;
      case 'decision':
        shape = `${node.id}{${node.label}}`;
        break;
      case 'io':
        shape = `${node.id}[/${node.label}/]`;
        break;
      default:
        shape = `${node.id}[${node.label}]`;
    }
    lines.push(`    ${shape}`);
  }

  // 엣지 정의
  for (const edge of data.edges) {
    const label = edge.label ? `|${edge.label}|` : '';
    lines.push(`    ${edge.source} -->${label} ${edge.target}`);
  }

  lines.push('```');
  return lines.join('\n');
}
