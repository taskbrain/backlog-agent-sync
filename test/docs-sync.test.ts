import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocsSync } from "../src/docs/sync.js";
import type { DocsLedger } from "../src/docs/ledger.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function memLedger(initial?: DocsLedger) {
  let saved: DocsLedger = initial ?? { version: 1, pages: {} };
  return {
    loadLedger: async () => JSON.parse(JSON.stringify(saved)) as DocsLedger,
    saveLedger: async (l: DocsLedger) => { saved = JSON.parse(JSON.stringify(l)) as DocsLedger; },
    get: () => saved,
  };
}

function restMock(wikis: Array<{ id: number; name: string }> = []) {
  let seq = 0;
  return {
    getWikis: vi.fn().mockResolvedValue(wikis),
    addWiki: vi.fn().mockImplementation(async (i: any) => ({ id: 1000 + ++seq, name: i.name })),
    updateWiki: vi.fn().mockResolvedValue(undefined),
    deleteWiki: vi.fn().mockResolvedValue(undefined),
    addDocument: vi.fn().mockImplementation(async (i: any) => ({ id: `d-${i.title}`, title: i.title })),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  };
}

const gitNone = { headSha: vi.fn().mockResolvedValue(undefined) } as any;

function makeDeps(rest: any, ledger: ReturnType<typeof memLedger>, over: Record<string, unknown> = {}) {
  return { rest, projectId: 7, git: gitNone, loadLedger: ledger.loadLedger, saveLedger: ledger.saveLedger, ...over } as any;
}

describe("runDocsSync（wiki backend）", () => {
  it("初回は create され、台帳に wikiId/hash が保存される", async () => {
    write("docs/a.md", "# A");
    write("docs/guide/b.md", "# B");
    write("README.md", "# R");
    const rest = restMock();
    const ledger = memLedger();
    const res = await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest, ledger));
    // 2 docs + 概要ページ
    expect(rest.addWiki).toHaveBeenCalledTimes(3);
    expect(rest.addWiki.mock.calls.map((c: any[]) => c[0].name).sort()).toEqual(["a", "guide/b", "プロジェクト概要"]);
    expect(res.created).toBe(3);
    const saved = ledger.get();
    expect(saved.pages["a.md"].wikiId).toBeTypeOf("number");
    expect(saved.pages["a.md"].hash).toBeTypeOf("string");
    expect(saved.pages["overview::README.md"]).toBeDefined(); // 概要は専用キー
  });

  it("再実行はハッシュ一致で全スキップ（API を呼ばない＝冪等）", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const ledger = memLedger();
    await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(restMock(), ledger));
    const rest2 = restMock();
    const res = await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest2, ledger));
    expect(rest2.addWiki).not.toHaveBeenCalled();
    expect(rest2.updateWiki).not.toHaveBeenCalled();
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(2); // a.md + 概要
  });

  it("変更されたページは台帳の wikiId で update される", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const ledger = memLedger();
    await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(restMock(), ledger));
    const savedId = ledger.get().pages["a.md"].wikiId;
    write("docs/a.md", "# A 改訂");
    const rest2 = restMock();
    const res = await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest2, ledger));
    expect(rest2.updateWiki).toHaveBeenCalledWith(savedId, expect.objectContaining({ name: "a", content: expect.stringContaining("改訂") }));
    expect(rest2.addWiki).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
  });

  it("台帳に無くてもリモート同名ページがあれば update（重複作成しない）", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const rest = restMock([{ id: 55, name: "a" }]);
    const res = await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest, memLedger()));
    expect(rest.updateWiki).toHaveBeenCalledWith(55, expect.objectContaining({ name: "a" }));
    expect(rest.addWiki.mock.calls.every((c: any[]) => c[0].name !== "a")).toBe(true);
    expect(res.updated).toBe(1);
  });

  it("重複 POST エラー時は辞書を再構築して PATCH へフォールバックする", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const rest = restMock();
    rest.getWikis = vi.fn()
      .mockResolvedValueOnce([]) // 起動時は見えない（直後に別経路で作成された想定）
      .mockResolvedValue([{ id: 66, name: "a" }, { id: 67, name: "プロジェクト概要" }]);
    rest.addWiki = vi.fn().mockRejectedValue(new Error("Backlog POST /wikis -> 400 duplicate"));
    const ledger = memLedger();
    const res = await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest, ledger));
    expect(rest.updateWiki).toHaveBeenCalledWith(66, expect.objectContaining({ name: "a" }));
    expect(res.updated).toBeGreaterThanOrEqual(1);
    expect(ledger.get().pages["a.md"].wikiId).toBe(66);
  });

  it("prune は opt-in。台帳管理下の消えたページのみ削除し、台帳外リモートページは不可侵", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const initial: DocsLedger = { version: 1, pages: { "gone.md": { name: "gone", wikiId: 77, hash: "x" } } };
    // 台帳外のリモートページ（手書き）が存在する状況
    const rest1 = restMock([{ id: 99, name: "手書きメモ" }, { id: 77, name: "gone" }]);
    const ledger1 = memLedger(JSON.parse(JSON.stringify(initial)));
    await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest1, ledger1)); // prune 無し
    expect(rest1.deleteWiki).not.toHaveBeenCalled();

    const rest2 = restMock([{ id: 99, name: "手書きメモ" }, { id: 77, name: "gone" }]);
    const ledger2 = memLedger(JSON.parse(JSON.stringify(initial)));
    const res = await runDocsSync({ repoRoot: dir, cfg: {}, prune: true }, makeDeps(rest2, ledger2));
    expect(rest2.deleteWiki).toHaveBeenCalledTimes(1);
    expect(rest2.deleteWiki).toHaveBeenCalledWith(77); // 台帳管理下のみ。99（台帳外）は不可侵
    expect(res.pruned).toBe(1);
    expect(ledger2.get().pages["gone.md"]).toBeUndefined();
  });

  it("dry-run は一切書き込まず preview を返す", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const rest = restMock();
    const ledger = memLedger({ version: 1, pages: { "gone.md": { name: "gone", wikiId: 77, hash: "x" } } });
    const res = await runDocsSync(
      { repoRoot: dir, cfg: {}, dryRun: true, prune: true },
      { rest, projectId: 7, git: gitNone, loadLedger: ledger.loadLedger } as any, // saveLedger 未注入
    );
    expect(rest.addWiki).not.toHaveBeenCalled();
    expect(rest.updateWiki).not.toHaveBeenCalled();
    expect(rest.deleteWiki).not.toHaveBeenCalled();
    expect(res.preview.filter((p) => p.action === "create").map((p) => p.pageName)).toContain("a");
    expect(res.preview.filter((p) => p.action === "prune").map((p) => p.pageName)).toContain("gone");
    expect(res.created).toBeGreaterThan(0); // 集計は dry-run でも算出
  });

  it("概要ページは変換結果 + ドキュメント一覧（階層 [[リンク]]）になる", async () => {
    write("docs/a.md", "# A");
    write("docs/guide/b.md", "# B");
    write("README.md", "概要です。 [a へ](docs/a.md)");
    const rest = restMock();
    await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest, memLedger()));
    const overviewCall = rest.addWiki.mock.calls.find((c: any[]) => c[0].name === "プロジェクト概要");
    const content = String(overviewCall![0].content);
    expect(content).toContain("[[a]]"); // 本文の相対 .md リンクも Wiki リンク化
    expect(content).toContain("## ドキュメント一覧");
    expect(content).toContain("- [[a]]");
    expect(content).toContain("- guide"); // ディレクトリ見出し
    expect(content).toContain("  - [[guide/b]]"); // 階層インデント
  });

  it("Home という名のページにはいかなる場合も書き込まない", async () => {
    write("docs/Home.md", "# 乗っ取り");
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const rest = restMock([{ id: 1, name: "Home" }]);
    const res = await runDocsSync({ repoRoot: dir, cfg: {} }, makeDeps(rest, memLedger()));
    expect(rest.addWiki.mock.calls.every((c: any[]) => c[0].name !== "Home")).toBe(true);
    expect(rest.updateWiki).not.toHaveBeenCalledWith(1, expect.anything());
    expect(res.warnings.some((w) => w.includes("Home"))).toBe(true);
  });
});

