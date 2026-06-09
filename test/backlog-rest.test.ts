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
});
