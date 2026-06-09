import type { CanonicalEvent, LifecycleEvent } from "../types.js";

type Raw = Record<string, any>;

export function normalizeClaude(event: LifecycleEvent, raw: Raw): CanonicalEvent {
  return {
    tool: "claude",
    event,
    sessionId: String(raw.session_id ?? ""),
    cwd: String(raw.cwd ?? process.cwd()),
    source: raw.source,
    toolName: raw.tool_name,
    toolUseId: raw.tool_use_id,
    agentType: raw.agent_type,
    stopHookActive: raw.stop_hook_active,
    reason: raw.reason,
    raw,
  };
}

/** stdin の JSON を読む（フックは stdin で渡す）。空なら {}。 */
export async function readStdin(): Promise<Raw> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
