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

/**
 * セッション課題の find-or-create。state に issueKey があれば再作成しない（冪等）。
 * issueTypeId/priorityId 未解決（init 未実行）の場合は作成せず undefined を返す。
 * Codex exec 等 SessionStart が発火しない環境では stop/subagent-stop からの遅延作成に使う。
 * 同一 session_id なら同一のサマリ/説明で作成されるため、どのフックから呼んでも課題は一意。
 */
export async function ensureSessionIssue(ev: CanonicalEvent, deps: LifecycleDeps, st: SessionState): Promise<string | undefined> {
  if (st.issueKey) return st.issueKey;
  if (!deps.issueTypeId || !deps.priorityId) return undefined;
  const summary = `[セッション] ${ev.sessionId.slice(0, 8)} (${new Date().toISOString().slice(0, 16)})`;
  const ref = await deps.adapter.createIssue({
    projectId: deps.projectId,
    summary,
    issueTypeId: deps.issueTypeId,
    priorityId: deps.priorityId,
    description: `自動生成: backlog-agent-sync\nsession_id: ${ev.sessionId}`,
  });
  await deps.store.withLock(ev.sessionId, (s) => {
    s.issueKey = ref.issueKey; s.issueId = ref.id; s.statusMap = st.statusMap; s.lastStatus = "in_progress";
  });
  await deps.adapter.setStatus(ref.issueKey, st.statusMap.in_progress, "作業を開始しました（backlog-agent-sync）");
  st.issueKey = ref.issueKey; st.issueId = ref.id; // 呼出元のスナップショットにも反映
  return ref.issueKey;
}

export async function runSessionStart(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter } = deps;
  const statusMap = await adapter.getStatusMap();
  const st = await store.loadOrCreate(ev.sessionId, statusMap);
  st.statusMap = statusMap; // 課題作成時は最新の statusMap を使う（既存課題なら影響なし）

  // issueTypeId/priorityId 未解決（init 未実行）なら実在しない ID で 404 を投げ続けず、ローカル記録のみで継続
  if (!st.issueKey && (!deps.issueTypeId || !deps.priorityId)) {
    process.stderr.write("backlog-sync: init未実行（issueTypeId/priorityId 未解決）。課題作成をスキップします。`backlog-sync init` を実行してください。\n");
    await store.withLock(ev.sessionId, (s) => {
      s.activityBuffer.push({ ts: new Date().toISOString(), tool: "session-start", summary: "init未実行のため課題未作成" });
    });
    return { additionalContext: "Backlog 同期: init 未実行のため課題は未作成です（活動はローカル記録のみ）。`backlog-sync init` を実行してください。" };
  }

  // 既に課題が紐付いていれば再作成しない（resume / 二重起動の冪等）
  const issueKey = await ensureSessionIssue(ev, deps, st);
  let context = `Backlog 課題: ${issueKey}（この作業は同課題へ同期されます）`;
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
