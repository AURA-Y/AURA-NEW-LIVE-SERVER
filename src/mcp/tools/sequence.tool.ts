/**
 * Sequence Diagram 생성 도구
 * 회의 중 논의된 시스템 간 상호작용을 시퀀스 다이어그램으로 변환
 */

import {
  McpTool,
  ToolInput,
  ToolOutput,
  LlmCallFn,
  SequenceData,
} from '../types/tool.types';

const SEQUENCE_PROMPT = `당신은 회의 내용을 분석하여 시퀀스 다이어그램 데이터를 생성하는 전문가입니다.

주어진 회의 내용에서 시스템/컴포넌트 간의 상호작용을 추출하여 JSON 형식의 시퀀스 다이어그램 데이터로 변환하세요.

## 규칙
1. Actor 타입:
   - user: 사용자/클라이언트
   - frontend: 프론트엔드 (웹, 앱)
   - backend: 백엔드 서버/API
   - database: 데이터베이스
   - external: 외부 서비스 (결제, 알림 등)

2. Message 타입:
   - sync: 동기 호출 (실선 화살표 →)
   - async: 비동기 호출 (점선 화살표 -→)
   - response: 응답 (점선 화살표 ←--)

3. 메시지 순서:
   - 시간순으로 배열
   - 요청-응답 쌍을 명확히

4. 출력 형식 (반드시 JSON만 출력):
{
  "actors": [
    { "id": "user", "name": "사용자", "type": "user" },
    { "id": "fe", "name": "Frontend", "type": "frontend" },
    { "id": "api", "name": "API Server", "type": "backend" },
    { "id": "db", "name": "Database", "type": "database" }
  ],
  "messages": [
    { "id": "m1", "from": "user", "to": "fe", "label": "로그인 버튼 클릭", "type": "sync" },
    { "id": "m2", "from": "fe", "to": "api", "label": "POST /auth/login", "type": "sync" },
    { "id": "m3", "from": "api", "to": "db", "label": "SELECT user", "type": "sync" },
    { "id": "m4", "from": "db", "to": "api", "label": "user data", "type": "response" },
    { "id": "m5", "from": "api", "to": "fe", "label": "JWT token", "type": "response" }
  ]
}

회의 내용:
`;

export const sequenceTool: McpTool = {
  name: 'sequence',
  description: '시스템/컴포넌트 간 상호작용을 시퀀스 다이어그램으로 시각화',
  category: 'diagram',
  keywords: ['시퀀스', 'sequence', '상호작용', 'API', '호출', '요청', '응답', '흐름'],

  async execute(input: ToolInput, llmCall: LlmCallFn): Promise<ToolOutput> {
    const prompt = SEQUENCE_PROMPT + input.transcript;

    const response = await llmCall(prompt, 2000);

    // JSON 파싱
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM이 유효한 JSON을 생성하지 못했습니다');
    }

    const data: SequenceData = JSON.parse(jsonMatch[0]);

    // 데이터 검증
    if (!data.actors || !data.messages || data.actors.length === 0) {
      throw new Error('시퀀스 다이어그램 데이터가 불완전합니다');
    }

    // Markdown 생성 (Mermaid 형식)
    const markdown = generateMermaidSequence(data);

    return {
      type: 'sequence',
      data,
      markdown,
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'sequence',
        editable: true,
      },
    };
  },
};

function generateMermaidSequence(data: SequenceData): string {
  const lines: string[] = ['```mermaid', 'sequenceDiagram'];

  // 참여자 정의
  for (const actor of data.actors) {
    lines.push(`    participant ${actor.id} as ${actor.name}`);
  }

  lines.push('');

  // 메시지 정의
  for (const msg of data.messages) {
    let arrow: string;
    switch (msg.type) {
      case 'sync':
        arrow = '->>';
        break;
      case 'async':
        arrow = '-->>';
        break;
      case 'response':
        arrow = '-->>';
        break;
      default:
        arrow = '->>';
    }
    lines.push(`    ${msg.from}${arrow}${msg.to}: ${msg.label}`);
  }

  lines.push('```');
  return lines.join('\n');
}
