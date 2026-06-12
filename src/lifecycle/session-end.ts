import type { CanonicalEvent } from "../types.js";
import { opDrainHandler, type LifecycleDeps, type HookOutput } from "./session-start.js";

export async function runSessionEnd(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter } = deps;
  const st = await store.loadOrCreate(ev.sessionId);
  if (!st.issueKey) return {};
  await store.drain(ev.sessionId, opDrainHandler(adapter, st.issueKey));
  return {};
}
