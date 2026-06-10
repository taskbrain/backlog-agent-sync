import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeAdapter() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), setStatus: vi.fn(), addComment: vi.fn(), findByMarker: vi.fn(),
  } as any;
}

function fakeRest(overrides: Record<string, unknown> = {}) {
  return {
    getMyself: vi.fn().mockResolvedValue({ id: 5, name: "me" }),
    getProject: vi.fn().mockResolvedValue({ id: 99, projectKey: "PROJ", name: "P" }),
    getIssueTypes: vi.fn().mockResolvedValue([{ id: 4236190, name: "タスク" }, { id: 4236189, name: "バグ" }]),
    getPriorities: vi.fn().mockResolvedValue([{ id: 2, name: "高" }, { id: 3, name: "中" }, { id: 4, name: "低" }]),
    ...overrides,
  } as any;
}

function readWritten() {
  return JSON.parse(readFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"), "utf8"));
}

describe("runInit", () => {
  it("auth 検証 → statusMap 解決 → project.json を書く", async () => {
    const adapter = fakeAdapter();
    const rest = fakeRest();
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, { adapter, rest });
    expect(rest.getMyself).toHaveBeenCalled();
    const written = readWritten();
    expect(written.statusMap.in_progress).toBe(2);
    expect(written.projectKey).toBe("PROJ");
    expect(out.ok).toBe(true);
  });

  it("projectId 未指定なら getProject で解決する", async () => {
    const adapter = fakeAdapter();
    const rest = fakeRest();
    const out = await runInit({ cwd: dir, projectKey: "PROJ" }, { adapter, rest });
    expect(rest.getProject).toHaveBeenCalledWith("PROJ");
    expect(readWritten().projectId).toBe(99);
    expect(out.ok).toBe(true);
  });

  it("issueTypes/priorities をキャッシュし「タスク」「中」を既定に選ぶ", async () => {
    const rest = fakeRest({
      getIssueTypes: vi.fn().mockResolvedValue([
        { id: 4236189, name: "バグ" }, { id: 4236190, name: "タスク" }, { id: 4236191, name: "要望" },
      ]),
      getPriorities: vi.fn().mockResolvedValue([{ id: 2, name: "高" }, { id: 3, name: "中" }, { id: 4, name: "低" }]),
    });
    const out = await runInit({ cwd: dir, projectKey: "TC", projectId: 791973 }, { adapter: fakeAdapter(), rest });
    expect(rest.getIssueTypes).toHaveBeenCalledWith("TC");
    const written = readWritten();
    expect(written.issueTypes).toEqual([
      { id: 4236189, name: "バグ" }, { id: 4236190, name: "タスク" }, { id: 4236191, name: "要望" },
    ]);
    expect(written.priorities.length).toBe(3);
    expect(written.defaultIssueTypeId).toBe(4236190); // 「タスク」優先
    expect(written.defaultPriorityId).toBe(3); // 「中」優先
    expect(out.defaultIssueTypeId).toBe(4236190);
    expect(out.defaultPriorityId).toBe(3);
  });

  it("「タスク」「中」が無ければ先頭/中央へフォールバックする", async () => {
    const rest = fakeRest({
      getIssueTypes: vi.fn().mockResolvedValue([{ id: 7, name: "Feature" }, { id: 8, name: "Chore" }]),
      getPriorities: vi.fn().mockResolvedValue([{ id: 11, name: "P1" }, { id: 12, name: "P2" }, { id: 13, name: "P3" }]),
    });
    const out = await runInit({ cwd: dir, projectKey: "PROJ", projectId: 10 }, { adapter: fakeAdapter(), rest });
    expect(out.defaultIssueTypeId).toBe(7); // 先頭
    expect(out.defaultPriorityId).toBe(12); // 中央
  });
});
