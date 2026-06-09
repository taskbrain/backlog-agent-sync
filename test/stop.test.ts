import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";
import { runStop } from "../src/lifecycle/stop.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function adapterWithIssue() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), findByMarker: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runStop", () => {
  it("バッファを1つの集約コメントにまとめ、状態を resolved にする", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Bash", toolUseId: "b", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).toHaveBeenCalledOnce(); // ツール毎ではなく1回に集約
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined);
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(0); // フラッシュ後は空
    expect(st.lastStatus).toBe("resolved");
  });

  it("stopHookActive=true の場合は何もしない（無限ループ回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: true, raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).not.toHaveBeenCalled();
  });
});
