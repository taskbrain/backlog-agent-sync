import type { CanonicalEvent, ActivityEntry } from "../types.js";
import { ensureSessionIssue, type LifecycleDeps, type HookOutput } from "./session-start.js";
import { FILE_TOOLS } from "./post-tool.js";
import { readLastAssistantText } from "../transcript.js";

const PROMPT_MAX = 200;
const RESULT_MAX = 600;
const RESULT_MAX_BYTES = 262144;
const COMMAND_PREVIEW = 3;
const REQUEST_TOOL = "(依頼)"; // user-prompt-submit が積む擬似エントリ（ツール件数から除外）

/** 変更ファイルの集計: "foo.ts(3) / bar.md(1)"。 */
export function summarizeFiles(entries: ActivityEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (!FILE_TOOLS.has(e.tool) || !e.detail) continue;
    counts.set(e.detail, (counts.get(e.detail) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  return [...counts.entries()].map(([file, n]) => `${file}(${n})`).join(" / ");
}

/** 実行コマンドの集計: 先頭3件 + 総数。 */
export function summarizeCommands(entries: ActivityEntry[]): string | undefined {
  const cmds = entries.filter((e) => e.tool === "Bash" && e.detail).map((e) => e.detail as string);
  if (cmds.length === 0) return undefined;
  return `${cmds.slice(0, COMMAND_PREVIEW).join(" / ")}（${cmds.length}件）`;
}

export function countTools(entries: ActivityEntry[]): number {
  return entries.filter((e) => e.tool !== REQUEST_TOOL).length;
}

/** 最終回答: Codex は payload（last_assistant_message）、Claude は transcript 末尾から抽出。 */
async function resolveResult(ev: CanonicalEvent): Promise<string | undefined> {
  const fromPayload = ev.lastAssistantMessage?.trim();
  if (fromPayload) return fromPayload.slice(0, RESULT_MAX);
  if (ev.transcriptPath) {
    return readLastAssistantText(ev.transcriptPath, { maxBytes: RESULT_MAX_BYTES, maxChars: RESULT_MAX });
  }
  return undefined;
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

  const entries = st.activityBuffer;
  const turn = (st.turnCount ?? 0) + 1;
  const prompt = st.lastPrompt?.trim();
  const result = await resolveResult(ev);
  const files = summarizeFiles(entries);
  const commands = summarizeCommands(entries);

  const lines: string[] = [`🤖 ターン要約 #${turn}`];
  if (prompt) lines.push(`■ 依頼: ${prompt.slice(0, PROMPT_MAX)}`);
  if (result) lines.push(`■ 結果: ${result}`);
  if (files) lines.push(`■ 変更ファイル: ${files}`);
  if (commands) lines.push(`■ 実行コマンド: ${commands}`);
  lines.push(`（ツール使用 ${countTools(entries)} 件）`);
  const body = lines.join("\n");

  // 送信前に耐久記録（オフラインでも欠落しない・§15）。enqueue id はターン毎に一意
  // （セッション固定 id だと drain の成功判定 Map で 2 ターン目以降が潰れるため）
  await store.enqueue(ev.sessionId, { id: `stop:${ev.sessionId}:${turn}`, op: "add_comment", payload: { content: body }, attempts: 0 });
  // 同値ステータス PATCH は Backlog が code 7 で拒否するため、resolved 済みならスキップ
  const flipStatus = st.lastStatus !== "resolved";
  if (flipStatus) {
    await store.enqueue(ev.sessionId, { id: `stop-status:${ev.sessionId}:${turn}`, op: "update_issue", payload: { statusId: st.statusMap.resolved }, attempts: 0 });
  }

  // enqueue 済みのためバッファ/lastPrompt はクリアして安全。lastStatus は楽観更新
  await store.withLock(ev.sessionId, (s) => {
    s.activityBuffer = [];
    s.lastPrompt = undefined;
    s.turnCount = turn;
    if (flipStatus) s.lastStatus = "resolved";
  });

  // drain は失敗 op を attempts++ で残置するため、オフラインでも例外を伝播しない
  await store.drain(ev.sessionId, async (op) => {
    if (op.op === "add_comment") { await adapter.addComment(issueKey, String(op.payload.content)); return true; }
    if (op.op === "update_issue") { await adapter.setStatus(issueKey, Number(op.payload.statusId), undefined); return true; }
    return true;
  });
  return {};
}
