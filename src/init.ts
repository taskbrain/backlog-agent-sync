import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { projectConfigPath } from "./config.js";
import type { FieldRules, JudgmentConfig, VcsConfig } from "./types.js";
import type { TrackerAdapter } from "./tracker/adapter.js";
import type { BacklogRest, IssueTypeDef, PriorityDef } from "./tracker/backlog-rest.js";

export type ExecFileFn = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string }>;

/**
 * 判定モデルの選択肢（init 対話の1問）。
 * - "default": claude 既定モデル（backend=auto）
 * - "haiku" | "sonnet" | "opus" | "fable": 当該モデルで claude -p（backend=auto）
 * - "deterministic": LLM 不使用の決定論のみ
 *
 * 実機知見: prompt フックでは model="haiku" が OAuth でエラーになるが、
 * claude -p の --model haiku は別経路で機能する（G20 実績）。よってここでのモデル選択は有効。
 */
export type JudgmentChoice = "default" | "haiku" | "sonnet" | "opus" | "fable" | "deterministic";

/** 判定モデル選択 → project.json `judgment` ブロックへ変換する純関数。 */
export function judgmentFromChoice(choice: JudgmentChoice): JudgmentConfig {
  if (choice === "deterministic") return { backend: "deterministic" };
  if (choice === "default") return { backend: "auto" };
  return { backend: "auto", model: choice };
}

export interface InitInput {
  cwd: string;
  projectKey: string;
  projectId?: number;
  /** `--vcs github|backlog|generic` による検出結果の上書き。 */
  vcsOverride?: "github" | "backlog" | "generic";
}
export interface InitDeps {
  adapter: TrackerAdapter;
  rest: Pick<
    BacklogRest,
    "getMyself" | "getProject" | "getIssueTypes" | "getPriorities"
    | "getProjectInfo" | "getCategories" | "getVersions" | "getResolutions" | "getGitRepositories"
  >;
  /** git コマンド実行（テスト注入用。既定は child_process.execFile）。 */
  execFile?: ExecFileFn;
  /** remote URL → VcsConfig（テスト注入用。既定はパート A の src/vcs/detect.ts）。 */
  parseRemoteUrl?: (url: string) => VcsConfig;
  /**
   * 判定モデル選択の対話（テスト注入用）。
   * 未指定 = 非対話（既定 backend=auto）。既存 project.json に judgment があれば呼ばれない。
   */
  selectJudgment?: () => Promise<JudgmentChoice>;
}
export interface InitResult {
  ok: boolean;
  me: { id: number; name: string };
  projectId: number;
  defaultIssueTypeId?: number;
  defaultPriorityId?: number;
  vcs: VcsConfig;
  textFormattingRule: string;
  resolutionFixedId?: number;
  judgment: JudgmentConfig;
  warnings: string[];
}

const DEFAULT_FIELD_RULES: FieldRules = { assignSelf: true, resolutionOnResolve: true, milestone: "off", summarize: "claude" };

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

/** VCS 検出: git remote get-url origin → parseRemoteUrl → backlog は実在確認（best-effort・非ブロッキング）。 */
async function detectVcs(input: InitInput, deps: InitDeps, warnings: string[]): Promise<VcsConfig> {
  let vcs: VcsConfig = { kind: "generic" };

  // override が generic なら git 実行ごとスキップ
  if (input.vcsOverride !== "generic") {
    const execFileFn: ExecFileFn = deps.execFile ?? (promisify(execFileCb) as unknown as ExecFileFn);
    let remoteUrl = "";
    try {
      const r = await execFileFn("git", ["remote", "get-url", "origin"], { cwd: input.cwd, timeout: 5000 });
      remoteUrl = String(r.stdout).trim();
    } catch {
      // git が無い / リポジトリでない / origin 無し → generic
    }
    if (remoteUrl) {
      try {
        const parse = deps.parseRemoteUrl ?? (await import("./vcs/detect.js")).parseRemoteUrl;
        vcs = parse(remoteUrl);
      } catch (e) {
        warnings.push(`remote URL の解析に失敗しました（generic として扱います）: ${String(e instanceof Error ? e.message : e)}`);
      }
    }
  }

  if (input.vcsOverride && input.vcsOverride !== vcs.kind) {
    vcs = { ...vcs, kind: input.vcsOverride };
  }

  // backlog は Git リポジトリの実在確認（無ければ警告して generic）
  if (vcs.kind === "backlog") {
    if (!vcs.repoName) {
      warnings.push("vcs=backlog ですが repoName を特定できませんでした。generic として扱います。");
      vcs = { kind: "generic" };
    } else {
      const repoName = vcs.repoName;
      try {
        const repos = await deps.rest.getGitRepositories(input.projectKey);
        if (!repos.some((r) => r.name === repoName)) {
          warnings.push(`Backlog Git リポジトリ '${repoName}' がプロジェクト ${input.projectKey} に見つかりません。generic として扱います。`);
          vcs = { kind: "generic" };
        }
      } catch (e) {
        warnings.push(`Backlog Git リポジトリ一覧の取得に失敗しました（検出結果は保持します）: ${String(e instanceof Error ? e.message : e)}`);
      }
    }
  }

  return vcs;
}

