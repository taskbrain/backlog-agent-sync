import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, utimesSync, readFileSync } from "node:fs";
import { StateStore } from "../src/state/store.js";
import { runSessionStart, sessionMarker, ensureSessionIssue } from "../src/lifecycle/session-start.js";
import type { SessionState, StatusMap } from "../src/types.js";

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

const ev = { tool: "claude", event: "session-start", sessionId: "s1", cwd: "/repo", source: "startup", raw: {} } as const;

describe("runSessionStart", () => {
  it("課題は作成せず、初回プロンプト時に作成する旨を additionalContext で返す", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.createIssue).not.toHaveBeenCalled(); // 作成は UserPromptSubmit に移譲
    expect(out.additionalContext).toContain("初回プロンプト");
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBeUndefined();
    expect(st.statusMap.in_progress).toBe(2); // 最新 statusMap は保存される
  });

  it("state に issueKey があればそれを additionalContext に出す（マーカー検索しない）", async () => {
    const store = new StateStore(dir);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-7"; });
    const adapter = fakeAdapter();
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(out.additionalContext).toContain("PROJ-7");
    expect(adapter.findByMarker).not.toHaveBeenCalled(); // state 優先
    expect(adapter.createIssue).not.toHaveBeenCalled();
  });

  it("state 消失時はマーカー検索で既存課題を再照合し state に保存する", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    adapter.findByMarker.mockResolvedValue({ id: 100, issueKey: "PROJ-100" });
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.findByMarker).toHaveBeenCalledWith(sessionMarker("s1"));
    expect(adapter.createIssue).not.toHaveBeenCalled(); // 再照合のみ・作成しない
    expect(out.additionalContext).toContain("PROJ-100");
    const st = await store.loadOrCreate("s1");
    expect(st.issueKey).toBe("PROJ-100");
  });

  it("issueTypeId/priorityId 未解決（init未実行）なら警告を出す", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const out = await runSessionStart(ev, { store, adapter, projectId: 10 });
    expect(adapter.createIssue).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("init未実行");
    expect(out.additionalContext).toContain("init 未実行");
    errSpy.mockRestore();
  });

  it("rest があれば pull の digest を additionalContext に含める", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const rest = {
      getMyself: vi.fn().mockResolvedValue({ id: 5, name: "me" }),
      findIssues: vi.fn().mockResolvedValue([{ id: 9, issueKey: "PROJ-9", summary: "他課題", status: "処理中", updated: "2026-06-10T00:00:00Z" }]),
      getComments: vi.fn().mockResolvedValue([]),
    } as any;
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3, rest });
    expect(out.additionalContext).toContain("PROJ-9"); // pull digest
    const st = await store.loadOrCreate("s1");
    expect(st.inboundCursor?.issuesUpdatedSince).toBe("2026-06-10T00:00:00Z"); // カーソルも保存
  });

  it("pull が失敗してもセッション開始は成功する（非ブロッキング）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    const rest = {
      getMyself: vi.fn().mockRejectedValue(new Error("network")),
      findIssues: vi.fn(),
      getComments: vi.fn(),
    } as any;
    const out = await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3, rest });
    expect(out.additionalContext).toContain("初回プロンプト"); // コンテキスト返却は成功
  });
});

// ---- G23 改訂 F1: ensureSessionIssue が課題確立時に originalTask / activeIssueKey を seed する ----

describe("ensureSessionIssue seeding（F1）", () => {
  // Stop 遅延作成相当（prompt 無しイベント）。seed の素材は ev.prompt → st.initialPrompt → 課題件名。
  const stopEv = { tool: "claude", event: "stop", sessionId: "s1", cwd: "/repo", raw: {} } as const;
  const depsBase = { projectId: 10, issueTypeId: 4236190, priorityId: 3 };

  it("新規作成経路: activeIssueKey=issueKey / progress=[] を seed し、originalTask は実プロンプトから導出する", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    await store.withLock("s1", (s) => {
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.initialPrompt = "ログインバグを直して";
    });
    const st = await store.loadOrCreate("s1");
    await ensureSessionIssue(stopEv, { store, adapter, ...depsBase }, st);
    expect(adapter.createIssue).toHaveBeenCalledOnce();
    const saved = await store.loadOrCreate("s1");
    expect(saved.issueKey).toBe("PROJ-100");
    expect(saved.activeIssueKey).toBe("PROJ-100"); // F1: activeIssueKey が seed される
    expect(saved.originalTask).toBe("ログインバグを直して"); // 実プロンプト由来
    expect(saved.progress).toEqual([]);
    // 呼出元スナップショットにも反映
    expect(st.activeIssueKey).toBe("PROJ-100");
    expect(st.originalTask).toBe("ログインバグを直して");
  });

  it("ev.prompt を最優先で originalTask に採用する（Stop 経路で prompt が乗る場合）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    await store.withLock("s1", (s) => {
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.initialPrompt = "古い初回プロンプト";
    });
    const st = await store.loadOrCreate("s1");
    const evWithPrompt = { ...stopEv, prompt: "実ユーザーの依頼です" } as const;
    await ensureSessionIssue(evWithPrompt, { store, adapter, ...depsBase }, st);
    const saved = await store.loadOrCreate("s1");
    expect(saved.originalTask).toBe("実ユーザーの依頼です"); // ev.prompt 優先
  });

  it("マーカー再照合経路でも activeIssueKey / originalTask を seed する（found.summary を件名に使う）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    adapter.findByMarker.mockResolvedValue({ id: 100, issueKey: "PROJ-100", summary: "文字起こしを元に設計をまとめる" });
    await store.withLock("s1", (s) => {
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.initialPrompt = "<system-reminder>noise</system-reminder>"; // 実プロンプト不可 → summary へ
    });
    const st = await store.loadOrCreate("s1");
    await ensureSessionIssue(stopEv, { store, adapter, ...depsBase }, st);
    expect(adapter.createIssue).not.toHaveBeenCalled(); // 再照合のみ
    const saved = await store.loadOrCreate("s1");
    expect(saved.issueKey).toBe("PROJ-100");
    expect(saved.activeIssueKey).toBe("PROJ-100");
    // 実プロンプト不可 → found.summary（クリーンな件名）へフォールバック。ブロブは混入しない。
    expect(saved.originalTask).toBe("文字起こしを元に設計をまとめる");
    expect(saved.originalTask).not.toContain("system-reminder");
  });

  it("既に originalTask がある場合は seed で上書きしない（一度設定したら固定）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    await store.withLock("s1", (s) => {
      s.statusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
      s.initialPrompt = "新しい依頼";
      s.originalTask = "既存の原タスク"; // 既設定（disk に永続化）
    });
    const st = await store.loadOrCreate("s1");
    await ensureSessionIssue(stopEv, { store, adapter, ...depsBase }, st);
    const saved = await store.loadOrCreate("s1");
    expect(saved.originalTask).toBe("既存の原タスク"); // 不変
    expect(saved.activeIssueKey).toBe("PROJ-100"); // activeIssueKey は常に揃える
  });
});

