import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";
import { runStop } from "../src/lifecycle/stop.js";
import { runSessionEnd } from "../src/lifecycle/session-end.js";

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

  it("adapter が例外を投げても伝播せず、add_comment と update_issue がキューに残る（オフライン耐久）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.addComment.mockRejectedValue(new Error("fetch failed"));
    adapter.setStatus.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10 }),
    ).resolves.toEqual({}); // セッションを止めない（非ブロッキング）
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue.map((o) => o.op).sort()).toEqual(["add_comment", "update_issue"]); // 状態遷移も失われない
    expect(st.pendingQueue.every((o) => o.attempts === 1)).toBe(true);
    expect(st.lastStatus).toBe("resolved"); // 楽観更新（実遷移はキュー再送に委ねる）
  });

  it("復帰後の drain（SessionEnd相当）で残 op が両方排出され状態遷移する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    const offline = adapterWithIssue();
    offline.addComment.mockRejectedValue(new Error("fetch failed"));
    offline.setStatus.mockRejectedValue(new Error("fetch failed"));
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: offline as any, projectId: 10 });

    const online = adapterWithIssue();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter: online as any, projectId: 10 });
    expect(online.addComment).toHaveBeenCalledOnce();
    expect(online.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined); // resolved へ遷移
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue).toEqual([]); // 排出済み
  });

  it("issueKey 無しでも deps 解決済みなら遅延作成し、集約コメント+状態遷移まで行う（Codex exec パリティ）", async () => {
    const store = new StateStore(dir);
    // SessionStart は発火していない（issueKey 無し）。post-tool のバッファのみ存在
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.createIssue.mockResolvedValue({ id: 100, issueKey: "PROJ-100" });
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} },
      { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
    );
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    expect(adapter.createIssue).toHaveBeenCalledWith(expect.objectContaining({ issueTypeId: 4236190, priorityId: 3 }));
    expect(adapter.addComment).toHaveBeenCalledOnce(); // 集約コメント
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-100", 3, undefined); // resolved へ遷移
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
    expect(st.lastStatus).toBe("resolved");
  });

  it("遅延作成が失敗しても例外を伝播しない（非ブロッキング）", async () => {
    const store = new StateStore(dir);
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.createIssue.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runStop(
        { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} },
        { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
      ),
    ).resolves.toEqual({});
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("issueKey 無しで init 未解決なら静かに no-op（従来挙動）", async () => {
    const store = new StateStore(dir);
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });
});
