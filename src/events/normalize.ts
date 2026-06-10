import type { AgentTool, CanonicalEvent, LifecycleEvent } from "../types.js";

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

/**
 * hook_event_name → ライフサイクルの対応（Claude / Codex 互換イベント名）。
 * 確実に対応付くもののみ列挙し、それ以外（PreToolUse/PreCompact/UserPromptSubmit 等）は
 * 保守的に null でスキップする（設計 §12）。
 * 注: Codex に SessionEnd フックは無い（キュー排出は Stop の drain と `flush` で代替）。
 */
const HOOK_EVENT_TO_LIFECYCLE: Record<string, LifecycleEvent> = {
  SessionStart: "session-start",
  PostToolUse: "post-tool",
  SubagentStop: "subagent-stop",
  Stop: "stop",
  SessionEnd: "session-end",
};

/**
 * Codex のフックイベント（turn_id 拡張を持つ JSON）を正準イベントへ変換する。
 * - event 未指定時は hook_event_name から導出。対応不明なら null（スキップ）。
 * - 冪等キー（toolUseId）は turn_id 基点（設計 §10）。1 ターン内に複数のツール呼出が
 *   あるため、tool_use_id があれば `<turn_id>:<tool_use_id>` として一意性を保つ。
 */
export function normalizeCodex(event: LifecycleEvent | undefined, raw: Raw): CanonicalEvent | null {
  const lifecycle = event ?? HOOK_EVENT_TO_LIFECYCLE[String(raw.hook_event_name ?? "")];
  if (!lifecycle) return null;
  const turnId = typeof raw.turn_id === "string" && raw.turn_id !== "" ? raw.turn_id : undefined;
  const toolUseId = turnId
    ? (raw.tool_use_id ? `${turnId}:${raw.tool_use_id}` : turnId)
    : (raw.tool_use_id as string | undefined);
  return {
    tool: "codex",
    event: lifecycle,
    sessionId: String(raw.session_id ?? ""),
    cwd: String(raw.cwd ?? process.cwd()),
    source: raw.source,
    toolName: raw.tool_name,
    toolUseId,
    agentType: raw.agent_type,
    stopHookActive: raw.stop_hook_active,
    reason: raw.reason,
    raw,
  };
}

/**
 * payload から発信元エージェントを自動判別する。
 * - turn_id があれば Codex（Codex 固有拡張。判別はこちらを先に行う —
 *   Codex は Claude 互換の hook_event_name も併せ持つため）。
 * - hook_event_name のみなら Claude。ただし `model` は Codex 拡張フィールドのため、
 *   turn_id を持たない Codex イベント（thread スコープの SessionStart 等）はこれで拾う。
 * - どちらでもなければ null。
 */
export function detectAgentTool(raw: Raw): AgentTool | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.turn_id === "string" && raw.turn_id !== "") return "codex";
  if (typeof raw.hook_event_name === "string" && raw.hook_event_name !== "") {
    if (typeof raw.model === "string" && raw.model !== "") return "codex";
    return "claude";
  }
  return null;
}

/**
 * 自動判別エントリポイント。既存の normalizeClaude のシグネチャ・挙動は変えない
 * （cli.ts の切替はコーディネーター判断。切替時は
 *  `normalizeClaude(parsed.event, raw)` → `normalizeAuto(parsed.event, raw)` の置換で済む）。
 * 判別不能・対応不明イベントは null を返しスキップする。
 */
export function normalizeAuto(event: LifecycleEvent | undefined, raw: Raw): CanonicalEvent | null {
  const tool = detectAgentTool(raw);
  if (tool === "codex") return normalizeCodex(event, raw);
  if (tool === "claude") {
    const lifecycle = event ?? HOOK_EVENT_TO_LIFECYCLE[String(raw.hook_event_name ?? "")];
    if (!lifecycle) return null;
    return normalizeClaude(lifecycle, raw);
  }
  return null;
}

/** stdin の JSON を読む（フックは stdin で渡す）。空なら {}。 */
export async function readStdin(): Promise<Raw> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
