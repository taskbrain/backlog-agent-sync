import { describe, it, expect } from "vitest";
import { parseArgs, main } from "../src/cli.js";

describe("parseArgs", () => {
  it("hook session-start を解釈する", () => {
    expect(parseArgs(["hook", "session-start"])).toEqual({ cmd: "hook", event: "session-start" });
  });
  it("seed --dry-run を解釈する", () => {
    expect(parseArgs(["seed", "--dry-run"])).toEqual({ cmd: "seed", dryRun: true });
  });
  it("不明コマンドは cmd=help", () => {
    expect(parseArgs(["wat"]).cmd).toBe("help");
  });
  it("seed --plan と --dry-run を解釈する", () => {
    expect(parseArgs(["seed", "--plan", "p.json", "--dry-run"])).toEqual({ cmd: "seed", dryRun: true, planPath: "p.json" });
  });
  it("hook subagent-stop を解釈する", () => {
    expect(parseArgs(["hook", "subagent-stop"])).toEqual({ cmd: "hook", event: "subagent-stop" });
  });
  it("hook user-prompt-submit を解釈する", () => {
    expect(parseArgs(["hook", "user-prompt-submit"])).toEqual({ cmd: "hook", event: "user-prompt-submit" });
  });
  it("pull を解釈する（--session は任意）", () => {
    expect(parseArgs(["pull"])).toEqual({ cmd: "pull" });
    expect(parseArgs(["pull", "--session", "s1"])).toEqual({ cmd: "pull", sessionId: "s1" });
  });
  it("status を解釈する", () => {
    expect(parseArgs(["status"])).toEqual({ cmd: "status" });
  });
  it("flush --session を解釈する", () => {
    expect(parseArgs(["flush", "--session", "s1"])).toEqual({ cmd: "flush", sessionId: "s1" });
  });
  it("init を解釈する（--vcs は任意）", () => {
    expect(parseArgs(["init"])).toEqual({ cmd: "init" });
    expect(parseArgs(["init", "--vcs", "backlog"])).toEqual({ cmd: "init", vcs: "backlog" });
    expect(parseArgs(["init", "--vcs", "github"])).toEqual({ cmd: "init", vcs: "github" });
  });
  it("init --vcs の不正値は無視する", () => {
    expect(parseArgs(["init", "--vcs", "bogus"])).toEqual({ cmd: "init" });
    expect(parseArgs(["init", "--vcs"])).toEqual({ cmd: "init" });
  });
});

describe("hook 再帰ガード", () => {
  it("BACKLOG_SYNC_IN_HOOK があれば hook 入口で即 return する（summarize 子プロセスの誤発火防止）", async () => {
    const prev = process.env.BACKLOG_SYNC_IN_HOOK;
    process.env.BACKLOG_SYNC_IN_HOOK = "1";
    try {
      // ガードが無いと stdin 読込で待ち続ける（= テストはタイムアウトで失敗する）
      await expect(main(["hook", "stop"])).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BACKLOG_SYNC_IN_HOOK;
      else process.env.BACKLOG_SYNC_IN_HOOK = prev;
    }
  });
});
