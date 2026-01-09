/**
 * Kanban WBS 생성 도구
 * 회의 중 논의된 업무를 칸반 보드 형태의 WBS로 변환
 */

import {
  McpTool,
  ToolInput,
  ToolOutput,
  LlmCallFn,
  KanbanData,
} from '../types/tool.types';

const KANBAN_PROMPT = `당신은 회의 내용을 분석하여 칸반 보드 형태의 WBS(Work Breakdown Structure) 데이터를 생성하는 전문가입니다.

주어진 회의 내용에서 업무, 담당자, 일정을 추출하여 JSON 형식의 칸반 데이터로 변환하세요.

## 규칙
1. 태스크 상태:
   - todo: 해야 할 일
   - in_progress: 진행 중
   - review: 검토 중
   - done: 완료

2. 태스크 속성:
   - title: 명확하고 구체적인 업무 제목
   - assignee: 담당자 (언급된 경우)
   - dueDate: 마감일 (YYYY-MM-DD 형식, 언급된 경우)
   - tags: 관련 태그 (기능, 버그, 문서 등)

3. 우선순위:
   - 먼저 언급된 업무가 더 중요한 경향
   - 명시적으로 "급한", "먼저" 등이 언급되면 상단 배치

4. 출력 형식 (반드시 JSON만 출력):
{
  "title": "스프린트 #1 - 회원가입 기능",
  "tasks": [
    {
      "id": "task1",
      "title": "회원가입 API 설계",
      "assignee": "김철수",
      "dueDate": "2024-01-15",
      "status": "in_progress",
      "tags": ["backend", "api"]
    },
    {
      "id": "task2",
      "title": "회원가입 UI 구현",
      "assignee": "이영희",
      "status": "todo",
      "tags": ["frontend", "ui"]
    },
    {
      "id": "task3",
      "title": "이메일 인증 로직 구현",
      "status": "todo",
      "tags": ["backend", "email"]
    }
  ]
}

회의 내용:
`;

export const kanbanTool: McpTool = {
  name: 'kanban',
  description: '업무/태스크를 칸반 보드 형태의 WBS로 정리',
  category: 'management',
  keywords: ['칸반', 'kanban', 'WBS', '업무', '태스크', '할일', '담당', '일정', '스프린트'],

  async execute(input: ToolInput, llmCall: LlmCallFn): Promise<ToolOutput> {
    const prompt = KANBAN_PROMPT + input.transcript;

    const response = await llmCall(prompt, 2000);

    // JSON 파싱
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('LLM이 유효한 JSON을 생성하지 못했습니다');
    }

    const data: KanbanData = JSON.parse(jsonMatch[0]);

    // 데이터 검증
    if (!data.tasks || data.tasks.length === 0) {
      throw new Error('칸반 데이터가 불완전합니다');
    }

    // Markdown 생성
    const markdown = generateKanbanMarkdown(data);

    return {
      type: 'kanban',
      data,
      markdown,
      metadata: {
        generatedAt: new Date().toISOString(),
        toolName: 'kanban',
        editable: true,
      },
    };
  },
};

function generateKanbanMarkdown(data: KanbanData): string {
  const lines: string[] = [`## ${data.title}`, ''];

  // 상태별 그룹핑
  const statusGroups = {
    todo: [] as typeof data.tasks,
    in_progress: [] as typeof data.tasks,
    review: [] as typeof data.tasks,
    done: [] as typeof data.tasks,
  };

  for (const task of data.tasks) {
    statusGroups[task.status].push(task);
  }

  const statusLabels = {
    todo: 'To Do',
    in_progress: 'In Progress',
    review: 'Review',
    done: 'Done',
  };

  // 각 상태별 테이블 생성
  for (const [status, tasks] of Object.entries(statusGroups)) {
    if (tasks.length === 0) continue;

    lines.push(`### ${statusLabels[status as keyof typeof statusLabels]} (${tasks.length})`);
    lines.push('');
    lines.push('| Task | Assignee | Due Date | Tags |');
    lines.push('|------|----------|----------|------|');

    for (const task of tasks) {
      const assignee = task.assignee || '-';
      const dueDate = task.dueDate || '-';
      const tags = task.tags?.map(t => `\`${t}\``).join(' ') || '-';
      lines.push(`| ${task.title} | ${assignee} | ${dueDate} | ${tags} |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
