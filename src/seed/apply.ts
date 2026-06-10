import type { StatusMap } from "../types.js";
import type { TrackerAdapter } from "../tracker/adapter.js";

export interface SeedEpic { slug: string; summary: string; status: keyof StatusMap; description?: string; }
export interface SeedPlan { projectId: number; issueTypeId?: number; priorityId?: number; epics: SeedEpic[]; }

export interface SeedDeps { adapter: TrackerAdapter; dryRun?: boolean; defaultIssueTypeId?: number; defaultPriorityId?: number; }
export interface SeedResult { created: number; updated: number; preview?: Array<{ slug: string; summary: string; status: string; action: "create" | "update" }>; }

export function markerFor(slug: string): string { return `[[bas:epic:${slug}]]`; }

export async function applySeed(plan: SeedPlan, deps: SeedDeps): Promise<SeedResult> {
  const statusMap = await deps.adapter.getStatusMap();
  // plan 指定を優先し、無ければ init が解決した既定値（ID=1 等のハードコード禁止）
  const issueTypeId = plan.issueTypeId ?? deps.defaultIssueTypeId;
  const priorityId = plan.priorityId ?? deps.defaultPriorityId;
  const preview: NonNullable<SeedResult["preview"]> = [];
  let created = 0, updated = 0;

  for (const epic of plan.epics) {
    const marker = markerFor(epic.slug);
    const existing = await deps.adapter.findByMarker(marker);
    const action: "create" | "update" = existing ? "update" : "create";
    preview.push({ slug: epic.slug, summary: epic.summary, status: String(epic.status), action });
    if (deps.dryRun) continue;

    const statusId = statusMap[epic.status];
    if (existing) {
      // update は状態遷移のみ（説明は上書きしない）
      await deps.adapter.setStatus(existing.issueKey, statusId, undefined);
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
      await deps.adapter.setStatus(ref.issueKey, statusId, undefined);
      created++;
    }
  }
  return { created, updated, preview };
}
