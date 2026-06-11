import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runPostTool", () => {
  it("activityBuffer に積むだけで adapter は呼ばない", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("s1");
    const adapter = { addComment: vi.fn(), setStatus: vi.fn(), createIssue: vi.fn(), getStatusMap: vi.fn(), findByMarker: vi.fn() };
    await runPostTool(
      { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", toolName: "Edit", toolUseId: "tu1", raw: {} },
      { store, adapter: adapter as any, projectId: 10 },
    );
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(1);
    expect(st.activityBuffer[0].tool).toBe("Edit");
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("同じ toolUseId は二重に積まない（冪等）", async () => {
    const store = new StateStore(dir);
    await store.loadOrCreate("s1");
    const adapter = { addComment: vi.fn(), setStatus: vi.fn(), createIssue: vi.fn(), getStatusMap: vi.fn(), findByMarker: vi.fn() } as any;
    const ev = { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", toolName: "Edit", toolUseId: "tu1", raw: {} } as const;
    await runPostTool(ev, { store, adapter, projectId: 10 });
    await runPostTool(ev, { store, adapter, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(1);
  });
});

const base = { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", raw: {} } as const;

describe("runPostTool の要旨記録", () => {
  it("Edit/Write 系は file_path を cwd 相対で detail に記録する", async () => {
    const store = new StateStore(dir);
    await runPostTool({ ...base, toolName: "Edit", toolUseId: "a", toolInput: { filePath: "/repo/src/foo.ts" } }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ ...base, toolName: "Write", toolUseId: "b", toolInput: { filePath: "/repo/docs/bar.md" } }, { store, adapter: {} as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer[0].detail).toBe("src/foo.ts");
    expect(st.activityBuffer[1].detail).toBe("docs/bar.md");
  });

  it("cwd 外の file_path は basename のみ記録する", async () => {
    const store = new StateStore(dir);
    await runPostTool({ ...base, toolName: "Edit", toolUseId: "a", toolInput: { filePath: "/other/place/secret.ts" } }, { store, adapter: {} as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer[0].detail).toBe("secret.ts");
  });

  it("Bash は command の先頭80字（改行→空白）を記録する", async () => {
    const store = new StateStore(dir);
    const command = `npm run build &&\nnpm test -- ${"x".repeat(100)}`;
    await runPostTool({ ...base, toolName: "Bash", toolUseId: "a", toolInput: { command } }, { store, adapter: {} as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    const detail = st.activityBuffer[0].detail ?? "";
    expect(detail.startsWith("npm run build && npm test")).toBe(true); // 改行は空白へ
    expect(detail.length).toBe(80);
  });

  it("その他のツールや toolInput 無しは detail を記録しない", async () => {
    const store = new StateStore(dir);
    await runPostTool({ ...base, toolName: "Read", toolUseId: "a", toolInput: { filePath: "/repo/src/foo.ts" } }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ ...base, toolName: "Edit", toolUseId: "b" }, { store, adapter: {} as any, projectId: 10 });
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer[0].detail).toBeUndefined(); // Read は対象外
    expect(st.activityBuffer[1].detail).toBeUndefined(); // toolInput 無し
    expect(st.activityBuffer[0].tool).toBe("Read"); // ツール名自体は従来どおり記録
  });
});
