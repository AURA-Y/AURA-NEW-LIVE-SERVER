/**
 * MCP Tools 등록
 */

import { McpTool } from '../types/tool.types';
import { flowchartTool } from './flowchart.tool';
import { sequenceTool } from './sequence.tool';
import { erdTool } from './erd.tool';
import { architectureTool } from './architecture.tool';
import { kanbanTool } from './kanban.tool';

// 모든 도구 배열
export const allTools: McpTool[] = [
  flowchartTool,
  sequenceTool,
  erdTool,
  architectureTool,
  kanbanTool,
];

// 도구 이름으로 매핑
export const toolMap: Map<string, McpTool> = new Map(
  allTools.map((tool) => [tool.name, tool]),
);

// 카테고리별 도구
export const toolsByCategory = {
  diagram: allTools.filter((t) => t.category === 'diagram'),
  document: allTools.filter((t) => t.category === 'document'),
  management: allTools.filter((t) => t.category === 'management'),
  analysis: allTools.filter((t) => t.category === 'analysis'),
};

// 개별 도구 export
export { flowchartTool } from './flowchart.tool';
export { sequenceTool } from './sequence.tool';
export { erdTool } from './erd.tool';
export { architectureTool } from './architecture.tool';
export { kanbanTool } from './kanban.tool';
