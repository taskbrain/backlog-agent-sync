import { describe, it, expect } from "vitest";
import { convertMarkdown, type ConvertCtx } from "../src/docs/convert.js";
import type { VcsConfig } from "../src/types.js";

const vcs: VcsConfig = { kind: "github", owner: "o", repo: "r" };
const SHA = "a".repeat(40);
const pages = new Map([
  ["overview.md", "overview"],
  ["guide/setup.md", "guide/setup"],
  ["guide/advanced.md", "guide/advanced"],
]);

function ctx(over: Partial<ConvertCtx> = {}): ConvertCtx {
  return { selfRelDir: "", pageNameOf: (p) => pages.get(p), vcs, headSha: SHA, rule: "markdown", docsRootRel: "docs", ...over };
}

describe("convertMarkdown", () => {
  it("相対 .md リンクを [[ページ名]] へ変換する（./ と ../）", () => {
    const fromRoot = convertMarkdown("see [setup](guide/setup.md) and [o](./overview.md)", ctx());
    expect(fromRoot.content).toBe("see [[guide/setup]] and [[overview]]");
    const fromSub = convertMarkdown("see [adv](advanced.md) / [top](../overview.md)", ctx({ selfRelDir: "guide" }));
    expect(fromSub.content).toBe("see [[guide/advanced]] / [[overview]]");
  });

  it("フェンスコードブロック内は変換しない", () => {
    const md = ["before [s](guide/setup.md)", "```", "[s](guide/setup.md)", "```", "after [s](guide/setup.md)"].join("\n");
    const out = convertMarkdown(md, ctx());
    expect(out.content).toBe(["before [[guide/setup]]", "```", "[s](guide/setup.md)", "```", "after [[guide/setup]]"].join("\n"));
  });

  it("docs 外（リポジトリ内）のファイルは GitHub permalink（text 維持）", () => {
    const out = convertMarkdown("impl: [cli](../src/cli.ts)", ctx());
    expect(out.content).toBe(`impl: [cli](https://github.com/o/r/blob/${SHA}/src/cli.ts)`);
    expect(out.warnings).toEqual([]);
  });

  it("外部 URL / アンカー / mailto / 絶対パスは素通し", () => {
    const md = "[a](https://example.com) [b](#sec) [c](mailto:x@y.z) [d](/abs/path)";
    const out = convertMarkdown(md, ctx());
    expect(out.content).toBe(md);
    expect(out.warnings).toEqual([]);
  });

  it("画像の相対パスは permalink 化、vcs 無しは素通し + warning", () => {
    const withVcs = convertMarkdown("![diagram](assets/arch.png)", ctx());
    expect(withVcs.content).toBe(`![diagram](https://github.com/o/r/blob/${SHA}/docs/assets/arch.png)`);
    const noVcs = convertMarkdown("![diagram](assets/arch.png)", ctx({ vcs: undefined }));
    expect(noVcs.content).toBe("![diagram](assets/arch.png)"); // 素通し
    expect(noVcs.warnings.length).toBe(1);
  });

  it("同期対象外の .md は素通し + warning", () => {
    const out = convertMarkdown("[x](excluded/secret.md)", ctx());
    expect(out.content).toBe("[x](excluded/secret.md)");
    expect(out.warnings.some((w) => w.includes("同期対象外"))).toBe(true);
  });

  it("リポジトリ外への ../ は素通し + warning", () => {
    const out = convertMarkdown("[x](../../outside.md)", ctx({ selfRelDir: "" }));
    expect(out.content).toBe("[x](../../outside.md)");
    expect(out.warnings.some((w) => w.includes("リポジトリ外"))).toBe(true);
  });

  it("backlog 記法: 非 md リンクは [[text>url]]、Wiki リンクは同形 [[ページ名]]", () => {
    const out = convertMarkdown("[cli](../src/cli.ts) と [s](guide/setup.md)", ctx({ rule: "backlog" }));
    expect(out.content).toBe(`[[cli>https://github.com/o/r/blob/${SHA}/src/cli.ts]] と [[guide/setup]]`);
  });

  it("概要ソース（selfRelDir='..'）からは docs/ 配下を指すリンクが Wiki リンクになる", () => {
    const out = convertMarkdown("[setup](docs/guide/setup.md) / [src](src/cli.ts)", ctx({ selfRelDir: ".." }));
    expect(out.content).toBe(`[[guide/setup]] / [src](https://github.com/o/r/blob/${SHA}/src/cli.ts)`);
  });

  it(".md リンクのアンカーは破棄して警告する", () => {
    const out = convertMarkdown("[s](guide/setup.md#install)", ctx());
    expect(out.content).toBe("[[guide/setup]]");
    expect(out.warnings.some((w) => w.includes("アンカー"))).toBe(true);
  });
});
