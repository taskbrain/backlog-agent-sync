import type { BacklogConfig } from "../types.js";
import { RateLimiter, type RateCategory } from "./rate-limiter.js";

export interface IssueRef { id: number; issueKey: string; }
/** findIssues の詳細付き結果（既存呼出に対し後方互換の optional 拡張）。 */
export interface FoundIssue extends IssueRef { summary?: string; status?: string; updated?: string; }
export interface IssueComment { id: number; content: string; createdUser: { id: number; name: string }; created: string; }
export interface StatusDef { id: number; name: string; }
export interface IssueTypeDef { id: number; name: string; }
export interface PriorityDef { id: number; name: string; }
export interface ProjectRef { id: number; projectKey: string; name: string; }
export interface CreateIssueInput {
  projectId: number; summary: string; issueTypeId: number; priorityId: number;
  description?: string; parentIssueId?: number; assigneeId?: number;
}
export interface UpdateIssueInput {
  issueIdOrKey: string | number; statusId?: number; comment?: string; summary?: string; description?: string; resolutionId?: number;
}

interface Deps { fetch?: typeof fetch; rateLimiter?: Pick<RateLimiter, "beforeRequest" | "handle429">; }

export class BacklogRest {
  private readonly fetch: typeof fetch;
  private readonly rl: Pick<RateLimiter, "beforeRequest" | "handle429">;
  constructor(private readonly cfg: BacklogConfig, deps: Deps = {}) {
    this.fetch = deps.fetch ?? fetch;
    this.rl = deps.rateLimiter ?? new RateLimiter();
  }

  private base(path: string): string {
    return `https://${this.cfg.domain}/api/v2${path}`;
  }

  private form(params: Record<string, unknown>): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      sp.append(k, String(v));
    }
    return sp.toString();
  }

  private async request(method: string, path: string, category: RateCategory, body?: Record<string, unknown>): Promise<any> {
    const url = `${this.base(path)}?apiKey=${encodeURIComponent(this.cfg.apiKey)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.rl.beforeRequest(category);
      const init: RequestInit = { method };
      if (body) {
        init.body = this.form(body);
        init.headers = { "content-type": "application/x-www-form-urlencoded" };
      }
      const res = await this.fetch(url, init);
      if (res.status === 429 && attempt === 0) {
        await this.rl.handle429(res.headers);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backlog ${method} ${path} -> ${res.status} ${text}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : {};
    }
    throw new Error(`Backlog ${method} ${path} -> 429 (リトライ上限)`);
  }

  async getMyself(): Promise<{ id: number; name: string }> {
    return this.request("GET", "/users/myself", "read");
  }

  async getProject(projectIdOrKey: string | number): Promise<ProjectRef> {
    const r = await this.request("GET", `/projects/${encodeURIComponent(String(projectIdOrKey))}`, "read");
    return { id: r.id, projectKey: r.projectKey, name: r.name };
  }

  async getProjectStatuses(projectKey: string): Promise<StatusDef[]> {
    return this.request("GET", `/projects/${encodeURIComponent(projectKey)}/statuses`, "read");
  }

  async getIssueTypes(projectIdOrKey: string | number): Promise<IssueTypeDef[]> {
    return this.request("GET", `/projects/${encodeURIComponent(String(projectIdOrKey))}/issueTypes`, "read");
  }

  async getPriorities(): Promise<PriorityDef[]> {
    return this.request("GET", "/priorities", "read");
  }

  async createIssue(input: CreateIssueInput): Promise<IssueRef> {
    const r = await this.request("POST", "/issues", "write", input as unknown as Record<string, unknown>);
    return { id: r.id, issueKey: r.issueKey };
  }

  async updateIssue(input: UpdateIssueInput): Promise<void> {
    const { issueIdOrKey, ...rest } = input;
    await this.request("PATCH", `/issues/${encodeURIComponent(String(issueIdOrKey))}`, "write", rest as unknown as Record<string, unknown>);
  }

  async addComment(issueIdOrKey: string | number, content: string): Promise<void> {
    await this.request("POST", `/issues/${encodeURIComponent(String(issueIdOrKey))}/comments`, "write", { content });
  }

  async findIssues(query: { projectId?: number; keyword?: string; assigneeId?: number[]; updatedSince?: string; sort?: string; count?: number }): Promise<FoundIssue[]> {
    const sp = new URLSearchParams();
    sp.append("apiKey", this.cfg.apiKey);
    if (query.projectId) sp.append("projectId[]", String(query.projectId));
    if (query.keyword) sp.append("keyword", query.keyword);
    if (query.updatedSince) sp.append("updatedSince", query.updatedSince);
    if (query.sort) sp.append("sort", query.sort);
    for (const a of query.assigneeId ?? []) sp.append("assigneeId[]", String(a));
    sp.append("count", String(query.count ?? 50));
    const url = `${this.base("/issues")}?${sp.toString()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.rl.beforeRequest("search");
      const res = await this.fetch(url);
      if (res.status === 429 && attempt === 0) { await this.rl.handle429(res.headers); continue; }
      if (!res.ok) throw new Error(`Backlog GET /issues -> ${res.status}`);
      const arr = (await res.json()) as Array<{ id: number; issueKey: string; summary?: string; status?: { name?: string }; updated?: string }>;
      return arr.map((x) => ({ id: x.id, issueKey: x.issueKey, summary: x.summary, status: x.status?.name, updated: x.updated }));
    }
    throw new Error(`Backlog GET /issues -> 429 (リトライ上限)`);
  }

  /** 課題コメント取得。minId は前回取得済み最大 id（それ以降の新着のみ取得）。 */
  async getComments(issueIdOrKey: string | number, opts: { minId?: number; count?: number } = {}): Promise<IssueComment[]> {
    const sp = new URLSearchParams();
    sp.append("apiKey", this.cfg.apiKey);
    if (opts.minId !== undefined) sp.append("minId", String(opts.minId));
    sp.append("order", "asc");
    sp.append("count", String(opts.count ?? 100));
    const url = `${this.base(`/issues/${encodeURIComponent(String(issueIdOrKey))}/comments`)}?${sp.toString()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.rl.beforeRequest("search");
      const res = await this.fetch(url);
      if (res.status === 429 && attempt === 0) { await this.rl.handle429(res.headers); continue; }
      if (!res.ok) throw new Error(`Backlog GET /issues/:key/comments -> ${res.status}`);
      return (await res.json()) as IssueComment[];
    }
    throw new Error(`Backlog GET /issues/:key/comments -> 429 (リトライ上限)`);
  }
}
