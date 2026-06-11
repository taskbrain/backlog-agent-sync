import type { CanonicalEvent, SessionState } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import { runPull, formatDigest, type PullRest } from "../inbound/pull.js";

export interface LifecycleDeps {
  store: StateStore;
  adapter: TrackerAdapter;
  projectId: number;
  issueTypeId?: number;
  priorityId?: number;
  rest?: PullRest; // インバウンド pull 用（未指定なら pull をスキップ）
}

export interface HookOutput { additionalContext?: string; }

const SUMMARY_MAX = 60;
const DESCRIPTION_PROMPT_MAX = 2000;

/** state 消失時の find 用機械マーカー（seed の [[bas:epic:]] と同じ二重化思想）。 */
export function sessionMarker(sessionId: string): string {
  return `[[bas:session:${sessionId}]]`;
}

/** タイトル: プロンプト1行目を空白正規化して max60字。無ければ従来形式へフォールバック。 */
function buildIssueSummary(ev: CanonicalEvent, st: SessionState): string {
  const prompt = (st.initialPrompt ?? ev.prompt ?? "").trim();
  if (prompt) {
    const firstLine = (prompt.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
    if (firstLine) return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine;
  }
  return `[セッション] ${ev.sessionId.slice(0, 8)} (${new Date().toISOString().slice(0, 16)})`;
}

/** 説明: 依頼全文（max2000字）+ メタ + 機械マーカー。 */
function buildIssueDescription(ev: CanonicalEvent, st: SessionState): string {
  const prompt = (st.initialPrompt ?? ev.prompt ?? "").trim();
  const model = typeof (ev.raw as any)?.model === "string" && (ev.raw as any).model !== "" ? ` (${(ev.raw as any).model})` : "";
  return [
    prompt ? prompt.slice(0, DESCRIPTION_PROMPT_MAX) : "自動生成: backlog-agent-sync",
    "",
    "---",
    `開始日時: ${new Date().toISOString()}`,
    `エージェント: ${ev.tool}${model}`,
    `cwd: ${ev.cwd}`,
    `session_id: ${ev.sessionId}`,
    sessionMarker(ev.sessionId),
  ].join("\n");
}

/**
 * セッション課題の find-or-create。優先順: state.issueKey → マーカー検索 → 新規作成。
 * issueTypeId/priorityId 未解決（init 未実行）の場合は作成せず undefined を返す。
 * UserPromptSubmit が主経路。SessionStart/UserPromptSubmit が発火しない環境
 * （Codex exec 等）では stop/subagent-stop からの遅延作成に使う。
 */
export async function ensureSessionIssue(ev: CanonicalEvent, deps: LifecycleDeps, st: SessionState): Promise<string | undefined> {
  if (st.issueKey) return st.issueKey;
  if (!deps.issueTypeId || !deps.priorityId) return undefined;

  // state 消失時はマーカー検索で既存課題を再照合（state が一次なので検索インデックス遅延の影響は小）
  const found = await deps.adapter.findByMarker(sessionMarker(ev.sessionId));
  if (found) {
    await deps.store.withLock(ev.sessionId, (s) => { s.issueKey = found.issueKey; s.issueId = found.id; });
    st.issueKey = found.issueKey; st.issueId = found.id;
    return found.issueKey;
  }

  const ref = await deps.adapter.createIssue({
    projectId: deps.projectId,
    summary: buildIssueSummary(ev, st),
    issueTypeId: deps.issueTypeId,
    priorityId: deps.priorityId,
    description: buildIssueDescription(ev, st),
  });
  await deps.store.withLock(ev.sessionId, (s) => {
    s.issueKey = ref.issueKey; s.issueId = ref.id; s.statusMap = st.statusMap; s.lastStatus = "in_progress";
  });
  await deps.adapter.setStatus(ref.issueKey, st.statusMap.in_progress, "作業を開始しました（backlog-agent-sync）");
  st.issueKey = ref.issueKey; st.issueId = ref.id; // 呼出元のスナップショットにも反映
  return ref.issueKey;
}

/**
 * SessionStart は statusMap 読込 + 既存課題の再照合（state 優先→マーカー検索）+ pull 注入のみ。
 * 課題の作成は行わない（初回プロンプト送信時 = UserPromptSubmit で作成する）。
 */
export async function runSessionStart(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter } = deps;
  const statusMap = await adapter.getStatusMap();
  // 後続フック（UserPromptSubmit/Stop）の課題作成・状態遷移が最新の statusMap を使えるよう保存
  const st = await store.withLock(ev.sessionId, (s) => { s.statusMap = statusMap; return s; });

  if (!st.issueKey && (!deps.issueTypeId || !deps.priorityId)) {
    process.stderr.write("backlog-sync: init未実行（issueTypeId/priorityId 未解決）。課題は作成されません。`backlog-sync init` を実行してください。\n");
    return { additionalContext: "Backlog 同期: init 未実行のため課題は作成されません。`backlog-sync init` を実行してください。" };
  }

  // 既存課題の再照合: state 優先 → マーカー検索（state 消失時の resume 対応）
  let issueKey = st.issueKey;
  if (!issueKey) {
    try {
      const found = await adapter.findByMarker(sessionMarker(ev.sessionId));
      if (found) {
        issueKey = found.issueKey;
        await store.withLock(ev.sessionId, (s) => { s.issueKey = found.issueKey; s.issueId = found.id; });
      }
    } catch {
      // 再照合失敗はセッション開始を止めない（非ブロッキング原則）
    }
  }

  let context = issueKey
    ? `Backlog 課題: ${issueKey}（この作業は同課題へ同期されます）`
    : "Backlog 同期: 初回プロンプト送信時に課題を作成します";
  if (deps.rest) {
    try {
      const digest = await runPull({ rest: deps.rest, store, sessionId: ev.sessionId, projectId: deps.projectId || undefined });
      context += `\n${formatDigest(digest)}`;
    } catch {
      // pull 失敗でセッション開始を止めない（非ブロッキング原則）
    }
  }
  return { additionalContext: context };
}