// ---- staleSweep の SessionStart 配線（best-effort・非ブロッキング） ----

describe("runSessionStart × staleSweep 配線", () => {
  const STATUS_MAP: StatusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
  const HOUR = 3_600_000;

  /** state ファイルを書き、mtime を hoursAgo（時間）前に設定する。 */
  function writeStaleState(sessionId: string, partial: Partial<SessionState>, hoursAgo: number): string {
    const st: SessionState = {
      sessionId, statusMap: STATUS_MAP, todoToChecklist: {}, processedEvents: [], pendingQueue: [], activityBuffer: [], ...partial,
    };
    const file = join(dir, `${sessionId}.json`);
    writeFileSync(file, JSON.stringify(st, null, 2), "utf8");
    const sec = (Date.now() - hoursAgo * HOUR) / 1000;
    utimesSync(file, sec, sec);
    return file;
  }

  it("enabled のとき古い in_progress 課題を解消し staleSwept 印を付ける（現在セッションは除外）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    // 放置された別セッション（48h 前）と、現在セッション s1（除外対象）
    const staleFile = writeStaleState("ghost", { issueKey: "PROJ-OLD", lastStatus: "in_progress" }, 48);
    await store.withLock("s1", (s) => { s.issueKey = "PROJ-7"; s.lastStatus = "in_progress"; });
    const out = await runSessionStart(ev, {
      store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3,
      staleSweep: { enabled: true, thresholdMs: 24 * HOUR, stateDir: dir, rest: adapter },
    });
    expect(adapter.setStatus).toHaveBeenCalledWith("PROJ-OLD", STATUS_MAP.resolved, undefined);
    const saved = JSON.parse(readFileSync(staleFile, "utf8")) as SessionState;
    expect(saved.staleSwept).toBe(true);
    expect(out.additionalContext).toContain("PROJ-7"); // 通常の SessionStart 出力は維持
  });

  it("staleSweep 未注入なら何もしない（後方互換）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    writeStaleState("ghost", { issueKey: "PROJ-OLD", lastStatus: "in_progress" }, 48);
    await runSessionStart(ev, { store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3 });
    expect(adapter.setStatus).not.toHaveBeenCalled();
  });

  it("enabled=false なら何もしない", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    writeStaleState("ghost", { issueKey: "PROJ-OLD", lastStatus: "in_progress" }, 48);
    await runSessionStart(ev, {
      store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3,
      staleSweep: { enabled: false, thresholdMs: 24 * HOUR, stateDir: dir, rest: adapter },
    });
    expect(adapter.setStatus).not.toHaveBeenCalled();
  });

  it("スイープが throw してもセッション開始は止まらない（非ブロッキング）", async () => {
    const store = new StateStore(dir);
    const adapter = fakeAdapter();
    writeStaleState("ghost", { issueKey: "PROJ-OLD", lastStatus: "in_progress" }, 48);
    // setStatus が transient 失敗してもスイープ自体は best-effort で握る → SessionStart は成功
    adapter.setStatus.mockRejectedValueOnce(new Error("network"));
    const out = await runSessionStart(ev, {
      store, adapter, projectId: 10, issueTypeId: 4236190, priorityId: 3,
      staleSweep: { enabled: true, thresholdMs: 24 * HOUR, stateDir: dir, rest: adapter },
    });
    expect(out.additionalContext).toContain("初回プロンプト"); // コンテキスト返却は成功
  });
});
