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
    // 説明・状態遷移ともアクティブ課題 PROJ-9 へ（status は in_progress 維持＝2）
    expect(adapter.updateDescription).toHaveBeenCalledWith("PROJ-9", expect.any(String));
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-9", 2, undefined);
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
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 2, undefined); // in_progress 維持（2）
  });

  it("F3: 作業中は in_progress を維持し、Stop では resolved へ遷移しない（既に in_progress なら status PATCH なし）", async () => {
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
    // 既に in_progress のため status PATCH は呼ばれない（毎ターンの往復トグル廃止）
    expect(adapter.setStatus).not.toHaveBeenCalled();
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("in_progress"); // resolved へ往復しない
  });

  it("F3: lastStatus 未設定なら Stop で in_progress へ1回 PATCH する（resolved にはしない）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "p"; // lastStatus は未設定
    });
    const adapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 2, undefined); // in_progress(2) へ。resolved(3) ではない
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("in_progress");
  });

  it("stopHookActive=true の場合は何もしない（無限ループ回避）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-1"; });
    const adapter = adapterWithIssue();
    await runStop({ tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: true, raw: {} }, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    expect(adapter.updateDescription).not.toHaveBeenCalled();
    expect(adapter.addComment).not.toHaveBeenCalled();
  });

  it("非節目ターンの in_progress 遷移はキューに残り、adapter 例外を伝播しない（オフライン耐久）", async () => {
    const store = new StateStore(dir);
    // lastStatus 未設定 = まだ in_progress でない → Stop で in_progress へ遷移を試みる
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
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
    // 非節目なのでコメントはキューに無い。in_progress 遷移のみ残る
    expect(st.pendingQueue.map((o) => o.op)).toEqual(["update_issue"]);
    expect(st.pendingQueue[0].payload.statusId).toBe(2); // in_progress(2)
    expect(st.pendingQueue.every((o) => o.attempts === 1)).toBe(true);
    expect(st.lastStatus).toBe("in_progress"); // 楽観更新（実遷移はキュー再送に委ねる）
  });

  it("節目ターンのオフライン: add_comment と in_progress 遷移がキューに残る", async () => {
    const store = new StateStore(dir);
    // lastStatus 未設定 = in_progress 遷移が発生する
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
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
    const statusOp = st.pendingQueue.find((o) => o.op === "update_issue");
    expect(statusOp?.payload.statusId).toBe(2); // in_progress(2)、resolved ではない
    expect(st.pendingQueue.every((o) => o.attempts === 1)).toBe(true);
    expect(st.lastStatus).toBe("in_progress");
  });

  it("SessionEnd でセッション完了時に resolved へ遷移する（Stop では維持された in_progress から）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.lastStatus = "in_progress"; s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    // Stop は in_progress を維持（既に in_progress なので status PATCH しない）
    const stopAdapter = adapterWithIssue();
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: stopAdapter as any, projectId: 10, judgment: DET },
    );
    expect(stopAdapter.setStatus).not.toHaveBeenCalled(); // Stop では status を触らない
    const mid = await store.loadOrCreate("s1");
    expect(mid.lastStatus).toBe("in_progress");

    // SessionEnd で完了 → resolved へ1回 PATCH
    const online = adapterWithIssue();
    await runSessionEnd({ tool: "claude", event: "session-end", sessionId: "s1", cwd: "/r", raw: {} }, { store, adapter: online as any, projectId: 10, judgment: DET });
    expect(online.setStatus).toHaveBeenCalledWith("PROJ-1", 3, undefined); // resolved へ遷移
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("resolved");
    expect(st.pendingQueue).toEqual([]); // 排出済み
  });

  it("issueKey 無しでも deps 解決済みなら遅延作成し、説明更新+in_progress 維持まで行う（Codex exec パリティ）", async () => {
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
    // ensureSessionIssue が in_progress(2) へ遷移済み。Stop は同値スキップで重複 PATCH しない（resolved にしない）
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-100", 2, undefined);
    expect(adapter.setStatus).not.toHaveBeenCalledWith("PROJ-100", 3, undefined);
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
    expect(st.lastStatus).toBe("in_progress"); // 作業中は in_progress 維持
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

  it("F3: 2ターン連続で in_progress を維持（2回目は status PATCH なし）・コメントは節目時のみ", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "依頼1";
    });
    const adapter = adapterWithIssue();
    // 1ターン目: 非節目 → コメント無し・in_progress へ遷移（lastStatus 未設定のため1回 PATCH）
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    // 2ターン目: 節目 → コメント1件・status は in_progress 同値スキップ（往復しない）
    await store.withLock("s1", (s) => { s.lastPrompt = "依頼2"; });
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );

    expect(adapter.updateDescription).toHaveBeenCalledTimes(2); // 説明は毎ターン（本文が変化するため）
    expect(adapter.addComment).toHaveBeenCalledTimes(1); // 節目ターンのみ
    expect(adapter.setStatus).toHaveBeenCalledTimes(1); // 1回目の in_progress のみ。2回目は同値スキップ（往復トグルなし）
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 2, undefined); // in_progress(2)
    expect(adapter.setStatus).not.toHaveBeenCalledWith("PROJ-1", 3, undefined); // resolved には遷移しない
    const st = await store.loadOrCreate("s1");
    expect(st.lastStatus).toBe("in_progress");
    expect(st.turnCount).toBe(2);
  });

  it("F3: Stop は resolutionFixedId が設定されていても resolved/resolutionId を送らない（完了は SessionEnd の責務）", async () => {
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
    // Stop は in_progress(2) へのみ遷移。resolutionId（4引数）は送らない
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-1", 2, undefined);
    expect(adapter.setStatus).not.toHaveBeenCalledWith("PROJ-1", 3, undefined, 0);
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

  it("F4: 同一本文の連続ターンでは2回目の updateDescription がスキップされる（差分ハッシュ）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "ログイン機能の実装"; s.progress = []; s.lastPrompt = "原因を調べて";
    });
    const adapter = adapterWithIssue();
    const ev = { tool: "claude" as const, event: "stop" as const, sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} };

    // 1ターン目: 説明欄を PATCH（初回ハッシュ確定）
    await runStop(ev, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    expect(adapter.updateDescription).toHaveBeenCalledTimes(1);
    const st1 = await store.loadOrCreate("s1");
    expect(st1.lastDescriptionHash).toBeTruthy();

    // 2ターン目: 同一プロンプト/結果 → 本文不変 → updateDescription はスキップ（呼び出し回数据え置き）
    await store.withLock("s1", (s) => { s.lastPrompt = "原因を調べて"; });
    await runStop(ev, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    expect(adapter.updateDescription).toHaveBeenCalledTimes(1); // スキップされ増えない
    const st2 = await store.loadOrCreate("s1");
    expect(st2.lastDescriptionHash).toBe(st1.lastDescriptionHash); // ハッシュ不変
    expect(st2.turnCount).toBe(2); // ターンは進む（スキップは説明 PATCH のみ）
  });

  it("F4: 本文が変化したターンでは PATCH され、ハッシュが更新される", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "ログイン機能の実装"; s.progress = []; s.lastPrompt = "原因を調べて";
    });
    const adapter = adapterWithIssue();

    // 1ターン目
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    const st1 = await store.loadOrCreate("s1");

    // 2ターン目: 結果テキストが変化 → 最新状況が変わり本文も変化 → PATCH される
    await store.withLock("s1", (s) => { s.lastPrompt = "次の作業"; });
    await runStop(
      { tool: "claude", event: "stop", sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: "別の調査結果を報告します。", raw: {} },
      { store, adapter: adapter as any, projectId: 10, judgment: DET },
    );
    expect(adapter.updateDescription).toHaveBeenCalledTimes(2); // 本文変化のため再 PATCH
    const st2 = await store.loadOrCreate("s1");
    expect(st2.lastDescriptionHash).not.toBe(st1.lastDescriptionHash); // ハッシュ更新
  });

  it("F4: PATCH 失敗時はハッシュを更新せず、次ターンで再 PATCH を試みる", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => {
      s.issueKey = "PROJ-1"; s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.originalTask = "t"; s.progress = []; s.lastPrompt = "p";
    });
    const adapter = adapterWithIssue();
    adapter.updateDescription.mockRejectedValueOnce(new Error("fetch failed")); // 1回目だけ失敗
    const ev = { tool: "claude" as const, event: "stop" as const, sessionId: "s1", cwd: "/r", stopHookActive: false, lastAssistantMessage: NON_MILESTONE_MSG, raw: {} };

    await runStop(ev, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    const st1 = await store.loadOrCreate("s1");
    expect(st1.lastDescriptionHash).toBeUndefined(); // 失敗ターンはハッシュ未更新

    // 同一本文でも前回 PATCH 失敗のため再 PATCH される（スキップしない）
    await store.withLock("s1", (s) => { s.lastPrompt = "p"; });
    await runStop(ev, { store, adapter: adapter as any, projectId: 10, judgment: DET });
    expect(adapter.updateDescription).toHaveBeenCalledTimes(2); // 再 PATCH
    const st2 = await store.loadOrCreate("s1");
    expect(st2.lastDescriptionHash).toBeTruthy(); // 2回目成功でハッシュ確定
  });
});
