import { describe, it, expect } from "vitest";
import { normalizeClaude } from "../src/events/normalize.js";

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
