import type { JudgmentBackend } from "./types.js";
import { DeterministicBackend } from "./deterministic.js";

export type { JudgmentBackend, JudgmentInput, Divergence, SummaryUpdate } from "./types.js";
export { DeterministicBackend } from "./deterministic.js";

/**
 * 判定 backend を返すファクトリ。現状は決定論 backend 固定。
 *
 * 将来の拡張点（LLM backend）:
 * prompt フックは判定結果をコードへ渡せないため、決定論 backend が全オプション共通の基盤。
 * LLM 整理を有効化する場合は、ここで FieldRules.summarize 等の設定値を見て
 * `new LlmBackend(...)` を返す分岐を追加する。今は決定論固定（設定読み取りも未配線）。
 */
export function getBackend(): JudgmentBackend {
  // TODO(llm-backend): 設定（例 FieldRules.summarize === "claude"）に応じて LLM backend を選択する分岐をここに追加。
  return new DeterministicBackend();
}
