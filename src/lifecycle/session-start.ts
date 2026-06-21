import type { CanonicalEvent, SessionState, QueuedOp, VcsConfig, TextFormattingRule, IssueFieldOverrides, JudgmentConfig } from "../types.js";
import type { StateStore } from "../state/store.js";
import type { TrackerAdapter } from "../tracker/adapter.js";
import type { GitOps } from "../vcs/git.js";
import { defaultGitOps } from "../vcs/git.js";
import { repoUrl } from "../vcs/linker.js";
import { renderer } from "../markup.js";
import { runPull, formatDigest, type PullRest } from "../inbound/pull.js";
import { deriveOriginalTask } from "../issue/original-task.js";
import { sweepStaleIssues, type StaleSweepRest } from "./stale-sweep.js";

export interface LifecycleDeps {
  store: StateStore;
  adapter: TrackerAdapter;
  projectId: number;
  issueTypeId?: number;
  priorityId?: number;
  rest?: PullRest; // インバウンド pull 用（未指定なら pull をスキップ）
  // ---- G19: VCS 連携 / フィールド動的設定（すべて optional・後方互換） ----
  vcs?: VcsConfig; // リンク生成（無ければリンク無しの従来表記）
  textFormattingRule?: TextFormattingRule; // 無ければ markdown
  fields?: (prompt: string) => Promise<IssueFieldOverrides> | IssueFieldOverrides; // パートB fields.ts の resolveCreateFields を束縛して注入
  resolutionFixedId?: number; // 完了理由。0 もあり得るため != null で判定すること
  root?: string; // buildRuntime の実行ルート（turnStartHead / git 認識用。無ければ ev.cwd）
  git?: GitOps; // git 操作の DI（テスト用。無ければ実 git）
  // G20: 依頼プロンプトの LLM 整理（summarize.ts を束縛して注入。Claude セッションのみ呼ぶ判定は lifecycle 側）
  summarize?: (prompt: string) => Promise<string | undefined>;
  // ---- Wave2 Task2.2: 逸脱検知→親子化（すべて optional・後方互換。未注入なら逸脱検知をスキップ） ----
  /** 判定 backend の選択（project.json judgment）。getBackend() に渡す。未注入でも getBackend が既定を返す。 */
  judgment?: JudgmentConfig;
  /**
   * 既存課題キー → 数値 id 解決（child/sibling-親あり の親子化に必要）。
   * 未注入時は state.issueId（active がセッション主課題と一致する場合のみ）で解決する。
   */
  getIssueId?: (issueKey: string) => Promise<number | undefined>;
  /**
   * SessionStart 時の放置課題スイープ設定（すべて optional・後方互換。未注入ならスイープしない）。
   * 異常終了で SessionEnd が発火せず in_progress のまま残った課題を保守的に resolved へ遷移させる。
   * runtime が project.json から解決した enabled/thresholdMs と、state ディレクトリ・REST 面を供給する。
   */
  staleSweep?: {
    enabled: boolean;
    thresholdMs: number;
    stateDir: string;
    rest: StaleSweepRest;
  };
}

export interface HookOutput { additionalContext?: string; }

const SUMMARY_MAX = 60;
const DESCRIPTION_PROMPT_MAX = 4000;
const OVERVIEW_MAX = 300;

/** state 消失時の find 用機械マーカー（seed の [[bas:epic:]] と同じ二重化思想）。 */
export function sessionMarker(sessionId: string): string {
  return `[[bas:session:${sessionId}]]`;
}

/** Backlog code 7 = 変更なし更新。同値ステータスへの PATCH で発生する。 */
function isNoChangeError(e: unknown): boolean {
  return /"code"\s*:\s*7\b/.test(String(e instanceof Error ? e.message : e));
}

/**
 * drain 用の共通 op ハンドラ（stop/subagent-stop/user-prompt-submit/session-end で共用）。
 * update_issue は resolutionId を持つ場合のみ 4 引数で渡す（id:0 の falsy 罠に注意し != null 判定）。
 * currentStatusId（既知の現在ステータス）を渡すと、同値 PATCH を REST 呼出前にスキップして成功扱いにする。
 * REST 呼出が code 7（変更なし）で失敗した場合も成功扱いで除去し、無限リトライを防ぐ。
 */
