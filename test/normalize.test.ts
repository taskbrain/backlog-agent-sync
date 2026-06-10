import { describe, it, expect } from "vitest";
import { normalizeClaude, normalizeCodex, normalizeAuto, detectAgentTool } from "../src/events/normalize.js";

describe("normalizeClaude", () => {
  it("SessionStart を正準イベントへ", () => {
    const ev = normalizeClaude("session-start", {
      session_id: "s1", cwd: "/repo", hook_event_name: "SessionStart", source: "startup",
    });
    expect(ev).toMatchObject({ tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup" });
  });

  it("PostToolUse は toolName/toolUseId を拾う", () => {
    const ev = normalizeClaude("post-tool", {
      session_id: "s1", cwd: "/repo", tool_name: "Edit", tool_use_id: "tu-1",
    });
    expect(ev.toolName).toBe("Edit");
    expect(ev.toolUseId).toBe("tu-1");
  });
});

describe("normalizeCodex", () => {
  it("turn_id を持つ Codex イベントを tool:'codex' で正規化する", () => {
    const ev = normalizeCodex("stop", {
      session_id: "s1", cwd: "/repo", hook_event_name: "Stop", turn_id: "t-1",
      stop_hook_active: false, model: "gpt-5.1-codex",
    });
    expect(ev).toMatchObject({ tool: "codex", event: "stop", sessionId: "s1", cwd: "/repo", toolUseId: "t-1" });
  });

  it("event 未指定なら hook_event_name から導出する（PostToolUse → post-tool）", () => {
    const ev = normalizeCodex(undefined, {
      session_id: "s1", cwd: "/repo", hook_event_name: "PostToolUse",
      turn_id: "t-1", tool_name: "shell", tool_use_id: "tu-9",
    });
    expect(ev?.event).toBe("post-tool");
    expect(ev?.toolName).toBe("shell");
  });

  it("冪等キーは turn_id 基点で安定（同一入力 → 同一キー、ツール呼出毎に一意）", () => {
    const raw = {
      session_id: "s1", cwd: "/repo", hook_event_name: "PostToolUse",
      turn_id: "t-1", tool_name: "shell", tool_use_id: "tu-9",
    };
    const a = normalizeCodex(undefined, raw);
    const b = normalizeCodex(undefined, raw);
    expect(a?.toolUseId).toBe("t-1:tu-9");
    expect(a?.toolUseId).toBe(b?.toolUseId);
    const c = normalizeCodex(undefined, { ...raw, tool_use_id: "tu-10" });
    expect(c?.toolUseId).toBe("t-1:tu-10");
    expect(c?.toolUseId).not.toBe(a?.toolUseId);
  });

  it("対応不明な hook_event_name は null でスキップする（保守的）", () => {
    const ev = normalizeCodex(undefined, {
      session_id: "s1", cwd: "/repo", hook_event_name: "PreCompact", turn_id: "t-2", trigger: "auto",
    });
    expect(ev).toBeNull();
  });
});

describe("detectAgentTool / normalizeAuto", () => {
  it("hook_event_name のみ → claude", () => {
    const raw = { session_id: "s1", cwd: "/repo", hook_event_name: "SessionStart", source: "startup" };
    expect(detectAgentTool(raw)).toBe("claude");
    const ev = normalizeAuto("session-start", raw);
    expect(ev).toMatchObject({ tool: "claude", event: "session-start", sessionId: "s1", source: "startup" });
  });

  it("turn_id あり → codex（hook_event_name を併せ持っていても codex 優先）", () => {
    const raw = { session_id: "s1", cwd: "/repo", hook_event_name: "Stop", turn_id: "t-1", model: "gpt-5.1-codex" };
    expect(detectAgentTool(raw)).toBe("codex");
    const ev = normalizeAuto("stop", raw);
    expect(ev).toMatchObject({ tool: "codex", event: "stop", toolUseId: "t-1" });
  });

  it("turn_id の無い Codex SessionStart も model 拡張フィールドで codex と判別する", () => {
    const raw = { session_id: "s1", cwd: "/repo", hook_event_name: "SessionStart", source: "startup", model: "gpt-5.1-codex" };
    expect(detectAgentTool(raw)).toBe("codex");
    const ev = normalizeAuto(undefined, raw);
    expect(ev).toMatchObject({ tool: "codex", event: "session-start", sessionId: "s1", source: "startup" });
  });

  it("不明形式は null（判別不能 / 対応不明イベントはスキップ）", () => {
    expect(detectAgentTool({})).toBeNull();
    expect(detectAgentTool({ foo: "bar" })).toBeNull();
    expect(normalizeAuto(undefined, { foo: "bar" })).toBeNull();
    // Claude 形式でもライフサイクル未対応イベントは null
    expect(normalizeAuto(undefined, { session_id: "s1", hook_event_name: "PreToolUse" })).toBeNull();
  });
});
