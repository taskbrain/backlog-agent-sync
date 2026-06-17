import { normalizeAuto, readStdin } from "./events/normalize.js";
import { runSessionStart } from "./lifecycle/session-start.js";
import { runUserPromptSubmit } from "./lifecycle/user-prompt-submit.js";
import { runPostTool } from "./lifecycle/post-tool.js";
import { runSubagentStop } from "./lifecycle/subagent-stop.js";
import { runStop } from "./lifecycle/stop.js";
import { runSessionEnd } from "./lifecycle/session-end.js";
import type { LifecycleEvent } from "./types.js";
import type { SeedLedger } from "./seed/apply.js";
import type { JudgmentChoice } from "./init.js";

export interface ParsedArgs {
  cmd: string;
  event?: LifecycleEvent;
  dryRun?: boolean;
  planPath?: string;
  sessionId?: string;
  vcs?: "github" | "backlog" | "generic";
  prune?: boolean;
  recreate?: boolean;
  target?: "wiki" | "documents";
  /** init の判定モデル選択（--judgment）。未指定なら既存挙動（既存設定保持 → なければ auto）。 */
  judgment?: JudgmentChoice;
}

/** --judgment の値を JudgmentChoice へ正規化（"auto" は "default" の別名）。不正値は undefined。 */
function parseJudgmentChoice(v: string | undefined): JudgmentChoice | undefined {
  if (v === "auto") return "default"; // auto = claude 既定モデル（backend=auto）
  if (v === "default" || v === "haiku" || v === "sonnet" || v === "opus" || v === "fable" || v === "deterministic") return v;
  return undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  const known = ["hook", "init", "seed", "pull", "status", "flush", "docs"];
  if (!cmd || !known.includes(cmd)) return { cmd: "help" };
  if (cmd === "hook") return { cmd, event: rest[0] as LifecycleEvent };
  if (cmd === "init") {
    const out: ParsedArgs = { cmd };
    const i = rest.indexOf("--vcs");
    const v = i >= 0 ? rest[i + 1] : undefined;
    if (v === "github" || v === "backlog" || v === "generic") out.vcs = v;
    const j = rest.indexOf("--judgment");
    const choice = parseJudgmentChoice(j >= 0 ? rest[j + 1] : undefined);
    if (choice) out.judgment = choice;
    return out;
  }
  if (cmd === "seed") {
    const out: ParsedArgs = { cmd, dryRun: rest.includes("--dry-run") };
    const i = rest.indexOf("--plan");
    if (i >= 0 && rest[i + 1]) out.planPath = rest[i + 1];
    return out;
  }
  if (cmd === "docs") {
    const out: ParsedArgs = { cmd, dryRun: rest.includes("--dry-run"), prune: rest.includes("--prune"), recreate: rest.includes("--recreate") };
    const i = rest.indexOf("--target");
    const t = i >= 0 ? rest[i + 1] : undefined;
    if (t === "wiki" || t === "documents") out.target = t;
    return out;
  }
  if (cmd === "pull" || cmd === "flush") {
    const out: ParsedArgs = { cmd };
    const i = rest.indexOf("--session");
    if (i >= 0 && rest[i + 1]) out.sessionId = rest[i + 1];
    return out;
  }
  return { cmd };
}

// APIキー混入警告は 1 プロセス 1 回に抑制する（フック/CLI が複数回 main を呼んでも重複させない）。
let apiKeyWarned = false;

/** テスト用: 1回抑制フラグをリセットする。 */
export function __resetApiKeyWarning(): void {
  apiKeyWarned = false;
}

/**
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN が環境に存在する場合、judgment が API 従量課金を
 * 回避するため決定論へフォールバックする旨を 1 回だけ警告する（告知のみ・ガードは judgment 側で実装済み）。
 */
export function warnIfApiKeyPresent(write: (s: string) => void = (s) => process.stderr.write(s)): void {
  if (apiKeyWarned) return;
  const hit = process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : process.env.ANTHROPIC_AUTH_TOKEN ? "ANTHROPIC_AUTH_TOKEN" : undefined;
  if (!hit) return;
  apiKeyWarned = true;
  write(`backlog-sync: ${hit} が設定されています。claude -p がサブスクではなく API 従量課金になる恐れがあるため、判定は API 課金回避のため決定論にフォールバックします。\n`);
}

