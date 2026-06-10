import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli.js";

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
});
