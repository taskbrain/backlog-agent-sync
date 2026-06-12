import type { StatusMap } from "../types.js";
import type { IssueRef, FoundIssue, CreateIssueInput } from "./backlog-rest.js";

export interface TrackerAdapter {
  getStatusMap(): Promise<StatusMap>;
  createIssue(input: CreateIssueInput): Promise<IssueRef>;
  /** resolutionId は 0 もあり得る（「対応済み」）。呼出側は != null で有無を判定する。 */
  setStatus(issueIdOrKey: string | number, statusId: number, comment?: string, resolutionId?: number): Promise<void>;
  addComment(issueIdOrKey: string | number, content: string): Promise<void>;
  /** 説明文のみの更新（依頼内容の v3 PATCH 用）。 */
  updateDescription(issueIdOrKey: string | number, description: string): Promise<void>;
  /** マーカー検索。status は現在のステータス名（取得できる実装のみ・optional） */
  findByMarker(marker: string): Promise<FoundIssue | undefined>;
}
