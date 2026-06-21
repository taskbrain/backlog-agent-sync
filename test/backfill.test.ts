import { describe, it, expect, vi } from "vitest";
import { backfillSummary, type BackfillDeps } from "../src/issue/backfill.js";

/**
 * REST/judgment を最小注入契約（BackfillDeps）越しにモックする。
 * - getIssueDetail: 既存の肥大課題（件名 + 旧説明）を返す。
 * - getComments: 直近コメントを材料として返す（任意。未注入/失敗でも本文生成は落ちない）。
 * - updateIssueDescription: 本番のみ 1 回呼ばれる想定。dry-run では呼ばれない。
 * - コメント削除系メソッドは契約に存在しない（= 構造的に非削除）ことを担保する。
 */
function makeDeps(over: Partial<BackfillDeps> = {}): BackfillDeps & {
  getIssueDetail: ReturnType<typeof vi.fn>;
  getComments: ReturnType<typeof vi.fn>;
  updateIssueDescription: ReturnType<typeof vi.fn>;
} {
  const getIssueDetail = vi.fn(async (_key: string) => ({
    id: 26,
    issueKey: "TC-26",
    summary: "決済フローの実装",
    description: "## タスク\n決済フローを実装する\n\n## 最新状況\n旧サマリ",
  }));
  const getComments = vi.fn(async (_key: string, _opts?: any) => [
    { id: 1, content: "着手しました", createdUser: { id: 1, name: "u" }, created: "2026-01-01T00:00:00Z" },
    { id: 2, content: "実装完了しました", createdUser: { id: 1, name: "u" }, created: "2026-01-02T00:00:00Z" },
  ]);
  const updateIssueDescription = vi.fn(async (_key: string, _body: string) => undefined);
  return {
    getIssueDetail,
    getComments,
    updateIssueDescription,
    judgment: { backend: "deterministic" },
    textFormattingRule: "markdown",
    ...over,
  } as any;
}

describe("backfillSummary", () => {
  it("dry-run: updateIssueDescription を呼ばず、生成本文を返し stdout へ出力する", async () => {
    const deps = makeDeps();
    const writes: string[] = [];
    const res = await backfillSummary(deps, "TC-26", { dryRun: true, write: (s) => writes.push(s) });

    // 既存説明を読むために getIssueDetail を 1 回呼ぶ
    expect(deps.getIssueDetail).toHaveBeenCalledWith("TC-26");
    // dry-run は説明欄を書き換えない（非破壊）
    expect(deps.updateIssueDescription).not.toHaveBeenCalled();
    // §7.1 の 4 ブロック構造を含む本文が返り、stdout にも出る
    expect(res.body).toContain("## タスク");
    expect(res.body).toContain("## 進捗");
    expect(res.body).toContain("## 最新状況");
    expect(res.body).toContain("## 子課題");
    expect(res.updated).toBe(false);
    expect(writes.join("")).toContain("## タスク");
  });

  it("本番: updateIssueDescription を 1 回だけ呼ぶ（説明欄のみ更新）", async () => {
    const deps = makeDeps();
    const res = await backfillSummary(deps, "TC-26", { dryRun: false });

    expect(deps.getIssueDetail).toHaveBeenCalledOnce();
    expect(deps.updateIssueDescription).toHaveBeenCalledOnce();
    const [key, body] = deps.updateIssueDescription.mock.calls[0];
    expect(key).toBe("TC-26");
    expect(body).toContain("## タスク");
    expect(body).toContain("## 最新状況");
    expect(res.updated).toBe(true);
  });

  it("コメントは一切削除・改変しない（GET と説明更新以外の書込なし）", async () => {
    const deps = makeDeps();
    await backfillSummary(deps, "TC-26", { dryRun: false });

    // BackfillDeps にコメント削除/改変系メソッドは存在しない（構造的非削除）。
    // 念のため、注入された任意の delete/remove/update-comment 系が呼ばれていないことを確認。
    for (const [name, fn] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof fn !== "function") continue;
      if (/delete|remove|deletecomment|updatecomment|addcomment/i.test(name)) {
        expect((fn as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
      }
    }
    // 説明更新は呼ぶが、コメント取得は読み取り専用（材料収集）に留まる
    expect(deps.updateIssueDescription).toHaveBeenCalledOnce();
  });

  it("既存説明の ## タスク を引き継ぐ（無ければ件名をタスクに使う）", async () => {
    const deps = makeDeps();
    const res = await backfillSummary(deps, "TC-26", { dryRun: true });
    // 既存説明にあった原タスクが維持される
    expect(res.body).toContain("決済フローを実装する");

    // ## タスクが無い旧説明では件名をタスクに使う
    const deps2 = makeDeps({
      getIssueDetail: vi.fn(async () => ({ id: 9, issueKey: "TC-9", summary: "件名タスク", description: "雑多な説明本文" })) as any,
    });
    const res2 = await backfillSummary(deps2, "TC-9", { dryRun: true });
    expect(res2.body).toContain("件名タスク");
  });

  it("Backlog 記法見出し（* タスク）の既存説明からもタスクを抽出する（markdown 非対称の解消）", async () => {
    // Backlog 記法で作られた既存説明は ## ではなく ** が見出しに使われる。
    // markdown 専用だと ## タスク を取りこぼし件名へ無駄に落ちるため、両記法対応を確認する。
    const deps = makeDeps({
      getIssueDetail: vi.fn(async () => ({
        id: 30,
        issueKey: "TC-30",
        summary: "件名（フォールバック先）",
        description: "** タスク\n文字起こしを元に設計をまとめる\n\n** 最新状況\n旧サマリ",
      })) as any,
      // Backlog 記法本文を生成すると ** タスク 見出しで出力されるため本文側の見出し検証は記法非依存に行う
      textFormattingRule: "backlog",
    });
    const res = await backfillSummary(deps, "TC-30", { dryRun: true });
    // ** タスク ブロックの本文が原タスクとして引き継がれる（件名ではない）
    expect(res.body).toContain("文字起こしを元に設計をまとめる");
    expect(res.body).not.toContain("件名（フォールバック先）");
  });

  it("judgment 失敗時も決定論で本文生成され落ちない", async () => {
    // updateSummary が必ず throw する backend を注入 → 決定論フォールバックで本文を組む
    const throwingBackend = {
      classifyDivergence: vi.fn(async () => ({ kind: "in_scope" as const })),
      updateSummary: vi.fn(async () => {
        throw new Error("claude -p 失敗（API課金回避 or オフライン）");
      }),
    };
    const deps = makeDeps({ backend: throwingBackend } as any);
    const res = await backfillSummary(deps, "TC-26", { dryRun: true });
    // 例外を投げず本文を返す（§7.1 構造）
    expect(res.body).toContain("## タスク");
    expect(res.body).toContain("## 最新状況");
    expect(res.body).toContain("決済フローを実装する");
  });

  it("getComments が未注入/失敗でも本文生成は落ちない（説明のみで可）", async () => {
    const deps = makeDeps({
      getComments: vi.fn(async () => {
        throw new Error("comments GET 失敗");
      }) as any,
    });
    const res = await backfillSummary(deps, "TC-26", { dryRun: true });
    expect(res.body).toContain("## タスク");

    // getComments 自体が無い場合も動く
    const deps2 = makeDeps();
    delete (deps2 as any).getComments;
    const res2 = await backfillSummary(deps2 as any, "TC-26", { dryRun: true });
    expect(res2.body).toContain("## タスク");
  });
});
