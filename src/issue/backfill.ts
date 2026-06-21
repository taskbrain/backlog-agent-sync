import type { TextFormattingRule, JudgmentConfig } from "../types.js";
import type { IssueComment, IssueDetail } from "../tracker/backlog-rest.js";
import type { JudgmentBackend, SummaryUpdate } from "../judgment/types.js";
import { getBackend, DeterministicBackend } from "../judgment/index.js";
import { buildDescription } from "./description.js";

/**
 * backfill-summary（spec §12 / Plan 2.5）の最小注入契約。
 *
 * 既存の肥大課題（例 TC-26=74コメント）に対し、**コメントは一切削除・改変せず**、
 * 説明欄に現状サマリ（§7.1 の 4 ブロック構造）を 1 回だけ再構築するワンタイム処理。
 *
 * 設計の要点:
 * - REST/judgment を直接握らず注入契約越しに操作する → テスタブル & 配線非依存（lifecycle.ts と同型）。
 * - 契約は「読み取り（getIssueDetail / getComments）」と「説明更新（updateIssueDescription）」のみ。
 *   コメントの削除・改変メソッドは契約に存在しない（= 構造的に非削除を担保）。
 * - getComments は任意。未注入/失敗でも本文生成は説明のみで成立する（落とさない）。
 * - backend は任意注入（テスト用）。未注入時は judgment から getBackend で解決する
 *   （claude-p の API課金ガード / 失敗時の決定論フォールバックを内包）。
 *   さらに updateSummary 自体が throw しても本処理は決定論で本文を組み直し落ちない。
 */
export interface BackfillDeps {
  /** 既存課題の件名・説明を取得（材料の中心）。 */
  getIssueDetail(issueIdOrKey: string | number): Promise<IssueDetail>;
  /** 直近コメント取得（任意・読み取り専用の材料収集）。未注入/失敗時は説明のみで継続。 */
  getComments?(issueIdOrKey: string | number, opts?: { minId?: number; count?: number }): Promise<IssueComment[]>;
  /** 説明欄のみ更新（コメントには触れない）。本番時に 1 回だけ呼ぶ。 */
  updateIssueDescription(issueIdOrKey: string | number, description: string): Promise<void>;
  /** 判定 backend 選択（project.json judgment）。backend 未注入時に getBackend へ渡す。 */
  judgment?: JudgmentConfig;
  /** 説明本文のマークアップ（markdown / backlog）。 */
  textFormattingRule?: TextFormattingRule;
  /** テスト用に backend を直接差し込む口（未指定なら getBackend(judgment)）。 */
  backend?: JudgmentBackend;
}

export interface BackfillOptions {
  /** true なら説明欄を書き換えず、生成本文を返す + write へ出力するだけ。 */
  dryRun?: boolean;
  /** dry-run 時の出力先（既定 stdout）。 */
  write?: (s: string) => void;
  /** コメント材料の取得件数（既定 20。多すぎる課題でも材料は直近に限定）。 */
  commentCount?: number;
}

export interface BackfillResult {
  issueKey: string;
  body: string;
  /** updateIssueDescription を実行したか（dry-run は false）。 */
  updated: boolean;
}

/**
 * 既存説明から ## タスク ブロックを抽出（deterministic backend と対称の見出し基準）。無ければ "".
 * markdown 見出し（# タスク）と Backlog 記法見出し（* タスク）の両方に対応する
 * （extractLatestText が最新状況で markdown/backlog 両対応なのと対称。Backlog 記法で作られた
 * 既存説明では ## ではなく ** が使われるため、片側だけだとタスクを取りこぼし件名へ無駄に落ちる）。
 */
const TASK_RE = /(?:^|\n)#{1,6}\s*タスク\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;
const TASK_RE_BACKLOG = /(?:^|\n)\*{1,6}\s*タスク\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;
function extractTask(description: string): string {
  const m = TASK_RE.exec(description) ?? TASK_RE_BACKLOG.exec(description);
  return m ? m[1]!.trim() : "";
}

/**
 * 既存の §7.1 構造見出し（## タスク / ## 進捗 / ## 最新状況 / ## 子課題、Backlog 記法の * 見出しも）を
 * 材料テキストから除去する。これを行わないと、説明を判定材料へ渡した際に決定論フォールバックが
 * 「最新状況」ブロックへ旧構造ごと貼り直してしまい、見出しが入れ子になる（§7.1 の単一ブロック原則に反する）。
 */
