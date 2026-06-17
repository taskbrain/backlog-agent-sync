import { describe, it, expect, vi } from "vitest";
import { BacklogRest } from "../src/tracker/backlog-rest.js";

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const cfg = { domain: "ex.backlog.com", apiKey: "K", projectKey: "PROJ" };

describe("BacklogRest", () => {
  it("getProjectStatuses は statuses 配列を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([{ id: 1, name: "未対応" }, { id: 2, name: "処理中" }]));
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
    const statuses = await rest.getProjectStatuses("PROJ");
    expect(statuses.map((s) => s.id)).toEqual([1, 2]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v2/projects/PROJ/statuses");
    expect(url).toContain("apiKey=K");
  });

  it("addComment は POST /issues/:key/comments に content を送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 999 }));
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
    await rest.addComment("PROJ-1", "hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/issues/PROJ-1/comments");
    expect((init as RequestInit).method).toBe("POST");
    expect(String((init as RequestInit).body)).toContain("content=hello");
  });

  it("429 を受けたら handle429 後にリトライする", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ errors: [] }, 429, { "X-RateLimit-Reset": "0" }))
      .mockResolvedValueOnce(jsonRes({ id: 1, issueKey: "PROJ-1" }));
    const handle429 = vi.fn().mockResolvedValue(undefined);
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429 } as any });
    const ref = await rest.createIssue({ projectId: 10, summary: "s", issueTypeId: 1, priorityId: 3 });
    expect(handle429).toHaveBeenCalledOnce();
    expect(ref.issueKey).toBe("PROJ-1");
  });

  it("getProject は GET /projects/:key を呼び id を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 77, projectKey: "PROJ", name: "P" }));
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
    const p = await rest.getProject("PROJ");
    expect(p.id).toBe(77);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/projects/PROJ");
  });

  it("findIssues は 429 後にリトライする", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes([], 429, { "X-RateLimit-Reset": "0" }))
      .mockResolvedValueOnce(jsonRes([{ id: 1, issueKey: "PROJ-1" }]));
    const handle429 = vi.fn().mockResolvedValue(undefined);
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429 } as any });
    const found = await rest.findIssues({ keyword: "x" });
    expect(handle429).toHaveBeenCalledOnce();
    expect(found[0].issueKey).toBe("PROJ-1");
  });

  it("findIssues は sort/assigneeId/updatedSince をクエリに付与し詳細フィールドを返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([
      { id: 1, issueKey: "PROJ-1", summary: "課題A", status: { id: 2, name: "処理中" }, updated: "2026-06-10T10:00:00Z" },
    ]));
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
    const found = await rest.findIssues({ assigneeId: [5], updatedSince: "2026-06-09", sort: "updated" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("sort=updated");
    expect(url).toContain("assigneeId%5B%5D=5");
    expect(url).toContain("updatedSince=2026-06-09");
    expect(found[0]).toEqual({ id: 1, issueKey: "PROJ-1", summary: "課題A", status: "処理中", updated: "2026-06-10T10:00:00Z" });
  });

  it("getComments は GET /issues/:key/comments に minId/order/count を付与する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([
      { id: 11, content: "c", createdUser: { id: 9, name: "alice" }, created: "2026-06-10T09:00:00Z" },
    ]));
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
    const comments = await rest.getComments("PROJ-1", { minId: 10 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v2/issues/PROJ-1/comments");
    expect(url).toContain("minId=10");
    expect(url).toContain("order=asc");
    expect(url).toContain("count=100");
    expect(comments[0].id).toBe(11);
  });

  it("getIssueTypes / getPriorities は対応エンドポイントを呼び id/name を返す", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes([{ id: 4236190, name: "タスク" }, { id: 4236189, name: "バグ" }]))
      .mockResolvedValueOnce(jsonRes([{ id: 2, name: "高" }, { id: 3, name: "中" }, { id: 4, name: "低" }]));
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
    const types = await rest.getIssueTypes("PROJ");
    const priorities = await rest.getPriorities();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/projects/PROJ/issueTypes");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/v2/priorities");
    expect(types[0]).toEqual({ id: 4236190, name: "タスク" });
    expect(priorities[1].name).toBe("中");
  });
});