function emit(out: { additionalContext?: string }): void {
  if (out.additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out.additionalContext } }) + "\n");
  }
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  // APIキー混入の告知（1回）。再帰起動された claude -p 子プロセス（BACKLOG_SYNC_IN_HOOK=1）では出さない。
  if (!process.env.BACKLOG_SYNC_IN_HOOK) warnIfApiKeyPresent();
  if (parsed.cmd === "help") {
    process.stdout.write("backlog-sync <init [--vcs github|backlog|generic] [--judgment default|haiku|sonnet|opus|fable|deterministic|auto]|seed [--plan <file>] [--dry-run]|docs [--dry-run] [--prune] [--recreate] [--target wiki|documents]|hook <event>|pull [--session <id>]|status|flush [--session <id>]>\n");
    return;
  }
  if (parsed.cmd === "hook" && parsed.event) {
    // 再帰ガード: summarize の `claude -p` 子プロセスが発火させたフックは即終了（無限再帰防止）
    if (process.env.BACKLOG_SYNC_IN_HOOK) return;
    const raw = await readStdin();
    const ev = normalizeAuto(parsed.event, raw);
    if (!ev || !ev.sessionId) return; // 識別子が無ければ無視（非ブロッキング）
    const { buildRuntime } = await import("./runtime.js");
    // state の置き場はセッションの一時 cwd でなくプロジェクトルートに固定する
    const root = process.env.BACKLOG_SYNC_ROOT || process.env.CLAUDE_PROJECT_DIR || ev.cwd;
    const { deps } = await buildRuntime(root);
    if (parsed.event === "session-start") emit(await runSessionStart(ev, deps));
    else if (parsed.event === "user-prompt-submit") await runUserPromptSubmit(ev, deps);
    else if (parsed.event === "post-tool") await runPostTool(ev, deps);
    else if (parsed.event === "subagent-stop") await runSubagentStop(ev, deps);
    else if (parsed.event === "stop") await runStop(ev, deps);
    else if (parsed.event === "session-end") await runSessionEnd(ev, deps);
    return;
  }
  if (parsed.cmd === "init") {
    const cwd = process.cwd();
    const { buildRuntime } = await import("./runtime.js");
    const { deps, rest, projectKey } = await buildRuntime(cwd);
    const { runInit } = await import("./init.js");
    // --judgment 指定時のみ選択を伝播（runInit は既存 project.json の judgment があれば selectJudgment を呼ばないため、
    // 既存設定保持 → なければ選択 → 選択も無ければ auto、の優先順は runInit 側で担保される）。
    const judgmentChoice = parsed.judgment;
    const res = await runInit(
      { cwd, projectKey, projectId: deps.projectId || undefined, vcsOverride: parsed.vcs },
      {
        adapter: deps.adapter,
        rest,
        ...(judgmentChoice ? { selectJudgment: async () => judgmentChoice } : {}),
      },
    );
    process.stdout.write(`init OK: project=${projectKey} projectId=${res.projectId} user=${res.me.name} issueTypeId=${res.defaultIssueTypeId ?? "-"} priorityId=${res.defaultPriorityId ?? "-"} vcs=${res.vcs.kind} textFormattingRule=${res.textFormattingRule}\n`);
    for (const w of res.warnings) process.stdout.write(`WARN: ${w}\n`);
    return;
  }
  if (parsed.cmd === "seed") {
    const cwd = process.cwd();
    const { buildRuntime } = await import("./runtime.js");
    const { deps } = await buildRuntime(cwd);
    let planRaw: Record<string, any>;
    if (parsed.planPath) {
      const { readFile } = await import("node:fs/promises");
      planRaw = JSON.parse(await readFile(parsed.planPath, "utf8"));
    } else {
      planRaw = await readStdin();
    }
    const { applySeed } = await import("./seed/apply.js");
    const { loadSeedLedger, saveSeedLedger } = await import("./seed/ledger.js");
    const { seedLedgerPath } = await import("./config.js");
    const ledgerPath = seedLedgerPath(cwd);
    const plan = {
      projectId: planRaw.projectId ?? deps.projectId,
      issueTypeId: planRaw.issueTypeId,
      priorityId: planRaw.priorityId,
      epics: planRaw.epics ?? [],
    };
    const res = await applySeed(plan as any, {
      adapter: deps.adapter,
      dryRun: parsed.dryRun,
      defaultIssueTypeId: deps.issueTypeId,
      defaultPriorityId: deps.priorityId,
      // 台帳はプレビュー精度のため常に読む。保存は dry-run では行わない
      loadLedger: () => loadSeedLedger(ledgerPath),
      ...(parsed.dryRun ? {} : { saveLedger: (l: SeedLedger) => saveSeedLedger(ledgerPath, l) }),
    });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (parsed.cmd === "docs") {
    const cwd = process.cwd();
    const { buildRuntime } = await import("./runtime.js");
    const { deps, rest } = await buildRuntime(cwd);
    const { readFile } = await import("node:fs/promises");
    const { projectConfigPath, docsLedgerPath } = await import("./config.js");
    let cfg: import("./types.js").DocsSyncConfig = {};
    try {
      cfg = (JSON.parse(await readFile(projectConfigPath(cwd), "utf8")) as import("./types.js").ProjectCache).docsSync ?? {};
    } catch {
      // project.json 未作成/設定なし → 既定値（root=docs, target=wiki）で実行
    }
    const { runDocsSync } = await import("./docs/sync.js");
    const { loadDocsLedger, saveDocsLedger } = await import("./docs/ledger.js");
    const ledgerPath = docsLedgerPath(cwd);
    const res = await runDocsSync(
      { repoRoot: cwd, cfg, dryRun: parsed.dryRun, prune: parsed.prune, recreate: parsed.recreate, target: parsed.target },
      {
        rest,
        projectId: deps.projectId,
        textFormattingRule: deps.textFormattingRule,
        vcs: deps.vcs,
        git: deps.git,
        loadLedger: () => loadDocsLedger(ledgerPath),
        // dry-run は台帳も書かない（書込なし保証）
        ...(parsed.dryRun ? {} : { saveLedger: (l: import("./docs/ledger.js").DocsLedger) => saveDocsLedger(ledgerPath, l) }),
      },
    );
    for (const p of res.preview) process.stdout.write(`${p.action.padEnd(6)} ${p.pageName}\n`);
    for (const w of res.warnings) process.stdout.write(`WARN: ${w}\n`);
    process.stdout.write(`docs sync: created=${res.created} updated=${res.updated} skipped=${res.skipped} pruned=${res.pruned}${parsed.dryRun ? " (dry-run)" : ""}\n`);
    return;
  }
  if (parsed.cmd === "pull") {
    const cwd = process.cwd();
    const { buildRuntime } = await import("./runtime.js");
    const { deps, rest } = await buildRuntime(cwd);
    const { runPull, formatDigest } = await import("./inbound/pull.js");
    const digest = await runPull({ rest, store: deps.store, sessionId: parsed.sessionId, projectId: deps.projectId || undefined });
    process.stdout.write(formatDigest(digest) + "\n");
    process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
    return;
  }
  if (parsed.cmd === "status") {
    const cwd = process.cwd();
    const { StateStore } = await import("./state/store.js");
    const { stateDirFor } = await import("./config.js");
    const store = new StateStore(stateDirFor(cwd));
    const sessions = await store.listSessions();
    if (!sessions.length) { process.stdout.write("同期セッションなし\n"); return; }
    for (const s of sessions) {
      process.stdout.write(`session=${s.sessionId} issue=${s.issueKey ?? "-"} status=${s.lastStatus ?? "-"} queue=${s.pendingQueue?.length ?? 0} buffer=${s.activityBuffer?.length ?? 0}\n`);
    }
    return;
  }
  if (parsed.cmd === "flush") {
    const cwd = process.cwd();
    const { buildRuntime } = await import("./runtime.js");
    const { deps } = await buildRuntime(cwd);
    const sessions = await deps.store.listSessions();
    const targets = parsed.sessionId ? sessions.filter((s) => s.sessionId === parsed.sessionId) : sessions;
    if (!targets.length) { process.stdout.write("同期セッションなし\n"); return; }
    for (const s of targets) {
      const before = s.pendingQueue?.length ?? 0;
      if (before === 0) { process.stdout.write(`${s.sessionId}: キュー 0 件\n`); continue; }
      const { opDrainHandler } = await import("./lifecycle/session-start.js");
      await deps.store.drain(s.sessionId, async (op) => {
        if (!s.issueKey) return false; // 課題未紐付の op は残置
        return opDrainHandler(deps.adapter, s.issueKey)(op); // resolutionId を含む再送経路を共通化
      });
      const after = (await deps.store.loadOrCreate(s.sessionId)).pendingQueue.length;
      process.stdout.write(`${s.sessionId}: 排出 ${before - after}/${before} 件（残 ${after}）\n`);
    }
    return;
  }
  process.stdout.write(`backlog-sync: 不明なコマンド '${parsed.cmd}'\n`);
}
