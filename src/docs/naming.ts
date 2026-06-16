import type { DocsNamingConfig } from "../types.js";

const FENCE_RE = /^\s{0,3}(```|~~~)/; // convert.ts と同形
const ATX_H1_RE = /^\s{0,3}#\s+(.+?)\s*#*\s*$/; // 単一 "#" + 空白 + 本文（## 以上は非該当・# のあと空白必須）
const LEADING_NUMBER_RE = /^(\d+)[-_ ](.*)$/; // 先頭の数字塊 + 区切り 1 文字 + 残り

/**
 * Markdown 本文から最初の ATX H1 見出しを抽出する（純粋・I/O なし）。
 * - 先頭 frontmatter ブロック（lines[0] が "---"、閉じ "---" あり）は読み飛ばす。閉じが無ければ frontmatter 扱いしない。
 * - フェンスコードブロック内の "#" は H1 とみなさない。
 * - 単一 "#" + 空白の ATX H1 のみ対象。装飾は最小限に正規化する。
 */
export function extractH1(content: string): string | undefined {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // 先頭 BOM を除去（インデント計数・frontmatter 判定の誤りを防ぐ）
  const lines = content.split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    let close = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j].trim() === "---") {
        close = j;
        break;
      }
    }
    if (close >= 0) start = close + 1; // 閉じがある時のみ frontmatter として読み飛ばす
  }

  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_H1_RE.exec(line);
    if (m) {
      const text = normalizeInline(m[1]).trim();
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * H1 本文の最小正規化（リンク → ラベル、強調/コードのマーカー除去）。完全な Markdown パーサではない。
 * 単一 `_`/`*` の強調は語境界でのみ剥がす（CommonMark 準拠）。語中アンダースコア（api_v2_design 等）は保持する。
 */
function normalizeInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) / ![alt](url) → label/alt
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **x** → x
    .replace(/__([^_]+)__/g, "$1") // __x__ → x
    // 単一 `*`/`_` 強調は語境界でのみ剥がす。語=Unicode 文字/数字/`_`（CJK も含む）。
    // 語中マーカー（api_v2_design / 設定_詳細_メモ 等）は両隣が語文字のため非該当で保持される。
    .replace(/(?<![\p{L}\p{N}_])\*([^*]+)\*(?![\p{L}\p{N}_])/gu, "$1") // *x* 強調
    .replace(/(?<![\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/gu, "$1") // _x_ 強調
    .replace(/`([^`]+)`/g, "$1") // `x` → x
    .trim();
}

/**
 * 先頭の番号プレフィクスを分離する。"00-overview" → { number: "00", rest: "overview" }。
 * number は元の桁を文字列として保持（先頭ゼロを失わない）。区切りが無ければ { rest: seg }。
 */
export function extractLeadingNumber(seg: string): { number?: string; rest: string } {
  const m = LEADING_NUMBER_RE.exec(seg);
  return m ? { number: m[1], rest: m[2] } : { rest: seg };
}

/** ファイル名（.md 除去済みベース）から先頭番号プレフィクスを剥がしたスラグ。 */
function slugFallback(fileBaseName: string): string {
  return fileBaseName.replace(/^\d+[-_ ]/, "");
}

/**
 * H1 由来タイトルの末尾から共通サフィックスを除去する（純粋・I/O なし・決定論的）。
 * - 末尾の空白を無視して末尾一致を判定する（"… AI SNSつくるくん" の前のスペース有無を吸収）。
 * - 複数該当時は「除去後が最短になる候補」= 最長サフィックスを採用する（最長一致）。
 * - 除去後が空/空白のみになる場合は除去しない（タイトル全体がサフィックスのケースを保護）。
 * - 1 回のみ適用する（除去後に再ループしない）。suffixes 未指定/空なら無変更。
 */
export function stripTitleSuffix(title: string, suffixes: string[] | undefined): string {
  if (!suffixes || suffixes.length === 0) return title;
  const tEnd = title.replace(/\s+$/, ""); // 末尾空白を無視した照合対象
  // 1) 最長一致を先に確定する（一致サフィックスの中で最長のもの = 除去後が最短になるもの）。
  let bestSuffix: string | undefined;
  for (const suffix of suffixes) {
    if (!suffix) continue;
    if (!tEnd.endsWith(suffix)) continue;
    if (bestSuffix === undefined || suffix.length > bestSuffix.length) bestSuffix = suffix;
  }
  if (bestSuffix === undefined) return title; // 一致なし
  // 2) 確定した最長サフィックスを 1 回だけ除去し、ガードを適用する（再ループしない）。
  const stripped = tEnd.slice(0, tEnd.length - bestSuffix.length).replace(/\s+$/, "");
  if (stripped.trim() === "") return title; // ガード: 除去後が空/空白のみなら原文を返す
  return stripped;
}

/**
 * Wiki ページ名を組み立てる純粋関数（I/O・警告なし・決定論的）。
 * @param relPath docs ルート相対の posix パス（.md を含む。例 "00-overview/00-executive-summary.md"）
 * @param h1 呼出側がファイル本文から抽出した H1（無ければ undefined）
 * @param naming 命名設定（未指定/旧設定なら fast path で relPath の .md 除去をそのまま返す）
 * @param _docsRoot 署名互換のための docs ルート相対パス（lookup では未使用）
 */
export function computePageName(
  relPath: string,
  h1: string | undefined,
  naming: DocsNamingConfig | undefined,
  _docsRoot?: string,
): string {
  const stripped = relPath.replace(/\.md$/, "");

  // 後方互換 fast path: naming 未指定、または fileSource=filename かつ numberPrefix=none
  const fileSource = naming?.fileSource ?? "filename";
  const numberPrefix = naming?.numberPrefix ?? "none";
  if (!naming || (fileSource === "filename" && numberPrefix === "none")) {
    return stripped; // 旧挙動とバイト一致
  }

  const segments = stripped.split("/");
  const lastIdx = segments.length - 1;
  const dirNames = naming.dirNames ?? {};
  const out: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const rawSeg = segments[i];
    if (i < lastIdx) {
      // ディレクトリセグメント
      const cumulative = segments.slice(0, i + 1).join("/");
      const { number, rest } = extractLeadingNumber(rawSeg);
      // dirNames の値が空/空白のみなら未設定扱い → 番号剥がしスラグへフォールバック（"NN /T" 等の破損回避）
      const mapped = dirNames[cumulative];
      const display = mapped != null && mapped.trim() !== "" ? mapped : rest;
      const withNumber = (numberPrefix === "dir" || numberPrefix === "all") && number != null ? `${number} ${display}` : display;
      out.push(withNumber);
    } else {
      // ファイルセグメント
      const { number } = extractLeadingNumber(rawSeg);
      // H1 由来の本文を使う場合のみ、番号再付与の前に末尾サフィックスを除去する。
      // slugFallback 経路（H1 無し）・fileSource:filename は対象外。
      const fileText =
        fileSource === "h1"
          ? h1 && h1.trim()
            ? stripTitleSuffix(h1.trim(), naming.stripTitleSuffix)
            : slugFallback(rawSeg)
          : slugFallback(rawSeg);
      const withNumber = numberPrefix === "all" && number != null ? `${number} ${fileText}` : fileText;
      out.push(withNumber);
    }
  }

  return out.join("/");
}
