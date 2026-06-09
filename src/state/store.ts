import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionState, StatusMap, QueuedOp } from "../types.js";

const DEFAULT_STATUS: StatusMap = { open: 1, in_progress: 2, resolved: 3, closed: 4 };

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
   * ハンドラ実行中に enqueue された op は失わない（ロック内で現在状態と突合）。
   */
  async drain(sessionId: string, handler: (op: QueuedOp) => Promise<boolean>): Promise<void> {
    const snapshot = await this.loadOrCreate(sessionId);
    const results = new Map<string, QueuedOp | null>(); // id -> 置換(失敗) または null(除去)
    for (const op of snapshot.pendingQueue) {
      const ok = await handler(op).catch(() => false);
      results.set(op.id, ok ? null : { ...op, attempts: op.attempts + 1 });
    }
    await this.withLock(sessionId, (st) => {
      st.pendingQueue = st.pendingQueue
        .filter((op) => results.get(op.id) !== null) // 成功(null)は除去。未処理(undefined)/失敗は保持
        .map((op) => {
          const replacement = results.get(op.id);
          return replacement ? replacement : op; // 失敗→attempts++、drain中に追加された新規op→そのまま
        });
    });
  }
}
