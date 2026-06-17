/**
 * Judgment Service の型（設計書 spec §5）。
 * 判定は決定論 backend が基盤。LLM backend は将来の拡張点（index.ts 参照）。
 */

/** 1 ターン分の判定入力。turnPrompt=このターンの依頼、turnResult=直前アシスタント出力想定。 */
export interface JudgmentInput {
  sessionId: string;
  /** 初回プロンプト由来の原タスク（不変の本旨）。 */
  originalTask: string;
  /** 現在の構造化サマリ（最新状況など）。 */
  currentSummary: string;
  /** このターンの依頼文。 */
  turnPrompt?: string;
  /** 直前アシスタント出力（ターン結果）。 */
  turnResult?: string;
  /** このターンで変更されたファイル（相対パス想定）。 */
  changedFiles?: string[];
}

/** 原タスクとの乖離分類。in_scope=継続、divergent=新トピック（分割候補）。 */
export type Divergence =
  | { kind: "in_scope" }
  | {
      kind: "divergent";
      /** 原タスクとの関係。child=従属、sibling=兄弟、independent=独立（既定）。 */
      relationship: "child" | "sibling" | "independent";
      /** 子課題に用いる短いラベル。 */
      label: string;
    };

/** サマリ更新結果。isMilestone=true で進捗へ 1 行追加（有界化）対象。 */
export interface SummaryUpdate {
  summary: string;
  isMilestone: boolean;
}

/** 判定 backend のインターフェース（決定論 / 将来 LLM の共通契約）。 */
export interface JudgmentBackend {
  classifyDivergence(input: JudgmentInput): Promise<Divergence>;
  updateSummary(input: JudgmentInput): Promise<SummaryUpdate>;
}
