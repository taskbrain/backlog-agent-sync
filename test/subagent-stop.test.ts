import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";
import { runSubagentStop } from "../src/lifecycle/subagent-stop.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeAdapter() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), findByMarker: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    updateDescription: vi.fn().mockResolvedValue(undefined),
  };
}

const ev = { tool: "claude", event: "subagent-stop", sessionId: "s1", cwd: "/r", agentType: "tester", toolUseId: "t1", raw: {} } as const;

describe("runSubagentStop（G20: 表示純化）", () => {
  it("コメントを投稿せず、課題の遅延作成もしない", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = fakeAdapter();
    await runSubagentStop(ev, { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.addComment).not.toHaveBeenCalled();
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.setStatus).not.toHaveBeenCalled();
  });

  it("activityBuffer は残置され、親の Stop のファイル集計へ折り込まれる", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const base = { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", raw: {} } as const;
    await runPostTool({ ...base, toolName: "Edit", toolUseId: "a", toolInput: { filePath: "/r/a.ts" } }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ ...base, toolName: "Write", toolUseId: "b", toolInput: { filePath: "/r/b.ts" } }, { store, adapter: {} as any, projectId: 10 });
    await runSubagentStop(ev, { store, adapter: fakeAdapter() as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(2); // クリアしない（Stop の ### 変更 で集計される）
  });

  it("冪等記録（markProcessed）は行う", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    await runSubagentStop(ev, { store, adapter: adapter as any, projectId: 10 });
    await runSubagentStop(ev, { store, adapter: adapter as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.processedEvents.filter((k) => k === "subagent-stop:t1").length).toBe(1); // 二重記録しない
  });

  it("stopHookActive=true は何もしない", async () => {
    const store = new StateStore(dir);
    await runSubagentStop({ ...ev, stopHookActive: true }, { store, adapter: fakeAdapter() as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.processedEvents.length).toBe(0);
  });
});
