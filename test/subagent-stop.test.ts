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

function adapterWithIssue() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), findByMarker: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runSubagentStop", () => {
  it("バッファを1つの集約コメントにまとめ、バッファをクリアする", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Bash", toolUseId: "b", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runSubagentStop({ tool: "claude", event: "subagent-stop", sessionId: "s1", cwd: "/r", agentType: "tester", toolUseId: "t1", raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).toHaveBeenCalledOnce(); // ツール毎ではなく1回に集約
    expect(String(adapter.addComment.mock.calls[0][1])).toContain("tester");
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(0); // 投稿後にクリア
  });

  it("同一イベントを2回受けてもコメントは1件（冪等）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const adapter = adapterWithIssue();
    const ev = { tool: "claude", event: "subagent-stop", sessionId: "s1", cwd: "/r", agentType: "tester", toolUseId: "t1", raw: {} } as const;
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    await runSubagentStop(ev, { store, adapter: adapter as any, projectId: 10 });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Bash", toolUseId: "b", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    await runSubagentStop(ev, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).toHaveBeenCalledOnce();
  });

  it("バッファが空なら投稿しない", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const adapter = adapterWithIssue();
    await runSubagentStop({ tool: "claude", event: "subagent-stop", sessionId: "s1", cwd: "/r", agentType: "tester", toolUseId: "t1", raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("issueKey 無しでも遅延作成してコメントを投稿する（Codex exec パリティ）", async () => {
    const store = new StateStore(dir);
    // SessionStart は発火していない（issueKey 無し）。post-tool のバッファのみ存在
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.createIssue.mockResolvedValue({ id: 100, issueKey: "PROJ-100" });
    await runSubagentStop(
      { tool: "claude", event: "subagent-stop", sessionId: "s1", cwd: "/r", agentType: "tester", toolUseId: "t1", raw: {} },
      { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
    );
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    expect(adapter.addComment).toHaveBeenCalledOnce(); // 集約コメント
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
  });

  it("バッファが空なら遅延作成もしない（空課題のノイズ防止）", async () => {
    const store = new StateStore(dir);
    const adapter = adapterWithIssue();
    await runSubagentStop(
      { tool: "claude", event: "subagent-stop", sessionId: "s1", cwd: "/r", agentType: "tester", toolUseId: "t1", raw: {} },
      { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
    );
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });
});
