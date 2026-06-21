import { describe, it, expect, vi } from "vitest";
import { isToolComment, cleanupToolComments, type CleanupDeps } from "../src/issue/cleanup.js";
import type { IssueComment } from "../src/tracker/backlog-rest.js";

/** IssueComment の最小生成ヘルパ（テスト材料用）。 */
function comment(id: number, content: string): IssueComment {
  return { id, content, createdUser: { id: 1, name: "u" }, created: "2026-06-01T00:00:00Z" };
}

describe("isToolComment", () => {
  it("`## ターン #N` 形式の legacy 見出しは true", () => {
    expect(isToolComment("## ターン #3\n本文")).toBe(true);
    expect(isToolComment("## ターン #1")).toBe(true);
    // 見出し記号や空白の揺れも許容
    expect(isToolComment("### ターン #12 まとめ")).toBe(true);
    expect(isToolComment("##ターン #7")).toBe(true);
  });

  it("`🤖 ターン要約 #N` 形式の legacy 要約は true", () => {
    expect(isToolComment("🤖 ターン要約 #5\nやったこと…")).toBe(true);
    expect(isToolComment("🤖ターン要約 #2")).toBe(true);
  });

  it("既知の機械マーカー `[[bas:...]]` を含むものは true", () => {
    expect(isToolComment("セッション開始 [[bas:session:abc-123]]")).toBe(true);
    expect(isToolComment("[[bas:epic:auth]] エポック")).toBe(true);
  });

  it("人間が書いたコメントは false（絶対に消さない）", () => {
    expect(isToolComment("ここ直して")).toBe(false);
    expect(isToolComment("レビューしました。LGTM です")).toBe(false);
    // 「ターン」を含むが定型見出しで始まらない人間コメントは保持
    expect(isToolComment("このターン制ゲームの仕様について相談です")).toBe(false);
    // 現行フォーマット（マーカー無しの節目1行）も巻き込まない
    expect(isToolComment("子課題を作成しました: PROJ-30")).toBe(false);
  });

  it("空文字・空白のみは false", () => {
    expect(isToolComment("")).toBe(false);
    expect(isToolComment("   \n  ")).toBe(false);
  });
});

describe("cleanupToolComments", () => {
  function makeDeps(comments: IssueComment[], over: Partial<CleanupDeps> = {}): CleanupDeps & {
    getIssueComments: ReturnType<typeof vi.fn>;
    deleteComment: ReturnType<typeof vi.fn>;
  } {
    // 1 ページ（< pageSize）で返し切るモック（minId 起点は呼び出し検証用に保持）。
    const getIssueComments = vi.fn(async (_key: string, _opts?: any) => comments);
    const deleteComment = vi.fn(async (_key: string, _id: number) => undefined);
    return { getIssueComments, deleteComment, ...over } as any;
  }

  it("本番ではツールコメントのみ delete し、人間コメントは保持する", async () => {
    const deps = makeDeps([
      comment(1, "## ターン #1\n着手"),
      comment(2, "ここ直して"), // 人間
      comment(3, "🤖 ターン要約 #1\n完了"),
      comment(4, "レビューOKです"), // 人間
      comment(5, "[[bas:session:s1]] 機械"),
    ]);
    const res = await cleanupToolComments(deps, "TC-26");

    expect(res.deleted).toBe(3);
    expect(res.kept).toBe(2);
    // delete はツールコメントの id のみ
    const deletedIds = deps.deleteComment.mock.calls.map((c: any[]) => c[1]).sort();
    expect(deletedIds).toEqual([1, 3, 5]);
    // 人間コメント(2,4)に対して delete は呼ばれない
    for (const call of deps.deleteComment.mock.calls) {
      expect([2, 4]).not.toContain(call[1]);
    }
  });

  it("dry-run では delete を一切呼ばず候補を列挙する", async () => {
    const deps = makeDeps([
      comment(10, "## ターン #2\n進捗"),
      comment(11, "人間メモ"),
    ]);
    const res = await cleanupToolComments(deps, "TC-26", { dryRun: true });

    expect(deps.deleteComment).not.toHaveBeenCalled();
    expect(res.deleted).toBe(0);
    expect(res.kept).toBe(1);
    expect(res.candidates.map((c) => c.id)).toEqual([10]);
    expect(res.candidates[0]!.preview).toContain("## ターン #2");
  });

  it("ツールコメントが無ければ削除候補ゼロ・全件保持", async () => {
    const deps = makeDeps([comment(1, "人間A"), comment(2, "人間B")]);
    const res = await cleanupToolComments(deps, "TC-1");
    expect(res.deleted).toBe(0);
    expect(res.kept).toBe(2);
    expect(res.candidates).toEqual([]);
    expect(deps.deleteComment).not.toHaveBeenCalled();
  });

  it("delete が 1 件失敗しても残りの候補を削除し続ける（堅牢性）", async () => {
    const deps = makeDeps([
      comment(1, "## ターン #1"),
      comment(2, "🤖 ターン要約 #1"),
    ]);
    deps.deleteComment.mockImplementationOnce(async () => {
      throw new Error("transient 500");
    });
    const res = await cleanupToolComments(deps, "TC-26");
    // 2 候補のうち 1 件目は失敗、2 件目は成功 → deleted=1、両方 candidates には残る
    expect(deps.deleteComment).toHaveBeenCalledTimes(2);
    expect(res.deleted).toBe(1);
    expect(res.candidates.map((c) => c.id)).toEqual([1, 2]);
  });

  it("pageSize 満杯ページは minId を次起点にしてページングする", async () => {
    // 1 ページ目: id 1..2（pageSize=2 で満杯）→ 2 ページ目: id 3（端数）→ 終了
    const page1 = [comment(1, "## ターン #1"), comment(2, "人間")];
    const page2 = [comment(3, "🤖 ターン要約 #1")];
    const getIssueComments = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const deleteComment = vi.fn(async () => undefined);
    const deps = { getIssueComments, deleteComment } as any as CleanupDeps;

    const res = await cleanupToolComments(deps, "TC-26", { pageSize: 2 });

    expect(getIssueComments).toHaveBeenCalledTimes(2);
    // 2 ページ目の minId は 1 ページ目末尾 id(=2)
    expect((getIssueComments as any).mock.calls[1][1]).toEqual({ minId: 2, count: 2 });
    expect(res.deleted).toBe(2); // id 1 と 3
    expect(res.kept).toBe(1); // id 2
  });
});
