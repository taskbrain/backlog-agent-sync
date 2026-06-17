import { describe, it, expect } from "vitest";
import { resolveConfig, stateDirFor, resolveJudgmentConfig } from "../src/config.js";

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

describe("resolveJudgmentConfig", () => {
  it("undefined 入力は既定 backend=auto・model 未設定", () => {
    expect(resolveJudgmentConfig(undefined)).toEqual({ backend: "auto", model: undefined });
  });

  it("deterministic はそのまま維持する", () => {
    expect(resolveJudgmentConfig({ backend: "deterministic" })).toEqual({ backend: "deterministic", model: undefined });
  });

  it("claude-p + model はそのまま通す", () => {
    expect(resolveJudgmentConfig({ backend: "claude-p", model: "sonnet" })).toEqual({ backend: "claude-p", model: "sonnet" });
  });

  it("不正な backend 値は auto に丸める（後方互換・安全側）", () => {
    expect(resolveJudgmentConfig({ backend: "garbage" as any })).toEqual({ backend: "auto", model: undefined });
  });
});
