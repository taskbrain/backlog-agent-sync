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
    expect(deps.vcs).toBeUndefined();
    expect(deps.textFormattingRule).toBeUndefined();
    expect(deps.resolutionFixedId).toBeUndefined();
  });

  it("project.json の vcs/textFormattingRule/resolutionFixedId(0) を deps へ注入し root も設定する", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"), JSON.stringify({
      projectId: 1,
      vcs: { kind: "github", owner: "o", repo: "r" },
      textFormattingRule: "backlog",
      resolutionFixedId: 0,
    }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.vcs).toEqual({ kind: "github", owner: "o", repo: "r" });
    expect(deps.textFormattingRule).toBe("backlog");
    expect(deps.resolutionFixedId).toBe(0); // 0（対応済み）が落ちない
    expect(deps.root).toBe(dir);
  });

  it("summarize は既定で注入され（fieldRules 無しでも ON）、\"off\" で無効化される", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    const path = join(dir, ".claude", "backlog-agent-sync", "project.json");
    writeFileSync(path, JSON.stringify({ projectId: 1 }), "utf8");
    expect((await buildRuntime(dir)).deps.summarize).toBeTypeOf("function"); // 既定 ON

    writeFileSync(path, JSON.stringify({ projectId: 1, fieldRules: { summarize: "claude" } }), "utf8");
    expect((await buildRuntime(dir)).deps.summarize).toBeTypeOf("function");

    writeFileSync(path, JSON.stringify({ projectId: 1, fieldRules: { summarize: "off" } }), "utf8");
    expect((await buildRuntime(dir)).deps.summarize).toBeUndefined(); // "off" で無効化
  });
});