describe("BacklogRest（G19: フィールド/Backlog Git）", () => {
  function restWith(fetchMock: ReturnType<typeof vi.fn>) {
    return new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
  }

  it("getCategories / getVersions は project 配下のエンドポイントを呼ぶ", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes([{ id: 101, name: "フロントエンド" }]))
      .mockResolvedValueOnce(jsonRes([{ id: 201, name: "v1.0", startDate: "2026-06-01", releaseDueDate: "2026-06-30", archived: false }]));
    const rest = restWith(fetchMock);
    const cats = await rest.getCategories("PROJ");
    const vers = await rest.getVersions("PROJ");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/projects/PROJ/categories");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/v2/projects/PROJ/versions");
    expect(cats[0]).toEqual({ id: 101, name: "フロントエンド" });
    expect(vers[0].releaseDueDate).toBe("2026-06-30");
  });

  it("getResolutions は id:0（対応済み）をそのまま返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([{ id: 0, name: "対応済み" }, { id: 1, name: "対応しない" }]));
    const rest = restWith(fetchMock);
    const resolutions = await rest.getResolutions();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/resolutions");
    expect(resolutions[0].id).toBe(0);
    expect(resolutions[0].name).toBe("対応済み");
  });

  it("getProjectInfo は textFormattingRule を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 77, projectKey: "PROJ", name: "P", textFormattingRule: "markdown" }));
    const rest = restWith(fetchMock);
    const info = await rest.getProjectInfo("PROJ");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/projects/PROJ");
    expect(info).toEqual({ id: 77, textFormattingRule: "markdown" });
  });

  it("getGitRepositories は id/name/httpUrl を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([
      { id: 9, name: "app", httpUrl: "https://ex.backlog.com/git/PROJ/app.git", sshUrl: "x" },
    ]));
    const rest = restWith(fetchMock);
    const repos = await rest.getGitRepositories("PROJ");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/projects/PROJ/git/repositories");
    expect(repos).toEqual([{ id: 9, name: "app", httpUrl: "https://ex.backlog.com/git/PROJ/app.git" }]);
  });

  it("getGitPullRequests は statusId[] を反復付与し issue を整形して返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([
      { id: 50, number: 3, summary: "PR title", branch: "feature/x", base: "main", issue: { id: 700, issueKey: "PROJ-7" } },
      { id: 51, number: 4, summary: "no issue", branch: "fix/y", base: "main", issue: null },
    ]));
    const rest = restWith(fetchMock);
    const prs = await rest.getGitPullRequests("PROJ", "app", { statusId: [1, 2] });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v2/projects/PROJ/git/repositories/app/pullRequests");
    expect(url).toContain("statusId%5B%5D=1");
    expect(url).toContain("statusId%5B%5D=2");
    expect(prs[0].issue).toEqual({ id: 700, issueKey: "PROJ-7" });
    expect(prs[1].issue).toBeUndefined();
  });

  it("updateGitPullRequest は PATCH /pullRequests/:number に issueId/comment を送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 50 }));
    const rest = restWith(fetchMock);
    await rest.updateGitPullRequest("PROJ", "app", 3, { issueId: 700, comment: "関連付け" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/projects/PROJ/git/repositories/app/pullRequests/3");
    expect((init as RequestInit).method).toBe("PATCH");
    const body = String((init as RequestInit).body);
    expect(body).toContain("issueId=700");
    expect(body).toContain(`comment=${encodeURIComponent("関連付け")}`);
  });

  it("createIssue は categoryId/milestoneId 配列を categoryId[] 形式で反復送信する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 1, issueKey: "PROJ-1" }));
    const rest = restWith(fetchMock);
    await rest.createIssue({
      projectId: 10, summary: "s", issueTypeId: 1, priorityId: 3,
      assigneeId: 5, categoryId: [101, 102], milestoneId: [201],
    });
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain("assigneeId=5");
    expect(body).toContain("categoryId%5B%5D=101");
    expect(body).toContain("categoryId%5B%5D=102");
    expect(body).toContain("milestoneId%5B%5D=201");
  });

  it("updateIssue は resolutionId=0 を欠落させずに送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const rest = restWith(fetchMock);
    await rest.updateIssue({ issueIdOrKey: "PROJ-1", statusId: 3, resolutionId: 0 });
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain("statusId=3");
    expect(body).toContain("resolutionId=0");
  });
});

