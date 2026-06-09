import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("StateStore", () => {
  it("初期状態を作成し読み戻せる", async () => {
    const store = new StateStore(dir);
    const st = await store.loadOrCreate("sess-1");
    expect(st.sessionId).toBe("sess-1");
    expect(st.processedEvents).toEqual([]);
    const again = await store.loadOrCreate("sess-1");
    expect(again.sessionId).toBe("sess-1");
  });

  it("markProcessed は冪等（同じキーは一度だけ true）", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("sess-2");
    const first = await store.markProcessed("sess-2", "evt-a");
    const second = await store.markProcessed("sess-2", "evt-a");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("enqueue / drain がキューを順に処理し成功分を除去する", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("sess-3");
    await store.enqueue("sess-3", { id: "q1", op: "add_comment", payload: { content: "x" }, attempts: 0 });
    await store.enqueue("sess-3", { id: "q2", op: "add_comment", payload: { content: "y" }, attempts: 0 });
    const processed: string[] = [];
    await store.drain("sess-3", async (op) => { processed.push(op.id); return true; });
    expect(processed).toEqual(["q1", "q2"]);
    const st = await store.loadOrCreate("sess-3");
    expect(st.pendingQueue).toEqual([]);
  });

  it("drain でハンドラが false を返すと残置される", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("sess-4");
    await store.enqueue("sess-4", { id: "q1", op: "add_comment", payload: {}, attempts: 0 });
    await store.drain("sess-4", async () => false);
    const st = await store.loadOrCreate("sess-4");
    expect(st.pendingQueue.length).toBe(1);
    expect(st.pendingQueue[0].attempts).toBe(1);
  });

  it("drain 中に enqueue された op は失われない", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("sess-5");
    await store.enqueue("sess-5", { id: "q1", op: "add_comment", payload: {}, attempts: 0 });
    await store.drain("sess-5", async () => {
      await store.enqueue("sess-5", { id: "q2", op: "add_comment", payload: {}, attempts: 0 });
      return true;
    });
    const st = await store.loadOrCreate("sess-5");
    expect(st.pendingQueue.map((o) => o.id)).toEqual(["q2"]);
  });

  it("enqueue は事前 loadOrCreate なしでも動く", async () => {
    const store = new StateStore(dir);
    await store.enqueue("sess-6", { id: "q1", op: "add_comment", payload: {}, attempts: 0 });
    const st = await store.loadOrCreate("sess-6");
    expect(st.pendingQueue.length).toBe(1);
  });

  it("破損JSONは黙って初期化せず throw する", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("sess-7");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "sess-7.json"), "{ broken", "utf8");
    await expect(store.loadOrCreate("sess-7")).rejects.toThrow(/破損/);
  });
});
