export type RateCategory = "read" | "write" | "search";

export interface RateLimiterDeps {
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private last = new Map<RateCategory, number>();
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: RateLimiterDeps = {}) {
    this.minIntervalMs = deps.minIntervalMs ?? 1000;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async beforeRequest(category: RateCategory): Promise<void> {
    if (category === "read") return; // read は緩いので間隔制御しない
    const last = this.last.get(category);
    const t = this.now();
    if (last !== undefined) {
      const wait = this.minIntervalMs - (t - last);
      if (wait > 0) await this.sleep(wait);
    }
    this.last.set(category, this.now());
  }

  /** 429 時: Retry-After は無いので X-RateLimit-Reset(UTC epoch sec)まで待つ。無ければ60s。 */
  async handle429(headers: Headers): Promise<void> {
    const reset = headers.get("X-RateLimit-Reset");
    let waitMs = 60_000;
    if (reset) {
      const resetMs = Number(reset) * 1000;
      waitMs = Math.max(0, resetMs - this.now());
    }
    await this.sleep(waitMs);
  }
}
