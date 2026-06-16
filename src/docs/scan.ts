import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DocsSyncConfig } from "../types.js";
import { computePageName, extractH1 } from "./naming.js";

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

/**
 * 衝突した素ページ名に対し、未使用の連番識別子を返す（決定論的）。
 * `name (2)`, `name (3)`, … と空きを順に探し最初の空きを返す。連番が尽きる（実質到達不能）場合の
 * 最終フォールバックとして `name (relPath)` を返す（relPath は一意なので必ず空く）。
 */
function nextFreeName(rawName: string, relPath: string, used: Set<string>): string {
  for (let i = 2; i < 1000; i++) {
    const candidate = `${rawName} (${i})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${rawName} (${relPath})`; // 最終フォールバック（relPath は走査内で一意）
}

/**
 * docs ルート相対の Markdown 群を Backlog Wiki/Document へ同期するためにスキャンする。
 * @param repoRoot リポジトリルート絶対パス
 * @param cfg docsSync 設定（root/exclude/maxFileKb/naming/overview*）
 * @param stableKeys 既存ページの安定キー集合（台帳キー = docs ルート相対 relPath）。
 *   衝突時、ここに含まれる relPath の素ページ名を優先確保し、新規（非安定）ファイルへ連番を回す。
 *   undefined のときは S-1 と同じ挙動（走査順=localeCompare 順の先頭が素名・以降は連番）。
 */
export async function scanDocs(repoRoot: string, cfg: DocsSyncConfig, stableKeys?: Set<string>): Promise<ScanResult> {
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

  // ---- Pass 1: フィルタ（exclude/サイズ/読み取り）を通過したファイルの素ページ名を走査順で収集 ----
  interface FileRecord { rel: string; abs: string; rawPageName: string; bytes: number; }
  const records: FileRecord[] = [];
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
    // サイズ確認後に本文を読む（H1 抽出。超過ファイルは読まない）。読み取り失敗は走査を止めずスキップ
    let content: string;
    try {
      content = await readFile(f.abs, "utf8");
    } catch {
      skipped.push({ relPath: f.rel, reason: "読み取り不可" });
      continue;
    }
    const h1 = extractH1(content);
    if (cfg.naming?.fileSource === "h1" && h1 === undefined) {
      warnings.push(`H1 見出しが見つからないためファイル名から命名: ${f.rel}`); // ファイルごと 1 回
    }
    const rawPageName = computePageName(f.rel, h1, cfg.naming, rootRel);
    records.push({ rel: f.rel, abs: f.abs, rawPageName, bytes });
  }

  // ---- Pass 2: 最終ページ名の割り当て（安定キーが衝突時に素名を確保し走査順を上書きする） ----
  // 素名 → 最初の安定メンバー（複数あれば走査順で先頭）。素名予約に使う。
  const stableOwner = new Map<string, FileRecord>();
  if (stableKeys) {
    for (const r of records) {
      if (stableKeys.has(r.rel) && !stableOwner.has(r.rawPageName)) stableOwner.set(r.rawPageName, r);
    }
  }
  const usedPageNames = new Set<string>();
  for (const r of records) {
    const raw = r.rawPageName;
    const owner = stableOwner.get(raw);
    let pageName: string;
    if (owner === r) {
      // 安定メンバー: 素名を確保（事前予約相当。owner は素名群で唯一なので必ず空く）
      pageName = raw;
    } else if (!usedPageNames.has(raw) && (owner === undefined)) {
      // 安定 owner が居ない素名で、まだ未使用 → 走査順先頭が素名を取る（S-1 と同じ）
      pageName = raw;
    } else {
      // 既出、または安定 owner に素名を予約されている → 連番識別子を付与
      const candidate = nextFreeName(raw, r.rel, usedPageNames);
      warnings.push(`ページ名が衝突したため識別子を付与: ${raw} → ${candidate}`);
      pageName = candidate;
    }
    usedPageNames.add(pageName);

    // 行頭が「[」のページ名は Backlog がタグとして解釈する副作用がある（最終名で判定）
    if (pageName.startsWith("[")) {
      warnings.push(`ページ名が「[」で始まるため Backlog のタグとして解釈されます: ${pageName}`);
    }
    docs.push({ absPath: r.abs, relPath: r.rel, pageName, bytes: r.bytes });
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
