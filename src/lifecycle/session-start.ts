import type { CanonicalEvent } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { TrackerAdapter } from "../tracker/adapter.js";

export interface LifecycleDeps {
  store: StateStore;
  adapter: TrackerAdapter;
  projectId: number;
  issueTypeId?: number;
  priorityId?: number;
}

export interface HookOutput { additionalContext?: string; }

export async function runSessionStart(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter, projectId } = deps;
  const statusMap = await adapter.getStatusMap();
  const st = await store.loadOrCreate(ev.sessionId, statusMap);

  // 既に課題が紐付いていれば再作成しない（resume / 二重起動の冪等）
  if (!st.issueKey) {
    const summary = `[セッション] ${ev.sessionId.slice(0, 8)} (${new Date().toISOString().slice(0, 16)})`;
    const ref = await adapter.createIssue({
      projectId,
      summary,
      issueTypeId: deps.issueTypeId ?? 1,
      priorityId: deps.priorityId ?? 3,
      description: `自動生成: backlog-agent-sync\nsession_id: ${ev.sessionId}`,
    });
    await store.withLock(ev.sessionId, (s) => {
      s.issueKey = ref.issueKey; s.issueId = ref.id; s.statusMap = statusMap; s.lastStatus = "in_progress";
    });
    await adapter.setStatus(ref.issueKey, statusMap.in_progress, "作業を開始しました（backlog-agent-sync）");
  }

  const fresh = await store.loadOrCreate(ev.sessionId);
  return { additionalContext: `Backlog 課題: ${fresh.issueKey}（この作業は同課題へ同期されます）` };
}
