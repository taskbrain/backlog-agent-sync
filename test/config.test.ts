import { describe, it, expect } from "vitest";
import { resolveConfig, stateDirFor } from "../src/config.js";

describe("config", () => {
  it("env から BacklogConfig を解決する", () => {
    const cfg = resolveConfig({ BACKLOG_DOMAIN: "ex.backlog.com", BACKLOG_API_KEY: "K", BACKLOG_PROJECT: "PROJ" });
    expect(cfg).toEqual({ domain: "ex.backlog.com", apiKey: "K", projectKey: "PROJ" });
  });

  it("必須 env 欠落で明確に throw", () => {
    expect(() => resolveConfig({ BACKLOG_DOMAIN: "ex" } as any)).toThrow(/BACKLOG_API_KEY/);
  });

  it("stateDirFor は cwd 配下の .claude/state を返す", () => {
    expect(stateDirFor("/repo")).toBe("/repo/.claude/state");
  });
});
