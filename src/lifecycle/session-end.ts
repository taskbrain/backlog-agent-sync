import type { CanonicalEvent } from "../types.js";
import { opDrainHandler, type LifecycleDeps, type HookOutput } from "./session-start.js";

/**
 * SessionEnd（セッション終了時）。
 * F3: 「処理済み」への遷移はここで1回だけ行う（完了時のみ）。Stop は作業中=in_progress を維持する。
 * 現在値が resolved 以外のときのみ resolved へ PATCH（同値 PATCH = Backlog code 7 を避ける）。
 * resolutionId は resolutionFixedId が設定されている場合のみ同一 PATCH で送る（0「対応済み」が有効値のため != null 判定）。
 * 既存キュー（オフライン残置 op）も同時に排出する。
 */
export async function runSessionEnd(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter } = deps;
  const st = await store.loadOrCreate(ev.sessionId);
  if (!st.issueKey) return {};

  // 完了時のみ resolved へ遷移（実際に変化する場合のみ）。同値ならキューに積まない。
  const toResolved = st.lastStatus !== "resolved";
  if (toResolved) {
    const payload: Record<string, unknown> = { statusId: st.statusMap.resolved };
    // 完了理由を同一 PATCH で送信（resolutionFixedId=0「対応済み」が有効値のため != null 判定）
    if (deps.resolutionFixedId != null) payload.resolutionId = deps.resolutionFixedId;
    await store.enqueue(ev.sessionId, { id: `session-end-status:${ev.sessionId}`, op: "update_issue", payload, attempts: 0 });
    await store.withLock(ev.sessionId, (s) => { s.lastStatus = "resolved"; }); // 楽観更新（実遷移はキュー drain に委ねる）
  }

  // 同値 PATCH（Backlog code 7）の事前スキップ用に「終了前」の既知ステータスを渡す。
  // st は楽観更新前のスナップショット（loadOrCreate 直後）なので st.lastStatus は終了前の値。
  const currentStatusId = st.lastStatus ? st.statusMap[st.lastStatus] : undefined;
  await store.drain(ev.sessionId, opDrainHandler(adapter, st.issueKey, currentStatusId));
  return {};
}
