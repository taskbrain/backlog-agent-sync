import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runPostTool", () => {
  it("activityBuffer に積むだけで adapter は呼ばない", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("s1");
    const adapter = { addComment: vi.fn(), setStatus: vi.fn(), createIssue: vi.fn(), getStatusMap: vi.fn(), findByMarker: vi.fn() };
    await runPostTool(
      { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", toolName: "Edit", toolUseId: "tu1", raw: {} },
      { store, adapter: adapter as any, projectId: 10 },
    );
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(1);
    expect(st.activityBuffer[0].tool).toBe("Edit");
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("同じ toolUseId は二重に積まない（冪等）", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("s1");
    const adapter = { addComment: vi.fn(), setStatus: vi.fn(), createIssue: vi.fn(), getStatusMap: vi.fn(), findByMarker: vi.fn() } as any;
    const ev = { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", toolName: "Edit", toolUseId: "tu1", raw: {} } as const;
    await runPostTool(ev, { store, adapter, projectId: 10 });
    await runPostTool(ev, { store, adapter, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(1);
  });
});
