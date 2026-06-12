import { describe, it, expect, vi } from "vitest";
import { BacklogRest } from "../src/tracker/backlog-rest.js";

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const cfg = { domain: "ex.backlog.com", apiKey: "K", projectKey: "PROJ" };

function make(fetchMock: any, beforeRequest = vi.fn().mockResolvedValue(undefined)) {
  const rest = new BacklogRest(cfg, { fetch: fetchMock, rateLimiter: { beforeRequest, handle429: vi.fn() } as any });
  return { rest, beforeRequest };
}

describe("BacklogRest Wiki/Document（G21）", () => {
  it("getWikis は projectIdOrKey を付け search カテゴリで呼ぶ", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes([{ id: 1, name: "Home" }, { id: 2, name: "guide/setup" }]));
    const { rest, beforeRequest } = make(fetchMock);
    const wikis = await rest.getWikis(99);
    expect(wikis).toEqual([{ id: 1, name: "Home" }, { id: 2, name: "guide/setup" }]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v2/wikis");
    expect(url).toContain("projectIdOrKey=99");
    expect(beforeRequest).toHaveBeenCalledWith("search");
  });

  it("addWiki は mailNotify=false を必ず送る", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 10, name: "guide/setup" }));
    const { rest } = make(fetchMock);
    const ref = await rest.addWiki({ projectId: 99, name: "guide/setup", content: "本文" });
    expect(ref).toEqual({ id: 10, name: "guide/setup" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/wikis");
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("mailNotify=false"); // 通知スパム防止（必須）
    expect(body).toContain("projectId=99");
    expect(body).toContain(`name=${encodeURIComponent("guide/setup")}`);
  });

  it("updateWiki は PATCH /wikis/:id + mailNotify=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: 10 }));
    const { rest } = make(fetchMock);
    await rest.updateWiki(10, { name: "guide/setup", content: "更新" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/wikis/10");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(String((init as RequestInit).body)).toContain("mailNotify=false");
  });

  it("deleteWiki は DELETE /wikis/:id + mailNotify=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const { rest } = make(fetchMock);
    await rest.deleteWiki(10);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/wikis/10");
    expect((init as RequestInit).method).toBe("DELETE");
    expect(String((init as RequestInit).body)).toContain("mailNotify=false");
  });

  it("getWiki はレスポンスに生制御文字が混ざっていても content を返す（実測対応）", async () => {
    // JSON 文字列値の中に生の U+0001（不正 JSON）を混入させる（ソースに制御文字を直書きしない）
    const ctrl = String.fromCharCode(1);
    const raw = `{"id": 5, "name": "page", "content": "A${ctrl}B"}`;
    expect(() => JSON.parse(raw)).toThrow(); // 素のパースでは失敗する入力であること
    const fetchMock = vi.fn().mockResolvedValue(new Response(raw, { status: 200 }));
    const { rest } = make(fetchMock);
    const wiki = await rest.getWiki(5);
    expect(wiki.id).toBe(5);
    expect(wiki.content).toBe("AB"); // 制御文字のみ除去して救済
  });

  it("addDocument は projectId/title/content/parentId/addLast を送り id/title を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ id: "doc-1", title: "setup" }));
    const { rest } = make(fetchMock);
    const ref = await rest.addDocument({ projectId: 99, title: "setup", content: "# x", parentId: "doc-0", addLast: true });
    expect(ref).toEqual({ id: "doc-1", title: "setup" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/documents");
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("parentId=doc-0");
    expect(body).toContain("addLast=true");
  });

  it("deleteDocument は DELETE /documents/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({}));
    const { rest } = make(fetchMock);
    await rest.deleteDocument("doc-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v2/documents/doc-1");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
