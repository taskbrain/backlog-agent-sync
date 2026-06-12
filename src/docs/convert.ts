import type { VcsConfig } from "../types.js";
import { fileUrl } from "../vcs/linker.js";

export interface ConvertCtx {
  /** 変換元ファイルの docs ルート相対ディレクトリ（ルート直下は ""。概要ソースは ".."） */
  selfRelDir: string;
  /** docs ルート相対パス → Wiki ページ名（同期対象のみ返す） */
  pageNameOf: (docsRelPath: string) => string | undefined;
  vcs?: VcsConfig;
  headSha?: string;
  rule: "markdown" | "backlog";
  /** docs ルートのリポジトリルート相対パス（既定 "docs"） */
  docsRootRel?: string;
}

const LINK_RE = /(!?)\[([^\]]*)\]\(([^)]+)\)/g;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i; // http: / https: / mailto: 等

/** posix パス正規化（"."/".." 解決。先頭に残る ".." はルート外）。 */
function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

function splitAnchor(url: string): { path: string; anchor: string } {
  const i = url.indexOf("#");
  return i >= 0 ? { path: url.slice(0, i), anchor: url.slice(i) } : { path: url, anchor: "" };
}

/**
 * インラインリンク/画像の相対パスを書き換える Markdown 変換。
 * - 同期対象の .md → Wiki ページリンク [[pageName]]（markdown / backlog 記法とも同形）
 * - docs 外のリポジトリ内ファイル → vcs+headSha があれば GitHub permalink（text 維持）
 * - 外部 URL / アンカー / 絶対パスは素通し。フェンスコードブロック内は不変換
 */
export function convertMarkdown(content: string, ctx: ConvertCtx): { content: string; warnings: string[] } {
  const warnings: string[] = [];
  const docsRoot = (ctx.docsRootRel ?? "docs").replace(/\/+$/, "");
  let inFence = false;

  const converted = content.split("\n").map((line) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    return line.replace(LINK_RE, (whole, bang: string, text: string, target: string) => {
      const rawUrl = target.trim().split(/\s+/)[0] ?? ""; // 末尾の "title" を除去
      if (!rawUrl || PROTOCOL_RE.test(rawUrl) || rawUrl.startsWith("#") || rawUrl.startsWith("/")) {
        return whole; // 外部 URL / ページ内アンカー / 絶対パスは素通し
      }
      const { path, anchor } = splitAnchor(rawUrl);
      if (!path) return whole;

      // リポジトリルート相対へ解決（docsRoot/selfRelDir 基準）
      const repoRel = normalizePosix([docsRoot, ctx.selfRelDir, path].filter(Boolean).join("/"));
      if (repoRel.startsWith("..")) {
        warnings.push(`リポジトリ外への相対リンクは変換できません（素通し）: ${rawUrl}`);
        return whole;
      }

      // docs 配下の .md → Wiki ページリンク
      if (!bang && repoRel.startsWith(`${docsRoot}/`) && repoRel.endsWith(".md")) {
        const docsRel = repoRel.slice(docsRoot.length + 1);
        const page = ctx.pageNameOf(docsRel);
        if (page) {
          if (anchor) warnings.push(`Wiki リンクはアンカーを保持できません（破棄）: ${rawUrl}`);
          return `[[${page}]]`; // backlog 記法でも [[text>page]] は不可のため同形
        }
        warnings.push(`同期対象外の .md へのリンクです（素通し）: ${rawUrl}`);
        return whole;
      }

      // docs 外（リポジトリ内）のファイル / 画像 → permalink
      if (ctx.vcs && ctx.headSha) {
        const url = fileUrl(ctx.vcs, repoRel, ctx.headSha);
        if (url) {
          const full = `${url}${anchor}`;
          if (bang) return ctx.rule === "backlog" ? full : `![${text}](${full})`; // backlog 記法の画像は裸 URL へフォールバック
          return ctx.rule === "backlog" ? `[[${text}>${full}]]` : `[${text}](${full})`;
        }
      }
      warnings.push(`リンク先を permalink 化できません（素通し）: ${rawUrl}`);
      return whole;
    });
  });

  return { content: converted.join("\n"), warnings };
}
