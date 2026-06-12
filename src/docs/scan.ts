import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DocsSyncConfig } from "../types.js";

export interface ScannedDoc {
  absPath: string;
  relPath: string; // docs ルート相対（概要は リポジトリルート相対）・posix 区切り
  pageName: string; // .md 除去（"/" 区切りで Wiki ツリー表示になる）
  bytes: number;
}
export interface SkippedDoc { relPath: string; reason: string; }
export interface ScanResult {
  docs: ScannedDoc[];
  /** 概要ページ（overviewSource。リポジトリルート相対の別エントリ・pageName=overviewPage） */
  overview?: ScannedDoc;
  skipped: SkippedDoc[];
  warnings: string[];
}

export const DEFAULT_DOCS_ROOT = "docs";
const DEFAULT_MAX_KB = 100;
const DEFAULT_OVERVIEW_SOURCE = "README.md";
const DEFAULT_OVERVIEW_PAGE = "プロジェクト概要";
const HOME_PAGE = "Home";

/** node:fs の再帰走査（依存追加なし）。relPath は posix 区切り・名前順で決定論的。 */
async function walk(dirAbs: string, rel: string, out: Array<{ rel: string; abs: string }>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // ディレクトリ無し/権限なしは空扱い（呼出側で警告）
  }
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dirAbs, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(abs, r, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push({ rel: r, abs });
  }
}

export async function scanDocs(repoRoot: string, cfg: DocsSyncConfig): Promise<ScanResult> {
  const rootRel = (cfg.root ?? DEFAULT_DOCS_ROOT).replace(/\/+$/, "");
  const exclude = cfg.exclude ?? [];
  const maxKb = cfg.maxFileKb ?? DEFAULT_MAX_KB;
  const maxBytes = maxKb * 1024;
  const warnings: string[] = [];
  const skipped: SkippedDoc[] = [];
  const docs: ScannedDoc[] = [];

  const files: Array<{ rel: string; abs: string }> = [];
  await walk(join(repoRoot, rootRel), "", files);
  if (files.length === 0) warnings.push(`同期対象が見つかりません: ${rootRel}/**/*.md`);

  for (const f of files) {
    if (exclude.some((p) => f.rel.startsWith(p))) {
      skipped.push({ relPath: f.rel, reason: "exclude 設定に一致" });
      continue;
    }
    let bytes: number;
    try {
      bytes = (await stat(f.abs)).size;
    } catch {
      skipped.push({ relPath: f.rel, reason: "読み取り不可" });
      continue;
    }
    if (bytes > maxBytes) {
      skipped.push({ relPath: f.rel, reason: `サイズ超過（${Math.ceil(bytes / 1024)}KB > ${maxKb}KB）` });
      continue;
    }
    const pageName = f.rel.replace(/\.md$/, "");
    // 行頭が「[」のページ名は Backlog がタグとして解釈する副作用がある
    if (pageName.startsWith("[")) {
      warnings.push(`ページ名が「[」で始まるため Backlog のタグとして解釈されます: ${pageName}`);
    }
    docs.push({ absPath: f.abs, relPath: f.rel, pageName, bytes });
  }

  // 概要ページ（リポジトリルート相対の別エントリ）
  let overview: ScannedDoc | undefined;
  const src = cfg.overviewSource ?? DEFAULT_OVERVIEW_SOURCE;
  const page = cfg.overviewPage ?? DEFAULT_OVERVIEW_PAGE;
  if (page === HOME_PAGE) {
    warnings.push("overviewPage に Home は指定できません（ユーザー手書きページのため不可侵）。概要ページをスキップします。");
  } else {
    const abs = join(repoRoot, src);
    try {
      const s = await stat(abs);
      if (s.size > maxBytes) {
        warnings.push(`概要ソースがサイズ超過のためスキップ: ${src}`);
      } else {
        overview = { absPath: abs, relPath: src, pageName: page, bytes: s.size };
      }
    } catch {
      warnings.push(`概要ソースが見つかりません: ${src}`);
    }
  }

  return { docs, overview, skipped, warnings };
}
