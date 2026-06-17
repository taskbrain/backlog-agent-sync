import type { JudgmentBackend, JudgmentInput, Divergence, SummaryUpdate } from "./types.js";
import { buildDescription } from "../issue/description.js";

/**
 * 決定論 backend（LLM 不使用・依存追加なし）。
 * - classifyDivergence: 原タスクとターン依頼の軽量類似度（共有トークン数）で乖離判定。
 *   保守的閾値（明確に乖離した時のみ divergent）+ 明示キーワード優先。既定 in_scope でタスク乱立を防ぐ。
 * - updateSummary: ターン結果から最新状況を上書きし、状態語/完了語で isMilestone を立てる。
 *   ※ isMilestone を返すだけで appendMilestone は呼ばない。進捗への反映（appendMilestone 呼出）は
 *     呼び出し側（Phase2 の Stop 配線）の責務（updateSummary の docstring 参照）。
 */

/** 明示的に「別作業」を宣言するキーワード（出現で divergent 寄り）。 */
const DIVERGENT_KEYWORDS = ["別タスク", "別件", "別の課題", "別課題", "別の作業", "新しいタスク", "別途"];

/** 子課題（従属）を示唆するキーワード（relationship=child）。 */
const CHILD_KEYWORDS = ["サブタスク", "子課題", "子タスク", "分割して", "別で進める"];

/**
 * マイルストーン（進捗 1 行追加）対象とみなすキーワード。
 * 過検知（コメント増殖）防止のため、**完了・状態変更・分割・エラー（=終端/節目）に限定**する。
 * 進行中を示す語（裸の「修正」「fix」「マージ」「デプロイ」等）は含めない。
 * - 完了: "修正している最中"/"fix中"/"マージ予定" は false、
 *   "修正完了"/"デプロイ完了"/"マージ済み" は true になるよう、完了を伴う複合形のみを採る。
 */
const MILESTONE_KEYWORDS = [
  // --- 完了 ---
  "完了",
  "完成",
  "done",
  "対応済",
  "解決",
  "実装完了",
  "実装した",
  "修正完了",
  "修正した",
  "fixed",
  // --- 状態変更（デプロイ/リリース/マージは「済/した/完了」を伴う複合形に限定） ---
  "デプロイ済",
  "デプロイした",
  "デプロイ完了",
  "deployed",
  "リリース済",
  "リリースした",
  "リリース完了",
  "released",
  "マージ済",
  "マージした",
  "マージ完了",
  "merged",
  // --- 分割（課題分割は構造上の節目） ---
  "分割した",
  "別課題に切り出",
  "別タスクに切り出",
  "切り出した",
  // --- エラー/中止/方針変更（終端・転換点） ---
  "失敗",
  "error",
  "エラー",
  "中止",
  "方針変更",
  "断念",
  "ブロック",
];

/**
 * 乖離と判断する語彙重なりの上限件数（共有トークン数）。
 * 原タスクとの共有トークンがこの件数以下（= 実質的に語彙の接点がない）の時のみ divergent。
 * 既定 0 = 1 トークンでも重なれば in_scope を維持する最も保守的な設定。
 * 「機能」のような僅かな重なりでも継続扱いとし、タスク乱立を防ぐ（Jaccard 比率では
 * 文長差で揺らぐため、件数ベースの方が決定論的に安定）。
 */
const DIVERGENT_MAX_SHARED_TOKENS = 0;

/** 類似度判定を行うのに最低限必要なターン依頼のトークン数（短すぎる依頼は in_scope 据え置き）。 */
const MIN_TOKENS_FOR_DIVERGENCE = 4;

export class DeterministicBackend implements JudgmentBackend {
  async classifyDivergence(input: JudgmentInput): Promise<Divergence> {
    const prompt = input.turnPrompt?.trim();
    // 情報不足（ターン依頼なし）は保守的に in_scope。
    if (!prompt) return { kind: "in_scope" };

    // 1) 明示キーワード優先（語彙が重なっていても明示宣言があれば乖離扱い）。
    if (hasKeyword(prompt, CHILD_KEYWORDS)) {
      return { kind: "divergent", relationship: "child", label: makeLabel(prompt) };
    }
    if (hasKeyword(prompt, DIVERGENT_KEYWORDS)) {
      return { kind: "divergent", relationship: "independent", label: makeLabel(prompt) };
    }

    // 2) 軽量類似度（共有トークン数）。明確に乖離した時のみ divergent、既定 independent。
    const promptTokens = tokenize(prompt);
    const taskTokens = tokenize(input.originalTask);
    if (promptTokens.size < MIN_TOKENS_FOR_DIVERGENCE || taskTokens.size === 0) {
      return { kind: "in_scope" };
    }
    const shared = sharedCount(promptTokens, taskTokens);
    if (shared <= DIVERGENT_MAX_SHARED_TOKENS) {
      return { kind: "divergent", relationship: "independent", label: makeLabel(prompt) };
    }
    return { kind: "in_scope" };
  }

