import { describe, it, expect } from "vitest";
import { fileUrl, commitUrl, prUrl, repoUrl } from "../src/vcs/linker.js";
import type { VcsConfig } from "../src/types.js";

const gh: VcsConfig = { kind: "github", owner: "o", repo: "r" };
const bl: VcsConfig = { kind: "backlog", webBase: "https://xx.backlog.jp", projectKey: "PROJ", repoName: "repo" };
const generic: VcsConfig = { kind: "generic" };
const sha = "a".repeat(40);

describe("linker", () => {
  it("github: blob/commit/pull/リポジトリの URL を生成する", () => {
    expect(repoUrl(gh)).toBe("https://github.com/o/r");
    expect(fileUrl(gh, "src/foo.ts", sha)).toBe(`https://github.com/o/r/blob/${sha}/src/foo.ts`);
    expect(fileUrl(gh, "src/foo.ts", sha, { start: 10 })).toBe(`https://github.com/o/r/blob/${sha}/src/foo.ts#L10`);
    expect(fileUrl(gh, "src/foo.ts", sha, { start: 10, end: 20 })).toBe(`https://github.com/o/r/blob/${sha}/src/foo.ts#L10-L20`);
    expect(commitUrl(gh, sha)).toBe(`https://github.com/o/r/commit/${sha}`);
    expect(prUrl(gh, 12)).toBe("https://github.com/o/r/pull/12");
  });

  it("backlog: Web UI 形式（gitb 由来）の URL を生成する", () => {
    expect(repoUrl(bl)).toBe("https://xx.backlog.jp/git/PROJ/repo");
    expect(fileUrl(bl, "src/foo.ts", sha)).toBe(`https://xx.backlog.jp/git/PROJ/repo/blob/${sha}/src/foo.ts`);
    expect(commitUrl(bl, sha)).toBe(`https://xx.backlog.jp/git/PROJ/repo/commit/${sha}`);
    expect(prUrl(bl, 12)).toBe("https://xx.backlog.jp/git/PROJ/repo/pullRequests/12");
  });

  it("generic は undefined を返す", () => {
    expect(repoUrl(generic)).toBeUndefined();
    expect(fileUrl(generic, "a.ts", sha)).toBeUndefined();
    expect(commitUrl(generic, sha)).toBeUndefined();
    expect(prUrl(generic, 1)).toBeUndefined();
  });

  it("パスはセグメント毎に URL エンコードする", () => {
    expect(fileUrl(gh, "docs/日本語 メモ.md", sha)).toBe(
      `https://github.com/o/r/blob/${sha}/${encodeURIComponent("docs")}/${encodeURIComponent("日本語 メモ.md")}`,
    );
  });

  it("必須情報が欠けていれば undefined（不完全な設定に耐える）", () => {
    expect(fileUrl({ kind: "github" }, "a.ts", sha)).toBeUndefined();
    expect(commitUrl({ kind: "backlog", webBase: "https://xx.backlog.jp" }, sha)).toBeUndefined();
  });
});
