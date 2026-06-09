import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runSessionEnd } from "../src/lifecycle/session-end.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runSessionEnd", () => {
  it("pendingQueue の add_comment を排出する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    await store.enqueue("s1", { id: "q1", op: "add_comment", payload: { content: "残コメント" }, attempts: 0 });
    const adapter = { addComment: vi.fn().mockResolvedValue(undefined), setStatus: vi.fn(), createIssue: vi.fn(), getStatusMap: vi.fn(), findByMarker: vi.fn() } as any;
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter, projectId: 10 });
    expect(adapter.addComment).toHaveBeenCalledWith("PROJ-1", "残コメント");
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue).toEqual([]);
  });
});
