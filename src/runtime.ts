import { readFile } from "node:fs/promises";
import { resolveConfig, stateDirFor, projectConfigPath, resolveJudgmentConfig } from "./config.js";
import { StateStore } from "./state/store.js";
import { BacklogRest } from "./tracker/backlog-rest.js";
import { BacklogAdapter } from "./tracker/backlog-adapter.js";
import type { LifecycleDeps } from "./lifecycle/session-start.js";
import type { ProjectCache } from "./types.js";
import { resolveCreateFields } from "./fields.js";
import { summarizeRequest } from "./summarize.js";

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
  let summarize: LifecycleDeps["summarize"];
  // judgment は project.json 未解決時も既定（backend=auto）へ正規化する（getBackend が常に有効な backend を受け取る）
  let judgment: LifecycleDeps["judgment"] = resolveJudgmentConfig(undefined);
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
    // 依頼の LLM 整理は既定 ON（"off" で無効化）。Codex セッションで呼ばない判定は lifecycle 側（ev.tool）
    if (pj.fieldRules?.summarize !== "off") summarize = (prompt) => summarizeRequest(prompt);
    // ユーザーが init で選んだ判定 backend/model を本番ハンドラ（user-prompt-submit / stop）へ伝播する
    judgment = resolveJudgmentConfig(pj.judgment);
  } catch {
    // project.json 未作成: env または未解決にフォールバック（judgment は既定 backend=auto のまま）
  }
  // 既存課題キー → 数値 id 解決（child 孫世代 / sibling 親あり の親子化に必要）。失敗は undefined（呼出側で no-op + skip ログ）。
  const getIssueId = (issueKey: string): Promise<number | undefined> =>
    rest.getIssue(issueKey).then((i) => i.id).catch(() => undefined);
  const deps: LifecycleDeps = { store, adapter, projectId, issueTypeId, priorityId, rest, vcs, textFormattingRule, resolutionFixedId, root: cwd, fields, summarize, judgment, getIssueId };
  return { deps, rest, projectKey: cfg.projectKey };
}
