import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudePBackend, type ClaudePRunner } from "../src/judgment/claude-p.js";
import { DeterministicBackend } from "../src/judgment/deterministic.js";
import type { JudgmentInput } from "../src/judgment/types.js";

// claude -p --output-format json は { result: "<本文>" } を返し、本文が判定 JSON 文字列。
// テストの runner はこの二重 JSON 形を模す。
function llmStdout(verdict: unknown): string {
  return JSON.stringify({ result: JSON.stringify(verdict) });
}

// in_scope: 元タスクと依頼が語彙を共有 → 決定論は in_scope を返す（distinguishable な基準）。
const IN_SCOPE_INPUT: JudgmentInput = {
  sessionId: "s1",
  originalTask: "ログインフォームのバリデーションを実装する",
  currentSummary: "## タスク\nログインフォームのバリデーション\n## 進捗\n## 最新状況\n着手",
  turnPrompt: "ログインフォームのバリデーションのエラーメッセージを調整する",
};

// 明示キーワード「別件」を含む依頼 → 決定論は divergent/independent を返す。
const DIVERGENT_INPUT: JudgmentInput = {
  sessionId: "s1",
  originalTask: "ログインフォームのバリデーションを実装する",
  currentSummary: "## タスク\nログインフォームのバリデーション\n## 進捗\n## 最新状況\n着手",
  turnPrompt: "別件: 請求書PDFの出力機能を追加したい",
};

const SUMMARY_INPUT: JudgmentInput = {
  sessionId: "s1",
  originalTask: "ログインフォームのバリデーションを実装する",
  currentSummary: "## タスク\nログインフォームのバリデーション\n## 進捗\n## 最新状況\n着手",
  turnResult: "バリデーションの実装完了。テストも追加した。",
};

// 各テスト前後で API キー env を確実に退避・復元（runner 経路を実際に通すため非(b)ではクリア）。
let savedApiKey: string | undefined;
let savedAuthToken: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
});

describe("ClaudePBackend.classifyDivergence", () => {
  it("(a) 成功: runner の JSON 判定をそのまま返す", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(
      llmStdout({ kind: "divergent", relationship: "child", label: "請求書PDF出力" }),
    );
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    // 依頼自体は in_scope 寄り（語彙共有）だが、LLM 判定（divergent/child）を優先することを確認。
    const out = await backend.classifyDivergence(IN_SCOPE_INPUT);
    expect(out).toEqual({ kind: "divergent", relationship: "child", label: "請求書PDF出力" });
    expect(runner).toHaveBeenCalledTimes(1);
    // (iii) runner へ渡す flag 配列に判定用フラグが含まれる。
    const [args] = (runner as any).mock.calls[0];
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("1");
  });

  it("(a) 成功: in_scope 判定もそのまま返す", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(llmStdout({ kind: "in_scope" }));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    expect(await backend.classifyDivergence(DIVERGENT_INPUT)).toEqual({ kind: "in_scope" });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("(b) ANTHROPIC_API_KEY 検出時は runner を呼ばず決定論へ即フォールバック", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const runner = vi.fn();
    const backend = new ClaudePBackend(new DeterministicBackend(), runner as unknown as ClaudePRunner);
    const out = await backend.classifyDivergence(IN_SCOPE_INPUT);
    const expected = await new DeterministicBackend().classifyDivergence(IN_SCOPE_INPUT);
    expect(out).toEqual(expected);
    expect(runner).not.toHaveBeenCalled();
  });

  it("(c) runner が throw（timeout/ENOENT 想定）→ 決定論へフォールバック（throw しない）", async () => {
    const runner: ClaudePRunner = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    const out = await backend.classifyDivergence(DIVERGENT_INPUT);
    const expected = await new DeterministicBackend().classifyDivergence(DIVERGENT_INPUT);
    expect(out).toEqual(expected); // 「別件」→ divergent/independent
    expect(out.kind).toBe("divergent");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("(d) result が非 JSON → 決定論へフォールバック", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(JSON.stringify({ result: "not json" }));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    const out = await backend.classifyDivergence(DIVERGENT_INPUT);
    const expected = await new DeterministicBackend().classifyDivergence(DIVERGENT_INPUT);
    expect(out).toEqual(expected);
  });

  it("(d) 判定 JSON の形が不正（kind:bogus）→ 決定論へフォールバック", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(llmStdout({ kind: "bogus" }));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    const out = await backend.classifyDivergence(IN_SCOPE_INPUT);
    const expected = await new DeterministicBackend().classifyDivergence(IN_SCOPE_INPUT);
    expect(out).toEqual(expected); // 語彙共有 → in_scope
    expect(out).toEqual({ kind: "in_scope" });
  });

  it("散文に囲まれた JSON も抽出して受理する（寛容パース）", async () => {
    const body = "```json\n{\"kind\":\"divergent\",\"relationship\":\"sibling\",\"label\":\"PDF出力\"}\n```";
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(JSON.stringify({ result: body }));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    expect(await backend.classifyDivergence(IN_SCOPE_INPUT)).toEqual({
      kind: "divergent",
      relationship: "sibling",
      label: "PDF出力",
    });
  });

  it("model 設定時は runner の flag に --model が含まれる", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(llmStdout({ kind: "in_scope" }));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner, "sonnet");
    await backend.classifyDivergence(IN_SCOPE_INPUT);
    const [args] = (runner as any).mock.calls[0];
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
  });
});

describe("ClaudePBackend.updateSummary", () => {
  it("(a) 成功: runner の JSON サマリをそのまま返す", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(
      llmStdout({ summary: "バリデーション実装が完了", isMilestone: true }),
    );
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    expect(await backend.updateSummary(SUMMARY_INPUT)).toEqual({ summary: "バリデーション実装が完了", isMilestone: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("(b) ANTHROPIC_API_KEY 検出時は runner を呼ばず決定論へ即フォールバック", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const runner = vi.fn();
    const backend = new ClaudePBackend(new DeterministicBackend(), runner as unknown as ClaudePRunner);
    const out = await backend.updateSummary(SUMMARY_INPUT);
    const expected = await new DeterministicBackend().updateSummary(SUMMARY_INPUT);
    expect(out).toEqual(expected);
    expect(runner).not.toHaveBeenCalled();
  });

  it("(c) runner が throw → 決定論へフォールバック（throw しない）", async () => {
    const runner: ClaudePRunner = vi.fn().mockRejectedValue(new Error("timeout"));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    const out = await backend.updateSummary(SUMMARY_INPUT);
    const expected = await new DeterministicBackend().updateSummary(SUMMARY_INPUT);
    expect(out).toEqual(expected);
    expect(out.isMilestone).toBe(true); // 「実装完了」→ 決定論で isMilestone
  });

  it("(d) summary 欠落の不正形 → 決定論へフォールバック", async () => {
    const runner: ClaudePRunner = vi.fn().mockResolvedValue(llmStdout({ isMilestone: true }));
    const backend = new ClaudePBackend(new DeterministicBackend(), runner);
    const out = await backend.updateSummary(SUMMARY_INPUT);
    const expected = await new DeterministicBackend().updateSummary(SUMMARY_INPUT);
    expect(out).toEqual(expected);
  });
});