export function opDrainHandler(
  adapter: TrackerAdapter,
  issueKey: string,
  currentStatusId?: number,
): (op: QueuedOp) => Promise<boolean> {
  return async (op) => {
    if (op.op === "add_comment") {
      await adapter.addComment(issueKey, String(op.payload.content));
      return true;
    }
    if (op.op === "update_issue") {
      const statusId = Number(op.payload.statusId);
      // (a) 既知の現在ステータスと同値なら REST を呼ばず成功扱い（status id は 0 もあり得るため != null 判定）
      if (currentStatusId != null && statusId === currentStatusId) return true;
      const rid = op.payload.resolutionId;
      try {
        if (rid != null) await adapter.setStatus(issueKey, statusId, undefined, Number(rid));
        else await adapter.setStatus(issueKey, statusId, undefined);
      } catch (e) {
        // (b) code 7（変更なし）は既適用済みとみなし成功扱い。それ以外は再 throw → attempts++ で残置
        if (isNoChangeError(e)) return true;
        throw e;
      }
      return true;
    }
    return true;
  };
}

/** タイトル: プロンプト1行目を空白正規化して max60字。無ければ従来形式へフォールバック。 */
function buildIssueSummary(ev: CanonicalEvent, st: SessionState): string {
  const prompt = (st.initialPrompt ?? ev.prompt ?? "").trim();
  if (prompt) {
    const firstLine = (prompt.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
    if (firstLine) return firstLine.length > SUMMARY_MAX ? `${firstLine.slice(0, SUMMARY_MAX)}…` : firstLine;
  }
  return `[セッション] ${ev.sessionId.slice(0, 8)} (${new Date().toISOString().slice(0, 16)})`;
}

/** 概要 = 初回プロンプトの先頭段落（改行・空白を正規化、max300字）。 */
function buildOverview(prompt: string): string {
  const para = (prompt.split(/\n\s*\n/)[0] ?? "").replace(/\s+/g, " ").trim();
  return para.length > OVERVIEW_MAX ? `${para.slice(0, OVERVIEW_MAX)}…` : para;
}

/** ## 環境 のリスト行（説明 v2/v3 で共用）。 */
function envLines(ev: CanonicalEvent, deps: LifecycleDeps, md: ReturnType<typeof renderer>, branch?: string): string[] {
  const model = typeof (ev.raw as any)?.model === "string" && (ev.raw as any).model !== "" ? ` (${(ev.raw as any).model})` : "";
  const out: string[] = [md.listItem(`エージェント: ${ev.tool}${model}`)];
  const repo = deps.vcs ? repoUrl(deps.vcs) : undefined;
  if (repo) out.push(md.listItem(`リポジトリ: ${repo}`));
  out.push(md.listItem(`ブランチ: ${branch ?? "-"} / 作業ディレクトリ: ${ev.cwd}`));
  out.push(md.listItem(`開始: ${new Date().toISOString()} / session_id: ${ev.sessionId}`));
  return out;
}

/** 説明 v2（作成時の即時説明）: ## 概要 / ## 依頼(原文) 4000字 / ## 環境 + 機械マーカー。 */
function buildIssueDescription(ev: CanonicalEvent, st: SessionState, deps: LifecycleDeps, branch?: string): string {
  const md = renderer(deps.textFormattingRule ?? "markdown");
  const prompt = (st.initialPrompt ?? ev.prompt ?? "").trim();
  const lines: string[] = [];
  lines.push(md.heading(2, "概要"));
  lines.push(buildOverview(prompt) || "自動生成: backlog-agent-sync");
  lines.push("");
  if (prompt) {
    lines.push(md.heading(2, "依頼(原文)"));
    lines.push(prompt.slice(0, DESCRIPTION_PROMPT_MAX));
    lines.push("");
  }
  lines.push(md.heading(2, "環境"));
  lines.push(...envLines(ev, deps, md, branch));
  lines.push(sessionMarker(ev.sessionId));
  return lines.join("\n");
}

/**
 * 説明 v3（G20）: LLM 整理に成功したときの PATCH 用。
 * まとめ直した依頼文を主役にし、原文は「元プロンプト」として末尾の別枠へ。
 * 環境とマーカーは必ず維持する。
 */
export async function buildDescriptionV3(ev: CanonicalEvent, deps: LifecycleDeps, prompt: string, summary: string): Promise<string> {
  const md = renderer(deps.textFormattingRule ?? "markdown");
  const git = deps.git ?? defaultGitOps;
  const branch = await git.branchName(deps.root ?? ev.cwd);
  return [
    md.heading(2, "依頼内容"),
    summary,
    "",
    md.heading(2, "環境"),
    ...envLines(ev, deps, md, branch),
    "",
    md.heading(2, "元プロンプト"),
    prompt.trim().slice(0, DESCRIPTION_PROMPT_MAX),
    sessionMarker(ev.sessionId),
  ].join("\n");
}

/** deps.fields による動的フィールド解決（失敗 / 未注入は空 = 従来挙動）。undefined 値のキーは除去。 */
async function resolveFieldOverrides(ev: CanonicalEvent, deps: LifecycleDeps, st: SessionState): Promise<IssueFieldOverrides> {
  if (!deps.fields) return {};
  try {
    const raw = await deps.fields(st.initialPrompt ?? ev.prompt ?? "");
    return Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v !== undefined)) as IssueFieldOverrides;
  } catch {
    return {};
  }
}

