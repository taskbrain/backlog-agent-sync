import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { projectConfigPath } from "./config.js";
import type { TrackerAdapter } from "./tracker/adapter.js";
import type { BacklogRest } from "./tracker/backlog-rest.js";

export interface InitInput { cwd: string; projectKey: string; projectId?: number; }
export interface InitDeps { adapter: TrackerAdapter; rest: Pick<BacklogRest, "getMyself" | "getProject">; }
export interface InitResult { ok: boolean; me: { id: number; name: string }; projectId: number; }

export async function runInit(input: InitInput, deps: InitDeps): Promise<InitResult> {
  const me = await deps.rest.getMyself(); // auth 検証（失敗で throw）
  const projectId = input.projectId ?? (await deps.rest.getProject(input.projectKey)).id;
  const statusMap = await deps.adapter.getStatusMap();
  const path = projectConfigPath(input.cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    projectKey: input.projectKey,
    projectId,
    statusMap,
    resolvedAt: new Date().toISOString(),
  }, null, 2), "utf8");
  return { ok: true, me, projectId };
}
