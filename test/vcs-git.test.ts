import { describe, it, expect, vi } from "vitest";
import { headSha, branchName, commitsBetween, isOnRemote, type GitExec } from "../src/vcs/git.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function execMock(result: string | undefined): GitExec {
  return vi.fn().mockResolvedValue(result);
}

describe("vcs/git（exec DI モック）", () => {
  it("headSha: 40桁hexのみ有効、失敗/不正出力は undefined", async () => {
    expect(await headSha("/repo", execMock(`${SHA_A}\n`))).toBe(SHA_A);
    expect(await headSha("/repo", execMock("HEAD\n"))).toBeUndefined(); // 不正出力
    expect(await headSha("/repo", execMock(undefined))).toBeUndefined(); // git 失敗
  });

  it("branchName: trim して返す。失敗は undefined", async () => {
    expect(await branchName("/repo", execMock("main\n"))).toBe("main");
    expect(await branchName("/repo", execMock(undefined))).toBeUndefined();
  });

  it("commitsBetween: rev-list --format 出力（commit 行 + sha\\t件名）をパースする", async () => {
    const out = [
      `commit ${SHA_A}`,
      `${SHA_A}\tfix: バグ修正`,
      `commit ${SHA_B}`,
      `${SHA_B}\tfeat: 機能追加`,
      "",
    ].join("\n");
    const exec = execMock(out);
    const res = await commitsBetween("/repo", "c".repeat(40), exec);
    expect(res.commits).toEqual([
      { sha: SHA_A, subject: "fix: バグ修正" },
      { sha: SHA_B, subject: "feat: 機能追加" },
    ]);
    expect(res.reason).toBeUndefined();
    expect(exec).toHaveBeenCalledWith("/repo", ["rev-list", "--format=%H%x09%s", `${"c".repeat(40)}..HEAD`]);
  });

  it("commitsBetween: fromSha 不在/到達不能（rev-list 失敗）は空配列 + reason", async () => {
    const res = await commitsBetween("/repo", "dead".repeat(10), execMock(undefined));
    expect(res.commits).toEqual([]);
    expect(res.reason).toBeTruthy();
  });

  it("isOnRemote: リモート追跡ブランチが1つでもあれば true", async () => {
    expect(await isOnRemote("/repo", SHA_A, execMock("  origin/main\n"))).toBe(true);
    expect(await isOnRemote("/repo", SHA_A, execMock("\n"))).toBe(false); // どこにも含まれない
    expect(await isOnRemote("/repo", SHA_A, execMock(undefined))).toBe(false); // git 失敗
  });
});
