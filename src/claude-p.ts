import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

/** claude -p を起動する低レベル実行関数（テストで差し替え可能）。 */
export type ExecFn = (cmd: string, args: string[], opts: { timeout: number; cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

export const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout, cwd: opts.cwd, env: opts.env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

/** claude -p の既定タイムアウト（ms）。 */
export const DEFAULT_CLAUDE_P_TIMEOUT_MS = 45000;

/**
 * claude -p を 1 ターンで起動し stdout を返す共通ランナー。
 * - 再帰防止: 子プロセスへ BACKLOG_SYNC_IN_HOOK=1 を付与（hook CLI 入口で即 return）
 * - cwd は os.tmpdir(): プロジェクトフックの誤発火と CLAUDE.md 読込を回避
 * 失敗（ENOENT/timeout 等）は例外として呼出側へ伝播する（握り潰さない）。
 * @param args  claude へ渡す引数全体（["-p", input, "--output-format", "json", ...]）
 */
export async function runClaudeP(args: string[], opts: { timeoutMs?: number; exec?: ExecFn } = {}): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const { stdout } = await exec("claude", args, {
    timeout: opts.timeoutMs ?? DEFAULT_CLAUDE_P_TIMEOUT_MS,
    cwd: tmpdir(),
    env: { ...process.env, BACKLOG_SYNC_IN_HOOK: "1" },
  });
  return stdout;
}
