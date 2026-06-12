import type { VcsConfig } from "../types.js";

/** remote URL を host/path に分解（https / ssh:// / scp 風の3形式、.git 任意）。 */
function splitUrl(url: string): { host: string; path: string } | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes("://")) {
    // scp 風: [user@]host:path
    const m = trimmed.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (!m) return undefined;
    return { host: m[1], path: m[2].replace(/^\/+/, "") };
  }
  try {
    const u = new URL(trimmed); // https:// と ssh:// の両方を解釈できる
    return { host: u.hostname, path: u.pathname.replace(/^\/+/, "") };
  } catch {
    return undefined;
  }
}

const BACKLOG_DOMAINS = "backlog\\.(?:com|jp)|backlogtool\\.com";
// SSH 系 Backlog Git ホスト: <space>.git.backlog.com|jp / <space>.git.backlogtool.com
const BACKLOG_GIT_HOST = new RegExp(`^([^.]+)\\.git\\.(${BACKLOG_DOMAINS})$`);
// HTTPS 系: <space>.backlog.com|jp 直下の /git/<PROJ>/<repo> パス
const BACKLOG_WEB_HOST = new RegExp(`^[^.]+\\.(?:${BACKLOG_DOMAINS})$`);

/**
 * git remote URL から VCS 種別と参照情報を導出する純関数。
 * - github: host が github.com のみ（GitHub Enterprise は generic）
 * - backlog: git. サブドメインを除去して webBase を組む
 *   例 ssh://xx@xx.git.backlog.jp/PROJ/repo.git → webBase=https://xx.backlog.jp, projectKey=PROJ, repoName=repo
 * - 判定不能 / 情報不足は generic
 */
export function parseRemoteUrl(url: string): VcsConfig {
  const parts = splitUrl(url);
  if (!parts) return { kind: "generic" };
  const host = parts.host.toLowerCase();
  const segs = parts.path.replace(/\.git$/, "").split("/").filter(Boolean);

  if (host === "github.com") {
    const [owner, repo] = segs;
    if (owner && repo) return { kind: "github", owner, repo };
    return { kind: "generic" };
  }

  const gitHost = host.match(BACKLOG_GIT_HOST);
  if (gitHost) {
    const [projectKey, repoName] = segs;
    if (projectKey && repoName) {
      return { kind: "backlog", webBase: `https://${gitHost[1]}.${gitHost[2]}`, projectKey, repoName };
    }
    return { kind: "generic" };
  }

  // HTTPS clone URL（https://space.backlog.jp/git/PROJ/repo.git）も backlog として扱う
  if (BACKLOG_WEB_HOST.test(host) && segs[0] === "git") {
    const [, projectKey, repoName] = segs;
    if (projectKey && repoName) {
      return { kind: "backlog", webBase: `https://${host}`, projectKey, repoName };
    }
  }

  return { kind: "generic" };
}
