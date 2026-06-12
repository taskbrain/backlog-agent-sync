import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../types.js";
import type { LifecycleDeps, HookOutput } from "./session-start.js";

/**
 * SubagentStop はコメントを投稿しない（G20: Backlog を人間向け表示へ純化）。
 * サブエージェントの活動は activityBuffer に残したまま、親の Stop の
 * ターン要約（変更ファイル集計）へ折り込まれる。ここでは冪等記録のみ行う。
 */
export async function runSubagentStop(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  if (ev.stopHookActive) return {}; // 既にこのフックでブロック中: 何もしない

  // 冪等キー: tool_use_id / agentType、無ければ内容ハッシュ（設計§10）
  const material = ev.toolUseId
    ?? ev.agentType
    ?? createHash("sha256").update(JSON.stringify(ev.raw ?? {})).digest("hex").slice(0, 16);
  await deps.store.markProcessed(ev.sessionId, `subagent-stop:${material}`);
  return {};
}
