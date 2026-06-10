import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime } from "../src/runtime.js";

let dir: string;
const ORIG = { ...process.env };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bas-"));
  process.env.BACKLOG_DOMAIN = "ex.backlog.com";
  process.env.BACKLOG_API_KEY = "K";
  process.env.BACKLOG_PROJECT = "PROJ";
  delete process.env.BACKLOG_PROJECT_ID;
  delete process.env.BACKLOG_ISSUE_TYPE_ID;
  delete process.env.BACKLOG_PRIORITY_ID;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); process.env = { ...ORIG }; });

describe("buildRuntime", () => {
  it("project.json があれば projectId を読む", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"), JSON.stringify({ projectId: 42 }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.projectId).toBe(42);
  });

  it("project.json が無ければ BACKLOG_PROJECT_ID env にフォールバック", async () => {
    process.env.BACKLOG_PROJECT_ID = "7";
    const { deps } = await buildRuntime(dir);
    expect(deps.projectId).toBe(7);
  });

  it("project.json の defaultIssueTypeId/defaultPriorityId を deps へ注入する", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"),
      JSON.stringify({ projectId: 791973, defaultIssueTypeId: 4236190, defaultPriorityId: 3 }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.projectId).toBe(791973);
    expect(deps.issueTypeId).toBe(4236190);
    expect(deps.priorityId).toBe(3);
  });

  it("project.json が無ければ BACKLOG_ISSUE_TYPE_ID/BACKLOG_PRIORITY_ID env にフォールバック", async () => {
    process.env.BACKLOG_ISSUE_TYPE_ID = "77";
    process.env.BACKLOG_PRIORITY_ID = "3";
    const { deps } = await buildRuntime(dir);
    expect(deps.issueTypeId).toBe(77);
    expect(deps.priorityId).toBe(3);
  });

  it("新フィールドの無い旧 project.json でも壊れない（未解決のまま）", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"),
      JSON.stringify({ projectId: 10, statusMap: { open: 1, in_progress: 2, resolved: 3, closed: 4 } }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.projectId).toBe(10);
    expect(deps.issueTypeId).toBeUndefined();
    expect(deps.priorityId).toBeUndefined();
  });
});
