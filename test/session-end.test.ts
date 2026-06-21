import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runSessionEnd } from "../src/lifecycle/session-end.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fullAdapter() {
  return {
    addComment: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn(),
    getStatusMap: vi.fn(),
    findByMarker: vi.fn(),
    updateDescription: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("runSessionEnd", () => {
  it("pendingQueue の add_comment を排出する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "resolved"; // 既に resolved → 状態遷移は発生せず、コメント排出のみを検証
    });
    await store.enqueue("s1", { id: "q1", op: "add_comment", payload: { content: "残コメント" }, attempts: 0 });
    const adapter = fullAdapter();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter, projectId: 10 });
    expect(adapter.addComment).toHaveBeenCalledWith("PROJ-1", "残コメント");
    expect(adapter.setStatus).not.toHaveBeenCalled(); // resolved 同値のため status PATCH なし
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue).toEqual([]);
  });

  it("F3: in_progress のセッション終了時に resolved へ1回遷移する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; s.lastStatus = "in_progress";
    });
    const adapter = fullAdapter();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter, projectId: 10 });
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined); // resolved(3)
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("resolved");
    expect(st.pendingQueue).toEqual([]);
  });

  it("F3: 既に resolved なら status PATCH しない（同値スキップ）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; s.lastStatus = "resolved";
    });
    const adapter = fullAdapter();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter, projectId: 10 });
    expect(adapter.setStatus).not.toHaveBeenCalled();
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue).toEqual([]);
  });

  it("F3: resolutionFixedId=0 でも resolved 遷移の PATCH に resolutionId(0) が含まれる（falsy 罠回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; s.lastStatus = "in_progress";
    });
    const adapter = fullAdapter();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter, projectId: 10, resolutionFixedId: 0 });
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined, 0); // 完了理由=対応済み(id:0)
  });

  it("オフライン時は resolved 遷移 op がキューに残り、例外を伝播しない", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; s.lastStatus = "in_progress";
    });
    const adapter = fullAdapter();
    adapter.setStatus.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter, projectId: 10 }),
    ).resolves.toEqual({});
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue.map((o) => o.op)).toEqual(["update_issue"]);
    expect(st.pendingQueue[0].payload.statusId).toBe(3); // resolved(3)
    expect(st.lastStatus).toBe("resolved"); // 楽観更新（実遷移はキュー再送に委ねる）
  });
});
