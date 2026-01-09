/**
 * ERD (Entity Relationship Diagram) 생성 도구
 * 회의 중 논의된 데이터 모델을 ERD로 변환
 */

import {
  McpTool,
  ToolInput,
  ToolOutput,
  LlmCallFn,
  ERDData,
} from '../types/tool.types';

const ERD_PROMPT = `당신은 회의 내용을 분석하여 ERD(Entity Relationship Diagram) 데이터를 생성하는 전문가입니다.

주어진 회의 내용에서 데이터 모델, 엔티티, 관계를 추출하여 JSON 형식의 ERD 데이터로 변환하세요.

## 규칙
1. 테이블 명명:
   - PascalCase 사용 (예: User, OrderItem)
   - 복수형 피하기 (Users X → User O)

2. 컬럼 속성:
   - pk: Primary Key 여부
   - fk: Foreign Key 참조 테이블 (예: "User")
   - nullable: NULL 허용 여부

3. 관계 타입:
   - 1:1 (일대일)
   - 1:N (일대다)
   - N:M (다대다)

4. 필수 컬럼:
   - id (PK)
   - createdAt, updatedAt (타임스탬프)

5. 출력 형식 (반드시 JSON만 출력):
{
  "tables": [
    {
      "name": "User",
      "columns": [
        { "name": "id", "type": "uuid", "pk": true },
        { "name": "email", "type": "varchar(255)", "nullable": false },
        { "name": "name", "type": "varchar(100)", "nullable": false },
        { "name": "createdAt", "type": "timestamp", "nullable": false },
        { "name": "updatedAt", "type": "timestamp", "nullable": false }
      ]
    },
    {
      "name": "Order",
      "columns": [
        { "name": "id", "type": "uuid", "pk": true },
        { "name": "userId", "type": "uuid", "fk": "User", "nullable": false },
        { "name": "status", "type": "varchar(20)", "nullable": false },
        { "name": "totalAmount", "type": "decimal(10,2)", "nullable": false }
      ]
    }
  ],
  "relations": [
    { "from": "User", "to": "Order", "type": "1:N", "label": "has" }
  ]
}

회의 내용:
`;

export const erdTool: McpTool = {
  name: 'erd',
  description: '데이터 모델/엔티티 관계를 ERD로 시각화',
  category: 'diagram',
  keywords: ['ERD', 'erd', '데이터베이스', 'DB', '테이블', '엔티티', '관계', '스키마', '모델'],

  async execute(input: ToolInput, llmCall: LlmCallFn): Promise<ToolOutput> {
    const prompt = ERD_PROMPT + input.transcript;

    const response = await llmCall(prompt, 3000);

    // JSON 파싱
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM이 유효한 JSON을 생성하지 못했습니다');
    }

    const data: ERDData = JSON.parse(jsonMatch[0]);

    // 데이터 검증
    if (!data.tables || data.tables.length === 0) {
      throw new Error('ERD 데이터가 불완전합니다');
    }

    // Markdown 생성 (Mermaid 형식)
    const markdown = generateMermaidERD(data);

    return {
      type: 'erd',
      data,
      markdown,
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'erd',
        editable: true,
      },
    };
  },
};

function generateMermaidERD(data: ERDData): string {
  const lines: string[] = ['```mermaid', 'erDiagram'];

  // 테이블 정의
  for (const table of data.tables) {
    lines.push(`    ${table.name} {`);
    for (const col of table.columns) {
      const pkMark = col.pk ? 'PK' : col.fk ? 'FK' : '';
      const nullMark = col.nullable === false ? '' : '"nullable"';
      lines.push(`        ${col.type.replace(/[(),]/g, '_')} ${col.name} ${pkMark} ${nullMark}`.trimEnd());
    }
    lines.push('    }');
  }

  lines.push('');

  // 관계 정의
  for (const rel of data.relations) {
    let relSymbol: string;
    switch (rel.type) {
      case '1:1':
        relSymbol = '||--||';
        break;
      case '1:N':
        relSymbol = '||--o{';
        break;
      case 'N:M':
        relSymbol = '}o--o{';
        break;
      default:
        relSymbol = '||--||';
    }
    const label = rel.label || '';
    lines.push(`    ${rel.from} ${relSymbol} ${rel.to} : "${label}"`);
  }

  lines.push('```');
  return lines.join('\n');
}
