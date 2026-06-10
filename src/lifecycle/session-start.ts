import type { CanonicalEvent } from "../types.js";
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

export async function runSessionStart(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter, projectId } = deps;
  const statusMap = await adapter.getStatusMap();
  const st = await store.loadOrCreate(ev.sessionId, statusMap);

  // 既に課題が紐付いていれば再作成しない（resume / 二重起動の冪等）
  if (!st.issueKey) {
    // issueTypeId/priorityId 未解決（init 未実行）なら実在しない ID で 404 を投げ続けず、ローカル記録のみで継続
    if (!deps.issueTypeId || !deps.priorityId) {
      process.stderr.write("backlog-sync: init未実行（issueTypeId/priorityId 未解決）。課題作成をスキップします。`backlog-sync init` を実行してください。\n");
      await store.withLock(ev.sessionId, (s) => {
        s.activityBuffer.push({ ts: new Date().toISOString(), tool: "session-start", summary: "init未実行のため課題未作成" });
      });
      return { additionalContext: "Backlog 同期: init 未実行のため課題は未作成です（活動はローカル記録のみ）。`backlog-sync init` を実行してください。" };
    }
    const summary = `[セッション] ${ev.sessionId.slice(0, 8)} (${new Date().toISOString().slice(0, 16)})`;
    const ref = await adapter.createIssue({
      projectId,
      summary,
      issueTypeId: deps.issueTypeId,
      priorityId: deps.priorityId,
      description: `自動生成: backlog-agent-sync\nsession_id: ${ev.sessionId}`,
    });
    await store.withLock(ev.sessionId, (s) => {
      s.issueKey = ref.issueKey; s.issueId = ref.id; s.statusMap = statusMap; s.lastStatus = "in_progress";
    });
    await adapter.setStatus(ref.issueKey, statusMap.in_progress, "作業を開始しました（backlog-agent-sync）");
  }

  const fresh = await store.loadOrCreate(ev.sessionId);
  let context = `Backlog 課題: ${fresh.issueKey}（この作業は同課題へ同期されます）`;
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
