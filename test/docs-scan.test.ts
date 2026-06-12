import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
});
