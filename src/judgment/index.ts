import type { JudgmentBackend } from "./types.js";
import type { JudgmentConfig } from "../types.js";
import { resolveJudgmentConfig } from "../config.js";
import { DeterministicBackend } from "./deterministic.js";
import { ClaudePBackend, defaultClaudePRunner } from "./claude-p.js";

export type { JudgmentBackend, JudgmentInput, Divergence, SummaryUpdate } from "./types.js";
export { DeterministicBackend } from "./deterministic.js";
export { ClaudePBackend, defaultClaudePRunner, type ClaudePRunner } from "./claude-p.js";

/**
 * 判定 backend を返すファクトリ。project.json の `judgment` ブロックに応じて選択する。
 *
 * - "deterministic": 決定論のみ（LLM 不使用）。
 * - "auto"（既定） / "claude-p": ClaudePBackend（claude -p サブスク認証で判定）。
 *   ClaudePBackend は内部で API キー検出 / 失敗時に決定論 backend へフォールバックするため、
 *   prompt フックが判定結果をコードへ渡せない経路でも決定論が常に基盤として機能する。
 *
 * 注意: `FieldRules.summarize` は G20 のプロンプト整理（依頼文の LLM 要約）用の別軸設定であり、
 * judgment backend の選択とは無関係。混同しないこと。
 */
export function getBackend(judgment?: JudgmentConfig): JudgmentBackend {
  const { backend, model } = resolveJudgmentConfig(judgment);
  if (backend === "deterministic") return new DeterministicBackend();
  // "auto" | "claude-p": ClaudePBackend 自身がガード/フォールバックを内包する。
  return new ClaudePBackend(new DeterministicBackend(), defaultClaudePRunner, model);
}
