import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { projectConfigPath } from "./config.js";
import type { TrackerAdapter } from "./tracker/adapter.js";
import type { BacklogRest, IssueTypeDef, PriorityDef } from "./tracker/backlog-rest.js";

export interface InitInput { cwd: string; projectKey: string; projectId?: number; }
export interface InitDeps { adapter: TrackerAdapter; rest: Pick<BacklogRest, "getMyself" | "getProject" | "getIssueTypes" | "getPriorities">; }
export interface InitResult { ok: boolean; me: { id: number; name: string }; projectId: number; defaultIssueTypeId?: number; defaultPriorityId?: number; }

/** 「タスク」(または task) を優先、無ければ先頭。 */
function pickDefaultIssueType(types: IssueTypeDef[]): number | undefined {
  const hit = types.find((t) => ["タスク", "task"].includes(t.name.trim().toLowerCase()));
  return (hit ?? types[0])?.id;
}

/** 「中」(または normal) を優先、無ければ中央、無ければ先頭。 */
function pickDefaultPriority(priorities: PriorityDef[]): number | undefined {
  const hit = priorities.find((p) => ["中", "normal"].includes(p.name.trim().toLowerCase()));
  return (hit ?? priorities[Math.floor(priorities.length / 2)] ?? priorities[0])?.id;
}

export async function runInit(input: InitInput, deps: InitDeps): Promise<InitResult> {
  const me = await deps.rest.getMyself(); // auth 検証（失敗で throw）
  const projectId = input.projectId ?? (await deps.rest.getProject(input.projectKey)).id;
  const statusMap = await deps.adapter.getStatusMap();
  // 課題種別/優先度は ID=1 等のデフォルトをハードコードせず実値を解決する（設計§8.1）
  const issueTypes = await deps.rest.getIssueTypes(input.projectKey);
  const priorities = await deps.rest.getPriorities();
  const defaultIssueTypeId = pickDefaultIssueType(issueTypes);
  const defaultPriorityId = pickDefaultPriority(priorities);
  const path = projectConfigPath(input.cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    projectKey: input.projectKey,
    projectId,
    statusMap,
    issueTypes: issueTypes.map((t) => ({ id: t.id, name: t.name })),
    priorities: priorities.map((p) => ({ id: p.id, name: p.name })),
    defaultIssueTypeId,
    defaultPriorityId,
    resolvedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return { ok: true, me, projectId, defaultIssueTypeId, defaultPriorityId };
}
