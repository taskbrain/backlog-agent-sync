import { describe, it, expect, vi } from "vitest";
import { applySeed, type SeedPlan } from "../src/seed/apply.js";

const plan: SeedPlan = {
  projectId: 10,
  epics: [
    { slug: "module-billing", summary: "課金モジュール", status: "in_progress" },
    { slug: "module-line", summary: "LINEモジュール", status: "open" },
  ],
};

function adapter(existing: Record<string, { id: number; issueKey: string }> = {}) {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn().mockImplementation(async (i: any) => ({ id: Math.floor(Math.random() * 1000) + 1, issueKey: `PROJ-${i.summary.length}` })),
    setStatus: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    findByMarker: vi.fn().mockImplementation(async (m: string) => existing[m]),
  };
}

const defaults = { defaultIssueTypeId: 4236190, defaultPriorityId: 3 };

describe("applySeed", () => {
  it("既存が無ければ各エピックを deps の既定 issueTypeId/priorityId で作成する", async () => {
    const a = adapter();
    const res = await applySeed(plan, { adapter: a as any, ...defaults });
    expect(a.createIssue).toHaveBeenCalledTimes(2);
    expect(a.createIssue).toHaveBeenCalledWith(expect.objectContaining({ issueTypeId: 4236190, priorityId: 3 })); // ハードコード1/3ではなく既定値
    expect(res.created).toBe(2);
    expect(res.updated).toBe(0);
  });

  it("マーカーで既存検出した場合は作成せず状態更新のみ（冪等）", async () => {
    const a = adapter({ "[[bas:epic:module-billing]]": { id: 50, issueKey: "PROJ-50" } });
    const res = await applySeed(plan, { adapter: a as any, ...defaults });
    expect(a.createIssue).toHaveBeenCalledTimes(1); // billing はスキップ
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(a.setStatus).toHaveBeenCalledWith("PROJ-50", 2, undefined); // in_progress
  });

  it("dry-run では一切書き込まない", async () => {
    const a = adapter();
    const res = await applySeed(plan, { adapter: a as any, dryRun: true });
    expect(a.createIssue).not.toHaveBeenCalled();
    expect(res.preview?.length).toBe(2);
  });

  it("plan の issueTypeId/priorityId は deps 既定より優先する", async () => {
    const a = adapter();
    await applySeed({ ...plan, issueTypeId: 999, priorityId: 2 }, { adapter: a as any, ...defaults });
    expect(a.createIssue).toHaveBeenCalledWith(expect.objectContaining({ issueTypeId: 999, priorityId: 2 }));
  });

  it("issueTypeId/priorityId 未解決で作成が必要な場合はエラーになる", async () => {
    const a = adapter();
    await expect(applySeed(plan, { adapter: a as any })).rejects.toThrow(/issueTypeId/);
  });

  it("epic.description はマーカーを先頭に保ったまま説明文に反映される", async () => {
    const a = adapter();
    const withDesc = {
      ...plan,
      epics: [{ slug: "module-billing", summary: "課金モジュール", status: "open" as const, description: "Stripe連携の現状まとめ" }],
    };
    await applySeed(withDesc, { adapter: a as any, ...defaults });
    const desc = String(a.createIssue.mock.calls[0][0].description);
    expect(desc.startsWith("[[bas:epic:module-billing]]")).toBe(true); // マーカー先頭維持（再実行時の既存検出に必要）
    expect(desc).toContain("Stripe連携の現状まとめ");
  });
});
