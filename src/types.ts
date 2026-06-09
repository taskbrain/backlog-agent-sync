export type AgentTool = "claude" | "codex";

export type LifecycleEvent = "session-start" | "post-tool" | "subagent-stop" | "stop" | "session-end";

export interface CanonicalEvent {
  tool: AgentTool;
  event: LifecycleEvent;
  sessionId: string;
  cwd: string;
  source?: string; // session-start: startup|resume|clear|compact
  toolName?: string; // post-tool
  toolUseId?: string; // 冪等キー材料
  agentType?: string; // subagent-stop
  stopHookActive?: boolean; // stop
  reason?: string; // session-end
  raw: unknown;
}

export interface StatusMap {
  open: number;
  in_progress: number;
  resolved: number;
  closed: number;
  [k: string]: number;
}

export interface QueuedOp {
  id: string;
  op: "add_comment" | "update_issue" | "add_issue";
  payload: Record<string, unknown>;
  attempts: number;
}

export interface ActivityEntry {
  ts: string;
  tool: string;
  summary: string;
}

export interface SessionState {
  sessionId: string;
  issueKey?: string;
  issueId?: number;
  parentIssueId?: number;
  statusMap: StatusMap;
  todoToChecklist: Record<string, string>;
  processedEvents: string[];
  pendingQueue: QueuedOp[];
  activityBuffer: ActivityEntry[];
  inboundCursor?: { issuesUpdatedSince?: string; commentMaxId?: Record<string, number> };
  lastStatus?: string;
}

export interface BacklogConfig {
  domain: string;
  apiKey: string;
  projectKey: string;
  projectId?: number;
}
