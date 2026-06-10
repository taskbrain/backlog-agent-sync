import { readFile } from "node:fs/promises";
import { resolveConfig, stateDirFor, projectConfigPath } from "./config.js";
import { StateStore } from "./state/store.js";
import { BacklogRest } from "./tracker/backlog-rest.js";
import { BacklogAdapter } from "./tracker/backlog-adapter.js";
import type { LifecycleDeps } from "./lifecycle/session-start.js";

export async function buildRuntime(cwd: string): Promise<{ deps: LifecycleDeps; rest: BacklogRest; projectKey: string }> {
  const cfg = resolveConfig(process.env);
  const rest = new BacklogRest(cfg);
  const adapter = new BacklogAdapter(rest, cfg.projectKey);
  const store = new StateStore(stateDirFor(cwd));
  // projectId は init が書く project.json を優先し、無ければ env、無ければ 0。
  let projectId = Number(process.env.BACKLOG_PROJECT_ID ?? 0);
  try {
    const raw = await readFile(projectConfigPath(cwd), "utf8");
    const pj = JSON.parse(raw) as { projectId?: number };
    if (pj.projectId) projectId = pj.projectId;
  } catch {
    // project.json 未作成: env または 0 にフォールバック
  }
  const deps: LifecycleDeps = { store, adapter, projectId, rest };
  return { deps, rest, projectKey: cfg.projectKey };
}
