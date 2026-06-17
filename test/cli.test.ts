import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pathToFileURL } from "node:url";
import { parseArgs, main, warnIfApiKeyPresent, __resetApiKeyWarning, isMainEntry } from "../src/cli.js";

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
  it("init --judgment を解釈する（haiku/sonnet/opus/fable/deterministic/default）", () => {
    expect(parseArgs(["init", "--judgment", "haiku"])).toEqual({ cmd: "init", judgment: "haiku" });
    expect(parseArgs(["init", "--judgment", "sonnet"])).toEqual({ cmd: "init", judgment: "sonnet" });
    expect(parseArgs(["init", "--judgment", "opus"])).toEqual({ cmd: "init", judgment: "opus" });
    expect(parseArgs(["init", "--judgment", "fable"])).toEqual({ cmd: "init", judgment: "fable" });
    expect(parseArgs(["init", "--judgment", "deterministic"])).toEqual({ cmd: "init", judgment: "deterministic" });
    expect(parseArgs(["init", "--judgment", "default"])).toEqual({ cmd: "init", judgment: "default" });
  });
  it("init --judgment auto は default の別名として解釈する", () => {
    expect(parseArgs(["init", "--judgment", "auto"])).toEqual({ cmd: "init", judgment: "default" });
  });
  it("init --judgment の不正値/値なしは無視する（未指定 = 既存挙動）", () => {
    expect(parseArgs(["init", "--judgment", "bogus"])).toEqual({ cmd: "init" });
    expect(parseArgs(["init", "--judgment"])).toEqual({ cmd: "init" });
    expect(parseArgs(["init"])).toEqual({ cmd: "init" });
  });
  it("init --vcs と --judgment を併用解釈する", () => {
    expect(parseArgs(["init", "--vcs", "github", "--judgment", "haiku"]))
      .toEqual({ cmd: "init", vcs: "github", judgment: "haiku" });
  });
  it("docs を解釈する（--dry-run/--prune/--recreate/--target）", () => {
    expect(parseArgs(["docs"])).toEqual({ cmd: "docs", dryRun: false, prune: false, recreate: false });
    expect(parseArgs(["docs", "--dry-run", "--prune", "--recreate", "--target", "documents"]))
      .toEqual({ cmd: "docs", dryRun: true, prune: true, recreate: true, target: "documents" });
    expect(parseArgs(["docs", "--target", "wiki"])).toEqual({ cmd: "docs", dryRun: false, prune: false, recreate: false, target: "wiki" });
  });
  it("docs --target の不正値は無視する（既定 wiki のまま）", () => {
    expect(parseArgs(["docs", "--target", "bogus"])).toEqual({ cmd: "docs", dryRun: false, prune: false, recreate: false });
  });
  it("backfill-summary <issueKey> を解釈する", () => {
    expect(parseArgs(["backfill-summary", "PROJ-26"])).toEqual({ cmd: "backfill-summary", dryRun: false, issueKey: "PROJ-26" });
  });
  it("backfill-summary <issueKey> --dry-run を解釈する（順序非依存）", () => {
    expect(parseArgs(["backfill-summary", "PROJ-26", "--dry-run"])).toEqual({ cmd: "backfill-summary", dryRun: true, issueKey: "PROJ-26" });
    expect(parseArgs(["backfill-summary", "--dry-run", "PROJ-26"])).toEqual({ cmd: "backfill-summary", dryRun: true, issueKey: "PROJ-26" });
  });
  it("backfill-summary はキー無し（--dry-run のみ）でも cmd を保持し issueKey は未設定", () => {
    expect(parseArgs(["backfill-summary", "--dry-run"])).toEqual({ cmd: "backfill-summary", dryRun: true });
    expect(parseArgs(["backfill-summary"])).toEqual({ cmd: "backfill-summary", dryRun: false });
  });
});

describe("warnIfApiKeyPresent（APIキー混入の起動時警告）", () => {
  const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    __resetApiKeyWarning();
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("ANTHROPIC_API_KEY があれば1回警告する", () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    const lines: string[] = [];
    warnIfApiKeyPresent((s) => lines.push(s));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ANTHROPIC_API_KEY");
    expect(lines[0]).toContain("決定論");
  });

  it("ANTHROPIC_AUTH_TOKEN があれば1回警告する", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "tok";
    const lines: string[] = [];
    warnIfApiKeyPresent((s) => lines.push(s));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("キー不在なら警告しない", () => {
    const lines: string[] = [];
    warnIfApiKeyPresent((s) => lines.push(s));
    expect(lines).toEqual([]);
  });

  it("同一プロセスでは2回目以降は警告しない（重複抑制）", () => {
    process.env.ANTHROPIC_API_KEY = "sk-x";
    const lines: string[] = [];
    warnIfApiKeyPresent((s) => lines.push(s));
    warnIfApiKeyPresent((s) => lines.push(s));
    warnIfApiKeyPresent((s) => lines.push(s));
    expect(lines.length).toBe(1);
  });
});

describe("isMainEntry（直接実行ガード）", () => {
  const MODULE_URL = "file:///abs/dist/cli.js";

  it("argv[1] が本モジュールと一致すれば true（直接 node dist/cli.js 実行）", () => {
    const argv1 = "/abs/dist/cli.js"; // パス → file URL に正規化すると MODULE_URL と一致
    expect(isMainEntry(MODULE_URL, argv1)).toBe(true);
    // 正規化が pathToFileURL と整合することも確認
    expect(pathToFileURL(argv1).href).toBe(MODULE_URL);
  });

  it("argv[1] が bin スクリプトのパスなら false（bin が import→main 明示呼び＝二重実行しない）", () => {
    // bin/backlog-sync 経由では argv[1] は bin のパス（dist/cli.js ではない）
    expect(isMainEntry(MODULE_URL, "/abs/bin/backlog-sync")).toBe(false);
  });

  it("argv[1] が undefined なら false（起動文脈不明時は走らせない）", () => {
    expect(isMainEntry(MODULE_URL, undefined)).toBe(false);
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
