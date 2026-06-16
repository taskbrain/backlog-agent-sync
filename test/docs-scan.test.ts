import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDocs } from "../src/docs/scan.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("scanDocs", () => {
  it("*.md を再帰列挙し relPath(posix)/pageName(.md除去) を返す", async () => {
    write("docs/overview.md", "# o");
    write("docs/guide/setup.md", "# s");
    write("docs/guide/note.txt", "not md"); // md 以外は対象外
    write("README.md", "# readme");
    const res = await scanDocs(dir, {});
    expect(res.docs.map((d) => d.relPath)).toEqual(["guide/setup.md", "overview.md"]); // 名前順で決定論的
    expect(res.docs.map((d) => d.pageName)).toEqual(["guide/setup", "overview"]);
    expect(res.overview?.pageName).toBe("プロジェクト概要"); // 既定
    expect(res.overview?.relPath).toBe("README.md");
  });

  it("exclude は root 相対の前方一致でスキップする", async () => {
    write("docs/keep.md", "# k");
    write("docs/superpowers/research/x.md", "# x");
    write("README.md", "# r");
    const res = await scanDocs(dir, { exclude: ["superpowers/research/"] });
    expect(res.docs.map((d) => d.relPath)).toEqual(["keep.md"]);
    expect(res.skipped).toEqual([{ relPath: "superpowers/research/x.md", reason: "exclude 設定に一致" }]);
  });

  it("maxFileKb 超過は理由つきでスキップする", async () => {
    write("docs/big.md", "x".repeat(2048));
    write("docs/small.md", "# s");
    write("README.md", "# r");
    const res = await scanDocs(dir, { maxFileKb: 1 });
    expect(res.docs.map((d) => d.relPath)).toEqual(["small.md"]);
    expect(res.skipped[0].relPath).toBe("big.md");
    expect(res.skipped[0].reason).toContain("サイズ超過");
  });

  it("「[」で始まるページ名は警告する（Backlog タグ解釈の副作用）", async () => {
    write("docs/[draft] plan.md", "# d");
    write("README.md", "# r");
    const res = await scanDocs(dir, {});
    expect(res.warnings.some((w) => w.includes("[draft] plan"))).toBe(true);
    expect(res.docs.length).toBe(1); // スキップはしない（警告のみ）
  });

  it("overviewPage=Home は不可侵のため概要をスキップして警告する", async () => {
    write("docs/a.md", "# a");
    write("README.md", "# r");
    const res = await scanDocs(dir, { overviewPage: "Home" });
    expect(res.overview).toBeUndefined();
    expect(res.warnings.some((w) => w.includes("Home"))).toBe(true);
  });

  it("overviewSource が無ければ警告して overview なし", async () => {
    write("docs/a.md", "# a");
    const res = await scanDocs(dir, { overviewSource: "MISSING.md" });
    expect(res.overview).toBeUndefined();
    expect(res.warnings.some((w) => w.includes("MISSING.md"))).toBe(true);
  });

  it("同名ページ名の衝突は (2)(3)… の連番識別子で解消する（S-1）", async () => {
    write("docs/sec/a.md", "# 重複");
    write("docs/sec/b.md", "# 重複");
    write("docs/sec/c.md", "# 重複");
    write("README.md", "# r");
    const cfg = { naming: { fileSource: "h1" as const, numberPrefix: "none" as const, dirNames: { sec: "セクション" } } };
    const res = await scanDocs(dir, cfg);
    // 走査順 a,b,c。先頭は素の名、後続は (2)(3) を付与
    const byRel = new Map(res.docs.map((d) => [d.relPath, d.pageName]));
    expect(byRel.get("sec/a.md")).toBe("セクション/重複");
    expect(byRel.get("sec/b.md")).toBe("セクション/重複 (2)");
    expect(byRel.get("sec/c.md")).toBe("セクション/重複 (3)");
    expect(res.warnings.some((w) => w.includes("ページ名が衝突"))).toBe(true);
  });

  it("stableKeys のメンバーは衝突時に素の名前を保持し、新規ファイルが連番を受ける（S-2）", async () => {
    write("docs/sec/a.md", "# 重複"); // 走査順で先（localeCompare）。stableKeys に含まれない新規ファイル
    write("docs/sec/z.md", "# 重複"); // 走査順で後だが既存（stableKeys メンバー）
    write("README.md", "# r");
    const cfg = { naming: { fileSource: "h1" as const, numberPrefix: "none" as const, dirNames: { sec: "セクション" } } };
    const res = await scanDocs(dir, cfg, new Set(["sec/z.md"]));
    const byRel = new Map(res.docs.map((d) => [d.relPath, d.pageName]));
    // 走査順では a が先だが、安定キー z が素の名前を確保する（スキャン順を上書き）
    expect(byRel.get("sec/z.md")).toBe("セクション/重複");
    expect(byRel.get("sec/a.md")).toBe("セクション/重複 (2)");
  });

  // root 実行ではパーミッションビットが無視され読み取りが成功してしまうため、その場合のみスキップ
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(isRoot)("本文の読み取りに失敗したファイルは理由つきでスキップし、走査は継続する", async () => {
    write("docs/ok.md", "# ok");
    write("docs/locked.md", "# secret");
    write("README.md", "# r");
    chmodSync(join(dir, "docs/locked.md"), 0o000); // 読み取り不可にする
    try {
      const res = await scanDocs(dir, {});
      // 読めるファイルは同期対象に残る（走査は中断しない）
      expect(res.docs.map((d) => d.relPath)).toEqual(["ok.md"]);
      expect(res.skipped).toContainEqual({ relPath: "locked.md", reason: "読み取り不可" });
    } finally {
      chmodSync(join(dir, "docs/locked.md"), 0o644); // afterEach の rm のため権限を戻す
    }
  });
});
