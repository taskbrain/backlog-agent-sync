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

  // ---- 修正(a): config.judgment を本番ハンドラ deps へ伝播 ----

  it("project.json の judgment（model/backend）を deps へ載せる", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"),
      JSON.stringify({ projectId: 1, judgment: { backend: "auto", model: "haiku" } }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.judgment).toEqual({ backend: "auto", model: "haiku" });
  });

  it("judgment.backend=deterministic を deps へ載せる", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"),
      JSON.stringify({ projectId: 1, judgment: { backend: "deterministic" } }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.judgment).toMatchObject({ backend: "deterministic" });
  });

  it("judgment 未設定（旧 project.json）でも既定 backend=auto に正規化して載せる", async () => {
    mkdirSync(join(dir, ".claude", "backlog-agent-sync"), { recursive: true });
    writeFileSync(join(dir, ".claude", "backlog-agent-sync", "project.json"),
      JSON.stringify({ projectId: 1 }), "utf8");
    const { deps } = await buildRuntime(dir);
    expect(deps.judgment).toEqual({ backend: "auto", model: undefined });
  });

  it("project.json 不在でも judgment は既定 backend=auto で載る", async () => {
    const { deps } = await buildRuntime(dir);
    expect(deps.judgment).toMatchObject({ backend: "auto" });
  });

  // ---- 修正(b): getIssueId を deps へ注入（rest.getIssue 経由・失敗時 undefined） ----

  it("deps.getIssueId を注入し rest.getIssue 経由でキー→数値 id を解決する", async () => {
    const { deps, rest } = await buildRuntime(dir);
    expect(deps.getIssueId).toBeTypeOf("function");
    // rest.getIssue をスタブして注入関数の配線を確認（ネットワークは張らない）
    (rest as any).getIssue = async (key: string) => ({ id: 4242, issueKey: key });
    await expect(deps.getIssueId!("PROJ-9")).resolves.toBe(4242);
  });

  it("getIssueId は rest.getIssue 失敗時に undefined を返す（沈黙 no-op の素材）", async () => {
    const { deps, rest } = await buildRuntime(dir);
    (rest as any).getIssue = async () => { throw new Error("404"); };
    await expect(deps.getIssueId!("PROJ-404")).resolves.toBeUndefined();
  });

  it("getIssueId は失敗時に理由（キー+メッセージ）を 1 行 stderr へ出す（観測性）", async () => {
    const { deps, rest } = await buildRuntime(dir);
    (rest as any).getIssue = async () => { throw new Error("404 Not Found"); };
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: string) => { written.push(String(s)); return true; };
    try {
      await expect(deps.getIssueId!("PROJ-404")).resolves.toBeUndefined();
    } finally {
      (process.stderr.write as any) = orig;
    }
    const line = written.join("");
    expect(line).toContain("課題id解決に失敗");
    expect(line).toContain("PROJ-404"); // 対象キー
    expect(line).toContain("404 Not Found"); // 失敗理由
    expect(line.endsWith("\n")).toBe(true); // 1 行（改行終端）
  });
});
