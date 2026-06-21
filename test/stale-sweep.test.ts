import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionState, StatusMap } from "../src/types.js";
import { sweepStaleIssues } from "../src/lifecycle/stale-sweep.js";
import { resolveStaleSweepConfig } from "../src/config.js";

const STATUS_MAP: StatusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };
const HOUR = 3_600_000;
const NOW = 1_000_000_000_000; // 固定基準時刻（テスト注入）
const THRESHOLD = 24 * HOUR;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-sweep-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** state ファイルを書き、mtime を now からの相対（時間）で設定する。 */
function writeState(sessionId: string, partial: Partial<SessionState>, mtimeHoursAgo: number): string {
  const st: SessionState = {
    sessionId,
    statusMap: STATUS_MAP,
    todoToChecklist: {},
    processedEvents: [],
    pendingQueue: [],
    activityBuffer: [],
    ...partial,
  };
  const file = join(dir, `${sessionId}.json`);
  writeFileSync(file, JSON.stringify(st, null, 2), "utf8");
  const mtimeSec = (NOW - mtimeHoursAgo * HOUR) / 1000;
  utimesSync(file, mtimeSec, mtimeSec);
  return file;
}

function fakeRest() {
  return { setStatus: vi.fn().mockResolvedValue(undefined) };
}

function baseDeps(rest: { setStatus: ReturnType<typeof vi.fn> }, extra: Partial<Parameters<typeof sweepStaleIssues>[0]> = {}) {
  return {
    stateDir: dir,
    rest,
    statusMap: STATUS_MAP,
    thresholdMs: THRESHOLD,
    now: NOW,
    warn: vi.fn(),
    ...extra,
  };
}

