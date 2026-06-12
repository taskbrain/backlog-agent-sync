import { execFile } from "node:child_process";

/** git 実行関数（テスト用 DI ポイント）。失敗時は undefined を解決し、例外を漏らさない。 */
export type GitExec = (cwd: string, args: string[]) => Promise<string | undefined>;

const defaultExec: GitExec = (cwd, args) =>
  new Promise((resolve) => {
    try {
      // シェル非経由（execFile）でインジェクションを避ける
      execFile("git", args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        resolve(err ? undefined : String(stdout));
      });
    } catch {
      resolve(undefined);
    }
  });

export async function headSha(cwd: string, exec: GitExec = defaultExec): Promise<string | undefined> {
  const out = await exec(cwd, ["rev-parse", "HEAD"]);
  const sha = out?.trim();
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
}

export async function branchName(cwd: string, exec: GitExec = defaultExec): Promise<string | undefined> {
  const out = await exec(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = out?.trim();
  return name || undefined;
}

export interface CommitInfo { sha: string; subject: string; }
export interface CommitsResult { commits: CommitInfo[]; reason?: string; }

/**
 * fromSha..HEAD のコミット列挙（新しい順）。
 * fromSha 不在/到達不能（amend/rebase 後等）は空配列 + reason を返す。
 */
export async function commitsBetween(cwd: string, fromSha: string, exec: GitExec = defaultExec): Promise<CommitsResult> {
  const out = await exec(cwd, ["rev-list", "--format=%H%x09%s", `${fromSha}..HEAD`]);
  if (out === undefined) return { commits: [], reason: "コミット列挙不可（開始点が履歴に見つからない可能性）" };
  const commits: CommitInfo[] = [];
  for (const line of out.split("\n")) {
    // rev-list --format は "commit <sha>" 行とフォーマット行のペアを出力する
    if (!line || line.startsWith("commit ")) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    commits.push({ sha: line.slice(0, tab), subject: line.slice(tab + 1) });
  }
  return { commits };
}

/** push 判定: リモート追跡ブランチに含まれるか（fetch はしない = 誤判定は注記で吸収）。 */
export async function isOnRemote(cwd: string, sha: string, exec: GitExec = defaultExec): Promise<boolean> {
  const out = await exec(cwd, ["branch", "-r", "--contains", sha]);
  return !!out && out.trim().length > 0;
}

/** lifecycle へ注入する git 操作の束（LifecycleDeps.git。未指定なら実 git）。 */
export interface GitOps {
  headSha(cwd: string): Promise<string | undefined>;
  branchName(cwd: string): Promise<string | undefined>;
  commitsBetween(cwd: string, fromSha: string): Promise<CommitsResult>;
  isOnRemote(cwd: string, sha: string): Promise<boolean>;
}

export const defaultGitOps: GitOps = {
  headSha: (cwd) => headSha(cwd),
  branchName: (cwd) => branchName(cwd),
  commitsBetween: (cwd, fromSha) => commitsBetween(cwd, fromSha),
  isOnRemote: (cwd, sha) => isOnRemote(cwd, sha),
};
