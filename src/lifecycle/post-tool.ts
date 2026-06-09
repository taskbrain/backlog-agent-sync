import type { CanonicalEvent } from "../types.js";
import type { LifecycleDeps, HookOutput } from "./session-start.js";

export async function runPostTool(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store } = deps;
  const key = `post:${ev.toolUseId ?? ev.toolName ?? ""}`;
  const fresh = await store.markProcessed(ev.sessionId, key);
  if (!fresh) return {}; // 二重起動を冪等に無視
  await store.withLock(ev.sessionId, (s) => {
    s.activityBuffer.push({ ts: new Date().toISOString(), tool: ev.toolName ?? "unknown", summary: ev.toolName ?? "" });
  });
  return {};
}