describe("BacklogRest（Phase 2: 親子化 / 説明後付け）", () => {
  function restWith(fetchMock: ReturnType<typeof vi.fn>) {
    return new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429: async () => {} } as any });
  }

  it("createIssue は parentIssueId を body に含める", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 2, issueKey: "PROJ-2" }));
    const rest = restWith(fetchMock);
    const ref = await rest.createIssue({ projectId: 10, summary: "子", issueTypeId: 1, priorityId: 3, parentIssueId: 700 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/issues");
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("parentIssueId=700");
    expect(ref.issueKey).toBe("PROJ-2");
  });

  it("setParent は PATCH /issues/:key に parentIssueId を送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 2, issueKey: "PROJ-2" }));
    const rest = restWith(fetchMock);
    await rest.setParent("PROJ-2", 700);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/issues/PROJ-2");
    expect((init as RequestInit).method).toBe("PATCH");
    const body = String((init as RequestInit).body);
    expect(body).toBe("parentIssueId=700");
  });

  it("setParent は数値の issueId も URL エンコードして送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const rest = restWith(fetchMock);
    await rest.setParent(12345, 700);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/issues/12345");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(String((init as RequestInit).body)).toContain("parentIssueId=700");
  });

  it("updateIssueDescription は PATCH /issues/:key に description を送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const rest = restWith(fetchMock);
    await rest.updateIssueDescription("PROJ-3", "概要\n本文");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/issues/PROJ-3");
    expect((init as RequestInit).method).toBe("PATCH");
    // form() は URLSearchParams ベース（x-www-form-urlencoded）。同じ方式で期待値を作る。
    const body = String((init as RequestInit).body);
    expect(body).toBe(new URLSearchParams({ description: "概要\n本文" }).toString());
    expect(body).toContain("%0A"); // 改行が保持される
  });

  it("setParent は 429 後にリトライする", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ errors: [] }, 429, { "X-RateLimit-Reset": "0" }))
      .mockResolvedValueOnce(jsonRes({ id: 2, issueKey: "PROJ-2" }));
    const handle429 = vi.fn().mockResolvedValue(undefined);
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429 } as any });
    await rest.setParent("PROJ-2", 700);
    expect(handle429).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("getIssue はキー指定で GET /issues/:key を呼び id/issueKey を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 4242, issueKey: "PROJ-9", summary: "課題" }));
    const rest = restWith(fetchMock);
    const ref = await rest.getIssue("PROJ-9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/issues/PROJ-9");
    expect(String(url)).toContain("apiKey=K");
    expect((init as RequestInit)?.method ?? "GET").toBe("GET"); // body 無し = GET
    expect(ref).toEqual({ id: 4242, issueKey: "PROJ-9" });
  });

  it("getIssueDetail は GET /issues/:key を呼び id/issueKey/summary/description を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 4242, issueKey: "PROJ-9", summary: "肥大課題", description: "## タスク\n旧説明" }));
    const rest = restWith(fetchMock);
    const detail = await rest.getIssueDetail("PROJ-9");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/issues/PROJ-9");
    expect(detail).toEqual({ id: 4242, issueKey: "PROJ-9", summary: "肥大課題", description: "## タスク\n旧説明" });
  });

  it("getIssueDetail は summary/description 欠落時に空文字へフォールバックする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 1, issueKey: "PROJ-1" }));
    const rest = restWith(fetchMock);
    const detail = await rest.getIssueDetail("PROJ-1");
    expect(detail).toEqual({ id: 1, issueKey: "PROJ-1", summary: "", description: "" });
  });

  it("getIssue は数値 id 指定でも GET /issues/:id を呼ぶ", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 4242, issueKey: "PROJ-9" }));
    const rest = restWith(fetchMock);
    const ref = await rest.getIssue(4242);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/v2/issues/4242");
    expect(ref.id).toBe(4242);
  });

  it("getIssue は 429 後にリトライする", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes({ errors: [] }, 429, { "X-RateLimit-Reset": "0" }))
      .mockResolvedValueOnce(jsonRes({ id: 4242, issueKey: "PROJ-9" }));
    const handle429 = vi.fn().mockResolvedValue(undefined);
    const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest: async () => {}, handle429 } as any });
    const ref = await rest.getIssue("PROJ-9");
    expect(handle429).toHaveBeenCalledOnce();
    expect(ref.issueKey).toBe("PROJ-9");
  });
});
