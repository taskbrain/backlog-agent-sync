import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface DocsLedgerEntry {
  name: string; // Wiki ページ名 / Document タイトル（dir:: はディレクトリパス）
  wikiId?: number;
  documentId?: string | number;
  hash?: string; // 変換後 content の sha256
}

/**
 * docs 同期台帳。pages のキーは docs ルート相対パス。
 * 特殊キー: `dir::<dirPath>`（documents の親ドキュメント）/ `overview::<source>`（概要ページ）。
 */
export interface DocsLedger { version: number; pages: Record<string, DocsLedgerEntry>; }

export function emptyDocsLedger(): DocsLedger {
  return { version: 1, pages: {} };
}

/** docs-ledger を読む。ファイル無し/破損/不正形式は空台帳として扱う。 */
export async function loadDocsLedger(path: string): Promise<DocsLedger> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<DocsLedger>;
    if (!raw || typeof raw !== "object" || typeof raw.pages !== "object" || raw.pages === null) return emptyDocsLedger();
    return { version: raw.version ?? 1, pages: raw.pages };
  } catch {
    return emptyDocsLedger();
  }
}

/** 原子的書込: 一意な temp に書いて rename（seed/ledger.ts と同手法）。 */
export async function saveDocsLedger(path: string, ledger: DocsLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
  await rename(tmp, path);
}