const STRUCT_HEADING_RE = /^\s*(?:#{1,6}|\*{1,6})\s*(?:タスク|進捗|最新状況|子課題)\s*$/u;
function stripStructHeadings(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !STRUCT_HEADING_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** updateSummary が返す最新状況テキスト（最終的に latest ブロックへ入る文）を取り出す。 */
const LATEST_RE = /(?:^|\n)#{1,6}\s*最新状況\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;
const LATEST_RE_BACKLOG = /(?:^|\n)\*{1,6}\s*最新状況\s*\n([\s\S]*?)(?=\n#{1,6}\s|\n\*{1,6}\s|$)/;
/**
 * backend.updateSummary の戻り（summary）から「最新状況」本文だけを取り出す。
 *
 * 決定論 backend は summary に §7.1 全体（## タスク…## 子課題）を返すため、そのまま latest へ入れると
 * 見出しが入れ子になる。最新状況ブロックを抜き出して latest 単体にする（claude-p backend が素のサマリ
 * 文字列を返す場合は見出しが無いのでそのまま全文を採る）。
 */
function extractLatestText(summary: string): string {
  const m = LATEST_RE.exec(summary) ?? LATEST_RE_BACKLOG.exec(summary);
  if (m) return m[1]!.trim();
  // 構造見出しを含まない素のサマリ → そのまま使う（ただし構造見出しが混ざる場合は均す）。
  return stripStructHeadings(summary);
}

/** コメント本文を材料用に短く連結（直近を古い順に）。空配列なら "". */
function joinComments(comments: IssueComment[]): string {
  return comments
    .map((c) => (c.content ?? "").trim())
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * 既存課題の説明欄を §7.1 構造で 1 回だけ再構築する（コメントは非削除・非改変）。
 *
 * 材料:
 *   - originalTask: 既存説明の ## タスク（無ければ件名）。
 *   - currentSummary: 既存説明（そのまま判定材料へ）。
 *   - turnResult: 既存説明 + 直近コメントの要約材料。
 * 生成:
 *   - updateSummary で現状サマリ（最新状況）を生成（throw 時は決定論へフォールバック）。
 *   - buildDescription で 4 ブロック本文を組む（progress=[] / children=[]：履歴は持たないため latest にサマリ）。
 */
export async function backfillSummary(
  deps: BackfillDeps,
  issueKey: string,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));

  const detail = await deps.getIssueDetail(issueKey);
  const existingDesc = detail.description ?? "";

  // 直近コメントは任意の材料（読み取り専用）。未注入/失敗は説明のみで継続。
  let commentsText = "";
  if (deps.getComments) {
    try {
      const comments = await deps.getComments(issueKey, { count: opts.commentCount ?? 20 });
      commentsText = joinComments(comments);
    } catch {
      // コメント取得失敗は致命ではない（説明のみで現状サマリを組む）
    }
  }

  // 原タスク = 既存説明の ## タスク → 無ければ件名 → それも無ければ空。
  const originalTask = extractTask(existingDesc) || (detail.summary ?? "").trim();
  // 判定材料: 既存説明（構造見出しを除去した本文）+ 直近コメント。構造見出しを残すと決定論フォールバックが
  // 最新状況へ §7.1 構造ごと貼り直し見出しが入れ子になるため、材料段階で素の本文へ均す。
  const turnResult = [stripStructHeadings(existingDesc), commentsText].filter((s) => s.trim()).join("\n\n");

  const backend = deps.backend ?? getBackend(deps.judgment);
  let update: SummaryUpdate;
  try {
    update = await backend.updateSummary({
      sessionId: "backfill",
      originalTask,
      currentSummary: existingDesc,
      turnResult,
    });
  } catch {
    // backend が throw しても落とさない（API課金回避/オフライン等）。決定論で組み直す。
    update = await new DeterministicBackend().updateSummary({
      sessionId: "backfill",
      originalTask,
      currentSummary: existingDesc,
      turnResult,
    });
  }

  // §7.1 構造の本文を再構築。進捗履歴は保持しないため progress=[] / 最新状況に生成サマリ（最新状況本文のみ）を置く。
  // update.summary は backend により全体構造 or 素のサマリ。latest 単体を抜き出し見出しの入れ子を防ぐ。
  const latest = extractLatestText(update.summary);
  const body = buildDescription(
    { originalTask, progress: [], latest, children: [] },
    deps.textFormattingRule ?? "markdown",
  );

  if (opts.dryRun) {
    write(body.endsWith("\n") ? body : body + "\n");
    return { issueKey: detail.issueKey, body, updated: false };
  }

  // 本番: 説明欄のみ更新（コメントは一切削除・改変しない）。
  await deps.updateIssueDescription(issueKey, body);
  return { issueKey: detail.issueKey, body, updated: true };
}
