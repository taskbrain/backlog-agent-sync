import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPull, formatDigest } from "../src/inbound/pull.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeRest(overrides: Record<string, unknown> = {}) {
  return {
    getMyself: vi.fn().mockResolvedValue({ id: 5, name: "me" }),
    findIssues: vi.fn().mockResolvedValue([
      { id: 1, issueKey: "PROJ-1", summary: "課題A", status: "処理中", updated: "2026-06-10T10:00:00Z" },
    ]),
    getComments: vi.fn().mockResolvedValue([
      { id: 10, content: "x".repeat(300), createdUser: { id: 9, name: "alice" }, created: "2026-06-10T09:00:00Z" },
    ]),
    ...overrides,
  } as any;
}

describe("runPull", () => {
  it("カーソル無し初回: updatedSince 無しで担当課題を取得し、カーソルを保存する", async () => {
    const store = new StateStore(dir);
    const rest = fakeRest();
    const digest = await runPull({ rest, store, sessionId: "s1", projectId: 10 });

    const query = rest.findIssues.mock.calls[0][0];
    expect(query.assigneeId).toEqual([5]);
    expect(query.sort).toBe("updated");
    expect(query.updatedSince).toBeUndefined();
    expect(digest.issues).toEqual([{ issueKey: "PROJ-1", summary: "課題A", status: "処理中", updated: "2026-06-10T10:00:00Z" }]);
    expect(digest.comments[0].content.length).toBe(200); // 先頭200字に切詰め
    expect(digest.comments[0].createdUser).toBe("alice");

    const st = await store.loadOrCreate("s1");
    expect(st.inboundCursor?.issuesUpdatedSince).toBe("2026-06-10T10:00:00Z");
    expect(st.inboundCursor?.commentMaxId).toEqual({ "PROJ-1": 10 });
  });

  it("カーソルあり: updatedSince(日付) と minId を渡し、既知コメントは digest に含めない", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.inboundCursor = { issuesUpdatedSince: "2026-06-09T00:00:00Z", commentMaxId: { "PROJ-1": 10 } };
    });
    const rest = fakeRest({
      getComments: vi.fn().mockResolvedValue([
        { id: 10, content: "既知", createdUser: { id: 9, name: "alice" }, created: "" }, // minId が inclusive でも排除される
        { id: 11, content: "新着", createdUser: { id: 9, name: "alice" }, created: "" },
      ]),
    });
    const digest = await runPull({ rest, store, sessionId: "s1" });

    expect(rest.findIssues.mock.calls[0][0].updatedSince).toBe("2026-06-09");
    expect(rest.getComments).toHaveBeenCalledWith("PROJ-1", { minId: 10 });
    expect(digest.comments).toEqual([{ issueKey: "PROJ-1", id: 11, content: "新着", createdUser: "alice" }]);
  });

  it("コメントカーソルを最大 id へ更新する", async () => {
    const store = new StateStore(dir);
    const rest = fakeRest({
      getComments: vi.fn().mockResolvedValue([
        { id: 11, content: "a", createdUser: { id: 9, name: "alice" }, created: "" },
        { id: 12, content: "b", createdUser: { id: 9, name: "alice" }, created: "" },
      ]),
    });
    const digest = await runPull({ rest, store, sessionId: "s1" });
    expect(digest.comments.length).toBe(2);
    const st = await store.loadOrCreate("s1");
    expect(st.inboundCursor?.commentMaxId).toEqual({ "PROJ-1": 12 });
  });

  it("コメント取得が失敗しても例外を投げず、課題のみの digest を返す", async () => {
    const store = new StateStore(dir);
    const rest = fakeRest({ getComments: vi.fn().mockRejectedValue(new Error("network")) });
    const digest = await runPull({ rest, store, sessionId: "s1" });
    expect(digest.issues.length).toBe(1);
    expect(digest.comments).toEqual([]);
    const st = await store.loadOrCreate("s1");
    expect(st.inboundCursor?.issuesUpdatedSince).toBe("2026-06-10T10:00:00Z"); // 課題カーソルは前進する
  });

  it("store/sessionId 無しでも動作する（カーソル非保存）", async () => {
    const rest = fakeRest();
    const digest = await runPull({ rest });
    expect(digest.issues.length).toBe(1);
    expect(digest.comments.length).toBe(1);
  });

  it("content が空のコメント(状態遷移changelog)は digest から除外しつつカーソルは前進する", async () => {
    const store = new StateStore(dir);
    const rest = fakeRest({
      getComments: vi.fn().mockResolvedValue([
        { id: 20, content: "実コメント", createdUser: { id: 9, name: "alice" }, created: "" },
        { id: 21, content: "", createdUser: { id: 9, name: "坂根一馬" }, created: "" }, // 状態遷移のみ
        { id: 22, content: null, createdUser: { id: 9, name: "坂根一馬" }, created: "" }, // content null
        { id: 23, content: "  \n", createdUser: { id: 9, name: "坂根一馬" }, created: "" }, // 空白のみ
      ]),
    });
    const digest = await runPull({ rest, store, sessionId: "s1" });
    expect(digest.comments).toEqual([{ issueKey: "PROJ-1", id: 20, content: "実コメント", createdUser: "alice" }]);
    const st = await store.loadOrCreate("s1");
    expect(st.inboundCursor?.commentMaxId).toEqual({ "PROJ-1": 23 }); // 空コメントの id まで前進=次回再取得しない
  });
});

describe("formatDigest", () => {
  it("空 digest は「なし」を返す", () => {
    expect(formatDigest({ issues: [], comments: [] })).toBe("Backlog 新着: なし");
  });
  it("課題とコメントを行形式に整形する", () => {
    const text = formatDigest({
      issues: [{ issueKey: "PROJ-1", summary: "課題A", status: "処理中", updated: "2026-06-10T10:00:00Z" }],
      comments: [{ issueKey: "PROJ-1", id: 11, content: "新着", createdUser: "alice" }],
    });
    expect(text).toContain("[PROJ-1] 課題A");
    expect(text).toContain("コメント#11 alice: 新着");
  });
});
