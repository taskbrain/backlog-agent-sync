import type { VcsConfig } from "../types.js";

// URL 形式は本モジュールに閉じ込める（変更時はここだけ直す）。
// 注意: Backlog Git の Web UI URL（/git/<PROJ>/<repo>/blob|commit|pullRequests）は
// 公式リファレンス非掲載（gitb 実装由来）。Backlog 側の UI 変更でリンク切れし得る。

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function githubBase(vcs: VcsConfig): string | undefined {
  return vcs.owner && vcs.repo ? `https://github.com/${vcs.owner}/${vcs.repo}` : undefined;
}

function backlogBase(vcs: VcsConfig): string | undefined {
  return vcs.webBase && vcs.projectKey && vcs.repoName
    ? `${vcs.webBase}/git/${vcs.projectKey}/${vcs.repoName}`
    : undefined;
}

/** リポジトリトップ URL（課題説明の「リポジトリ:」リンク用）。generic は undefined。 */
export function repoUrl(vcs: VcsConfig): string | undefined {
  if (vcs.kind === "github") return githubBase(vcs);
  if (vcs.kind === "backlog") return backlogBase(vcs);
  return undefined;
}

/** ファイル permalink。rev はそのターンの HEAD SHA。行アンカーは github のみ（Backlog 形式は未確認）。 */
export function fileUrl(vcs: VcsConfig, path: string, rev: string, lines?: { start: number; end?: number }): string | undefined {
  if (vcs.kind === "github") {
    const base = githubBase(vcs);
    if (!base) return undefined;
    const anchor = lines ? (lines.end && lines.end !== lines.start ? `#L${lines.start}-L${lines.end}` : `#L${lines.start}`) : "";
    return `${base}/blob/${rev}/${encodePath(path)}${anchor}`;
  }
  if (vcs.kind === "backlog") {
    const base = backlogBase(vcs);
    if (!base) return undefined;
    return `${base}/blob/${rev}/${encodePath(path)}`;
  }
  return undefined;
}

export function commitUrl(vcs: VcsConfig, sha: string): string | undefined {
  if (vcs.kind === "github") {
    const base = githubBase(vcs);
    return base ? `${base}/commit/${sha}` : undefined;
  }
  if (vcs.kind === "backlog") {
    const base = backlogBase(vcs);
    return base ? `${base}/commit/${sha}` : undefined;
  }
  return undefined;
}

export function prUrl(vcs: VcsConfig, number: number): string | undefined {
  if (vcs.kind === "github") {
    const base = githubBase(vcs);
    return base ? `${base}/pull/${number}` : undefined;
  }
  if (vcs.kind === "backlog") {
    const base = backlogBase(vcs);
    return base ? `${base}/pullRequests/${number}` : undefined;
  }
  return undefined;
}
