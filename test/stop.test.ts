import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import { runPostTool } from "../src/lifecycle/post-tool.js";
import { runStop } from "../src/lifecycle/stop.js";
import { runSessionEnd } from "../src/lifecycle/session-end.js";
import type { JudgmentConfig } from "../src/types.js";

// 決定論 backend を注入して claude 起動を回避する（全テスト共通）。
const DET: JudgmentConfig = { backend: "deterministic" };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function adapterWithIssue() {
  return {
    getStatusMap: vi.fn().mockResolvedValue({ open: 1, in_progress: 2, resolved: 3, closed: 4 }),
    createIssue: vi.fn(), findByMarker: vi.fn(),
    addComment: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
    updateDescription: vi.fn().mockResolvedValue(undefined),
  };
}

// 決定論 backend は turnResult のキーワードで isMilestone を立てる（deterministic.ts MILESTONE_KEYWORDS）。
const MILESTONE_MSG = "実装完了しました。テストも追加済みです。"; // 「完了」「実装完了」を含む → 節目
const NON_MILESTONE_MSG = "現在調査を進めています。"; // 節目語なし → 非節目

describe("runStop（説明欄更新 + 節目コメント）", () => {
  it("非節目ターン: コメントは投稿されず、説明欄だけが毎ターン更新される", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "ログイン機能の実装";
      s.progress = [];
      s.lastPrompt = "原因を調べて";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    // コメントは投稿されない（従来のターン毎 add_comment は撤去）
    expect(adapter.addComment).not.toHaveBeenCalled();
    // 説明欄は更新される（毎ターン）。同期先=PROJ-1、4ブロックを含む
    expect(adapter.updateDescription).toHaveBeenCalledOnce();
    const [key, body] = adapter.updateDescription.mock.calls[0];
    expect(key).toBe("PROJ-1");
    expect(body).toContain("## タスク");
    expect(body).toContain("ログイン機能の実装");
    expect(body).toContain("## 進捗");
    expect(body).toContain("## 最新状況");
    expect(body).toContain(NON_MILESTONE_MSG); // 最新状況に結果が反映
    expect(body).toContain("## 子課題");
    // 進捗は据え置き（節目でないため追加なし）
    const st = await store.loadOrCreate("s1");
    expect(st.progress).toEqual([]);
    expect(st.turnCount).toBe(1);
  });

  it("節目ターン: 進捗に1行追加・説明欄更新・コメント1件投稿", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "ログイン機能の実装";
      s.progress = [];
      s.lastPromptSummary = "ログイン実装";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    // 節目コメント1件
    expect(adapter.addComment).toHaveBeenCalledOnce();
    expect(adapter.addComment).toHaveBeenCalledWith("PROJ-1", expect.stringContaining("ログイン実装"));
    // 説明欄更新（進捗に1行・最新状況に結果）
    expect(adapter.updateDescription).toHaveBeenCalledOnce();
    const body = String(adapter.updateDescription.mock.calls[0][1]);
    expect(body).toContain("## 進捗");
    expect(body).toContain("ログイン実装"); // 節目1行が進捗に入る
    expect(body).toContain(MILESTONE_MSG); // 最新状況
    // state の progress に1行追加・有界
    const st = await store.loadOrCreate("s1");
    expect(st.progress).toEqual(["ログイン実装"]);
    expect(st.turnCount).toBe(1);
  });

  it("同期先は getActiveIssue 優先（逸脱分割後はアクティブ課題へ同期）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; // セッション主課題
      s.activeIssueKey = "PROJ-9"; // 分割後のアクティブ課題
      s.childIssueKeys = ["PROJ-9", "PROJ-10"];
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "親タスク";
      s.progress = [];
      s.lastPrompt = "子の作業";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    // 説明・状態遷移ともアクティブ課題 PROJ-9 へ
    expect(adapter.updateDescription).toHaveBeenCalledWith("PROJ-9", expect.any(String));
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-9", 3, undefined);
    // 子課題ブロックに childKeys が列挙される
    const body = String(adapter.updateDescription.mock.calls[0][1]);
    expect(body).toContain("## 子課題");
    expect(body).toContain("PROJ-9");
    expect(body).toContain("PROJ-10");
  });

  it("activeIssueKey 無しなら st.issueKey へ同期する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "タスク";
      s.progress = [];
      s.lastPrompt = "作業";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    expect(adapter.updateDescription).toHaveBeenCalledWith("PROJ-1", expect.any(String));
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined);
  });

  it("状態遷移を resolved にする（処理中→処理済み）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "in_progress"; s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined);
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("resolved");
  });

  it("stopHookActive=true の場合は何もしない（無限ループ回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: true, raw: {} }, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    expect(adapter.updateDescription).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("非節目ターンの状態遷移はキューに残り、adapter 例外を伝播しない（オフライン耐久）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "in_progress"; s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    const adapter = adapterWithIssue();
    adapter.setStatus.mockRejectedValue(new Error("fetch failed"));
    adapter.updateDescription.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runStop(
        { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
        { store, adapter: adapter as any, projectId: 10, judgment: DET },
      ),
    ).resolves.toEqual({}); // セッションを止めない（非ブロッキング）
    const st = await store.loadOrCreate("s1");
    // 非節目なのでコメントはキューに無い。状態遷移のみ残る
    expect(st.pendingQueue.map((o) => o.op)).toEqual(["update_issue"]);
    expect(st.pendingQueue.every((o) => o.attempts === 1)).toBe(true);
    expect(st.lastStatus).toBe("resolved"); // 楽観更新（実遷移はキュー再送に委ねる）
  });

  it("節目ターンのオフライン: add_comment と update_issue がキューに残る", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "in_progress"; s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    const adapter = adapterWithIssue();
    adapter.addComment.mockRejectedValue(new Error("fetch failed"));
    adapter.setStatus.mockRejectedValue(new Error("fetch failed"));
    adapter.updateDescription.mockRejectedValue(new Error("fetch failed"));
    await expect(
      runStop(
        { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: MILESTONE_MSG, raw: {} },
        { store, adapter: adapter as any, projectId: 10, judgment: DET },
      ),
    ).resolves.toEqual({});
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue.map((o) => o.op).sort()).toEqual(["add_comment", "update_issue"]);
    expect(st.pendingQueue.every((o) => o.attempts === 1)).toBe(true);
    expect(st.lastStatus).toBe("resolved");
  });

  it("復帰後の drain（SessionEnd相当）で残 op が排出され状態遷移する", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "in_progress"; s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    const offline = adapterWithIssue();
    offline.setStatus.mockRejectedValue(new Error("fetch failed"));
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: offline as any, projectId: 10, judgment: DET },
    );

    const online = adapterWithIssue();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter: online as any, projectId: 10, judgment: DET });
    expect(online.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined); // resolved へ遷移
    const st = await store.loadOrCreate("s1");
    expect(st.pendingQueue).toEqual([]); // 排出済み
  });

  it("issueKey 無しでも deps 解決済みなら遅延作成し、説明更新+状態遷移まで行う（Codex exec パリティ）", async () => {
    const store = new StateStore(dir);
    // SessionStart は発火していない（issueKey 無し）。post-tool のバッファのみ存在
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    adapter.createIssue.mockResolvedValue({ id: 100, issueKey: "PROJ-100" });
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3, judgment: DET },
    );
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    expect(adapter.createIssue).toHaveBeenCalledWith(expect.objectContaining({ issueTypeId: 4236190, priorityId: 3 }));
    expect(adapter.updateDescription).toHaveBeenCalledWith("PROJ-100", expect.any(String)); // 説明更新
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
        { store, adapter: adapter as any, projectId: 10, issueTypeId: 4236190, priorityId: 3, judgment: DET },
      ),
    ).resolves.toEqual({});
    expect(adapter.updateDescription).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("issueKey 無しで init 未解決なら静かに no-op（従来挙動）", async () => {
    const store = new StateStore(dir);
    await runPostTool({ tool: "claude", event: "post-tool", sessionId: "s1", cwd: "/r", toolName: "Edit", toolUseId: "a", raw: {} }, { store, adapter: {} as any, projectId: 10 });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, raw: {} }, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(adapter.updateDescription).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("依頼整理（lastPromptSummary）が節目1行/コメントの素材に使われ、使用後にクリアされる", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1";
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "親タスク";
      s.progress = [];
      s.lastPrompt = "とても長い原文のプロンプト";
      s.lastPromptSummary = "ログインバグの修正";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    // 節目1行は整理結果（原文ではない）
    expect(adapter.addComment).toHaveBeenCalledWith("PROJ-1", expect.stringContaining("ログインバグの修正"));
    expect(adapter.addComment).not.toHaveBeenCalledWith("PROJ-1", expect.stringContaining("とても長い原文"));
    const st = await store.loadOrCreate("s1");
    expect(st.lastPrompt).toBeUndefined();
    expect(st.lastPromptSummary).toBeUndefined();
    expect(st.progress).toEqual(["ログインバグの修正"]);
  });

  it("2ターン連続: 2回目の resolved 遷移は同値スキップされコメントは節目時のみ", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "依頼1";
    });
    const adapter = adapterWithIssue();
    // 1ターン目: 非節目 → コメント無し・resolved へ遷移
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    // 2ターン目: 節目 → コメント1件・状態は resolved 同値スキップ
    await store.withLock("s1", (s) => { s.lastPrompt = "依頼2"; });
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );

    expect(adapter.updateDescription).toHaveBeenCalledTimes(2); // 説明は毎ターン
    expect(adapter.addComment).toHaveBeenCalledTimes(1); // 節目ターンのみ
    expect(adapter.setStatus).toHaveBeenCalledTimes(1); // 2回目は resolved 同値スキップ（code 7 回避）
    const st = await store.loadOrCreate("s1");
    expect(st.turnCount).toBe(2);
  });

  it("resolutionFixedId=0 でも resolved 遷移の PATCH に resolutionId が含まれる（falsy 罠回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, resolutionFixedId: 0, judgment: DET },
    );
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined, 0); // 完了理由=対応済み(id:0)
  });

  it("lastAssistantMessage が無ければ transcript 末尾から結果を抽出し最新状況へ反映する（Claude）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; s.originalTask = "t"; s.progress = []; });
    const transcriptPath = join(dir, "transcript.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "user", message: { role: "user", content: "依頼" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "transcriptの最終回答" }] } }),
    ].join("\n") + "\n", "utf8");
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, transcriptPath, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    const body = String(adapter.updateDescription.mock.calls[0][1]);
    expect(body).toContain("## 最新状況");
    expect(body).toContain("transcriptの最終回答");
  });

  it("backlog 記法では説明欄が Backlog 記法で出力される", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.originalTask = "依頼です"; s.progress = []; s.lastPrompt = "p";
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, textFormattingRule: "backlog", judgment: DET },
    );
    const body = String(adapter.updateDescription.mock.calls[0][1]);
    expect(body).toContain("** タスク"); // Backlog 記法の見出し（行頭 *）
  });
});
