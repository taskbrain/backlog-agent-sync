import type { StatusMap } from "../types.js";
import type { IssueRef, CreateIssueInput } from "./backlog-rest.js";

export interface TrackerAdapter {
  getStatusMap(): Promise<StatusMap>;
  createIssue(input: CreateIssueInput): Promise<IssueRef>;
  setStatus(issueIdOrKey: string | number, statusId: number, comment?: string): Promise<void>;
  addComment(issueIdOrKey: string | number, content: string): Promise<void>;
  findByMarker(marker: string): Promise<IssueRef | undefined>;
}
