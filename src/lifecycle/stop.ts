import type { CanonicalEvent, ActivityEntry } from "../types.js";
import { ensureSessionIssue, opDrainHandler, type LifecycleDeps, type HookOutput } from "./session-start.js";
import { FILE_TOOLS } from "./post-tool.js";
import { readLastAssistantText } from "../transcript.js";
import { defaultGitOps } from "../vcs/git.js";
import { fileUrl, commitUrl } from "../vcs/linker.js";
import { renderer, type MarkupRenderer } from "../markup.js";

const PROMPT_MAX = 500;
const RESULT_MAX = 1200;
const RESULT_MAX_BYTES = 262144;
const BODY_MAX = 40000; // Backlog コメント上限は未公表（実測5万）のため安全側で切詰

/** 変更ファイル → 回数の Map（リンク化リスト用）。 */
export function countFiles(entries: ActivityEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!FILE_TOOLS.has(e.tool) || !e.detail) continue;
    counts.set(e.detail, (counts.get(e.detail) ?? 0) + 1);
  }
  return counts;
}

/** 最終回答: Claude/Codex とも payload（last_assistant_message）優先、無ければ transcript 末尾から抽出。 */
async function resolveResult(ev: CanonicalEvent): Promise<string | undefined> {
  const fromPayload = ev.lastAssistantMessage?.trim();
  if (fromPayload) return fromPayload.slice(0, RESULT_MAX);
  if (ev.transcriptPath) {
    return readLastAssistantText(ev.transcriptPath, { maxBytes: RESULT_MAX_BYTES, maxChars: RESULT_MAX });
  }
  return undefined;
}

/** ### 変更 のリスト行: ファイル（blob リンク）+ コミット（commit リンク + 未push 注記）。 */
async function buildChangeLines(
  ev: CanonicalEvent,
  deps: LifecycleDeps,
  md: MarkupRenderer,
  entries: ActivityEntry[],
  turnStartHead: string | undefined,
): Promise<string[]> {
  const git = deps.git ?? defaultGitOps;
  const root = deps.root ?? ev.cwd;
  const lines: string[] = [];

  // 変更ファイル（rev=このターンの HEAD で permalink。git/vcs 不在ならテキストのみ）
  const turnHead = await git.headSha(root);
  for (const [file, n] of countFiles(entries)) {
    const label = `${file}(${n})`;
    const url = deps.vcs && turnHead ? fileUrl(deps.vcs, file, turnHead) : undefined;
    lines.push(md.listItem(url ? md.link(label, url) : label));
  }

  // コミット列挙（turnStartHead..HEAD。開始点不明はスキップ+注記）
  if (turnStartHead) {
    const { commits, reason } = await git.commitsBetween(root, turnStartHead);
    if (reason) {
      lines.push(md.listItem(`コミット: ${reason}`));
    }
    for (const c of commits) {
      const label = `${c.sha.slice(0, 7)} ${c.subject}`;
      const url = deps.vcs ? commitUrl(deps.vcs, c.sha) : undefined;
      const pushed = await git.isOnRemote(root, c.sha);
      lines.push(md.listItem(`コミット: ${url ? md.link(label, url) : label}${pushed ? "" : "（未push）"}`));
    }
  }
  return lines;
}

export async function runStop(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  if (ev.stopHookActive) return {}; // 既にこのフックでブロック中: 何もしない
  const { store, adapter } = deps;
  const st = await store.loadOrCreate(ev.sessionId);

  // SessionStart/UserPromptSubmit が発火しない環境（Codex exec 等）向けの遅延 find-or-create
  let ensured: string | undefined;
  try {
    ensured = await ensureSessionIssue(ev, deps, st);
  } catch {
    // 作成失敗（オフライン/権限等）は非ブロッキングで no-op（init 未解決時は undefined が返る）
  }
  if (!ensured) return {};
  const issueKey = ensured; // const 化（drain クロージャ内での narrowing 維持）

  const md = renderer(deps.textFormattingRule ?? "markdown");
  const entries = st.activityBuffer;
  const turn = (st.turnCount ?? 0) + 1;
  // 依頼は LLM 整理（lastPromptSummary）を主役に、無ければ原文へフォールバック
  const request = st.lastPromptSummary?.trim() || st.lastPrompt?.trim()?.slice(0, PROMPT_MAX);
  const result = await resolveResult(ev);
  const changeLines = await buildChangeLines(ev, deps, md, entries, st.turnStartHead);

  // ターン要約 v3（G20: 人間向けに純化。ツール件数・コマンド一覧は出さない）
  const lines: string[] = [md.heading(2, `ターン #${turn}`)];
  if (request) lines.push(md.heading(3, "依頼"), request);
  if (result) lines.push(md.heading(3, "結果"), result);
  if (changeLines.length) lines.push(md.heading(3, "変更"), ...changeLines); // 変更が無ければセクションごと省略
  const body = lines.join("\n").slice(0, BODY_MAX);

  // 送信前に耐久記録（オフラインでも欠落しない・§15）。enqueue id はターン毎に一意
  // （セッション固定 id だと drain の成功判定 Map で 2 ターン目以降が潰れるため）
  await store.enqueue(ev.sessionId, { id: `stop:${ev.sessionId}:${turn}`, op: "add_comment", payload: { content: body }, attempts: 0 });
  // 同値ステータス PATCH は Backlog が code 7 で拒否するため、resolved 済みならスキップ
  const flipStatus = st.lastStatus !== "resolved";
  if (flipStatus) {
    const payload: Record<string, unknown> = { statusId: st.statusMap.resolved };
    // 完了理由を同一 PATCH で送信（resolutionFixedId=0「対応済み」が有効値のため != null 判定）
    if (deps.resolutionFixedId != null) payload.resolutionId = deps.resolutionFixedId;
    await store.enqueue(ev.sessionId, { id: `stop-status:${ev.sessionId}:${turn}`, op: "update_issue", payload, attempts: 0 });
  }

  // enqueue 済みのためバッファ/lastPrompt/lastPromptSummary/turnStartHead はクリアして安全。lastStatus は楽観更新
  await store.withLock(ev.sessionId, (s) => {
    s.activityBuffer = [];
    s.lastPrompt = undefined;
    s.lastPromptSummary = undefined;
    s.turnStartHead = undefined;
    s.turnCount = turn;
    if (flipStatus) s.lastStatus = "resolved";
  });

  // drain は失敗 op を attempts++ で残置するため、オフラインでも例外を伝播しない
  await store.drain(ev.sessionId, opDrainHandler(adapter, issueKey));
  return {};
}
