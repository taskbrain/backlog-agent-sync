import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionState, StatusMap, QueuedOp } from "../types.js";

const DEFAULT_STATUS: StatusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };

/** 失敗 op の最大試行回数。到達した op は再キューせず破棄する（無限リトライ防止）。 */
const MAX_ATTEMPTS = 5;

export class StateStore {
  constructor(private readonly dir: string) {}

  private path(sessionId: string): string {
    const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  async loadOrCreate(sessionId: string, statusMap: StatusMap = DEFAULT_STATUS): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.path(sessionId), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const fresh: SessionState = {
          sessionId,
          statusMap,
          todoToChecklist: {},
          processedEvents: [],
          pendingQueue: [],
          activityBuffer: [],
        };
        await this.save(fresh);
        return fresh;
      }
      throw e;
    }
    try {
      return JSON.parse(raw) as SessionState;
    } catch {
      throw new Error(`状態ファイルが破損しています: ${this.path(sessionId)}`);
    }
  }

  /** 原子的書込: 一意な temp に書いて rename（同一 FS 上で atomic）。 */
  async save(state: SessionState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.path(state.sessionId);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, target);
  }

  /** read-modify-write を直列化（プロセス内ロック）。 */
  private locks = new Map<string, Promise<void>>();
  async withLock<T>(sessionId: string, fn: (st: SessionState) => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(sessionId, prev.then(() => next));
    await prev;
    try {
      const st = await this.loadOrCreate(sessionId);
      const result = await fn(st);
      await this.save(st);
      return result;
    } finally {
      release();
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId);
    }
  }

  /** state ディレクトリ内の全セッション状態を読む（ディレクトリ無し→空、破損ファイルはスキップ）。 */
  async listSessions(): Promise<SessionState[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: SessionState[] = [];
    for (const f of files.filter((n) => n.endsWith(".json")).sort()) {
      try {
        out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as SessionState);
      } catch {
        // 破損/書込途中のファイルはスキップ
      }
    }
    return out;
  }

  async markProcessed(sessionId: string, key: string): Promise<boolean> {
    return this.withLock(sessionId, (st) => {
      if (st.processedEvents.includes(key)) return false;
      st.processedEvents.push(key);
      return true;
    });
  }

  async enqueue(sessionId: string, op: QueuedOp): Promise<void> {
    await this.withLock(sessionId, (st) => {
      st.pendingQueue.push(op);
    });
  }

  /**
   * ハンドラが true を返した op を除去。false/throw は残置し attempts++。
   * 結果は op.id ではなくスナップショット配列内の index で突合する
   * （同一 id の op が複数あっても各々独立に除去/残置するため）。
   * ハンドラ実行中に enqueue された op は失わない: drain はロックを保持せずハンドラを呼ぶため、
   * その間に enqueue（push）された op はスナップショットより後ろに追加される。よって先頭
   * processedCount 件は index 整合が保たれ、index >= processedCount は drain 中追加分として無加工で残す。
   * attempts が MAX_ATTEMPTS に達した失敗 op は再キューせず破棄し、破棄時に 1 回だけ警告する。
   */
  async drain(sessionId: string, handler: (op: QueuedOp) => Promise<boolean>): Promise<void> {
    const snapshot = await this.loadOrCreate(sessionId);
    const processedCount = snapshot.pendingQueue.length;
    const results: boolean[] = []; // index -> 成功なら true（除去）、失敗なら false（残置 or 破棄）
    for (const op of snapshot.pendingQueue) {
      results.push(await handler(op).catch(() => false));
    }
    await this.withLock(sessionId, (st) => {
      const next: QueuedOp[] = [];
      st.pendingQueue.forEach((op, i) => {
        if (i >= processedCount) {
          next.push(op); // drain 中に enqueue された op（無加工で保持）
          return;
        }
        if (results[i]) return; // 成功 → 除去
        const attempts = op.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          // 上限到達 → 破棄。再び見ることはないため警告はここで 1 回だけ。
          process.stderr.write(
            `backlog-sync: op を破棄しました（再試行上限 ${MAX_ATTEMPTS} 回到達）: id=${op.id} op=${op.op}\n`,
          );
          return;
        }
        next.push({ ...op, attempts });
      });
      st.pendingQueue = next;
    });
  }
}
