import { relative, basename, isAbsolute } from "node:path";
import type { CanonicalEvent } from "../types.js";
import type { LifecycleDeps, HookOutput } from "./session-start.js";

export const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COMMAND_MAX = 80;

/** cwd 配下なら相対パス、そうでなければ basename。 */
function relativizePath(filePath: string, cwd: string): string {
  const rel = relative(cwd, filePath);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return basename(filePath);
}

/** ツール毎の要旨: ファイル系→file_path、Bash→command 先頭80字（改行→空白）。それ以外は無し。 */
function buildDetail(ev: CanonicalEvent): string | undefined {
  if (ev.toolName && FILE_TOOLS.has(ev.toolName) && ev.toolInput?.filePath) {
    return relativizePath(ev.toolInput.filePath, ev.cwd);
  }
  if (ev.toolName === "Bash" && ev.toolInput?.command) {
    return ev.toolInput.command.replace(/\s+/g, " ").trim().slice(0, COMMAND_MAX);
  }
  return undefined;
}

export async function runPostTool(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store } = deps;
  const key = `post:${ev.toolUseId ?? ev.toolName ?? ""}`;
  const fresh = await store.markProcessed(ev.sessionId, key);
  if (!fresh) return {}; // 二重起動を冪等に無視
  const detail = buildDetail(ev);
  await store.withLock(ev.sessionId, (s) => {
    s.activityBuffer.push({
      ts: new Date().toISOString(),
      tool: ev.toolName ?? "unknown",
      summary: ev.toolName ?? "",
      ...(detail ? { detail } : {}),
    });
  });
  return {};
}
