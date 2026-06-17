import type { CanonicalEvent, SessionState } from "../types.js";
import { ensureSessionIssue, buildDescriptionV3, opDrainHandler, type LifecycleDeps, type HookOutput } from "./session-start.js";
import { defaultGitOps } from "../vcs/git.js";
import { getBackend } from "../judgment/index.js";
import { handleDivergence, type DivergenceDeps } from "../issue/lifecycle.js";
import { getActiveIssue } from "../state/store.js";

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
      // 逸脱検知の基準を確定: この課題をアクティブにし、原タスク = 初回プロンプト、進捗 = 空で開始。
      // （以降のターンで classifyDivergence が originalTask との乖離を判定する素材になる）
      if (issueKey) {
        await store.withLock(ev.sessionId, (s) => {
          s.activeIssueKey = issueKey;
          if (s.originalTask === undefined) s.originalTask = prompt || s.initialPrompt;
          if (s.progress === undefined) s.progress = [];
        });
        st.activeIssueKey = issueKey;
        if (st.originalTask === undefined) st.originalTask = prompt || st.initialPrompt;
        if (st.progress === undefined) st.progress = [];
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

    // 逸脱検知（2ターン目以降・アクティブ課題があり・プロンプトがある時のみ）。
    // 判定 backend は getBackend が常に既定（決定論フォールバック内包）を返すため未配線でも安全。
    // 構造化更新（課題作成/親子化）は handleDivergence が非ブロッキングに行う。
    if (prompt && getActiveIssue(st).key) {
      await detectAndHandleDivergence(ev, deps, st, prompt);
    }
  } catch {
    // 非ブロッキング: 課題作成・説明更新・状態遷移の失敗でプロンプト処理を止めない
  }
  return {};
}

/**
 * このターンのプロンプトを classifyDivergence にかけ、乖離していれば handleDivergence で構造化する。
 * 失敗はすべて握りつぶす（呼び出し側 try/catch 内だが、ここでも個別に防御して他処理に波及させない）。
 *
 * currentSummary: BacklogRest にキー→課題の GET が無いため、state 既知の originalTask（無ければ初回プロンプト）を渡す。
 * id 解決: deps.getIssueId 優先。未注入時は state.issueId（要求キーがセッション主課題キーと一致する場合のみ）。
 */
async function detectAndHandleDivergence(
  ev: CanonicalEvent,
  deps: LifecycleDeps,
  st: SessionState,
  turnPrompt: string,
): Promise<void> {
  const backend = getBackend(deps.judgment);
  const divergence = await backend.classifyDivergence({
    sessionId: ev.sessionId,
    originalTask: st.originalTask ?? st.initialPrompt ?? "",
    currentSummary: st.originalTask ?? st.initialPrompt ?? "",
    turnPrompt,
  });
  if (divergence.kind === "in_scope") return;

  // 既存課題キー → 数値 id 解決関数。
  // セッション主課題（st.issueKey）の id は state 既知のためショートカット（REST 不要）。
  // それ以外の任意キー（child 孫世代 / sibling 親あり）は deps.getIssueId（rest.getIssue）で解決する。
  const resolveIssueId = async (key: string): Promise<number | undefined> => {
    if (key === st.issueKey && st.issueId != null) return st.issueId;
    if (deps.getIssueId) {
      try { return await deps.getIssueId(key); } catch { /* 解決失敗は undefined（lifecycle 側で skip ログ + no-op） */ }
    }
    return undefined;
  };

  const divDeps: DivergenceDeps = {
    projectId: deps.projectId,
    issueTypeId: deps.issueTypeId,
    priorityId: deps.priorityId,
    createIssue: (input) => deps.adapter.createIssue(input),
    setParent: async (issueIdOrKey, parentIssueId) => {
      // adapter には setParent が無いため updateDescription と同経路の REST は使わず、
      // rest が注入されていればそれを使う。無ければ no-op（後付け再親子化を諦め、ぶら下げない）。
      const rest = deps.rest as { setParent?: (k: string | number, p: number) => Promise<void> } | undefined;
      if (rest?.setParent) await rest.setParent(issueIdOrKey, parentIssueId);
    },
    addComment: (issueIdOrKey, content) => deps.adapter.addComment(issueIdOrKey, content),
    getIssueId: resolveIssueId,
  };

  // setParent が使えない（rest 未注入）かつ sibling-親なしのケースは、後付け再親子化が成立しないため
  // handleDivergence 内で setParent が no-op になるが、課題作成自体は進む。乱立防止は閾値側で担保済み。
  await handleDivergence(divDeps, st, divergence, turnPrompt);
  // handleDivergence は引数の st（スナップショット）を直接変更するため、その結果を永続化する。
  await deps.store.withLock(ev.sessionId, (s) => {
    s.activeIssueKey = st.activeIssueKey;
    s.parentIssueKey = st.parentIssueKey;
    s.childIssueKeys = st.childIssueKeys;
    s.originalTask = st.originalTask;
    s.progress = st.progress;
  });
}
