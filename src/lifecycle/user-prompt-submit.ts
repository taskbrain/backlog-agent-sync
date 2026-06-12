import type { CanonicalEvent } from "../types.js";
import { ensureSessionIssue, buildDescriptionV3, opDrainHandler, type LifecycleDeps, type HookOutput } from "./session-start.js";
import { defaultGitOps } from "../vcs/git.js";

/**
 * UserPromptSubmit: 初回プロンプトで課題を作成し、LLM 整理に成功したら説明を v3 へ更新。
 * 2ターン目以降は依頼の整理結果を lastPromptSummary に保存し、状態を処理中へ戻す。
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

  // ターン開始時の HEAD を記録（stop のコミット列挙の起点。git 不在/失敗は無視）
  const git = deps.git ?? defaultGitOps;
  const head = await git.headSha(deps.root ?? ev.cwd);
  if (head) {
    await store.withLock(ev.sessionId, (s) => { s.turnStartHead = head; });
    st.turnStartHead = head;
  }

  // 依頼の LLM 整理（Claude セッションのみ。Codex 環境は claude CLI 不在 + フック同期30秒制約のため呼ばない）
  let summary: string | undefined;
  if (prompt && deps.summarize && ev.tool === "claude") {
    try {
      summary = await deps.summarize(prompt);
    } catch {
      summary = undefined; // 整理失敗は原文フォールバック
    }
  }
  if (prompt) {
    // 前ターンの残骸を上書き（undefined なら明示的にクリア = stop が原文へフォールバック）
    await store.withLock(ev.sessionId, (s) => { s.lastPromptSummary = summary; });
    st.lastPromptSummary = summary;
  }

  try {
    if (!st.issueKey) {
      // 初回プロンプト: 課題を即時作成（原文ベースの説明。init 未解決時は undefined で no-op）
      const issueKey = await ensureSessionIssue(ev, deps, st);
      // LLM 整理に成功していれば、説明を v3（まとめ直し主役 + 元プロンプト別枠）へ更新。
      // 失敗時は従来説明のまま（PATCH しない）。マーカーと環境は buildDescriptionV3 が維持する
      if (issueKey && prompt && summary) {
        await deps.adapter.updateDescription(issueKey, await buildDescriptionV3(ev, deps, prompt, summary));
      }
      return {};
    }

    // 2ターン目以降: 応答済（resolved）→ 再依頼で処理中へフリップ。同値ステータス PATCH は
    // Backlog が code 7 で拒否するため、lastStatus が既に in_progress ならスキップする
    if (st.lastStatus !== "in_progress") {
      const issueKey = st.issueKey;
      const turn = st.turnCount ?? 0;
      await store.enqueue(ev.sessionId, { id: `prompt-status:${ev.sessionId}:${turn}`, op: "update_issue", payload: { statusId: st.statusMap.in_progress }, attempts: 0 });
      await store.withLock(ev.sessionId, (s) => { s.lastStatus = "in_progress"; });
      await store.drain(ev.sessionId, opDrainHandler(deps.adapter, issueKey));
    }
  } catch {
    // 非ブロッキング: 課題作成・説明更新・状態遷移の失敗でプロンプト処理を止めない
  }
  return {};
}
