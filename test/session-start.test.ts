import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runSessionStart } from "../src/lifecycle/session-start.js";

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

describe("runSessionStart", () => {
  it("初回は注入された issueTypeId/priorityId で課題を1件作成し状態を保存、additionalContext を返す", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const out = await runSessionStart(
      { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} },
      { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
    );
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    expect(adapter.createIssue).toHaveBeenCalledWith(expect.objectContaining({ issueTypeId: 4236190, priorityId: 3 })); // ハードコード1/3ではなく注入値
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-100", 2, expect.any(String));
    expect(out.additionalContext).toContain("PROJ-100");
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
  });

  it("既に課題が紐付くセッションでは再作成しない（冪等）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const ev = { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} } as const;
    await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    adapter.createIssue.mockClear();
    await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.createIssue).not.toHaveBeenCalled();
  });

  it("issueTypeId/priorityId 未解決（init未実行）なら課題作成をスキップし警告する", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = await runSessionStart(
      { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} },
      { store, adapter, projectId: 10 },
    );
    expect(adapter.createIssue).not.toHaveBeenCalled(); // 実在しない既定IDで404を投げない
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("init未実行");
    expect(out.additionalContext).toContain("init 未実行");
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBeUndefined();
    expect(st.activityBuffer.length).toBe(1); // ローカル記録のみ
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
    const out = await runSessionStart(
      { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} },
      { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3, rest },
    );
    expect(out.additionalContext).toContain("PROJ-100"); // セッション課題
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
    const out = await runSessionStart(
      { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} },
      { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3, rest },
    );
    expect(out.additionalContext).toContain("PROJ-100"); // 課題作成・コンテキスト返却は成功
  });
});
