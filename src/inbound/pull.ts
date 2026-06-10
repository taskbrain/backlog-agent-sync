import type { StateStore } from "../state/store.js";
import type { BacklogRest } from "../tracker/backlog-rest.js";

export type PullRest = Pick<BacklogRest, "getMyself" | "findIssues" | "getComments">;

export interface InboundIssue { issueKey: string; summary: string; status: string; updated: string; }
export interface InboundComment { issueKey: string; id: number; content: string; createdUser: string; }
export interface InboundDigest { issues: InboundIssue[]; comments: InboundComment[]; }

export interface PullDeps {
  rest: PullRest;
  /** store + sessionId が揃っていればカーソルを SessionState.inboundCursor に保存。無くても動作する（直近分のみ）。 */
  store?: StateStore;
  sessionId?: string;
  projectId?: number;
}

const ISSUE_COUNT = 20; // pull は search カテゴリを消費するため控えめに制限
const CONTENT_MAX = 200;

export async function runPull(deps: PullDeps): Promise<InboundDigest> {
  const me = await deps.rest.getMyself();

  let cursor: { issuesUpdatedSince?: string; commentMaxId?: Record<string, number> } | undefined;
  if (deps.store && deps.sessionId) {
    cursor = (await deps.store.loadOrCreate(deps.sessionId)).inboundCursor;
  }

  const found = await deps.rest.findIssues({
    projectId: deps.projectId,
    assigneeId: [me.id],
    // updatedSince は日付（yyyy-MM-dd・当日含む）。重複分はコメントカーソルが排除する
    updatedSince: cursor?.issuesUpdatedSince?.slice(0, 10),
    sort: "updated",
    count: ISSUE_COUNT,
  });

  const issues: InboundIssue[] = [];
  const comments: InboundComment[] = [];
  let maxUpdated = cursor?.issuesUpdatedSince;
  const commentMaxId: Record<string, number> = { ...(cursor?.commentMaxId ?? {}) };

  for (const it of found) {
    issues.push({ issueKey: it.issueKey, summary: it.summary ?? "", status: it.status ?? "", updated: it.updated ?? "" });
    if (it.updated && (!maxUpdated || it.updated > maxUpdated)) maxUpdated = it.updated;
    const minId = commentMaxId[it.issueKey];
    let fetched;
    try {
      fetched = await deps.rest.getComments(it.issueKey, { minId });
    } catch {
      continue; // 個別課題のコメント取得失敗は握りつぶす（部分的な digest を返す）
    }
    for (const c of fetched) {
      if (minId !== undefined && c.id <= minId) continue; // minId が inclusive な場合の重複排除
      comments.push({ issueKey: it.issueKey, id: c.id, content: (c.content ?? "").slice(0, CONTENT_MAX), createdUser: c.createdUser?.name ?? "" });
      if (!commentMaxId[it.issueKey] || c.id > commentMaxId[it.issueKey]) commentMaxId[it.issueKey] = c.id;
    }
  }

  if (deps.store && deps.sessionId) {
    await deps.store.withLock(deps.sessionId, (s) => {
      s.inboundCursor = { issuesUpdatedSince: maxUpdated, commentMaxId };
    });
  }

  return { issues, comments };
}

export function formatDigest(d: InboundDigest): string {
  if (!d.issues.length && !d.comments.length) return "Backlog 新着: なし";
  const lines: string[] = ["Backlog 新着:"];
  for (const i of d.issues) lines.push(`- [${i.issueKey}] ${i.summary} (${i.status} / ${i.updated})`);
  for (const c of d.comments) lines.push(`- [${c.issueKey}] コメント#${c.id} ${c.createdUser}: ${c.content}`);
  return lines.join("\n");
}
