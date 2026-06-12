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
  categoryId?: number[]; milestoneId?: number[]; versionId?: number[];
}
export interface UpdateIssueInput {
  issueIdOrKey: string | number; statusId?: number; comment?: string; summary?: string; description?: string;
  /** 注: 「対応済み」は id:0（falsy）。0 も送信される（form() は null/undefined のみ除外）。 */
  resolutionId?: number;
}
export interface CategoryDef { id: number; name: string; }
/** マイルストーンと発生バージョンは共用（GET /projects/:key/versions）。 */
export interface VersionDef { id: number; name: string; startDate?: string; releaseDueDate?: string; archived?: boolean; }
/** 注: 「対応済み」は id:0 が正常値（falsy 罠に注意）。 */
export interface ResolutionDef { id: number; name: string; }
export interface ProjectInfo { id: number; textFormattingRule: string; }
export interface GitRepoDef { id: number; name: string; httpUrl?: string; }
export interface PullRequestDef {
  id: number; number: number; summary: string; branch: string; base: string;
  issue?: { id: number; issueKey: string };
}
export interface WikiRef { id: number; name: string; }
export interface WikiDetail { id: number; name: string; content: string; }
/** Document の id は数値とは限らないため string | number。 */
export interface DocumentRef { id: string | number; title: string; }

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
      if (Array.isArray(v)) {
        // Backlog の配列パラメータは categoryId[] 形式で同名キーを反復送信する
        for (const item of v) sp.append(`${k}[]`, String(item));
      } else {
        sp.append(k, String(v));
      }
    }
    return sp.toString();
  }

  private async request(method: string, path: string, category: RateCategory, body?: Record<string, unknown>): Promise<any> {
    const text = await this.requestText(method, path, category, body);
    return text ? JSON.parse(text) : {};
  }

  /** request と同じ流れで生テキストを返す（wiki/document 系の安全パース用）。 */
  private async requestText(method: string, path: string, category: RateCategory, body?: Record<string, unknown>): Promise<string> {
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
      return res.text();
    }
    throw new Error(`Backlog ${method} ${path} -> 429 (リトライ上限)`);
  }

  /**
   * wiki/document 系レスポンスは本文に生制御文字が混ざることがある（実測）。
   * 素のパースに失敗したら C0 制御文字（\n \r \t を除く）を除去して再試行する。
   */
  private static safeJson(text: string): any {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      try {
        const cleaned = Array.from(text).filter((ch) => {
          const c = ch.charCodeAt(0);
          return c > 0x1f || c === 0x09 || c === 0x0a || c === 0x0d; // タブ/改行のみ許容
        }).join("");
        return JSON.parse(cleaned);
      } catch {
        throw new Error("Backlog 応答の JSON 解析に失敗しました（制御文字除去後も不正）");
      }
    }
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

  async getCategories(projectKey: string): Promise<CategoryDef[]> {
    return this.request("GET", `/projects/${encodeURIComponent(projectKey)}/categories`, "read");
  }

  /** マイルストーンと発生バージョンの共用一覧。 */
  async getVersions(projectKey: string): Promise<VersionDef[]> {
    return this.request("GET", `/projects/${encodeURIComponent(projectKey)}/versions`, "read");
  }

  /** 完了理由一覧。「対応済み」は id:0 が正常値。 */
  async getResolutions(): Promise<ResolutionDef[]> {
    return this.request("GET", "/resolutions", "read");
  }

  /** プロジェクト情報（textFormattingRule: "markdown" | "backlog"）。 */
  async getProjectInfo(projectKey: string): Promise<ProjectInfo> {
    const r = await this.request("GET", `/projects/${encodeURIComponent(projectKey)}`, "read");
    return { id: r.id, textFormattingRule: r.textFormattingRule };
  }

  async getGitRepositories(projectKey: string): Promise<GitRepoDef[]> {
    const arr = await this.request("GET", `/projects/${encodeURIComponent(projectKey)}/git/repositories`, "read");
    return (arr as any[]).map((x) => ({ id: x.id, name: x.name, httpUrl: x.httpUrl }));
  }

  async getGitPullRequests(
    projectKey: string,
    repoIdOrName: string | number,
    query: { statusId?: number[] } = {},
  ): Promise<PullRequestDef[]> {
    const path = `/projects/${encodeURIComponent(projectKey)}/git/repositories/${encodeURIComponent(String(repoIdOrName))}/pullRequests`;
    const sp = new URLSearchParams();
    sp.append("apiKey", this.cfg.apiKey);
    for (const s of query.statusId ?? []) sp.append("statusId[]", String(s));
    const url = `${this.base(path)}?${sp.toString()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.rl.beforeRequest("read");
      const res = await this.fetch(url);
      if (res.status === 429 && attempt === 0) { await this.rl.handle429(res.headers); continue; }
      if (!res.ok) throw new Error(`Backlog GET ${path} -> ${res.status}`);
      const arr = (await res.json()) as any[];
      return arr.map((x) => ({
        id: x.id, number: x.number, summary: x.summary ?? "", branch: x.branch ?? "", base: x.base ?? "",
        issue: x.issue ? { id: x.issue.id, issueKey: x.issue.issueKey } : undefined,
      }));
    }
    throw new Error(`Backlog GET ${path} -> 429 (リトライ上限)`);
  }

  /** PR の更新（課題への関連付けは issueId=数値ID で PATCH）。 */
  async updateGitPullRequest(
    projectKey: string,
    repoIdOrName: string | number,
    number: number,
    patch: { issueId?: number; comment?: string },
  ): Promise<void> {
    const path = `/projects/${encodeURIComponent(projectKey)}/git/repositories/${encodeURIComponent(String(repoIdOrName))}/pullRequests/${number}`;
    await this.request("PATCH", path, "write", patch as Record<string, unknown>);
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

  // ---- Wiki / Document（G21: docs 同期。レスポンスは safeJson で安全にパースし必要フィールドのみ返す） ----

  /** Wiki 一覧（content は返らない）。 */
  async getWikis(projectIdOrKey: string | number): Promise<WikiRef[]> {
    const sp = new URLSearchParams();
    sp.append("apiKey", this.cfg.apiKey);
    sp.append("projectIdOrKey", String(projectIdOrKey));
    const url = `${this.base("/wikis")}?${sp.toString()}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.rl.beforeRequest("search");
      const res = await this.fetch(url);
      if (res.status === 429 && attempt === 0) { await this.rl.handle429(res.headers); continue; }
      if (!res.ok) throw new Error(`Backlog GET /wikis -> ${res.status}`);
      const arr = BacklogRest.safeJson(await res.text());
      return (Array.isArray(arr) ? arr : []).map((x: any) => ({ id: x.id, name: String(x.name ?? "") }));
    }
    throw new Error(`Backlog GET /wikis -> 429 (リトライ上限)`);
  }

  async getWiki(wikiId: number): Promise<WikiDetail> {
    const r = BacklogRest.safeJson(await this.requestText("GET", `/wikis/${wikiId}`, "read"));
    return { id: r.id, name: String(r.name ?? ""), content: String(r.content ?? "") };
  }

  /** Wiki 追加。mailNotify は通知スパム防止のため必ず false を送る。 */
  async addWiki(input: { projectId: number; name: string; content: string }): Promise<WikiRef> {
    const r = BacklogRest.safeJson(await this.requestText("POST", "/wikis", "write", { ...input, mailNotify: "false" }));
    return { id: r.id, name: String(r.name ?? input.name) };
  }

  /** Wiki 更新。mailNotify は通知スパム防止のため必ず false を送る。 */
  async updateWiki(wikiId: number, patch: { name?: string; content?: string }): Promise<void> {
    await this.requestText("PATCH", `/wikis/${wikiId}`, "write", { ...patch, mailNotify: "false" });
  }

  async deleteWiki(wikiId: number): Promise<void> {
    await this.requestText("DELETE", `/wikis/${wikiId}`, "write", { mailNotify: "false" });
  }

  /** Document 追加（content は Markdown としてパースされる。更新 API は存在しない）。 */
  async addDocument(input: { projectId: number; title: string; content: string; parentId?: string | number; addLast?: boolean }): Promise<DocumentRef> {
    const r = BacklogRest.safeJson(await this.requestText("POST", "/documents", "write", input as unknown as Record<string, unknown>));
    return { id: r.id, title: String(r.title ?? input.title) };
  }

  /** Document 削除（管理者権限が必要）。 */
  async deleteDocument(documentId: string | number): Promise<void> {
    await this.requestText("DELETE", `/documents/${encodeURIComponent(String(documentId))}`, "write");
  }
}
