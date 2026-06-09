import { resolveConfig, stateDirFor } from "./config.js";
import { StateStore } from "./state/store.js";
import { BacklogRest } from "./tracker/backlog-rest.js";
import { BacklogAdapter } from "./tracker/backlog-adapter.js";
import type { LifecycleDeps } from "./lifecycle/session-start.js";

export async function buildRuntime(cwd: string): Promise<{ deps: LifecycleDeps; rest: BacklogRest; projectKey: string }> {
  const cfg = resolveConfig(process.env);
  const rest = new BacklogRest(cfg);
  const adapter = new BacklogAdapter(rest, cfg.projectKey);
  const store = new StateStore(stateDirFor(cwd));
  // projectId は project.json があれば読む（無ければ find/プロジェクト解決は P1 検証時に補完）。
  const projectId = Number(process.env.BACKLOG_PROJECT_ID ?? 0);
  const deps: LifecycleDeps = { store, adapter, projectId };
  return { deps, rest, projectKey: cfg.projectKey };
}