/**
 * 課題が確立した時点（経路を問わず）に、逸脱判定の前提となる activeIssueKey と originalTask を seed する。
 *
 * G23 改訂 F1（主因修正）: 従来これらは UserPromptSubmit の `!st.issueKey` 初回ブロックでしか書かれず、
 * 本番では実際の課題作成が Stop の遅延 ensureSessionIssue 経路で起きるため永久に undefined だった。
 * → activeIssueKey 依存の逸脱ガードが常に false になり classifyDivergence が一度も呼ばれない。
 * 本ヘルパを課題確立の全経路（マーカー再照合 / 新規作成）から呼ぶことで確実に seed する。
 *
 * - activeIssueKey は常に issueKey に揃える（同期先課題が即アクティブ）。
 * - originalTask は未設定時のみ seed する（一度入れたら independent 逸脱時のみ更新＝既存ロジック不可侵）。
 *   素材: 実ユーザープロンプト（task-notification 等の非ユーザー由来ブロブは除外）→ 無ければ課題件名。
 */
async function seedActiveIssueAndOriginalTask(
  ev: CanonicalEvent,
  deps: LifecycleDeps,
  st: SessionState,
  issueKey: string,
  issueSummary: string,
): Promise<void> {
  try {
    const candidate = ev.prompt ?? st.initialPrompt;
    const original = deriveOriginalTask(candidate, issueSummary);
    await deps.store.withLock(ev.sessionId, (s) => {
      s.activeIssueKey = issueKey;
      if (s.originalTask === undefined && original !== undefined) s.originalTask = original;
      if (s.progress === undefined) s.progress = [];
    });
    // 呼出元スナップショットにも反映（同一ターンの後続処理が即参照できるように）
    st.activeIssueKey = issueKey;
    if (st.originalTask === undefined && original !== undefined) st.originalTask = original;
    if (st.progress === undefined) st.progress = [];
  } catch (e) {
    // seed 失敗は機能上は次ターンの backfill が自己修復するが、ここで握り潰すと沈黙消失して
    // 「逸脱判定が一度も走らない」状態の原因追跡が困難になる。既存の警告スタイルで 1 行残す。
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`backlog-sync: originalTask seed失敗(${issueKey}): ${msg}\n`);
  }
}

/**
 * セッション課題の find-or-create。優先順: state.issueKey → マーカー検索 → 新規作成。
 * issueTypeId/priorityId 未解決（init 未実行）の場合は作成せず undefined を返す。
 * UserPromptSubmit が主経路。SessionStart/UserPromptSubmit が発火しない環境
 * （Codex exec 等）では stop/subagent-stop からの遅延作成に使う。
 */
