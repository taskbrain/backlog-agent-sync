import { normalizeClaude, readStdin } from "./events/normalize.js";
import { runSessionStart } from "./lifecycle/session-start.js";
import { runPostTool } from "./lifecycle/post-tool.js";
import { runStop } from "./lifecycle/stop.js";
import { runSessionEnd } from "./lifecycle/session-end.js";
import type { LifecycleEvent } from "./types.js";

export interface ParsedArgs { cmd: string; event?: LifecycleEvent; dryRun?: boolean; }

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  const known = ["hook", "init", "seed", "pull", "status", "flush"];
  if (!cmd || !known.includes(cmd)) return { cmd: "help" };
  if (cmd === "hook") return { cmd, event: rest[0] as LifecycleEvent };
  if (cmd === "seed") return { cmd, dryRun: rest.includes("--dry-run") };
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
    process.stdout.write("backlog-sync <init|seed|hook <event>|pull|status|flush>\n");
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
  // init / seed / pull / status / flush は P1 検証・後続フェーズで CLI から実呼び出しする。
  process.stdout.write(`backlog-sync: '${parsed.cmd}' は対話コマンド（後続で配線）\n`);
}
