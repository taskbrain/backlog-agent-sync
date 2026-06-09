import { normalizeClaude, readStdin } from "./events/normalize.js";
import { runSessionStart } from "./lifecycle/session-start.js";
import { runPostTool } from "./lifecycle/post-tool.js";
import { runStop } from "./lifecycle/stop.js";
import { runSessionEnd } from "./lifecycle/session-end.js";
import type { LifecycleEvent } from "./types.js";

export interface ParsedArgs { cmd: string; event?: LifecycleEvent; dryRun?: boolean; planPath?: string; }

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  const known = ["hook", "init", "seed", "pull", "status", "flush"];
  if (!cmd || !known.includes(cmd)) return { cmd: "help" };
  if (cmd === "hook") return { cmd, event: rest[0] as LifecycleEvent };
  if (cmd === "seed") {
    const out: ParsedArgs = { cmd, dryRun: rest.includes("--dry-run") };
    const i = rest.indexOf("--plan");
    if (i >= 0 && rest[i + 1]) out.planPath = rest[i + 1];
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
    process.stdout.write("backlog-sync <init|seed [--plan <file>] [--dry-run]|hook <event>|pull|status|flush>\n");
    return;
  }
  if (parsed.cmd === "hook" && parsed.event) {
    const raw = await readStdin();
    const ev = normalizeClaude(parsed.event, raw);
    if (!ev.sessionId) return; // 識別子が無ければ無視（非ブロッキング）
    const { buildRuntime } = await import("./runtime.js");
    const { deps } = await buildRuntime(ev.cwd);
    if (parsed.event === "session-start") emit(await runSessionStart(ev, deps));
    else if (parsed.event === "post-tool") await runPostTool(ev, deps);
    else if (parsed.event === "stop") await runStop(ev, deps);
    else if (parsed.event === "session-end") await runSessionEnd(ev, deps);
    return;
  }
  if (parsed.cmd === "init") {
    const cwd = process.cwd();
    const { buildRuntime } = await import("./runtime.js");
    const { deps, rest, projectKey } = await buildRuntime(cwd);
    const { runInit } = await import("./init.js");
    const res = await runInit({ cwd, projectKey, projectId: deps.projectId || undefined }, { adapter: deps.adapter, rest });
    process.stdout.write(`init OK: project=${projectKey} projectId=${res.projectId} user=${res.me.name}\n`);
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
    const plan = {
      projectId: planRaw.projectId ?? deps.projectId,
      issueTypeId: planRaw.issueTypeId,
      priorityId: planRaw.priorityId,
      epics: planRaw.epics ?? [],
    };
    const res = await applySeed(plan as any, { adapter: deps.adapter, dryRun: parsed.dryRun });
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  // pull / status / flush は後続フェーズ（pull=P4、status/flush=ユーティリティ）で配線。
  process.stdout.write(`backlog-sync: '${parsed.cmd}' は後続フェーズで配線\n`);
}
