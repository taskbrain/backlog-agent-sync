import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runSessionStart, sessionMarker } from "../src/lifecycle/session-start.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeAdapter() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn().mockResolvedValue({ id: 100, issueKey: "PROJ-100" }),
    setStatus: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    findByMarker: vi.fn().mockResolvedValue(undefined),
  };
}

const ev = { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} } as const;

describe("runSessionStart", () => {
  it("課題は作成せず、初回プロンプト時に作成する旨を additionalContext で返す", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.createIssue).not.toHaveBeenCalled(); // 作成は UserPromptSubmit に移譲
    expect(out.additionalContext).toContain("初回プロンプト");
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBeUndefined();
    expect(st.statusMap.in_progress).toBe(2); // 最新 statusMap は保存される
  });

  it("state に issueKey があればそれを additionalContext に出す（マーカー検索しない）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-7"; });
    const adapter = fakeAdapter();
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(out.additionalContext).toContain("PROJ-7");
    expect(adapter.findByMarker).not.toHaveBeenCalled(); // state 優先
    expect(adapter.createIssue).not.toHaveBeenCalled();
  });

  it("state 消失時はマーカー検索で既存課題を再照合し state に保存する", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    adapter.findByMarker.mockResolvedValue({ id: 100, issueKey: "PROJ-100" });
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.findByMarker).toHaveBeenCalledWith(sessionMarker("s1"));
    expect(adapter.createIssue).not.toHaveBeenCalled(); // 再照合のみ・作成しない
    expect(out.additionalContext).toContain("PROJ-100");
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
  });

  it("issueTypeId/priorityId 未解決（init未実行）なら警告を出す", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = await runSessionStart(ev, { store, adapter, projectId: 10 });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("init未実行");
    expect(out.additionalContext).toContain("init 未実行");
    errSpy.mockRestore();
  });

  it("rest があれば pull の digest を additionalContext に含める", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const rest = {
      getMyself: vi.fn().mockResolvedValue({ id: 5, name: "me" }),
      findIssues: vi.fn().mockResolvedValue([{ id: 9, issueKey: "PROJ-9", summary: "他課題", status: "処理中", updated: "2026-06-10T00:00:00Z" }]),
      getComments: vi.fn().mockResolvedValue([]),
    } as any;
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3, rest });
    expect(out.additionalContext).toContain("PROJ-9"); // pull digest
    const st = await store.loadOrCreate("s1");
    expect(st.inboundCursor?.issuesUpdatedSince).toBe("2026-06-10T00:00:00Z"); // カーソルも保存
  });

  it("pull が失敗してもセッション開始は成功する（非ブロッキング）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const rest = {
      getMyself: vi.fn().mockRejectedValue(new Error("network")),
      findIssues: vi.fn(),
      getComments: vi.fn(),
    } as any;
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3, rest });
    expect(out.additionalContext).toContain("初回プロンプト"); // コンテキスト返却は成功
  });
});
