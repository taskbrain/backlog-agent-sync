import type { StatusMap } from "../types.js";
import type { IssueRef, FoundIssue, CreateIssueInput } from "./backlog-rest.js";

export interface TrackerAdapter {
  getStatusMap(): Promise<StatusMap>;
  createIssue(input: CreateIssueInput): Promise<IssueRef>;
  setStatus(issueIdOrKey: string | number, statusId: number, comment?: string): Promise<void>;
  addComment(issueIdOrKey: string | number, content: string): Promise<void>;
  /** マーカー検索。status は現在のステータス名（取得できる実装のみ・optional） */
  findByMarker(marker: string): Promise<FoundIssue | undefined>;
}
