import type { StatusMap } from "../types.js";
import type { TrackerAdapter } from "../tracker/adapter.js";

export interface SeedEpic { slug: string; summary: string; status: keyof StatusMap; }
export interface SeedPlan { projectId: number; issueTypeId?: number; priorityId?: number; epics: SeedEpic[]; }

export interface SeedDeps { adapter: TrackerAdapter; dryRun?: boolean; }
export interface SeedResult { created: number; updated: number; preview?: Array<{ slug: string; summary: string; status: string; action: "create" | "update" }>; }

export function markerFor(slug: string): string { return `[[bas:epic:${slug}]]`; }

export async function applySeed(plan: SeedPlan, deps: SeedDeps): Promise<SeedResult> {
  const statusMap = await deps.adapter.getStatusMap();
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
      await deps.adapter.setStatus(existing.issueKey, statusId, undefined);
      updated++;
    } else {
      const ref = await deps.adapter.createIssue({
        projectId: plan.projectId,
        summary: epic.summary,
        issueTypeId: plan.issueTypeId ?? 1,
        priorityId: plan.priorityId ?? 3,
        description: `${marker}\n（backlog-agent-sync seed が生成）`,
      });
      await deps.adapter.setStatus(ref.issueKey, statusId, undefined);
      created++;
    }
  }
  return { created, updated, preview };
}
