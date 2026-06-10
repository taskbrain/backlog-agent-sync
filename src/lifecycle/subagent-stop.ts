import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../types.js";
import type { LifecycleDeps, HookOutput } from "./session-start.js";

export async function runSubagentStop(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  if (ev.stopHookActive) return {}; // 既にこのフックでブロック中: 何もしない
  const { store, adapter } = deps;

  // 冪等キー: tool_use_id / agentType、無ければ内容ハッシュ（設計§10）
  const material = ev.toolUseId
    ?? ev.agentType
    ?? createHash("sha256").update(JSON.stringify(ev.raw ?? {})).digest("hex").slice(0, 16);
  const fresh = await store.markProcessed(ev.sessionId, `subagent-stop:${material}`);
  if (!fresh) return {}; // 二重起動を冪等に無視

  const st = await store.loadOrCreate(ev.sessionId);
  if (!st.issueKey) return {};

  const entries = st.activityBuffer;
  if (entries.length === 0) return {}; // 集約対象なし（空コメントは投稿しない）

  const label = ev.agentType ?? "subagent";
  const lines = entries.map((e) => `- ${e.ts.slice(11, 16)} ${e.tool}`).join("\n");
  const body = `🤖 サブエージェント要約（backlog-agent-sync / ${label}）\n使用ツール ${entries.length} 件\n${lines}`;

  // 送信前に耐久記録（オフラインでも欠落しない）
  await store.enqueue(ev.sessionId, { id: `subagent-stop:${material}`, op: "add_comment", payload: { content: body }, attempts: 0 });
  await store.drain(ev.sessionId, async (op) => {
    if (op.op === "add_comment") { await adapter.addComment(st.issueKey!, String(op.payload.content)); return true; }
    return true;
  });

  await store.withLock(ev.sessionId, (s) => { s.activityBuffer = []; });
  return {};
}
