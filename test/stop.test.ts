import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";
import { runStop } from "../src/lifecycle/stop.js";
import { runSessionEnd } from "../src/lifecycle/session-end.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function adapterWithIssue() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), findByMarker: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runStop", () => {
  it("バッファを1つの集約コメントにまとめ、状態を resolved にする", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Bash", toolUseId: "b", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).toHaveBeenCalledOnce(); // ツール毎ではなく1回に集約
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined);
    const st = await store.loadOrCreate("s1");
    expect(st.activityBuffer.length).toBe(0); // フラッシュ後は空
    expect(st.lastStatus).toBe("resolved");
  });

  it("stopHookActive=true の場合は何もしない（無限ループ回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: true, raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("adapter が例外を投げても伝播せず、add_comment と update_issue がキューに残る（オフライン耐久）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.addComment.mockRejectedValue(new Error("fetch failed"));
    adapter.setStatus.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10 }),
    ).resolves.toEqual({}); // セッションを止めない（非ブロッキング）
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue.map((o) => o.op).sort()).toEqual(["add_comment", "update_issue"]); // 状態遷移も失われない
    expect(st.pendingQueue.every((o) => o.attempts === 1)).toBe(true);
    expect(st.lastStatus).toBe("resolved"); // 楽観更新（実遷移はキュー再送に委ねる）
  });

  it("復帰後の drain（SessionEnd相当）で残 op が両方排出され状態遷移する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    const offline = adapterWithIssue();
    offline.addComment.mockRejectedValue(new Error("fetch failed"));
    offline.setStatus.mockRejectedValue(new Error("fetch failed"));
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: offline as any, projectId: 10 });

    const online = adapterWithIssue();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter: online as any, projectId: 10 });
    expect(online.addComment).toHaveBeenCalledOnce();
    expect(online.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined); // resolved へ遷移
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue).toEqual([]); // 排出済み
  });

  it("issueKey 無しでも deps 解決済みなら遅延作成し、集約コメント+状態遷移まで行う（Codex exec パリティ）", async () => {
    const store = new StateStore(dir);
    // SessionStart は発火していない（issueKey 無し）。post-tool のバッファのみ存在
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.createIssue.mockResolvedValue({ id: 100, issueKey: "PROJ-100" });
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} },
      { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
    );
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    expect(adapter.createIssue).toHaveBeenCalledWith(expect.objectContaining({ issueTypeId: 4236190, priorityId: 3 }));
    expect(adapter.addComment).toHaveBeenCalledOnce(); // 集約コメント
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-100", 3, undefined); // resolved へ遷移
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
    expect(st.lastStatus).toBe("resolved");
  });

  it("遅延作成が失敗しても例外を伝播しない（非ブロッキング）", async () => {
    const store = new StateStore(dir);
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.createIssue.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runStop(
        { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} },
        { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3 },
      ),
    ).resolves.toEqual({});
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("issueKey 無しで init 未解決なら静かに no-op（従来挙動）", async () => {
    const store = new StateStore(dir);
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10 });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("ターン要約に依頼・結果・変更ファイル集計・実行コマンドが入る", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.lastPrompt = "バグを直してテストも追加して"; });
    const base = { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", raw: {} } as const;
    await runPostTool({ ...base, toolName: "Edit", toolUseId: "a", toolInput: { filePath: "/r/src/foo.ts" } }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ ...base, toolName: "Edit", toolUseId: "b", toolInput: { filePath: "/r/src/foo.ts" } }, { store, adapter: {} as any, projectId: 10 });
    await runPostTool({ ...base, toolName: "Bash", toolUseId: "c", toolInput: { command: "npm test\n--watch" } }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "codex", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: "直しました。テストも追加済みです。", raw: {} },
      { store, adapter: adapter as any, projectId: 10 },
    );
    const body = String(adapter.addComment.mock.calls[0][1]);
    expect(body).toContain("## ターン #1");
    expect(body).toContain("### 依頼");
    expect(body).toContain("バグを直してテストも追加して");
    expect(body).toContain("### 結果");
    expect(body).toContain("直しました。テストも追加済みです。");
    expect(body).toContain("### 変更");
    expect(body).toContain("- src/foo.ts(2)"); // vcs 無し → リンク無しの従来表記
    expect(body).toContain("### 実行");
    expect(body).toContain("- npm test --watch（1件）");
    expect(body).toContain("（ツール使用 3 件）");
    const st = await store.loadOrCreate("s1");
    expect(st.turnCount).toBe(1);
    expect(st.lastPrompt).toBeUndefined(); // 消費後クリア
  });

  it("lastAssistantMessage が無ければ transcript 末尾から結果を抽出する（Claude）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: "依頼" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "transcriptの最終回答" }] } }),
    ].join("\n") + "\n", "utf8");
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, transcriptPath, raw: {} },
      { store, adapter: adapter as any, projectId: 10 },
    );
    const body = String(adapter.addComment.mock.calls[0][1]);
    expect(body).toContain("### 結果");
    expect(body).toContain("transcriptの最終回答");
  });

  it("2ターン連続で2コメント投稿され、2回目の resolved 遷移は同値スキップされる", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.lastPrompt = "依頼1"; });
    const adapter = adapterWithIssue();
    const ev = { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} } as const;
    await runStop(ev, { store, adapter: adapter as any, projectId: 10 });
    await store.withLock("s1", (s) => { s.lastPrompt = "依頼2"; }); // 次ターンの依頼（状態フリップ無しのまま stop）
    await runStop(ev, { store, adapter: adapter as any, projectId: 10 });

    expect(adapter.addComment).toHaveBeenCalledTimes(2); // セッション固定 id で潰れない
    expect(String(adapter.addComment.mock.calls[0][1])).toContain("ターン #1");
    expect(String(adapter.addComment.mock.calls[1][1])).toContain("ターン #2");
    expect(String(adapter.addComment.mock.calls[1][1])).toContain("依頼2");
    expect(adapter.setStatus).toHaveBeenCalledTimes(1); // 2回目は resolved 同値スキップ（code 7 回避）
    const st = await store.loadOrCreate("s1");
    expect(st.turnCount).toBe(2);
  });

  it("vcs と git があれば変更ファイル/コミットをリンク化し、未push を注記する", async () => {
    const store = new StateStore(dir);
    const HEAD = "a".repeat(40);
    const COMMIT = "b".repeat(40);
    const START = "c".repeat(40);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.turnStartHead = START; });
    await runPostTool(
      { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", toolName: "Edit", toolUseId: "a", toolInput: { filePath: "/repo/src/foo.ts" } },
      { store, adapter: {} as any, projectId: 10 },
    );
    const adapter = adapterWithIssue();
    const git = {
      headSha: vi.fn().mockResolvedValue(HEAD),
      branchName: vi.fn().mockResolvedValue("main"),
      commitsBetween: vi.fn().mockResolvedValue({ commits: [{ sha: COMMIT, subject: "fix: bug" }] }),
      isOnRemote: vi.fn().mockResolvedValue(false),
    };
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/repo", stopHookActive: false, raw: {} },
      { store, adapter: adapter as any, projectId: 10, vcs: { kind: "github", owner: "o", repo: "r" }, git: git as any, root: "/repo" },
    );
    const body = String(adapter.addComment.mock.calls[0][1]);
    expect(body).toContain(`[src/foo.ts(1)](https://github.com/o/r/blob/${HEAD}/src/foo.ts)`); // rev=このターンのHEAD
    expect(body).toContain(`[${COMMIT.slice(0, 7)} fix: bug](https://github.com/o/r/commit/${COMMIT})（未push）`);
    expect(git.commitsBetween).toHaveBeenCalledWith("/repo", START);
    const st = await store.loadOrCreate("s1");
    expect(st.turnStartHead).toBeUndefined(); // 消費後クリア
  });

  it("turnStartHead の到達不能（reason）はコミット列挙をスキップして注記する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.turnStartHead = "c".repeat(40); });
    const adapter = adapterWithIssue();
    const git = {
      headSha: vi.fn().mockResolvedValue(undefined),
      branchName: vi.fn().mockResolvedValue(undefined),
      commitsBetween: vi.fn().mockResolvedValue({ commits: [], reason: "コミット列挙不可（開始点が履歴に見つからない可能性）" }),
      isOnRemote: vi.fn().mockResolvedValue(false),
    };
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/repo", stopHookActive: false, raw: {} },
      { store, adapter: adapter as any, projectId: 10, git: git as any, root: "/repo" },
    );
    const body = String(adapter.addComment.mock.calls[0][1]);
    expect(body).toContain("コミット: コミット列挙不可");
    expect(git.isOnRemote).not.toHaveBeenCalled();
  });

  it("resolutionFixedId=0 でも resolved 遷移の PATCH に resolutionId が含まれる（falsy 罠回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 }; });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} },
      { store, adapter: adapter as any, projectId: 10, resolutionFixedId: 0 },
    );
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined, 0); // 完了理由=対応済み(id:0)
  });

  it("backlog 記法では見出し/リンクが Backlog 記法で出力される", async () => {
    const store = new StateStore(dir);
    const HEAD = "a".repeat(40);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.lastPrompt = "依頼です"; });
    await runPostTool(
      { tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/repo", toolName: "Edit", toolUseId: "a", toolInput: { filePath: "/repo/a.ts" } },
      { store, adapter: {} as any, projectId: 10 },
    );
    const adapter = adapterWithIssue();
    const git = {
      headSha: vi.fn().mockResolvedValue(HEAD),
      branchName: vi.fn().mockResolvedValue("main"),
      commitsBetween: vi.fn().mockResolvedValue({ commits: [] }),
      isOnRemote: vi.fn().mockResolvedValue(true),
    };
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/repo", stopHookActive: false, raw: {} },
      { store, adapter: adapter as any, projectId: 10, textFormattingRule: "backlog", vcs: { kind: "github", owner: "o", repo: "r" }, git: git as any, root: "/repo" },
    );
    const body = String(adapter.addComment.mock.calls[0][1]);
    expect(body).toContain("** ターン #1"); // 行頭 *（レベル数）
    expect(body).toContain(`[[a.ts(1)>https://github.com/o/r/blob/${HEAD}/a.ts]]`); // [[text>url]]
  });
});
