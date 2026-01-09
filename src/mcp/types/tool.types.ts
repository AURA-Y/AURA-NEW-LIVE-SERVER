/**
 * MCP Tool Set 타입 정의
 */

// 도구 입력
export interface ToolInput {
  transcript: string;
  context?: ToolContext;
  options?: Record<string, any>;
}

export interface ToolContext {
  roomId?: string;
  channelId?: string;
  participants?: string[];
  topic?: string;
}

// 도구 출력
export interface ToolOutput {
  type: string;
  data: any;
  markdown?: string;
  metadata: ToolMetadata;
}

export interface ToolMetadata {
  generatedAt: string;
  toolName: string;
  editable: boolean;
}

// 도구 정의
export interface McpTool {
  name: string;
  description: string;
  category: ToolCategory;
  keywords: string[];
  execute: (input: ToolInput, llmCall: LlmCallFn) => Promise<ToolOutput>;
}

export type ToolCategory = 'diagram' | 'document' | 'management' | 'analysis';

// LLM 호출 함수 타입 (LlmService.sendMessagePure 시그니처)
export type LlmCallFn = (prompt: string, maxTokens?: number) => Promise<string>;

// ============================================
// 다이어그램 타입들
// ============================================

// Flowchart
export interface FlowchartNode {
  id: string;
  type: 'start' | 'end' | 'process' | 'decision' | 'io';
  label: string;
}

export interface FlowchartEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface FlowchartData {
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

// Sequence Diagram
export interface SequenceActor {
  id: string;
  name: string;
  type: 'user' | 'frontend' | 'backend' | 'database' | 'external';
}

export interface SequenceMessage {
  id: string;
  from: string;
  to: string;
  label: string;
  type: 'sync' | 'async' | 'response';
}

export interface SequenceData {
  actors: SequenceActor[];
  messages: SequenceMessage[];
}

// ERD
export interface ERDTable {
  name: string;
  columns: ERDColumn[];
}

export interface ERDColumn {
  name: string;
  type: string;
  pk?: boolean;
  fk?: string;
  nullable?: boolean;
}

export interface ERDRelation {
  from: string;
  to: string;
  type: '1:1' | '1:N' | 'N:M';
  label?: string;
}

export interface ERDData {
  tables: ERDTable[];
  relations: ERDRelation[];
}

// Architecture
export interface ArchNode {
  id: string;
  name: string;
  type: 'client' | 'server' | 'database' | 'cache' | 'queue' | 'external' | 'loadbalancer';
  group?: string;
}

export interface ArchConnection {
  from: string;
  to: string;
  label?: string;
  protocol?: string;
}

export interface ArchitectureData {
  nodes: ArchNode[];
  connections: ArchConnection[];
}

// ============================================
// 문서 타입들
// ============================================

// Meeting Summary
export interface MeetingSummaryData {
  title: string;
  date: string;
  participants: string[];
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: ActionItem[];
}

export interface ActionItem {
  task: string;
  assignee?: string;
  dueDate?: string;
  priority?: 'high' | 'medium' | 'low';
}

// Kanban WBS
export interface KanbanTask {
  id: string;
  title: string;
  assignee?: string;
  dueDate?: string;
  status: 'todo' | 'in_progress' | 'review' | 'done';
  tags?: string[];
}

export interface KanbanData {
  title: string;
  tasks: KanbanTask[];
}
