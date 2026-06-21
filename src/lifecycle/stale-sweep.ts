import { readdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionState, StatusMap } from "../types.js";

/**
 * stale スイープが「課題を処理済みへ遷移」させるために必要な最小 REST 面。
 * BacklogAdapter / TrackerAdapter.setStatus がそのまま満たす（resolutionId は 0 もあり得るため != null 判定）。
 */
export interface StaleSweepRest {
  setStatus(issueIdOrKey: string | number, statusId: number, comment?: string, resolutionId?: number): Promise<void>;
}

export interface StaleSweepDeps {
  /** state ファイル（*.json）の置き場。StateStore と同じディレクトリ。 */
  stateDir: string;
  /** 解消用の REST 面（setStatus）。 */
  rest: StaleSweepRest;
  /** 正準ステータス id マップ（resolved を使う）。 */
  statusMap: StatusMap;
  /** 完了理由 id。0「対応済み」も有効値のため != null で有無判定すること。 */
  resolutionFixedId?: number;
  /** 放置とみなす無更新時間（ミリ秒）。`now - mtimeMs > thresholdMs` で stale。 */
  thresholdMs: number;
  /** 基準時刻（ミリ秒）。通常は Date.now()。テストでは注入。 */
  now: number;
  /** best-effort 警告（個別失敗の観測用）。未指定なら stderr へ 1 行。 */
  warn?: (msg: string) => void;
}

/** Backlog code 7 = 変更なし更新。既に resolved の課題へ PATCH したときに返る（既適用＝成功扱い）。 */
function isNoChangeError(e: unknown): boolean {
  return /"code"\s*:\s*7\b/.test(String(e instanceof Error ? e.message : e));
}

/** state ファイルの原子的上書き（StateStore.save と同じ temp→rename 方式）。 */
function atomicWrite(file: string, state: SessionState): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, file);
}

/**
 * SessionStart 時の保守的な放置課題スイープ。
 *
 * 異常終了（クラッシュ/ハードキル）で SessionEnd が発火せず、課題が `処理中`(in_progress) のまま
 * 残ったセッションを検出し、`処理済み`(resolved) へ遷移させて整合させる。
 *
 * stale 判定（すべて満たすときのみ対象）:
 *   1. state ファイルが現在のセッション（currentSessionId）のものでない
 *   2. issueKey が存在する（課題が作成済み）
 *   3. lastStatus !== "resolved"（=未解決。in_progress 等）
 *   4. staleSwept が真でない（=未スイープ。二重処理防止）
 *   5. (now - mtimeMs) > thresholdMs（=一定時間更新が無い＝放置）
 *
 * 解消は `rest.setStatus(issueKey, statusMap.resolved, undefined, resolutionFixedId?)`。
 * Backlog 側が既に resolved なら code 7（変更なし）で弾かれるが、それは成功扱い。
 * 成功（または code7）した state ファイルには staleSwept=true / lastStatus="resolved" を立てて保存し、
 * 二度とスイープしない。transient な失敗（ネットワーク等）ではフラグを立てず、次回 SessionStart で再試行する。
 *
 * best-effort: 個別の失敗は warn して継続。スイープ全体は SessionStart をブロックしない。
 *
 * @returns 解消した（または既に resolved で印を付けた）課題キーの配列。
 */
export async function sweepStaleIssues(
  deps: StaleSweepDeps,
  currentSessionId: string,
): Promise<{ swept: string[] }> {
  const warn = deps.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  const swept: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(deps.stateDir);
  } catch (e) {
    // ディレクトリ不在（ENOENT）は単にスイープ対象なし。その他も SessionStart を止めない。
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`backlog-sync: stale スイープのディレクトリ列挙に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { swept };
  }

  const currentFileBase = `${currentSessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (name === currentFileBase) continue; // 現在のセッションは除外
    const file = join(deps.stateDir, name);

    let st: SessionState;
    let mtimeMs: number;
    try {
      st = JSON.parse(readFileSync(file, "utf8")) as SessionState;
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // 破損/書込途中/読取競合のファイルはスキップ（best-effort）
      continue;
    }

    // 念のためセッション id でも除外（ファイル名サニタイズの取りこぼし対策）
    if (st.sessionId === currentSessionId) continue;
    if (!st.issueKey) continue; // 課題未作成 → 対象外
    if (st.lastStatus === "resolved") continue; // 既に解決 → 対象外
    if (st.staleSwept) continue; // 既スイープ → 二重処理防止
    if (!(deps.now - mtimeMs > deps.thresholdMs)) continue; // まだ放置でない（最近更新）→ 対象外

    try {
      // resolutionFixedId は 0（対応済み）も有効値のため != null 判定（falsy 罠回避）
      if (deps.resolutionFixedId != null) {
        await deps.rest.setStatus(st.issueKey, deps.statusMap.resolved, undefined, deps.resolutionFixedId);
      } else {
        await deps.rest.setStatus(st.issueKey, deps.statusMap.resolved, undefined);
      }
    } catch (e) {
      if (!isNoChangeError(e)) {
        // transient な失敗 → フラグを立てず次回 SessionStart で再試行
        warn(`backlog-sync: stale スイープに失敗（次回再試行）: ${st.issueKey}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      // code 7（変更なし）= 既に resolved。成功扱いで印を付ける。
    }

    // 解消成功（または既に resolved=code7）→ 二重処理防止フラグを立てて保存
    try {
      st.staleSwept = true;
      st.lastStatus = "resolved";
      atomicWrite(file, st);
    } catch (e) {
      // 印付けの保存に失敗しても Backlog 側の解消は完了している。warn のみ（次回 code7 で冪等）。
      warn(`backlog-sync: stale スイープの印付け保存に失敗: ${st.issueKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
    swept.push(st.issueKey);
  }

  return { swept };
}
