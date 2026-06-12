import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DocsSyncConfig, TextFormattingRule, VcsConfig } from "../types.js";
import type { BacklogRest } from "../tracker/backlog-rest.js";
import type { GitOps } from "../vcs/git.js";
import { defaultGitOps } from "../vcs/git.js";
import { renderer, type MarkupRenderer } from "../markup.js";
import { scanDocs, DEFAULT_DOCS_ROOT, type ScannedDoc } from "./scan.js";
import { convertMarkdown } from "./convert.js";
import type { DocsLedger } from "./ledger.js";

export type DocsRest = Pick<BacklogRest, "getWikis" | "addWiki" | "updateWiki" | "deleteWiki" | "addDocument" | "deleteDocument">;

export interface DocsSyncDeps {
  rest: DocsRest;
  projectId: number;
  textFormattingRule?: TextFormattingRule;
  vcs?: VcsConfig;
  git?: GitOps; // headSha 用 DI（無ければ実 git）
  loadLedger: () => Promise<DocsLedger>;
  /** dry-run では未注入（書込なし保証） */
  saveLedger?: (ledger: DocsLedger) => Promise<void>;
  /** テスト DI（既定 fs.readFile） */
  readFile?: (absPath: string) => Promise<string>;
}

export interface DocsSyncOptions {
  repoRoot: string;
  cfg: DocsSyncConfig;
  dryRun?: boolean;
  prune?: boolean;
  recreate?: boolean;
  /** cfg.target の上書き（CLI --target） */
  target?: "wiki" | "documents";
}

export interface SyncPreviewRow { action: "create" | "update" | "skip" | "prune" | "warn"; pageName: string; relPath?: string; }
export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  pruned: number;
  warnings: string[];
  preview: SyncPreviewRow[];
}

const HOME_PAGE = "Home"; // ユーザー手書きページ。いかなる場合も書き込まない

interface Prepared { doc: ScannedDoc; ledgerKey: string; content: string; hash: string; }

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const msg = (e: unknown): string => String(e instanceof Error ? e.message : e);

/** 「## ドキュメント一覧」: 同期ページの [[リンク]] を階層箇条書きで。 */
export function buildDocsToc(docs: ScannedDoc[], md: MarkupRenderer): string {
  const lines = [md.heading(2, "ドキュメント一覧")];
  const seenDirs = new Set<string>();
  for (const d of [...docs].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const segs = d.pageName.split("/");
    for (let i = 0; i < segs.length - 1; i++) {
      const dir = segs.slice(0, i + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        lines.push(`${"  ".repeat(i)}- ${segs[i]}`);
      }
    }
    lines.push(`${"  ".repeat(segs.length - 1)}- [[${d.pageName}]]`);
  }
  return lines.join("\n");
}

export async function runDocsSync(opts: DocsSyncOptions, deps: DocsSyncDeps): Promise<SyncResult> {
  const res: SyncResult = { created: 0, updated: 0, skipped: 0, pruned: 0, warnings: [], preview: [] };
  const cfg = opts.cfg ?? {};
  const target = opts.target ?? cfg.target ?? "wiki";
  const docsRootRel = (cfg.root ?? DEFAULT_DOCS_ROOT).replace(/\/+$/, "");

  // プリフライト: 記法。markdown 以外なら警告し、変換 rule を切り替える
  const rule: "markdown" | "backlog" = deps.textFormattingRule === "backlog" ? "backlog" : "markdown";
  if (deps.textFormattingRule && deps.textFormattingRule !== "markdown") {
    res.warnings.push(`プロジェクトの記法が markdown ではありません（${deps.textFormattingRule}）。リンクを ${deps.textFormattingRule} 記法で生成します。`);
  }

  const scan = await scanDocs(opts.repoRoot, cfg);
  res.warnings.push(...scan.warnings);
  for (const s of scan.skipped) {
    res.skipped++;
    res.preview.push({ action: "skip", pageName: s.relPath, relPath: s.relPath });
    res.warnings.push(`スキップ: ${s.relPath}（${s.reason}）`);
  }

  const ledger = await deps.loadLedger();
  const git = deps.git ?? defaultGitOps;
  const headSha = await git.headSha(opts.repoRoot);
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const md = renderer(rule);
  const pageNames = new Map(scan.docs.map((d) => [d.relPath, d.pageName]));
  const pageNameOf = (rel: string) => pageNames.get(rel);

  // 変換 + ハッシュ（preview / dry-run / 両 backend 共用）
  const prepared: Prepared[] = [];
  for (const doc of scan.docs) {
    const selfRelDir = doc.relPath.includes("/") ? doc.relPath.slice(0, doc.relPath.lastIndexOf("/")) : "";
    const conv = convertMarkdown(await read(doc.absPath), { selfRelDir, pageNameOf, vcs: deps.vcs, headSha, rule, docsRootRel });
    res.warnings.push(...conv.warnings.map((w) => `${doc.relPath}: ${w}`));
    prepared.push({ doc, ledgerKey: doc.relPath, content: conv.content, hash: sha256(conv.content) });
  }

  // 概要ページ（wiki backend のみ。documents は Wiki リンクが意味を持たないため対象外）
  if (target === "wiki" && scan.overview) {
    // 概要ソースはリポジトリルートにあるため selfRelDir=".."（docsRoot/../x = x）で解決する
    const conv = convertMarkdown(await read(scan.overview.absPath), { selfRelDir: "..", pageNameOf, vcs: deps.vcs, headSha, rule, docsRootRel });
    res.warnings.push(...conv.warnings.map((w) => `${scan.overview!.relPath}: ${w}`));
    const content = `${conv.content}\n\n${buildDocsToc(scan.docs, md)}`;
    prepared.push({ doc: scan.overview, ledgerKey: `overview::${scan.overview.relPath}`, content, hash: sha256(content) });
  }

  if (target === "wiki") {
    await syncWiki(opts, deps, res, prepared, ledger);
  } else {
    await syncDocuments(opts, deps, res, prepared, ledger);
  }
  return res;
}