export async function ensureSessionIssue(ev: CanonicalEvent, deps: LifecycleDeps, st: SessionState): Promise<string | undefined> {
  if (st.issueKey) return st.issueKey;
  if (!deps.issueTypeId || !deps.priorityId) return undefined;

  // state 消失時はマーカー検索で既存課題を再照合（state が一次なので検索インデックス遅延の影響は小）
  const found = await deps.adapter.findByMarker(sessionMarker(ev.sessionId));
  if (found) {
    await deps.store.withLock(ev.sessionId, (s) => { s.issueKey = found.issueKey; s.issueId = found.id; });
    st.issueKey = found.issueKey; st.issueId = found.id;
    // 再照合経路でも逸脱判定の前提を seed（件名は found.summary、無ければ buildIssueSummary）
    await seedActiveIssueAndOriginalTask(ev, deps, st, found.issueKey, found.summary ?? buildIssueSummary(ev, st));
    return found.issueKey;
  }

  const git = deps.git ?? defaultGitOps;
  const branch = await git.branchName(deps.root ?? ev.cwd);
  const overrides = await resolveFieldOverrides(ev, deps, st);
  const summary = buildIssueSummary(ev, st);
  const ref = await deps.adapter.createIssue({
    projectId: deps.projectId,
    summary,
    issueTypeId: deps.issueTypeId,
    priorityId: deps.priorityId,
    description: buildIssueDescription(ev, st, deps, branch),
    ...overrides, // assigneeId / priorityId / categoryId[] / milestoneId[] / versionId[]（priorityId は上書き優先）
  });
  await deps.store.withLock(ev.sessionId, (s) => {
    s.issueKey = ref.issueKey; s.issueId = ref.id; s.statusMap = st.statusMap; s.lastStatus = "in_progress";
  });
  // 「作業を開始しました」コメントは投稿しない（G20: 説明と処理中ステータスで十分・ノイズ削減）
  await deps.adapter.setStatus(ref.issueKey, st.statusMap.in_progress, undefined);
  st.issueKey = ref.issueKey; st.issueId = ref.id; // 呼出元のスナップショットにも反映
  // 新規作成経路で逸脱判定の前提を seed（件名は作成に使った summary）
  await seedActiveIssueAndOriginalTask(ev, deps, st, ref.issueKey, summary);
  return ref.issueKey;
}

/**
 * SessionStart は statusMap 読込 + 既存課題の再照合（state 優先→マーカー検索）+ pull 注入のみ。
 * 課題の作成は行わない（初回プロンプト送信時 = UserPromptSubmit で作成する）。
 */
export async function runSessionStart(ev: CanonicalEvent, deps: LifecycleDeps): Promise<HookOutput> {
  const { store, adapter } = deps;
  const statusMap = await adapter.getStatusMap();
  // 後続フック（UserPromptSubmit/Stop）の課題作成・状態遷移が最新の statusMap を使えるよう保存
  const st = await store.withLock(ev.sessionId, (s) => { s.statusMap = statusMap; return s; });

  // 異常終了で SessionEnd が発火せず in_progress のまま残った課題を保守的に解消する（best-effort・非ブロッキング）。
  // 現在のセッションは除外。失敗しても SessionStart を止めない。
  if (deps.staleSweep?.enabled) {
    try {
      await sweepStaleIssues(
        {
          stateDir: deps.staleSweep.stateDir,
          rest: deps.staleSweep.rest,
          statusMap,
          resolutionFixedId: deps.resolutionFixedId, // 0「対応済み」も有効（sweep 内で != null 判定）
          thresholdMs: deps.staleSweep.thresholdMs,
          now: Date.now(),
        },
        ev.sessionId,
      );
    } catch {
      // スイープ失敗はセッション開始を止めない（非ブロッキング原則）
    }
  }

  if (!st.issueKey && (!deps.issueTypeId || !deps.priorityId)) {
    process.stderr.write("backlog-sync: init未実行（issueTypeId/priorityId 未解決）。課題は作成されません。`backlog-sync init` を実行してください。\n");
    return { additionalContext: "Backlog 同期: init 未実行のため課題は作成されません。`backlog-sync init` を実行してください。" };
  }

  // 既存課題の再照合: state 優先 → マーカー検索（state 消失時の resume 対応）
  let issueKey = st.issueKey;
  if (!issueKey) {
    try {
      const found = await adapter.findByMarker(sessionMarker(ev.sessionId));
      if (found) {
        issueKey = found.issueKey;
        await store.withLock(ev.sessionId, (s) => { s.issueKey = found.issueKey; s.issueId = found.id; });
      }
    } catch {
      // 再照合失敗はセッション開始を止めない（非ブロッキング原則）
    }
  }

  let context = issueKey
    ? `Backlog 課題: ${issueKey}（この作業は同課題へ同期されます）`
    : "Backlog 同期: 初回プロンプト送信時に課題を作成します";
  if (deps.rest) {
    try {
      const digest = await runPull({ rest: deps.rest, store, sessionId: ev.sessionId, projectId: deps.projectId || undefined });
      context += `\n${formatDigest(digest)}`;
    } catch {
      // pull 失敗でセッション開始を止めない（非ブロッキング原則）
    }
  }
  return { additionalContext: context };
}
