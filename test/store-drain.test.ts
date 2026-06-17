import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { opDrainHandler } from "../src/lifecycle/session-start.js";
import type { QueuedOp } from "../src/types.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ---- TASK 1.2: index-based drain + max-attempts（store.ts 純粋） ----

describe("StateStore.drain（index ベース除去 + attempts 上限）", () => {
  it("同一 id の op が複数でも各々個別に除去される", async () => {
    const store = new StateStore(dir);
    // 同一 id "dup" の op を 2 件 enqueue。1 件目 false / 2 件目 true。
    // 旧 Map(by-id) 実装では 2 件目の結果が 1 件目を上書きし、両方除去される（誤り）。
    // index ベースなら 1 件目（失敗）は attempts:1 で残り、2 件目（成功）のみ除去される。
    await store.enqueue("sess-dup", { id: "dup", op: "add_comment", payload: { content: "a" }, attempts: 0 });
    await store.enqueue("sess-dup", { id: "dup", op: "add_comment", payload: { content: "b" }, attempts: 0 });
    let call = 0;
    await store.drain("sess-dup", async () => {
      call += 1;
      return call !== 1; // 1 回目=false, 2 回目=true
    });
    const st = await store.loadOrCreate("sess-dup");
    expect(st.pendingQueue.length).toBe(1);
    expect(st.pendingQueue[0].id).toBe("dup");
    expect(st.pendingQueue[0].attempts).toBe(1);
    // 残ったのは 1 件目（content: "a"）であることも確認（index 整合）
    expect(st.pendingQueue[0].payload.content).toBe("a");
  });

  it("同一 id の op が全て成功すれば全件除去される", async () => {
    const store = new StateStore(dir);
    await store.enqueue("sess-dup2", { id: "dup", op: "add_comment", payload: { content: "a" }, attempts: 0 });
    await store.enqueue("sess-dup2", { id: "dup", op: "add_comment", payload: { content: "b" }, attempts: 0 });
    await store.drain("sess-dup2", async () => true);
    const st = await store.loadOrCreate("sess-dup2");
    expect(st.pendingQueue.length).toBe(0);
  });

  it("attempts 上限超過の op は破棄され警告が出る", async () => {
    const store = new StateStore(dir);
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // 既定の最大試行回数は 5。attempts:4 の op が更に 1 回失敗すると 5 に到達し破棄される。
      await store.enqueue("sess-max", { id: "over", op: "add_comment", payload: {}, attempts: 4 });
      await store.drain("sess-max", async () => false);
      const st = await store.loadOrCreate("sess-max");
      expect(st.pendingQueue.length).toBe(0); // 破棄された
      // 警告は op id を含むメッセージで少なくとも 1 回出る
      const calledWithId = spy.mock.calls.some((c) => String(c[0]).includes("over"));
      expect(calledWithId).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("drain 中に enqueue された op は失われない", async () => {
    const store = new StateStore(dir);
    await store.enqueue("sess-mid", { id: "q1", op: "add_comment", payload: {}, attempts: 0 });
    await store.drain("sess-mid", async () => {
      await store.enqueue("sess-mid", { id: "q2", op: "add_comment", payload: {}, attempts: 0 });
      return true;
    });
    const st = await store.loadOrCreate("sess-mid");
    expect(st.pendingQueue.map((o) => o.id)).toEqual(["q2"]);
  });
});

// ---- TASK 1.1: opDrainHandler の no-op skip + code-7-as-success ----

/** TrackerAdapter の最小モック（drain に必要な addComment / setStatus のみ）。 */
function mockAdapter() {
  return {
    addComment: vi.fn(async () => {}),
    setStatus: vi.fn(async () => {}),
  };
}

describe("opDrainHandler（no-op skip + code 7 成功扱い）", () => {
  it("現在ステータスと同値の update_issue op は setStatus を呼ばずに除去される", async () => {
    const store = new StateStore(dir);
    const adapter = mockAdapter();
    const currentStatusId = 3; // resolved 相当
    await store.enqueue("sess-noop", {
      id: "u1", op: "update_issue", payload: { statusId: currentStatusId }, attempts: 0,
    });
    // adapter は TrackerAdapter のうち addComment/setStatus のみ実装したモック（型は handler 経由でしか触らない）
    const handler = opDrainHandler(adapter as never, "PROJ-1", currentStatusId);
    await store.drain("sess-noop", handler);
    expect(adapter.setStatus).not.toHaveBeenCalled();
    const st = await store.loadOrCreate("sess-noop");
    expect(st.pendingQueue.length).toBe(0); // 既適用扱いで除去
  });

  it("code 7 応答時も op は成功扱いで除去される", async () => {
    const store = new StateStore(dir);
    const adapter = mockAdapter();
    const currentStatusId = 3;
    // code 7（変更なし）を含むエラーメッセージで reject
    adapter.setStatus.mockRejectedValueOnce(
      new Error('Backlog API error: {"errors":[{"message":"No change","code":7}]}'),
    );
    // currentStatusId と異なる statusId（=REST 呼び出しに到達する）
    await store.enqueue("sess-c7", {
      id: "u1", op: "update_issue", payload: { statusId: 4 }, attempts: 0,
    });
    const handler = opDrainHandler(adapter as never, "PROJ-1", currentStatusId);
    await store.drain("sess-c7", handler);
    expect(adapter.setStatus).toHaveBeenCalledTimes(1); // 呼び出しには到達
    const st = await store.loadOrCreate("sess-c7");
    expect(st.pendingQueue.length).toBe(0); // code 7 は成功扱いで除去
  });

  it("非 code-7 のエラーは op を残置し attempts を増やす", async () => {
    const store = new StateStore(dir);
    const adapter = mockAdapter();
    const currentStatusId = 3;
    adapter.setStatus.mockRejectedValueOnce(new Error("500 boom"));
    await store.enqueue("sess-err", {
      id: "u1", op: "update_issue", payload: { statusId: 4 }, attempts: 0,
    });
    const handler = opDrainHandler(adapter as never, "PROJ-1", currentStatusId);
    await store.drain("sess-err", handler);
    expect(adapter.setStatus).toHaveBeenCalledTimes(1);
    const st = await store.loadOrCreate("sess-err");
    expect(st.pendingQueue.length).toBe(1);
    expect(st.pendingQueue[0].attempts).toBe(1);
  });
});
