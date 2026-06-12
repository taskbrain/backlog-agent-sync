import { normalizeAuto, readStdin } from "./events/normalize.js";
import { runSessionStart } from "./lifecycle/session-start.js";
import { runUserPromptSubmit } from "./lifecycle/user-prompt-submit.js";
import { runPostTool } from "./lifecycle/post-tool.js";
import { runSubagentStop } from "./lifecycle/subagent-stop.js";
import { runStop } from "./lifecycle/stop.js";
import { runSessionEnd } from "./lifecycle/session-end.js";
import type { LifecycleEvent } from "./types.js";
import type { SeedLedger } from "./seed/apply.js";

export interface ParsedArgs { cmd: string; event?: LifecycleEvent; dryRun?: boolean; planPath?: string; sessionId?: string; vcs?: "github" | "backlog" | "generic"; }

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  const known = ["hook", "init", "seed", "pull", "status", "flush"];
  if (!cmd || !known.includes(cmd)) return { cmd: "help" };
  if (cmd === "hook") return { cmd, event: rest[0] as LifecycleEvent };
  if (cmd === "init") {
    const out: ParsedArgs = { cmd };
    const i = rest.indexOf("--vcs");
    const v = i >= 0 ? rest[i + 1] : undefined;
    if (v === "github" || v === "backlog" || v === "generic") out.vcs = v;
    return out;
  }
  if (cmd === "seed") {
    const out: ParsedArgs = { cmd, dryRun: rest.includes("--dry-run") };
    const i = rest.indexOf("--plan");
    if (i >= 0 && rest[i + 1]) out.planPath = rest[i + 1];
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

function emit(out: { additionalContext?: string }): void {
  if (out.additionalContext) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: out.additionalContext } }) + "\n");
  }
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.cmd === "help") {
    process.stdout.write("backlog-sync <init [--vcs github|backlog|generic]|seed [--plan <file>] [--dry-run]|hook <event>|pull [--session <id>]|status|flush [--session <id>]>\n");
    return;
  }
  if (parsed.cmd === "hook" && parsed.event) {
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
    const res = await runInit(
      { cwd, projectKey, projectId: deps.projectId || undefined, vcsOverride: parsed.vcs },
      { adapter: deps.adapter, rest },
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
