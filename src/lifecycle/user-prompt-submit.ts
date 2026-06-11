import type { CanonicalEvent } from "../types.js";
import { ensureSessionIssue, type LifecycleDeps, type HookOutput } from "./session-start.js";

const PROMPT_DETAIL_MAX = 120;

/**
 * UserPromptSubmit: 初回プロンプトで課題を作成（タイトル/説明はプロンプト由来）。
 * 2ターン目以降は追加依頼としてバッファに記録し、状態を処理中へ戻す。
 * 失敗は握りつぶしプロンプト処理を止めない（非ブロッキング原則）。
 */
export async function runUserPromptSubmit(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store } = deps;
  const prompt = (ev.prompt ?? "").trim();
  const st = await store.loadOrCreate(ev.sessionId);

  if (prompt) {
    await store.withLock(ev.sessionId, (s) => {
      s.lastPrompt = prompt;
      if (!s.initialPrompt) s.initialPrompt = prompt;
    });
    st.lastPrompt = prompt;
    if (!st.initialPrompt) st.initialPrompt = prompt;
  }

  try {
    if (!st.issueKey) {
      // 初回プロンプト: ここで課題を作成（init 未解決時は undefined で no-op）
      await ensureSessionIssue(ev, deps, st);
      return {};
    }

    // 2ターン目以降: 追加依頼として記録
    if (prompt) {
      await store.withLock(ev.sessionId, (s) => {
        s.activityBuffer.push({ ts: new Date().toISOString(), tool: "(依頼)", summary: "(依頼)", detail: prompt.slice(0, PROMPT_DETAIL_MAX) });
      });
    }

    // 応答済（resolved）→ 再依頼で処理中へフリップ。同値ステータス PATCH は Backlog が
    // code 7 で拒否するため、lastStatus が既に in_progress ならスキップする
    if (st.lastStatus !== "in_progress") {
      const issueKey = st.issueKey;
      const turn = st.turnCount ?? 0;
      await store.enqueue(ev.sessionId, { id: `prompt-status:${ev.sessionId}:${turn}`, op: "update_issue", payload: { statusId: st.statusMap.in_progress }, attempts: 0 });
      await store.withLock(ev.sessionId, (s) => { s.lastStatus = "in_progress"; });
      await store.drain(ev.sessionId, async (op) => {
        if (op.op === "add_comment") { await deps.adapter.addComment(issueKey, String(op.payload.content)); return true; }
        if (op.op === "update_issue") { await deps.adapter.setStatus(issueKey, Number(op.payload.statusId), undefined); return true; }
        return true;
      });
    }
  } catch {
    // 非ブロッキング: 課題作成・状態遷移の失敗でプロンプト処理を止めない
  }
  return {};
}
