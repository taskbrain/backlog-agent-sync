import type { CanonicalEvent, ActivityEntry } from "../types.js";
import { ensureSessionIssue, opDrainHandler, type LifecycleDeps, type HookOutput } from "./session-start.js";
import { FILE_TOOLS } from "./post-tool.js";
import { readLastAssistantText } from "../transcript.js";
import { getActiveIssue } from "../state/store.js";
import { getBackend } from "../judgment/index.js";
import { buildDescription, appendMilestone, type ChildLink } from "../issue/description.js";

const RESULT_MAX = 1200;
const RESULT_MAX_BYTES = 262144;
const BODY_MAX = 40000; // Backlog コメント上限は未公表（実測5万）のため安全側で切詰
const PROGRESS_MAX_LINES = 20; // ## 進捗 の有界化（appendMilestone）
const MILESTONE_LINE_MAX = 200; // 節目1行・節目コメントの切詰

/** 変更ファイル → 回数の Map（変更ファイル集計用）。 */
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

/** 1 行の節目テキスト（依頼整理 > 結果先頭行 の順で素材化し切詰）。 */
function milestoneLine(request: string | undefined, result: string | undefined): string {
  const src = (request?.trim() || result?.trim() || "").replace(/\s+/g, " ").trim();
  if (!src) return "節目";
  return src.length > MILESTONE_LINE_MAX ? `${src.slice(0, MILESTONE_LINE_MAX)}…` : src;
}

/** childIssueKeys（string[]）を ChildLink へ変換。URL 生成器が無いため label=key。 */
function toChildLinks(childKeys: string[]): ChildLink[] {
  return childKeys.map((key) => ({ key, label: key }));
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

  // 同期先 = 逸脱分割後のアクティブ課題。未分割時はセッション主課題（ensureSessionIssue の戻り）。
  const active = getActiveIssue(st);
  const syncKey = active.key ?? ensured;

  const turn = (st.turnCount ?? 0) + 1;
  const request = st.lastPromptSummary?.trim() || st.lastPrompt?.trim();
  const result = await resolveResult(ev);
  const changedFiles = [...countFiles(st.activityBuffer).keys()];

  // 現状サマリ（説明欄再構築前の現在値）を導出。state に保持が無いため originalTask + progress から組む。
  const originalTask = st.originalTask ?? "";
  const prevProgress = st.progress ?? [];
  const currentSummary = buildDescription({ originalTask, progress: prevProgress, latest: "", children: [] });

  // 判定 backend でサマリ更新（claude 起動は backend 内のガード/フォールバックに委ねる）
  const { summary, isMilestone } = await getBackend(deps.judgment).updateSummary({
    sessionId: ev.sessionId,
    originalTask,
    currentSummary,
    turnPrompt: request,
    turnResult: result,
    changedFiles,
  });

  // 節目のみ進捗へ 1 行追加（有界化）。それ以外は進捗据え置き。
  const nextProgress = isMilestone
    ? appendMilestone(prevProgress, milestoneLine(request, result), PROGRESS_MAX_LINES)
    : prevProgress;

  // 説明欄は毎ターン再構築して上書き（4ブロック: タスク/進捗/最新状況/子課題）。
  const body = buildDescription(
    {
      originalTask,
      progress: nextProgress,
      latest: summary,
      children: toChildLinks(active.childKeys),
    },
    deps.textFormattingRule ?? "markdown",
  ).slice(0, BODY_MAX);

  // 説明欄更新は耐久キューを介さず直接呼ぶ（buildDescription が常に全体を再構築するため、
  // 失敗してもターン次第で自己修復する。非ブロッキングのため失敗は握り潰す）。
  try {
    await adapter.updateDescription(syncKey, body);
  } catch {
    // オフライン/権限等の失敗はセッションを止めない（次ターンの説明更新で回復）
  }

  // 節目コメントは isMilestone の時だけ 1 件（耐久キュー経由。従来のターン毎 add_comment は撤去）。
  // enqueue id はターン毎に一意（セッション固定 id だと drain の index 突合で潰れるため）。
  if (isMilestone) {
    await store.enqueue(ev.sessionId, {
      id: `stop-milestone:${ev.sessionId}:${turn}`,
      op: "add_comment",
      payload: { content: milestoneLine(request, result) },
      attempts: 0,
    });
  }

  // 状態遷移（処理中⇄処理済み）は維持。同値ステータス PATCH は Backlog が code 7 で拒否するため
  // resolved 済みならスキップ（Phase1 の no-op スキップ）。
  const flipStatus = st.lastStatus !== "resolved";
  if (flipStatus) {
    const payload: Record<string, unknown> = { statusId: st.statusMap.resolved };
    // 完了理由を同一 PATCH で送信（resolutionFixedId=0「対応済み」が有効値のため != null 判定）
    if (deps.resolutionFixedId != null) payload.resolutionId = deps.resolutionFixedId;
    await store.enqueue(ev.sessionId, { id: `stop-status:${ev.sessionId}:${turn}`, op: "update_issue", payload, attempts: 0 });
  }

  // 状態の永続化: バッファ/lastPrompt/lastPromptSummary/turnStartHead クリア、progress 更新、turnCount/lastStatus。
  await store.withLock(ev.sessionId, (s) => {
    s.activityBuffer = [];
    s.lastPrompt = undefined;
    s.lastPromptSummary = undefined;
    s.turnStartHead = undefined;
    s.turnCount = turn;
    if (isMilestone) s.progress = nextProgress;
    if (flipStatus) s.lastStatus = "resolved";
  });

  // drain は失敗 op を attempts++ で残置するため、オフラインでも例外を伝播しない。
  // 同値 PATCH（Backlog code 7）の事前スキップ用に「このターン開始前」の既知ステータスを渡す。
  // st は楽観更新前のスナップショット（loadOrCreate 直後）なので st.lastStatus はターン開始前の値。
  const currentStatusId = st.lastStatus ? st.statusMap[st.lastStatus] : undefined;
  await store.drain(ev.sessionId, opDrainHandler(adapter, syncKey, currentStatusId));

  return {};
}