async function syncWiki(opts: DocsSyncOptions, deps: DocsSyncDeps, res: SyncResult, prepared: Prepared[], ledger: DocsLedger): Promise<void> {
  // name → id 辞書（起動時 1 回。dry-run でも参照のみなので可）
  let dict: Map<string, number>;
  const buildDict = async () => new Map((await deps.rest.getWikis(deps.projectId)).map((w) => [w.name, w.id]));
  try {
    dict = await buildDict();
  } catch (e) {
    res.warnings.push(`Wiki 一覧の取得に失敗しました（台帳のみで照合します）: ${msg(e)}`);
    dict = new Map();
  }

  for (const p of prepared) {
    const pageName = p.doc.pageName;
    if (pageName === HOME_PAGE) {
      res.warnings.push(`Home はユーザー手書きページのため書き込みません: ${p.doc.relPath}`);
      res.preview.push({ action: "warn", pageName, relPath: p.doc.relPath });
      continue;
    }
    const entry = ledger.pages[p.ledgerKey];
    if (entry && entry.hash === p.hash) {
      res.skipped++;
      res.preview.push({ action: "skip", pageName, relPath: p.doc.relPath });
      continue;
    }
    // 既存検出: 台帳優先 → name 辞書
    const known = entry?.wikiId ?? dict.get(pageName);
    res.preview.push({ action: known != null ? "update" : "create", pageName, relPath: p.doc.relPath });
    if (opts.dryRun) {
      if (known != null) res.updated++;
      else res.created++;
      continue;
    }
    try {
      let wikiId = known;
      if (wikiId != null) {
        await deps.rest.updateWiki(wikiId, { name: pageName, content: p.content });
        res.updated++;
      } else {
        try {
          wikiId = (await deps.rest.addWiki({ projectId: deps.projectId, name: pageName, content: p.content })).id;
          res.created++;
        } catch (e) {
          // 重複 POST（既存同名ページ等）→ 辞書再構築 → PATCH フォールバック
          dict = await buildDict();
          const dupId = dict.get(pageName);
          if (dupId == null) throw e;
          await deps.rest.updateWiki(dupId, { name: pageName, content: p.content });
          wikiId = dupId;
          res.updated++;
        }
      }
      ledger.pages[p.ledgerKey] = { name: pageName, wikiId, hash: p.hash };
      if (deps.saveLedger) await deps.saveLedger(ledger); // 1 件ごと即保存（中断耐性）
    } catch (e) {
      res.warnings.push(`書込失敗: ${pageName}（${msg(e)}）`);
    }
  }

  // prune（opt-in）: 台帳にあるがローカルに無いページのみ。台帳管理外のリモートページと Home は不可侵
  if (opts.prune) {
    const localKeys = new Set(prepared.map((p) => p.ledgerKey));
    for (const [key, entry] of Object.entries(ledger.pages)) {
      if (key.startsWith("dir::") || localKeys.has(key)) continue;
      if (entry.wikiId == null || entry.name === HOME_PAGE) continue;
      res.preview.push({ action: "prune", pageName: entry.name, relPath: key });
      if (opts.dryRun) {
        res.pruned++;
        continue;
      }
      try {
        await deps.rest.deleteWiki(entry.wikiId);
        delete ledger.pages[key];
        if (deps.saveLedger) await deps.saveLedger(ledger);
        res.pruned++;
      } catch (e) {
        res.warnings.push(`prune 失敗: ${entry.name}（${msg(e)}）`);
      }
    }
  }
}