export async function runInit(input: InitInput, deps: InitDeps): Promise<InitResult> {
  const warnings: string[] = [];
  const me = await deps.rest.getMyself(); // auth 検証（失敗で throw）
  const projectId = input.projectId ?? (await deps.rest.getProject(input.projectKey)).id;
  const statusMap = await deps.adapter.getStatusMap();
  // 課題種別/優先度は ID=1 等のデフォルトをハードコードせず実値を解決する（設計§8.1）
  const issueTypes = await deps.rest.getIssueTypes(input.projectKey);
  const priorities = await deps.rest.getPriorities();
  const defaultIssueTypeId = pickDefaultIssueType(issueTypes);
  const defaultPriorityId = pickDefaultPriority(priorities);

  // G19: textFormattingRule / categories / versions / resolutions / vcs / fieldRules / myselfId
  const info = await deps.rest.getProjectInfo(input.projectKey);
  const categories = await deps.rest.getCategories(input.projectKey);
  const versions = await deps.rest.getVersions(input.projectKey);
  const resolutions = await deps.rest.getResolutions();
  // 「対応済み」は id:0 が正常値のため ?? / || で潰さず find の結果をそのまま使う
  const fixed = resolutions.find((r) => ["対応済み", "fixed"].includes(r.name.trim().toLowerCase()));
  const resolutionFixedId = fixed ? fixed.id : undefined;

  const vcs = await detectVcs(input, deps, warnings);

  const path = projectConfigPath(input.cwd);
  // 既存の project.json を読み、ユーザー設定（fieldRules 等）を保持する
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // 初回 / 壊れたファイルは上書き
  }
  const fieldRules: FieldRules = (existing.fieldRules as FieldRules | undefined) ?? DEFAULT_FIELD_RULES;

  // judgment は既存設定を尊重（init は上書きしない）。無ければ対話で選択、非対話なら既定 backend=auto。
  let judgment: JudgmentConfig = (existing.judgment as JudgmentConfig | undefined) ?? { backend: "auto" };
  if (existing.judgment === undefined && deps.selectJudgment) {
    judgment = judgmentFromChoice(await deps.selectJudgment());
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    ...existing,
    projectKey: input.projectKey,
    projectId,
    statusMap,
    issueTypes: issueTypes.map((t) => ({ id: t.id, name: t.name })),
    priorities: priorities.map((p) => ({ id: p.id, name: p.name })),
    defaultIssueTypeId,
    defaultPriorityId,
    textFormattingRule: info.textFormattingRule,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    versions: versions.map((v) => ({ id: v.id, name: v.name, startDate: v.startDate, releaseDueDate: v.releaseDueDate, archived: v.archived })),
    resolutions: resolutions.map((r) => ({ id: r.id, name: r.name })),
    resolutionFixedId,
    myselfId: me.id,
    vcs,
    fieldRules,
    judgment,
    resolvedAt: new Date().toISOString(),
  }, null, 2), "utf8");

  return {
    ok: true, me, projectId, defaultIssueTypeId, defaultPriorityId,
    vcs, textFormattingRule: info.textFormattingRule, resolutionFixedId, judgment, warnings,
  };
}
