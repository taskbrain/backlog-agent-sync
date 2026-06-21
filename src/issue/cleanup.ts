import type { IssueComment } from "../tracker/backlog-rest.js";

/**
 * legacy ツール生成コメントの整理（spec §F5）。
 *
 * 背景: G23 以前は 1 ターンごとに「## ターン #N」「🤖 ターン要約 #N」形式の
 * テキストコメントが量産され、肥大課題（例 TC-26）に 34 件級で残存している。
 * これらツール生成コメントのみを削除し、**人間が書いたコメントは絶対に残す**。
 * 活動ログ（status/description 変更）は Backlog 仕様上削除不可なので対象外。
 *
 * 設計の要点:
 * - REST を直接握らず注入契約（CleanupDeps）越しに操作する → テスタブル & 配線非依存。
 * - 識別は保守的（誤削除ゼロ優先）。定型見出し / 既知マーカーで始まる/含むものだけを候補にする。
 * - dry-run は候補列挙のみ（delete は呼ばない）。本番は候補のみ delete、人間コメントは保持。
 */

/**
 * ツール生成コメントを保守的に識別する純粋関数。
 *
 * true（=削除候補）になるのは以下のいずれか:
 *  1. 本文が legacy 定型見出しで始まる:
 *     - `## ターン #N`（markdown H2。`#` 個数や前後空白の揺れも許容）
 *     - `🤖 ターン要約 #N`（ロボット絵文字プレフィクス）
 *  2. 本文に既知のツールマーカー `[[bas:...]]` を含む（seed/session 機械マーカー）。
 *
 * 人間コメント（定型に該当しない自由文）・空文字は false。
 * 現行フォーマット（マーカー無しの節目1行コメント）も巻き込まないよう、
 * あくまで legacy 定型 / 機械マーカーのみを基準にする。
 */
export function isToolComment(content: string): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (trimmed === "") return false;

  // 既知の機械マーカー（seed: [[bas:epic:...]] / session: [[bas:session:...]]）を含む。
  if (/\[\[bas:[^\]]*\]\]/.test(trimmed)) return true;

  // legacy 定型見出しで「始まる」もののみ（中途に出現する人間コメントは除外）。
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();

  // `## ターン #3` … 見出し記号(#)の個数揺れを許容しつつ「ターン #<数字>」で始まる。
  if (/^#{1,6}\s*ターン\s*#\s*\d+/u.test(firstLine)) return true;

  // `🤖 ターン要約 #5` … ロボット絵文字プレフィクス + ターン要約。
  if (/^🤖\s*ターン要約\s*#\s*\d+/u.test(firstLine)) return true;

  return false;
}

/** cleanupToolComments の最小注入契約（読み取り + コメント削除のみ）。 */
export interface CleanupDeps {
  /** 課題コメントを取得（ページング起点 minId）。content と id を含む。 */
  getIssueComments(issueIdOrKey: string | number, opts?: { minId?: number; count?: number }): Promise<IssueComment[]>;
  /** 単一コメント削除。ツール生成コメントのみに対して呼ぶ。 */
  deleteComment(issueIdOrKey: string | number, commentId: number): Promise<void>;
}

export interface CleanupOptions {
  /** true なら削除せず候補列挙のみ。 */
  dryRun?: boolean;
  /** 1 ページの取得件数（既定 100。Backlog 上限）。 */
  pageSize?: number;
  /** 取得ページ数の安全上限（暴走防止。既定 20 ページ = 最大 2000 件）。 */
  maxPages?: number;
}

/** 削除候補の最小情報（id + 冒頭プレビュー）。 */
export interface CleanupCandidate {
  id: number;
  /** 本文の冒頭（最大 80 文字、改行は空白へ畳む）。 */
  preview: string;
}

export interface CleanupResult {
  issueKey: string;
  /** 実際に削除した件数（dry-run は 0）。 */
  deleted: number;
  /** 保持した件数（人間コメント等。候補でないもの）。 */
  kept: number;
  /** 削除候補（dry-run/本番ともに列挙）。 */
  candidates: CleanupCandidate[];
}

/** 本文冒頭をプレビュー用に短く整形（改行畳み + 80 文字切り詰め）。 */
function previewOf(content: string): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? oneLine.slice(0, 80) + "…" : oneLine;
}

/**
 * 課題コメントを走査し、ツール生成コメントのみを削除（dry-run なら列挙のみ）。
 *
 * - getIssueComments を minId ページングで全件取得（maxPages 上限で安全停止）。
 * - isToolComment が true のものだけを候補化。人間コメントは触れない。
 * - dry-run: deleteComment を一切呼ばず candidates を返す。
 * - 本番: 候補のみ deleteComment（昇順）。1 件失敗しても残りを試みる（堅牢性）。
 */
export async function cleanupToolComments(
  deps: CleanupDeps,
  issueKey: string,
  opts: CleanupOptions = {},
): Promise<CleanupResult> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 20;

  // 全コメントを minId ページングで収集（asc 前提。最後の id を次ページ起点にする）。
  const all: IssueComment[] = [];
  let minId: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = await deps.getIssueComments(issueKey, { minId, count: pageSize });
    if (!batch.length) break;
    all.push(...batch);
    if (batch.length < pageSize) break; // 端数ページ = 最終ページ
    minId = batch[batch.length - 1]!.id; // 次は最後の id より大きいものを取得
  }

  const candidates: CleanupCandidate[] = [];
  let kept = 0;
  for (const c of all) {
    if (isToolComment(c.content ?? "")) {
      candidates.push({ id: c.id, preview: previewOf(c.content ?? "") });
    } else {
      kept++;
    }
  }

  if (opts.dryRun) {
    return { issueKey, deleted: 0, kept, candidates };
  }

  let deleted = 0;
  for (const cand of candidates) {
    try {
      await deps.deleteComment(issueKey, cand.id);
      deleted++;
    } catch {
      // 1 件の失敗で全体を止めない（残りの候補削除を継続）。
    }
  }
  return { issueKey, deleted, kept, candidates };
}
