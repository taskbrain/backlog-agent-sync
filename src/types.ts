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
  lastAssistantMessage?: string; // stop（Claude/Codex とも Stop stdin で受領。2026-06 時点の公式仕様）
  transcriptPath?: string; // stop（Claude transcript JSONL。lastAssistantMessage 欠落時のフォールバック）
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
  lastPromptSummary?: string; // このターンのプロンプトの LLM 整理（stop の ### 依頼 で消費・クリア）
  turnCount?: number; // ターン要約の連番
  turnStartHead?: string; // ターン開始時の HEAD SHA（stop のコミット列挙に使用）
}

export interface BacklogConfig {
  domain: string;
  apiKey: string;
  projectKey: string;
  projectId?: number;
}

// ---- VCS 連携 / 課題フィールド（G19。project.json の契約 — init(パートB) が書き、runtime/fields が読む） ----

export type VcsKind = "github" | "backlog" | "generic";

/** project.json `vcs`。generic はリンク生成なし。 */
export interface VcsConfig {
  kind: VcsKind;
  owner?: string; // github
  repo?: string; // github
  webBase?: string; // backlog: 例 https://space.backlog.jp
  projectKey?: string; // backlog
  repoName?: string; // backlog
}

export type TextFormattingRule = "markdown" | "backlog";

export interface IdName { id: number; name: string; }

export interface VersionDef { id: number; name: string; startDate?: string; releaseDueDate?: string; archived?: boolean; }

/** project.json `fieldRules`（設計3.2の決定論ルール設定）。 */
export interface FieldRules {
  assignSelf?: boolean;
  priorityKeywords?: { high?: string[]; low?: string[] };
  categoryRules?: Record<string, string[]>; // カテゴリ名 → キーワード/パス片
  milestone?: string; // "current" | "<name>" | "off"
  affectedVersion?: string; // "<name>" | "off"
  resolutionOnResolve?: boolean;
  summarize?: "off" | "claude"; // 依頼文の LLM 整理（既定 "claude" = サブスク認証の claude CLI で haiku 1呼出/ターン。"off" で無効）
}

/** project.json `docsSync`（docs → Backlog Wiki/Document 同期の設定。G21）。 */
export interface DocsSyncConfig {
  target?: "wiki" | "documents"; // 既定 "wiki"（更新可能）。documents はワンショット投入（更新 API 不在）
  root?: string; // 同期ルート（リポジトリルート相対。既定 "docs"）
  overviewSource?: string; // 概要ページの元（リポジトリルート相対。既定 "README.md"）
  overviewPage?: string; // 概要の Wiki ページ名（既定 "プロジェクト概要"。Home は不可侵のため指定不可）
  exclude?: string[]; // root 相対の前方一致で除外
  maxFileKb?: number; // 超過は警告スキップ（既定 100）
}

/** project.json 全体（init が書くキャッシュ）。すべて optional = 旧ファイル後方互換。 */
export interface ProjectCache {
  projectKey?: string;
  projectId?: number;
  statusMap?: StatusMap;
  issueTypes?: IdName[];
  priorities?: IdName[];
  categories?: IdName[];
  versions?: VersionDef[]; // マイルストーン兼発生バージョン
  resolutions?: IdName[];
  myself?: { id: number; name: string };
  defaultIssueTypeId?: number;
  defaultPriorityId?: number;
  resolutionFixedId?: number; // 「対応済み」= 0 もあり得る（falsy 罠に注意・!= null 判定）
  textFormattingRule?: TextFormattingRule;
  vcs?: VcsConfig;
  fieldRules?: FieldRules;
  docsSync?: DocsSyncConfig;
  resolvedAt?: string;
}

/** 課題作成時の動的フィールド（fields.ts resolveCreateFields の戻り値契約）。undefined のキーは含めないこと。 */
export interface IssueFieldOverrides {
  assigneeId?: number;
  priorityId?: number;
  categoryId?: number[];
  milestoneId?: number[];
  versionId?: number[]; // 発生バージョン
}