describe("runDocsSync（documents backend）", () => {
  it("初回はディレクトリ階層を親ドキュメントで再現して create する", async () => {
    write("docs/a.md", "# A");
    write("docs/guide/b.md", "# B");
    write("README.md", "# R");
    const rest = restMock();
    const ledger = memLedger();
    const res = await runDocsSync({ repoRoot: dir, cfg: {}, target: "documents" }, makeDeps(rest, ledger));
    const calls = rest.addDocument.mock.calls.map((c: any[]) => c[0]);
    expect(calls.find((c: any) => c.title === "guide")).toBeDefined(); // ディレクトリ親
    expect(calls.find((c: any) => c.title === "b")?.parentId).toBe("d-guide"); // 親子関係
    expect(calls.find((c: any) => c.title === "a")?.parentId).toBeUndefined();
    expect(calls.every((c: any) => c.title !== "プロジェクト概要")).toBe(true); // 概要は wiki のみ
    expect(res.created).toBe(3); // dir + 2 docs
    expect(ledger.get().pages["dir::guide"].documentId).toBe("d-guide");
    expect(ledger.get().pages["guide/b.md"].documentId).toBe("d-b");
  });

  it("変更は既定で警告のみ（create-only）。--recreate で削除→再作成し新 id を台帳へ", async () => {
    write("docs/a.md", "# A");
    write("README.md", "# R");
    const ledger = memLedger();
    await runDocsSync({ repoRoot: dir, cfg: {}, target: "documents" }, makeDeps(restMock(), ledger));
    write("docs/a.md", "# A 改訂");

    const rest2 = restMock();
    const res2 = await runDocsSync({ repoRoot: dir, cfg: {}, target: "documents" }, makeDeps(rest2, ledger));
    expect(rest2.deleteDocument).not.toHaveBeenCalled();
    expect(rest2.addDocument).not.toHaveBeenCalled();
    expect(res2.warnings.some((w) => w.includes("--recreate"))).toBe(true);

    const rest3 = restMock();
    const res3 = await runDocsSync({ repoRoot: dir, cfg: {}, target: "documents", recreate: true }, makeDeps(rest3, ledger));
    expect(rest3.deleteDocument).toHaveBeenCalledWith("d-a");
    expect(rest3.addDocument).toHaveBeenCalledWith(expect.objectContaining({ title: "a", content: expect.stringContaining("改訂") }));
    expect(res3.updated).toBe(1);
    expect(ledger.get().pages["a.md"].documentId).toBe("d-a"); // モックは同 id を返すが台帳が更新されている
    expect(ledger.get().pages["a.md"].hash).toBeTypeOf("string");
  });
});