  /**
   * 最新状況を上書きした構造化サマリと isMilestone を返す。
   *
   * 責務境界（重要）: この関数は `isMilestone` を**判定して返すだけ**で、`appendMilestone` は呼ばない。
   * isMilestone===true のとき進捗（## 進捗）へ 1 行追加する処理は、**呼び出し側（Phase2 の Stop 配線）の責務**。
   * 典型的な配線は次の通り（このメソッドは進捗配列を持たないため、進捗の保持・有界化は呼び出し側が行う）:
   *
   *   const { summary, isMilestone } = await backend.updateSummary(input);
   *   if (isMilestone) progress = appendMilestone(progress, <節目1行>, 20);
   *   // 進捗を含めた最終本文は呼び出し側で buildDescription({ ..., progress }) を再構築する。
   *
   * ここで返す summary の ## 進捗 は currentSummary から引き継いだ既存値のみで、今ターンの節目は未反映。
   */
  async updateSummary(input: JudgmentInput): Promise<SummaryUpdate> {
    const result = input.turnResult?.trim();
    const isMilestone = result ? hasKeyword(result, MILESTONE_KEYWORDS) : false;

    // 最新状況は常に 1 ブロックで上書き。結果が無ければ現サマリの最新状況を維持。
    const latest = result || extractLatest(input.currentSummary);
    const originalTask = extractTask(input.currentSummary) || input.originalTask;

    const summary = buildDescription({
      originalTask,
      progress: extractProgress(input.currentSummary),
      latest,
      children: [],
    });
    return { summary, isMilestone };
  }
}

// ---- 軽量類似度（依存追加なしの素朴実装） ----

/** カタカナ（音写）判定。語幹の意味を持たず、2-gram の偶発衝突を起こしやすいため弱トークン扱い。 */
const KATAKANA_ONLY = /^[ァ-ヿー]+$/;
/** 漢字を含むか（意味を担う content word の指標）。 */
const HAS_KANJI = /[一-鿿々]/;

/**
 * 語彙トークン化。英数語はそのまま、CJK は 2-gram + 連続全体を語彙近似トークンにする。
 * 形態素解析なし・依存追加なしの素朴実装。
 */
function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();

  // 英数語（連続する ASCII 英数）
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }

  // CJK 連続文字列: 連続全体（強い一致）と 2-gram（部分一致）の双方をトークン化
  for (const run of lower.matchAll(/[぀-ヿ一-鿿々ー]+/g)) {
    const s = run[0];
    tokens.add(s);
    for (let i = 0; i < s.length - 1; i++) {
      tokens.add(s.slice(i, i + 2));
    }
  }
  return tokens;
}

/**
 * 「意味のある」共有トークン数 = |A∩B| から音写ノイズを除いた件数。
 * カタカナのみの 2-gram（例: ログ"イン" と デザ"イン"）は偶発衝突しやすいので、
 * content word（漢字を含む語 / ASCII 語）に限って語彙の接点を数える。
 */
function sharedCount(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const t of a) {
    if (!b.has(t)) continue;
    if (KATAKANA_ONLY.test(t) && !HAS_KANJI.test(t)) continue; // 音写の偶発一致は数えない
    inter++;
  }
  return inter;
}

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/** 子課題ラベル（依頼の先頭を短く切り出す）。 */
function makeLabel(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0]!.trim();
  // 「別件:」「サブタスク:」等の接頭辞を除去
  const cleaned = firstLine.replace(/^(別タスク|別件|サブタスク|子課題|子タスク|別の課題|別課題)[\s:：、。]*/u, "").trim();
  const base = cleaned || firstLine;
  return base.length > 40 ? `${base.slice(0, 40)}…` : base;
}

// ---- 現サマリからのブロック抽出（## 見出し基準。description.ts と対称） ----

const TASK_RE = /(?:^|\n)#{1,6}\s*タスク\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;
const LATEST_RE = /(?:^|\n)#{1,6}\s*最新状況\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;
const PROGRESS_RE = /(?:^|\n)#{1,6}\s*進捗\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;

/**
 * 構造見出し行（markdown `## ` / backlog `** ` 等）の検出。
 * 空の ## 進捗 直後に ## 最新状況 が続くレイアウトでは PROGRESS_RE の非貪欲キャプチャが
 * 次見出し行まで取り込みうる（決定論経路のみ・LLM 経路では非発生）。進捗行から見出しを
 * 確実に打ち切る境界フィルタとして適用する（backfill.ts の STRUCT_HEADING_RE 同型）。
 */
const PROGRESS_HEADING_RE = /^\s*(?:#{1,6}|\*{1,6})\s+\S/;

function extractTask(summary: string): string {
  const m = TASK_RE.exec(summary);
  return m ? m[1]!.trim() : "";
}

function extractLatest(summary: string): string {
  const m = LATEST_RE.exec(summary);
  return m ? m[1]!.trim() : "";
}

function extractProgress(summary: string): string[] {
  const m = PROGRESS_RE.exec(summary);
  if (!m) return [];
  const lines = m[1]!.split(/\r?\n/);
  // 次の構造見出し行で打ち切る（見出し以降は別ブロックの内容＝進捗ではない）。
  // 空進捗+直後最新状況のレイアウトでは PROGRESS_RE が見出し行とその本文まで取り込むため、
  // 見出し行を境界として以降を捨てる（見出し自身も本文も progress へ混入させない）。
  const headingIdx = lines.findIndex((l) => PROGRESS_HEADING_RE.test(l));
  const body = headingIdx >= 0 ? lines.slice(0, headingIdx) : lines;
  return body
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter((l) => l.length > 0);
}
