import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runInit", () => {
  it("auth 検証 → statusMap 解決 → project.json を書く", async () => {
    const adapter = {
      getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
      createIssue: vi.fn(), setStatus: vi.fn(), addComment: vi.fn(), findByMarker: vi.fn(),
    } as any;
    const rest = { getMyself: vi.fn().mockResolvedValue({ id: 5, name: "me" }) } as any;
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, { adapter, rest });
    expect(rest.getMyself).toHaveBeenCalled();
    const written = JSON.parse(readFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"), "utf8"));
    expect(written.statusMap.in_progress).toBe(2);
    expect(written.projectKey).toBe("PROJ");
    expect(out.ok).toBe(true);
  });
});
