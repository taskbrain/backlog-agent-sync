import type { CanonicalEvent } from "../types.js";
import type { LifecycleDeps, HookOutput } from "./session-start.js";

export async function runStop(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  if (ev.stopHookActive) return {}; // 既にこのフックでブロック中: 何もしない
  const { store, adapter } = deps;
  const st = await store.loadOrCreate(ev.sessionId);
  if (!st.issueKey) return {};

  const entries = st.activityBuffer;
  const lines = entries.map((e) => `- ${e.ts.slice(11, 16)} ${e.tool}`).join("\n");
  const body = `🤖 セッション要約（backlog-agent-sync）\n使用ツール ${entries.length} 件\n${lines || "(活動なし)"}`;

  // 送信前に耐久記録（オフラインでも欠落しない）
  await store.enqueue(ev.sessionId, { id: `stop:${ev.sessionId}`, op: "add_comment", payload: { content: body }, attempts: 0 });
  await store.drain(ev.sessionId, async (op) => {
    if (op.op === "add_comment") { await adapter.addComment(st.issueKey!, String(op.payload.content)); return true; }
    return true;
  });

  await adapter.setStatus(st.issueKey, st.statusMap.resolved, undefined);
  await store.withLock(ev.sessionId, (s) => { s.activityBuffer = []; s.lastStatus = "resolved"; });
  return {};
}
