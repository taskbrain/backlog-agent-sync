import type { StatusMap } from "../types.js";
import type { TrackerAdapter } from "./adapter.js";
import type { BacklogRest, IssueRef, FoundIssue, CreateIssueInput } from "./backlog-rest.js";

// Backlog 既定ステータス名 → 正準キー。カスタム名は displayOrder で近似。
const NAME_TO_KEY: Record<string, keyof StatusMap> = {
  "未対応": "open", "open": "open",
  "処理中": "in_progress", "in progress": "in_progress",
  "処理済み": "resolved", "resolved": "resolved",
  "完了": "closed", "closed": "closed",
};

/** ステータス表示名 → 正準キー。カスタム名など未知の場合は undefined。 */
export function statusNameToKey(name: string): keyof StatusMap | undefined {
  const t = name.trim();
  return NAME_TO_KEY[t.toLowerCase()] ?? NAME_TO_KEY[t];
}

export class BacklogAdapter implements TrackerAdapter {
  constructor(private readonly rest: Pick<BacklogRest, "getProjectStatuses" | "createIssue" | "updateIssue" | "addComment" | "findIssues">, private readonly projectKey: string) {}

  async getStatusMap(): Promise<StatusMap> {
    const statuses = await this.rest.getProjectStatuses(this.projectKey);
    const map: StatusMap = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
    for (const s of statuses) {
      const key = statusNameToKey(s.name);
      if (key) map[key] = s.id;
    }
    // 取得できなかったキーは displayOrder（配列順）でフォールバック
    const order: (keyof StatusMap)[] = ["open", "in_progress", "resolved", "closed"];
    order.forEach((k, i) => { if (!map[k] && statuses[i]) map[k] = statuses[i].id; });
    return map;
  }

  createIssue(input: CreateIssueInput): Promise<IssueRef> {
    return this.rest.createIssue(input);
  }

  async setStatus(issueIdOrKey: string | number, statusId: number, comment?: string, resolutionId?: number): Promise<void> {
    // resolutionId=0（対応済み）は有効値のため != null で判定（falsy 罠回避）
    await this.rest.updateIssue({ issueIdOrKey, statusId, ...(comment ? { comment } : {}), ...(resolutionId != null ? { resolutionId } : {}) });
  }

  async addComment(issueIdOrKey: string | number, content: string): Promise<void> {
    await this.rest.addComment(issueIdOrKey, content);
  }

  async findByMarker(marker: string): Promise<FoundIssue | undefined> {
    const found = await this.rest.findIssues({ keyword: marker, count: 1 });
    return found[0]; // findIssues は status 名（FoundIssue.status）を含む
  }
}
