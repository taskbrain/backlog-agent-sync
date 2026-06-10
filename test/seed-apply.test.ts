import { describe, it, expect, vi } from "vitest";
import { applySeed, type SeedPlan } from "../src/seed/apply.js";

const plan: SeedPlan = {
  projectId: 10,
  epics: [
    { slug: "module-billing", summary: "課金モジュール", status: "in_progress" },
    { slug: "module-line", summary: "LINEモジュール", status: "open" },
  ],
};

function adapter(existing: Record<string, { id: number; issueKey: string; status?: string }> = {}) {
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

  it("open エピックの create では setStatus を呼ばない（初期ステータスへの変更なしPATCH回避）", async () => {
    const a = adapter();
    const openOnly = { ...plan, epics: [{ slug: "module-line", summary: "LINEモジュール", status: "open" as const }] };
    const res = await applySeed(openOnly, { adapter: a as any, ...defaults });
    expect(a.createIssue).toHaveBeenCalledOnce();
    expect(a.setStatus).not.toHaveBeenCalled();
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("既存課題が目標ステータスと同じなら update で setStatus を呼ばない", async () => {
    const a = adapter({ "[[bas:epic:module-billing]]": { id: 50, issueKey: "PROJ-50", status: "処理中" } }); // 目標も in_progress
    const billingOnly = { ...plan, epics: [{ slug: "module-billing", summary: "課金モジュール", status: "in_progress" as const }] };
    const res = await applySeed(billingOnly, { adapter: a as any, ...defaults });
    expect(a.setStatus).not.toHaveBeenCalled();
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("既存課題が異なるステータスなら update で setStatus を呼ぶ", async () => {
    const a = adapter({ "[[bas:epic:module-billing]]": { id: 50, issueKey: "PROJ-50", status: "未対応" } });
    const billingOnly = { ...plan, epics: [{ slug: "module-billing", summary: "課金モジュール", status: "in_progress" as const }] };
    const res = await applySeed(billingOnly, { adapter: a as any, ...defaults });
    expect(a.setStatus).toHaveBeenCalledWith("PROJ-50", 2, undefined);
    expect(res.skipped).toBe(0);
  });

  it("status 名が取得できない既存課題への変更なしPATCH(code 7)は no-op として握りつぶす", async () => {
    const a = adapter({ "[[bas:epic:module-billing]]": { id: 50, issueKey: "PROJ-50" } }); // status 名なし→フォールバックで setStatus
    a.setStatus.mockRejectedValue(new Error('Backlog PATCH /issues/PROJ-50 -> 400 {"errors":[{"message":"No comment content.","code":7}]}'));
    const billingOnly = { ...plan, epics: [{ slug: "module-billing", summary: "課金モジュール", status: "in_progress" as const }] };
    const res = await applySeed(billingOnly, { adapter: a as any, ...defaults });
    expect(res.updated).toBe(1); // 例外を伝播しない
    expect(res.skipped).toBe(1);
  });

  it("code 7 以外の setStatus エラーは伝播する", async () => {
    const a = adapter({ "[[bas:epic:module-billing]]": { id: 50, issueKey: "PROJ-50" } });
    a.setStatus.mockRejectedValue(new Error("Backlog PATCH /issues/PROJ-50 -> 500 internal"));
    const billingOnly = { ...plan, epics: [{ slug: "module-billing", summary: "課金モジュール", status: "in_progress" as const }] };
    await expect(applySeed(billingOnly, { adapter: a as any, ...defaults })).rejects.toThrow("500");
  });

  it("ledger ヒット時は findByMarker を呼ばず update になる（検索の結果整合レース回避）", async () => {
    const a = adapter();
    const loadLedger = vi.fn().mockResolvedValue({ version: 1, epics: { "module-billing": { issueKey: "TC-19", issueId: 19 } } });
    const saveLedger = vi.fn().mockResolvedValue(undefined);
    const billingOnly = { ...plan, epics: [{ slug: "module-billing", summary: "課金モジュール", status: "in_progress" as const }] };
    const res = await applySeed(billingOnly, { adapter: a as any, ...defaults, loadLedger, saveLedger });
    expect(a.findByMarker).not.toHaveBeenCalled();
    expect(a.createIssue).not.toHaveBeenCalled(); // 重複作成しない
    expect(res.updated).toBe(1);
    expect(a.setStatus).toHaveBeenCalledWith("TC-19", 2, undefined); // ledger は status 不明→従来どおり遷移試行
  });

  it("新規作成時に ledger へ slug→issueKey が1件ごと即保存される", async () => {
    const a = adapter();
    const snapshots: any[] = [];
    const loadLedger = vi.fn().mockResolvedValue({ version: 1, epics: {} });
    const saveLedger = vi.fn().mockImplementation(async (l: any) => { snapshots.push(JSON.parse(JSON.stringify(l))); });
    await applySeed(plan, { adapter: a as any, ...defaults, loadLedger, saveLedger });
    expect(saveLedger).toHaveBeenCalledTimes(2); // エピックごとに即保存（中断耐性）
    expect(snapshots[0].epics["module-billing"].issueKey).toMatch(/^PROJ-/);
    expect(snapshots[0].epics["module-line"]).toBeUndefined(); // 1件目時点では2件目は未記録
    expect(snapshots[1].epics["module-line"].issueKey).toMatch(/^PROJ-/);
    expect(snapshots[1].epics["module-billing"].issueId).toEqual(expect.any(Number));
  });

  it("findByMarker ヒット時も ledger へ逆移入される", async () => {
    const a = adapter({ "[[bas:epic:module-billing]]": { id: 50, issueKey: "PROJ-50", status: "未対応" } });
    const loadLedger = vi.fn().mockResolvedValue({ version: 1, epics: {} });
    const saveLedger = vi.fn().mockResolvedValue(undefined);
    const billingOnly = { ...plan, epics: [{ slug: "module-billing", summary: "課金モジュール", status: "in_progress" as const }] };
    await applySeed(billingOnly, { adapter: a as any, ...defaults, loadLedger, saveLedger });
    expect(a.findByMarker).toHaveBeenCalledOnce();
    expect(saveLedger).toHaveBeenCalledWith(expect.objectContaining({
      epics: expect.objectContaining({
        "module-billing": expect.objectContaining({ issueKey: "PROJ-50", issueId: 50 }),
      }),
    }));
  });

  it("dry-run では ledger を保存しない（saveLedger 未注入でも preview に ledger ヒットが反映される）", async () => {
    const a = adapter();
    const loadLedger = vi.fn().mockResolvedValue({ version: 1, epics: { "module-billing": { issueKey: "TC-19" } } });
    const res = await applySeed(plan, { adapter: a as any, dryRun: true, loadLedger });
    expect(res.preview?.find((p) => p.slug === "module-billing")?.action).toBe("update"); // ledger 由来
    expect(res.preview?.find((p) => p.slug === "module-line")?.action).toBe("create");
    expect(a.createIssue).not.toHaveBeenCalled();
  });
});
