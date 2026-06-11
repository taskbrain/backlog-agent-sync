export type AgentTool = "claude" | "codex";

export type LifecycleEvent = "session-start" | "user-prompt-submit" | "post-tool" | "subagent-stop" | "stop" | "session-end";

export interface CanonicalEvent {
  tool: AgentTool;
  event: LifecycleEvent;
  sessionId: string;
  cwd: string;
  source?: string; // session-start: startup|resume|clear|compact
  prompt?: string; // user-prompt-submit
  toolName?: string; // post-tool
  toolUseId?: string; // 冪等キー材料
  toolInput?: { filePath?: string; command?: string }; // post-tool 要旨（全文は持たない）
  agentType?: string; // subagent-stop
  stopHookActive?: boolean; // stop
  lastAssistantMessage?: string; // stop（Codex payload）
  transcriptPath?: string; // stop（Claude transcript JSONL）
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
  detail?: string; // 要旨（file_path / command 抜粋 / 追加依頼の冒頭）
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
  initialPrompt?: string; // 初回プロンプト（課題タイトル/説明の素材）
  lastPrompt?: string; // このターンのプロンプト（stop で消費・クリア）
  turnCount?: number; // ターン要約の連番
}

export interface BacklogConfig {
  domain: string;
  apiKey: string;
  projectKey: string;
  projectId?: number;
}
