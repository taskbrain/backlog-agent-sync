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
});