async function syncDocuments(opts: DocsSyncOptions, deps: DocsSyncDeps, res: SyncResult, prepared: Prepared[], ledger: DocsLedger): Promise<void> {
  res.warnings.push("documents には更新 API が無いため、変更の反映は --recreate（削除→再作成・URL 変動）のみです。");

  // ディレクトリ階層の親ドキュメントを浅い順に確保（台帳キー: dir::<dirPath>）
  const dirs = new Set<string>();
  for (const p of prepared) {
    const segs = p.doc.pageName.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  const dirId = new Map<string, string | number>();
  for (const dir of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    const key = `dir::${dir}`;
    const existing = ledger.pages[key]?.documentId;
    if (existing != null) {
      dirId.set(dir, existing);
      continue;
    }
    res.preview.push({ action: "create", pageName: `${dir}/`, relPath: key });
    if (opts.dryRun) {
      res.created++;
      continue;
    }
    try {
      const parent = dir.includes("/") ? dirId.get(dir.slice(0, dir.lastIndexOf("/"))) : undefined;
      const ref = await deps.rest.addDocument({
        projectId: deps.projectId,
        title: dir.split("/").pop() ?? dir,
        content: "",
        ...(parent != null ? { parentId: parent } : {}),
        addLast: true,
      });
      dirId.set(dir, ref.id);
      ledger.pages[key] = { name: dir, documentId: ref.id };
      if (deps.saveLedger) await deps.saveLedger(ledger);
      res.created++;
    } catch (e) {
      res.warnings.push(`ディレクトリ作成失敗: ${dir}（${msg(e)}）`);
    }
  }

  const createDoc = async (p: Prepared): Promise<void> => {
    const parent = p.doc.pageName.includes("/") ? dirId.get(p.doc.pageName.slice(0, p.doc.pageName.lastIndexOf("/"))) : undefined;
    const ref = await deps.rest.addDocument({
      projectId: deps.projectId,
      title: p.doc.pageName.split("/").pop() ?? p.doc.pageName,
      content: p.content,
      ...(parent != null ? { parentId: parent } : {}),
      addLast: true,
    });
    ledger.pages[p.ledgerKey] = { name: p.doc.pageName, documentId: ref.id, hash: p.hash };
    if (deps.saveLedger) await deps.saveLedger(ledger);
  };

  for (const p of prepared) {
    const entry = ledger.pages[p.ledgerKey];
    if (entry?.documentId != null) {
      if (entry.hash === p.hash) {
        res.skipped++;
        res.preview.push({ action: "skip", pageName: p.doc.pageName, relPath: p.doc.relPath });
        continue;
      }
      if (!opts.recreate) {
        // 既定は create-only: 変更検出は警告表示のみ
        res.warnings.push(`変更を検出しましたが documents は更新できません（--recreate で削除→再作成・URL 変動）: ${p.doc.pageName}`);
        res.preview.push({ action: "warn", pageName: p.doc.pageName, relPath: p.doc.relPath });
        continue;
      }
      res.preview.push({ action: "update", pageName: p.doc.pageName, relPath: p.doc.relPath });
      if (opts.dryRun) {
        res.updated++;
        continue;
      }
      try {
        await deps.rest.deleteDocument(entry.documentId);
        await createDoc(p); // 新しい id が台帳へ入る
        res.updated++;
      } catch (e) {
        res.warnings.push(`再作成失敗: ${p.doc.pageName}（${msg(e)}）`);
      }
      continue;
    }
    res.preview.push({ action: "create", pageName: p.doc.pageName, relPath: p.doc.relPath });
    if (opts.dryRun) {
      res.created++;
      continue;
    }
    try {
      await createDoc(p);
      res.created++;
    } catch (e) {
      res.warnings.push(`作成失敗: ${p.doc.pageName}（${msg(e)}）`);
    }
  }

  // prune（opt-in）: 台帳管理下のページのみ。dir:: は子の有無が追えないため対象外
  if (opts.prune) {
    const localKeys = new Set(prepared.map((p) => p.ledgerKey));
    for (const [key, entry] of Object.entries(ledger.pages)) {
      if (key.startsWith("dir::") || localKeys.has(key)) continue;
      if (entry.documentId == null) continue;
      res.preview.push({ action: "prune", pageName: entry.name, relPath: key });
      if (opts.dryRun) {
        res.pruned++;
        continue;
      }
      try {
        await deps.rest.deleteDocument(entry.documentId);
        delete ledger.pages[key];
        if (deps.saveLedger) await deps.saveLedger(ledger);
        res.pruned++;
      } catch (e) {
        res.warnings.push(`prune 失敗: ${entry.name}（${msg(e)}）`);
      }
    }
  }
}
