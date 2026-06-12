import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runUserPromptSubmit } from "../src/lifecycle/user-prompt-submit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function fakeAdapter() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn().mockResolvedValue({ id: 100, issueKey: "PROJ-100" }),
    setStatus: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue(undefined),
    findByMarker: vi.fn().mockResolvedValue(undefined),
  };
}

function promptEv(prompt: string) {
  return { tool: "claude", event: "user-prompt-submit", sessionId: "s1", cwd: "/repo", prompt, raw: {} } as const;
}

const deps = { projectId: 10, issueTypeId: 4236190, priorityId: 3 };

describe("runUserPromptSubmit", () => {
  it("初回プロンプトで課題を作成: タイトル=1行目、説明=全文+メタ+マーカー", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    await runUserPromptSubmit(promptEv("ログインバグを直して\n再現手順: フォーム送信で500"), { store, adapter: adapter as any, ...deps });
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    const input = adapter.createIssue.mock.calls[0][0];
    expect(input.summary).toBe("ログインバグを直して"); // 1行目のみ
    expect(input.description).toContain("再現手順: フォーム送信で500"); // 依頼全文
    expect(input.description).toContain("[[bas:session:s1]]"); // 機械マーカー
    expect(input.description).toContain("session_id: s1");
    expect(input.description).toContain("エージェント: claude");
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-100", 2, expect.any(String)); // 処理中で開始
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
    expect(st.initialPrompt).toContain("ログインバグ");
    expect(st.lastPrompt).toContain("ログインバグ");
  });

  it("長いプロンプトはタイトル60字+…に切り詰める", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const long = "あ".repeat(80);
    await runUserPromptSubmit(promptEv(long), { store, adapter: adapter as any, ...deps });
    const summary = String(adapter.createIssue.mock.calls[0][0].summary);
    expect(summary.length).toBe(61); // 60字 + …
    expect(summary.endsWith("…")).toBe(true);
  });

  it("2回目以降は作成せず、追加依頼をバッファに積み in_progress へフリップする", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "resolved";
      s.initialPrompt = "最初の依頼";
    });
    const adapter = fakeAdapter();
    const long = "追加でテストも書いて ".repeat(20);
    await runUserPromptSubmit(promptEv(long), { store, adapter: adapter as any, ...deps });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 2, undefined); // resolved → in_progress
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("in_progress");
    expect(st.initialPrompt).toBe("最初の依頼"); // 上書きしない
    expect(st.lastPrompt).toContain("追加でテスト");
    const entry = st.activityBuffer[0];
    expect(entry.tool).toBe("(依頼)");
    expect(entry.detail?.length).toBe(120); // 先頭120字
  });

  it("lastStatus が既に in_progress ならステータス PATCH をスキップする（code 7 回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.lastStatus = "in_progress";
    });
    const adapter = fakeAdapter();
    await runUserPromptSubmit(promptEv("続けて"), { store, adapter: adapter as any, ...deps });
    expect(adapter.setStatus).not.toHaveBeenCalled();
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(1); // 記録はされる
  });

  it("課題作成が失敗してもプロンプト処理を止めず lastPrompt は保存される", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    adapter.createIssue.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runUserPromptSubmit(promptEv("ネットワーク断でも落ちない"), { store, adapter: adapter as any, ...deps }),
    ).resolves.toEqual({});
    const st = await store.loadOrCreate("s1");
    expect(st.lastPrompt).toContain("ネットワーク断");
    expect(st.issueKey).toBeUndefined();
  });

  it("init 未解決なら課題を作成しない（非ブロッキング no-op）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    await runUserPromptSubmit(promptEv("依頼"), { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    const st = await store.loadOrCreate("s1");
    expect(st.lastPrompt).toBe("依頼"); // ローカル記録は維持
  });

  it("turnStartHead を state に保存する（git DI 経由）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const HEAD = "f".repeat(40);
    const git = {
      headSha: vi.fn().mockResolvedValue(HEAD),
      branchName: vi.fn().mockResolvedValue("main"),
      commitsBetween: vi.fn().mockResolvedValue({ commits: [] }),
      isOnRemote: vi.fn().mockResolvedValue(true),
    };
    await runUserPromptSubmit(promptEv("依頼"), { store, adapter: adapter as any, ...deps, git: git as any, root: "/root" });
    expect(git.headSha).toHaveBeenCalledWith("/root"); // root を優先（無ければ ev.cwd）
    const st = await store.loadOrCreate("s1");
    expect(st.turnStartHead).toBe(HEAD);
  });

  it("git が使えなくても turnStartHead 無しで動作する", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const git = {
      headSha: vi.fn().mockResolvedValue(undefined),
      branchName: vi.fn().mockResolvedValue(undefined),
      commitsBetween: vi.fn().mockResolvedValue({ commits: [], reason: "x" }),
      isOnRemote: vi.fn().mockResolvedValue(false),
    };
    await runUserPromptSubmit(promptEv("依頼"), { store, adapter: adapter as any, ...deps, git: git as any });
    expect(adapter.createIssue).toHaveBeenCalledOnce(); // 課題作成は通常どおり
    const st = await store.loadOrCreate("s1");
    expect(st.turnStartHead).toBeUndefined();
  });

  it("deps.fields があれば createIssue 入力にフィールドをマージする", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const fields = vi.fn().mockResolvedValue({ assigneeId: 5, priorityId: 4, categoryId: [9], milestoneId: [70], versionId: undefined });
    await runUserPromptSubmit(promptEv("緊急のバグを直して"), { store, adapter: adapter as any, ...deps, fields });
    expect(fields).toHaveBeenCalledWith("緊急のバグを直して");
    const input = adapter.createIssue.mock.calls[0][0];
    expect(input).toMatchObject({ assigneeId: 5, priorityId: 4, categoryId: [9], milestoneId: [70] }); // priorityId は上書き
    expect("versionId" in input).toBe(false); // undefined 値のキーは除去（既定値を壊さない）
  });

  it("fields の解決が失敗しても課題作成は継続する（非ブロッキング）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const fields = vi.fn().mockRejectedValue(new Error("fields error"));
    await runUserPromptSubmit(promptEv("依頼"), { store, adapter: adapter as any, ...deps, fields });
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    expect(adapter.createIssue).toHaveBeenCalledWith(expect.objectContaining({ priorityId: 3 })); // 既定値のまま
  });
});
