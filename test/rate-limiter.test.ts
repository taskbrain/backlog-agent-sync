import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../src/tracker/rate-limiter.js";

describe("RateLimiter", () => {
  it("write は最小間隔(>=1000ms)を空ける", async () => {
    const sleeps: number[] = [];
    const rl = new RateLimiter({ minIntervalMs: 1000, now: () => 0, sleep: async (ms) => { sleeps.push(ms); } });
    await rl.beforeRequest("write"); // 初回は待たない
    await rl.beforeRequest("write"); // 直後なので ~1000ms 待つ
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it("429 応答時は X-RateLimit-Reset まで待つ", async () => {
    let slept = 0;
    const rl = new RateLimiter({ minIntervalMs: 0, now: () => 10_000, sleep: async (ms) => { slept = ms; } });
    const headers = new Headers({ "X-RateLimit-Reset": "15" }); // epoch sec = 15 -> 15000ms
    await rl.handle429(headers);
    expect(slept).toBe(5000); // 15000 - 10000
  });
});