describe("sweepStaleIssues", () => {
  it("古い in_progress セッションを処理済みへ遷移し staleSwept 印を付ける", async () => {
    const file = writeState("old", { issueKey: "PROJ-1", lastStatus: "in_progress" }, 48); // 48h 前
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual(["PROJ-1"]);
    expect(rest.setStatus).toHaveBeenCalledWith("PROJ-1", STATUS_MAP.resolved, undefined);
    const saved = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    expect(saved.staleSwept).toBe(true);
    expect(saved.lastStatus).toBe("resolved");
  });

  it("新しい（最近更新された）in_progress はスイープしない", async () => {
    writeState("fresh", { issueKey: "PROJ-2", lastStatus: "in_progress" }, 1); // 1h 前 < 24h
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual([]);
    expect(rest.setStatus).not.toHaveBeenCalled();
  });

  it("既に resolved の state はスキップする", async () => {
    writeState("done", { issueKey: "PROJ-3", lastStatus: "resolved" }, 48);
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual([]);
    expect(rest.setStatus).not.toHaveBeenCalled();
  });

  it("staleSwept=true の既処理 state はスキップする（二重処理防止）", async () => {
    writeState("already", { issueKey: "PROJ-4", lastStatus: "in_progress", staleSwept: true }, 48);
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual([]);
    expect(rest.setStatus).not.toHaveBeenCalled();
  });

  it("現在のセッション（currentSessionId）のファイルは除外する", async () => {
    writeState("current", { issueKey: "PROJ-5", lastStatus: "in_progress" }, 48);
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual([]);
    expect(rest.setStatus).not.toHaveBeenCalled();
  });

  it("issueKey が無い state（課題未作成）はスキップする", async () => {
    writeState("noissue", { lastStatus: "in_progress" }, 48);
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual([]);
    expect(rest.setStatus).not.toHaveBeenCalled();
  });

  it("Backlog code7（変更なし=既に resolved）は成功扱いで印を付ける", async () => {
    const file = writeState("c7", { issueKey: "PROJ-6", lastStatus: "in_progress" }, 48);
    const rest = { setStatus: vi.fn().mockRejectedValue(new Error('Backlog PATCH -> 400 {"errors":[{"code":7}]}')) };
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual(["PROJ-6"]); // code7 は成功扱い
    const saved = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    expect(saved.staleSwept).toBe(true);
    expect(saved.lastStatus).toBe("resolved");
  });

  it("引用符なしの code: 7 形式でも成功扱いで印を付ける", async () => {
    const file = writeState("c7raw", { issueKey: "PROJ-6B", lastStatus: "in_progress" }, 48);
    const rest = { setStatus: vi.fn().mockRejectedValue(new Error("Backlog PATCH -> 400 errors: [{ code: 7, message: No change }]")) };
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual(["PROJ-6B"]); // 引用符なしでも code7 は成功扱い
    const saved = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    expect(saved.staleSwept).toBe(true);
    expect(saved.lastStatus).toBe("resolved");
  });

  it("transient な失敗では印を付けない（次回 SessionStart で再試行）", async () => {
    const file = writeState("net", { issueKey: "PROJ-7", lastStatus: "in_progress" }, 48);
    const rest = { setStatus: vi.fn().mockRejectedValue(new Error("network ECONNRESET")) };
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual([]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    expect(saved.staleSwept).toBeUndefined(); // 印は付かない
    expect(saved.lastStatus).toBe("in_progress"); // 据え置き
  });

  it("resolutionFixedId=0（対応済み）が解消時に付与される（falsy 罠）", async () => {
    writeState("res0", { issueKey: "PROJ-8", lastStatus: "in_progress" }, 48);
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest, { resolutionFixedId: 0 }), "current");
    expect(swept).toEqual(["PROJ-8"]);
    // resolutionId=0 が 4 引数で渡る（!= null 判定により falsy でも付与）
    expect(rest.setStatus).toHaveBeenCalledWith("PROJ-8", STATUS_MAP.resolved, undefined, 0);
  });

  it("resolutionFixedId 未指定なら 3 引数で resolutionId を付けない", async () => {
    writeState("nores", { issueKey: "PROJ-9", lastStatus: "in_progress" }, 48);
    const rest = fakeRest();
    await sweepStaleIssues(baseDeps(rest), "current");
    expect(rest.setStatus).toHaveBeenCalledWith("PROJ-9", STATUS_MAP.resolved, undefined);
    expect(rest.setStatus.mock.calls[0]).toHaveLength(3); // 4 引数目（resolutionId）は無し
  });

  it("複数 state を一度に処理し、対象だけを返す", async () => {
    writeState("a", { issueKey: "PROJ-A", lastStatus: "in_progress" }, 48); // stale
    writeState("b", { issueKey: "PROJ-B", lastStatus: "in_progress" }, 2); // fresh
    writeState("c", { issueKey: "PROJ-C", lastStatus: "resolved" }, 48); // resolved
    writeState("current", { issueKey: "PROJ-CUR", lastStatus: "in_progress" }, 48); // current
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual(["PROJ-A"]);
    expect(rest.setStatus).toHaveBeenCalledTimes(1);
  });

  it("ディレクトリ不在でも例外を投げず空を返す", async () => {
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest, { stateDir: join(dir, "nope") }), "current");
    expect(swept).toEqual([]);
    expect(rest.setStatus).not.toHaveBeenCalled();
  });

  it("破損 JSON のファイルはスキップして他を処理する", async () => {
    writeFileSync(join(dir, "broken.json"), "{ not json", "utf8");
    const file = writeState("ok", { issueKey: "PROJ-OK", lastStatus: "in_progress" }, 48);
    const rest = fakeRest();
    const { swept } = await sweepStaleIssues(baseDeps(rest), "current");
    expect(swept).toEqual(["PROJ-OK"]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    expect(saved.staleSwept).toBe(true);
  });
});

describe("resolveStaleSweepConfig", () => {
  it("undefined 入力は既定 enabled=true / thresholdHours=24", () => {
    expect(resolveStaleSweepConfig(undefined)).toEqual({ enabled: true, thresholdHours: 24 });
  });

  it("enabled=false を尊重する", () => {
    expect(resolveStaleSweepConfig({ enabled: false })).toEqual({ enabled: false, thresholdHours: 24 });
  });

  it("thresholdHours を上書きできる", () => {
    expect(resolveStaleSweepConfig({ thresholdHours: 72 })).toEqual({ enabled: true, thresholdHours: 72 });
  });

  it("不正な thresholdHours（0/負/NaN）は既定 24 に丸める", () => {
    expect(resolveStaleSweepConfig({ thresholdHours: 0 })).toEqual({ enabled: true, thresholdHours: 24 });
    expect(resolveStaleSweepConfig({ thresholdHours: -5 })).toEqual({ enabled: true, thresholdHours: 24 });
    expect(resolveStaleSweepConfig({ thresholdHours: Number.NaN })).toEqual({ enabled: true, thresholdHours: 24 });
  });
});
