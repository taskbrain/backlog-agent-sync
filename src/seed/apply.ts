import type { StatusMap } from "../types.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import type { FoundIssue } from "../tracker/backlog-rest.js";
import { statusNameToKey } from "../tracker/backlog-adapter.js";

export interface SeedEpic { slug: string; summary: string; status: keyof StatusMap; description?: string; }
export interface SeedPlan { projectId: number; issueTypeId?: number; priorityId?: number; epics: SeedEpic[]; }

export interface SeedLedgerEntry { issueKey: string; issueId?: number; }
export interface SeedLedger { version: number; epics: Record<string, SeedLedgerEntry>; }

export interface SeedDeps {
  adapter: TrackerAdapter;
  dryRun?: boolean;
  defaultIssueTypeId?: number;
  defaultPriorityId?: number;
  /** seed-ledger（slug→issueKey 台帳）。未注入なら従来のマーカー検索のみで動作。 */
  loadLedger?: () => Promise<SeedLedger>;
  saveLedger?: (ledger: SeedLedger) => Promise<void>;
}
export interface SeedResult { created: number; updated: number; skipped: number; preview?: Array<{ slug: string; summary: string; status: string; action: "create" | "update" }>; }

export function markerFor(slug: string): string { return `[[bas:epic:${slug}]]`; }

/** Backlog code 7 = 変更なし更新（"No comment content."）。同値ステータスへの PATCH で発生する。 */
function isNoChangeError(e: unknown): boolean {
  return /"code"\s*:\s*7\b/.test(String(e instanceof Error ? e.message : e));
}

export async function applySeed(plan: SeedPlan, deps: SeedDeps): Promise<SeedResult> {
  const statusMap = await deps.adapter.getStatusMap();
  // plan 指定を優先し、無ければ init が解決した既定値（ID=1 等のハードコード禁止）
  const issueTypeId = plan.issueTypeId ?? deps.defaultIssueTypeId;
  const priorityId = plan.priorityId ?? deps.defaultPriorityId;
  const preview: NonNullable<SeedResult["preview"]> = [];
  let created = 0, updated = 0, skipped = 0;
  const ledger: SeedLedger = deps.loadLedger ? await deps.loadLedger() : { version: 1, epics: {} };

  for (const epic of plan.epics) {
    const marker = markerFor(epic.slug);
    // 既存検出の優先順位: ledger → マーカー全文検索 → 新規作成。
    // 全文検索は結果整合（直前作成分がヒットしない）のため、台帳ヒット時は検索しない
    const fromLedger = ledger.epics[epic.slug];
    const existing: FoundIssue | undefined = fromLedger
      ? { id: fromLedger.issueId ?? 0, issueKey: fromLedger.issueKey }
      : await deps.adapter.findByMarker(marker);
    const action: "create" | "update" = existing ? "update" : "create";
    preview.push({ slug: epic.slug, summary: epic.summary, status: String(epic.status), action });
    if (deps.dryRun) continue;

    const statusId = statusMap[epic.status];
    if (existing) {
      // マーカー検索でのヒットは ledger へ逆移入（次回から検索レース・search レート消費を回避）
      if (!fromLedger && deps.saveLedger) {
        ledger.epics[epic.slug] = { issueKey: existing.issueKey, ...(existing.id ? { issueId: existing.id } : {}) };
        await deps.saveLedger(ledger);
      }
      // update は状態遷移のみ（説明は上書きしない）。
      // 現在ステータスが目標と同じなら変更なし PATCH（Backlog code 7 エラー）を避けてスキップ
      const currentKey = existing.status ? statusNameToKey(existing.status) : undefined;
      if (currentKey === epic.status) {
        skipped++;
      } else {
        try {
          await deps.adapter.setStatus(existing.issueKey, statusId, undefined);
        } catch (e) {
          // status 名が取得できず同値更新になった場合の code 7 は no-op 成功として扱う
          if (!isNoChangeError(e)) throw e;
          skipped++;
        }
      }
      updated++;
    } else {
      if (!issueTypeId || !priorityId) {
        throw new Error("issueTypeId/priorityId が未解決です（backlog-sync init を実行するか plan で指定してください）");
      }
      const ref = await deps.adapter.createIssue({
        projectId: plan.projectId,
        summary: epic.summary,
        issueTypeId,
        priorityId,
        // マーカーを先頭に保ったまま説明文を反映（再実行時の既存検出に必要）
        description: `${marker}\n\n${epic.description ?? "（backlog-agent-sync seed が生成）"}`,
      });
      // 作成直後に台帳へ1件ごと即保存（途中 abort でも作成済み分が残り、再実行の重複作成を防ぐ）
      if (deps.saveLedger) {
        ledger.epics[epic.slug] = { issueKey: ref.issueKey, issueId: ref.id };
        await deps.saveLedger(ledger);
      }
      // 作成直後は初期ステータス（未対応=open）。目標が open なら変更なし PATCH になるためスキップ
      if (statusId !== statusMap.open) {
        await deps.adapter.setStatus(ref.issueKey, statusId, undefined);
      } else {
        skipped++;
      }
      created++;
    }
  }
  return { created, updated, skipped, preview };
}
