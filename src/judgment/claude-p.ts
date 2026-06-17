import type { JudgmentBackend, JudgmentInput, Divergence, SummaryUpdate } from "./types.js";
import { runClaudeP } from "../claude-p.js";

/** claude -p 判定ランナー: flag 配列（プロンプト除く）と stdin 用 input を受け、stdout を返す。テストで注入する。 */
export type ClaudePRunner = (args: string[], input: string) => Promise<string>;

/** 実 claude -p を起動する既定ランナー（input を -p 引数として渡す）。 */
export const defaultClaudePRunner: ClaudePRunner = (args, input) => runClaudeP(["-p", input, ...args]);

/** 依頼文の最大長（プロンプトの肥大化防止）。 */
const PROMPT_INPUT_MAX = 8000;

/**
 * claude -p（サブスク認証）で判定する backend。失敗時は決定論 backend へフォールバック。
 * ガード:
 *  (i) ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN が存在 → 課金 API 経路を避け、claude を起動せず即フォールバック。
 *  (ii) runner 失敗 / タイムアウト / 空 / JSON parse 失敗 / 不正形 → フォールバック。
 *  (iii) runner 内部で BACKLOG_SYNC_IN_HOOK=1・cwd=tmpdir・--max-turns 1（runClaudeP が付与）。model 設定時のみ --model。
 * 判定は保守的: 曖昧/不明なら classifyDivergence は in_scope に倒す。
 */
export class ClaudePBackend implements JudgmentBackend {
  constructor(
    private readonly fallback: JudgmentBackend,
    private readonly runner: ClaudePRunner = defaultClaudePRunner,
    private readonly model?: string,
  ) {}

  private modelArgs(): string[] {
    return this.model ? ["--model", this.model] : [];
  }

  /** API キー検出時は LLM を呼ばない（課金回避）。 */
  private apiKeyPresent(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  }

  /** claude -p を呼び JSON を parse。失敗（throw/空/不正JSON）は undefined を返す。 */
  private async callJson(input: string): Promise<unknown | undefined> {
    try {
      const stdout = await this.runner(["--output-format", "json", "--max-turns", "1", ...this.modelArgs()], input);
      if (!stdout || !stdout.trim()) return undefined;
      const parsed = JSON.parse(stdout) as { result?: unknown };
      // claude -p --output-format json は { result: "<本文>" }。本文も JSON 文字列のはず。
      const body = typeof parsed.result === "string" ? parsed.result : undefined;
      if (body === undefined) return undefined;
      return JSON.parse(extractJsonObject(body));
    } catch {
      return undefined;
    }
  }

  async classifyDivergence(input: JudgmentInput): Promise<Divergence> {
    if (this.apiKeyPresent()) return this.fallback.classifyDivergence(input);
    const prompt = buildDivergencePrompt(input);
    const obj = await this.callJson(prompt);
    const verdict = parseDivergence(obj);
    return verdict ?? this.fallback.classifyDivergence(input);
  }

  async updateSummary(input: JudgmentInput): Promise<SummaryUpdate> {
    if (this.apiKeyPresent()) return this.fallback.updateSummary(input);
    const prompt = buildSummaryPrompt(input);
    const obj = await this.callJson(prompt);
    const verdict = parseSummaryUpdate(obj);
    return verdict ?? this.fallback.updateSummary(input);
  }
}

// ---- プロンプト構築（JSON のみを出力させる厳格指示） ----

/**
 * 乖離分類プロンプト。turnPrompt が originalTask の範囲内（in_scope）か新トピック（divergent）かを判定させる。
 * 出力は JSON のみ（前置き・コードフェンス禁止）。曖昧なら in_scope に倒す保守姿勢を明示する。
 */
function buildDivergencePrompt(input: JudgmentInput): string {
  const task = input.originalTask.slice(0, PROMPT_INPUT_MAX);
  const turn = (input.turnPrompt ?? "").slice(0, PROMPT_INPUT_MAX);
  const summary = (input.currentSummary ?? "").slice(0, 1000);
  return [
    "あなたは開発タスクの乖離を判定する係。今回の依頼が、元タスクの範囲内（継続）か、新しいトピック（分割候補）かを判定せよ。",
    "判断は保守的に。少しでも元タスクと関係する/曖昧なら in_scope とせよ（タスク乱立を避ける）。",
    "出力は次の JSON オブジェクトのみ。前置き・後置き・説明・コードフェンス（```）を一切含めない。",
    '範囲内なら: {"kind":"in_scope"}',
    'はっきり別トピックなら: {"kind":"divergent","relationship":"child"|"sibling"|"independent","label":"<短いラベル>"}',
    "relationship は従属=child・兄弟=sibling・独立=independent。label は子課題タイトル向けの短い日本語。",
    "",
    `# 元タスク\n${task}`,
    `# 現在のサマリ（参考）\n${summary}`,
    `# 今回の依頼\n${turn}`,
  ].join("\n");
}

/**
 * サマリ更新プロンプト。currentSummary を turnResult で更新し、節目（isMilestone）かを判定させる。
 * 出力は JSON のみ。
 */
function buildSummaryPrompt(input: JudgmentInput): string {
  const summary = (input.currentSummary ?? "").slice(0, PROMPT_INPUT_MAX);
  const result = (input.turnResult ?? "").slice(0, PROMPT_INPUT_MAX);
  return [
    "あなたは開発進捗のサマリを更新する係。現在のサマリと今回のターン結果から、最新の簡潔なサマリへ更新せよ。",
    "今回のターンが完了・状態変更・分割・エラー等の節目なら isMilestone=true、進行中の作業なら false とせよ。",
    "出力は次の JSON オブジェクトのみ。前置き・後置き・説明・コードフェンス（```）を一切含めない。",
    '{"summary":"<簡潔な更新サマリ>","isMilestone":true|false}',
    "",
    `# 現在のサマリ\n${summary}`,
    `# 今回のターン結果\n${result}`,
  ].join("\n");
}

// ---- 出力パース（寛容な抽出 + 厳格な検証） ----

/**
 * claude 本文から JSON オブジェクト部分を取り出す寛容な抽出。
 * - ```json / ``` フェンスを除去
 * - 最初の `{` から最後の `}` までを切り出す（周囲の散文で parse 崩れを防ぐ）
 * 中括弧が無ければ原文を返す（JSON.parse がその後 throw → 呼出側でフォールバック）。
 */
export function extractJsonObject(text: string): string {
  const stripped = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stripped;
  return stripped.slice(start, end + 1);
}

/**
 * Divergence の厳格検証。形が崩れていれば undefined（呼出側が決定論へフォールバック）。
 * 保守的: in_scope / 完全な divergent のみ受理する。
 */
function parseDivergence(obj: unknown): Divergence | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (o.kind === "in_scope") return { kind: "in_scope" };
  if (o.kind === "divergent") {
    const rel = o.relationship;
    const label = o.label;
    const relOk = rel === "child" || rel === "sibling" || rel === "independent";
    if (relOk && typeof label === "string" && label.trim()) {
      return { kind: "divergent", relationship: rel, label: label.trim() };
    }
  }
  return undefined;
}

/** SummaryUpdate の厳格検証。summary が非空文字列・isMilestone が boolean のときのみ受理。 */
function parseSummaryUpdate(obj: unknown): SummaryUpdate | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.summary === "string" && o.summary.trim() && typeof o.isMilestone === "boolean") {
    return { summary: o.summary, isMilestone: o.isMilestone };
  }
  return undefined;
}
