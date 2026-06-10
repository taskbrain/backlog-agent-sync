import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../types.js";
import { ensureSessionIssue, type LifecycleDeps, type HookOutput } from "./session-start.js";

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

  const entries = st.activityBuffer;
  if (entries.length === 0) return {}; // 集約対象なし（空コメントは投稿せず、課題の遅延作成もしない）

  // SessionStart が発火しない環境（Codex exec 等）向けの遅延 find-or-create
  let ensured: string | undefined;
  try {
    ensured = await ensureSessionIssue(ev, deps, st);
  } catch {
    // 作成失敗（オフライン/権限等）は非ブロッキングで no-op（init 未解決時は undefined が返る）
  }
  if (!ensured) return {};
  const issueKey = ensured; // const 化（drain クロージャ内での narrowing 維持）

  const label = ev.agentType ?? "subagent";
  const lines = entries.map((e) => `- ${e.ts.slice(11, 16)} ${e.tool}`).join("\n");
  const body = `🤖 サブエージェント要約（backlog-agent-sync / ${label}）\n使用ツール ${entries.length} 件\n${lines}`;

  // 送信前に耐久記録（オフラインでも欠落しない）
  await store.enqueue(ev.sessionId, { id: `subagent-stop:${material}`, op: "add_comment", payload: { content: body }, attempts: 0 });
  // flush と同等の op 分岐: 残留中の update_issue（過去 stop のオフライン分）を無送信で除去しない
  await store.drain(ev.sessionId, async (op) => {
    if (op.op === "add_comment") { await adapter.addComment(issueKey, String(op.payload.content)); return true; }
    if (op.op === "update_issue") { await adapter.setStatus(issueKey, Number(op.payload.statusId), undefined); return true; }
    return true;
  });

  await store.withLock(ev.sessionId, (s) => { s.activityBuffer = []; });
  return {};
}
