import type { CanonicalEvent } from "../types.js";
import type { LifecycleDeps, HookOutput } from "./session-start.js";

export async function runSessionEnd(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter } = deps;
  const st = await store.loadOrCreate(ev.sessionId);
  if (!st.issueKey) return {};
  await store.drain(ev.sessionId, async (op) => {
    if (op.op === "add_comment") { await adapter.addComment(st.issueKey!, String(op.payload.content)); return true; }
    if (op.op === "update_issue") { await adapter.setStatus(st.issueKey!, Number(op.payload.statusId), undefined); return true; }
    return true;
  });
  return {};
}
