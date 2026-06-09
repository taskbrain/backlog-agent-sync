import { describe, it, expect } from "vitest";
import type { CanonicalEvent, SessionState, StatusMap } from "../src/types.js";

describe("types", () => {
  it("SessionState は最小フィールドで構築できる", () => {
    const statusMap: StatusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
    const ev: CanonicalEvent = { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/tmp", raw: {} };
    const st: SessionState = {
      sessionId: "s1", statusMap, todoToChecklist: {}, processedEvents: [], pendingQueue: [], activityBuffer: [],
    };
    expect(ev.event).toBe("session-start");
    expect(st.statusMap.in_progress).toBe(2);
  });
});
