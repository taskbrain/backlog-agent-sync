import { readFile } from "node:fs/promises";
import { resolveConfig, stateDirFor, projectConfigPath } from "./config.js";
import { StateStore } from "./state/store.js";
import { BacklogRest } from "./tracker/backlog-rest.js";
import { BacklogAdapter } from "./tracker/backlog-adapter.js";
import type { LifecycleDeps } from "./lifecycle/session-start.js";
import type { ProjectCache } from "./types.js";
import { resolveCreateFields } from "./fields.js";

export async function buildRuntime(cwd: string): Promise<{ deps: LifecycleDeps; rest: BacklogRest; projectKey: string }> {
  const cfg = resolveConfig(process.env);
  const rest = new BacklogRest(cfg);
  const adapter = new BacklogAdapter(rest, cfg.projectKey);
  const store = new StateStore(stateDirFor(cwd));
  // projectId/issueTypeId/priorityId は init が書く project.json を優先し、無ければ env、無ければ未解決。
  let projectId = Number(process.env.BACKLOG_PROJECT_ID ?? 0);
  let issueTypeId: number | undefined = Number(process.env.BACKLOG_ISSUE_TYPE_ID ?? 0) || undefined;
  let priorityId: number | undefined = Number(process.env.BACKLOG_PRIORITY_ID ?? 0) || undefined;
  let vcs: LifecycleDeps["vcs"];
  let textFormattingRule: LifecycleDeps["textFormattingRule"];
  let resolutionFixedId: number | undefined;
  let fields: LifecycleDeps["fields"];
  try {
    const raw = await readFile(projectConfigPath(cwd), "utf8");
    const pj = JSON.parse(raw) as ProjectCache;
    if (pj.projectId) projectId = pj.projectId;
    if (pj.defaultIssueTypeId) issueTypeId = pj.defaultIssueTypeId; // 旧 project.json（フィールド無し）は env/未解決のまま
    if (pj.defaultPriorityId) priorityId = pj.defaultPriorityId;
    if (pj.vcs?.kind) vcs = pj.vcs;
    if (pj.textFormattingRule === "markdown" || pj.textFormattingRule === "backlog") textFormattingRule = pj.textFormattingRule;
    if (pj.resolutionFixedId != null) resolutionFixedId = Number(pj.resolutionFixedId); // 0（対応済み）も有効
    fields = (prompt) => resolveCreateFields(prompt, pj);
  } catch {
    // project.json 未作成: env または未解決にフォールバック
  }
  const deps: LifecycleDeps = { store, adapter, projectId, issueTypeId, priorityId, rest, vcs, textFormattingRule, resolutionFixedId, root: cwd, fields };
  return { deps, rest, projectKey: cfg.projectKey };
}
