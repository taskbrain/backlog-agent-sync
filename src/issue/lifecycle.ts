import type { SessionState } from "../types.js";
import type { Divergence } from "../judgment/types.js";
import type { CreateIssueInput, IssueRef } from "../tracker/backlog-rest.js";
import { setActiveIssue } from "../state/store.js";

/**
 * 逸脱検知（classifyDivergence）の結果に応じて Backlog 課題を構造化する。
 *
 * 設計の要点:
 * - REST/state を直接握らず、最小の注入契約（DivergenceDeps）越しに操作する → テスタブル & 配線非依存。
 * - id 解決の制約: BacklogRest には「キー → 課題オブジェクト（id）」を取る GET が無い。
 *   よって既存課題の数値 id は `getIssueId(key)` 注入関数で解決する（呼出側が state.issueId 等で束縛）。
 *   新規作成課題の id は createIssue 返り値から得る（parentIssueId に直接渡せる）。
 *   親子化の API setParent は key/数値 id どちらも受けるため、現課題の再親子化はキーで足りる。
 * - 非ブロッキング原則: init 未解決（issueTypeId/priorityId 欠落）や id 解決失敗時は何もせず返す
 *   （プロンプト処理を止めない・乱立させない）。閾値ベースの乱立防止は classifyDivergence 側で担保済み。
 */
export interface DivergenceDeps {
  projectId: number;
  /** 課題種別 id（init 解決値）。未解決なら課題を作成しない。 */
  issueTypeId?: number;
  /** 優先度 id（init 解決値）。未解決なら課題を作成しない。 */
  priorityId?: number;
  /** 課題作成（parentIssueId 指定で子課題）。返り値の id/key を後続の親子化に使う。 */
  createIssue(input: CreateIssueInput): Promise<IssueRef>;
  /** 既存課題の後付け再親子化（key/数値 id どちらも可）。 */
  setParent(issueIdOrKey: string | number, parentIssueId: number): Promise<void>;
  /** 相互リンク/分割理由コメント。 */
  addComment(issueIdOrKey: string | number, content: string): Promise<void>;
  /** 既存課題キー → 数値 id 解決（無ければ undefined）。child/sibling-親あり で必要。 */
  getIssueId(issueKey: string): Promise<number | undefined>;
  /** project.json の textFormattingRule 等は説明本文には影響しないため最小説明のみ生成する。 */
}

/** 機械マーカー（session-start.ts の sessionMarker と同一規約 [[bas:session:<sid>]]）。 */
function sessionMarker(sessionId: string): string {
  return `[[bas:session:${sessionId}]]`;
}

/** 分割課題の最小説明（件名 + 由来 + マーカー）。重い v3 整形は初回課題に限り、分割は軽量に保つ。 */
function buildSplitDescription(sessionId: string, label: string, turnPrompt: string, relationLine: string): string {
  const lines: string[] = [];
  lines.push("## 概要");
  lines.push(label.trim() || "（自動分割）");
  lines.push("");
  lines.push("## 由来");
  lines.push(relationLine);
  if (turnPrompt.trim()) {
    lines.push("");
    lines.push("## 依頼(原文)");
    lines.push(turnPrompt.trim().slice(0, 4000));
  }
  lines.push("");
  lines.push(sessionMarker(sessionId));
  return lines.join("\n");
}

/**
 * Divergence に応じて課題構造を更新する。失敗・前提不足は no-op で返す（非ブロッキング）。
 *
 * - in_scope → 何もしない。
 * - divergent/independent → 独立課題を新規作成し active を切替。originalTask=turnPrompt / progress=[]（新トピック）。
 * - divergent/child → 現 active 課題の子として作成。相互リンクコメント。active を子へ（originalTask は維持）。
 * - divergent/sibling（親なし） → エポック親を作成 → 現課題を子#1へ後付け再親子化 → 子#2を作成し active へ。
 * - divergent/sibling（親あり） → 既存親エポック配下に子を1つ追加し active へ（再親子化しない）。
 */
export async function handleDivergence(
  deps: DivergenceDeps,
  st: SessionState,
  divergence: Divergence,
  turnPrompt: string,
): Promise<void> {
  if (divergence.kind === "in_scope") return;
  // init 未解決なら作成不可（非ブロッキング no-op）。
  if (!deps.issueTypeId || !deps.priorityId) return;

  const { relationship, label } = divergence;
  const activeKey = st.activeIssueKey ?? st.issueKey;
  // アクティブ課題が無い状況（初回課題未作成）では分割対象が無いため何もしない。
  if (!activeKey) return;

  const sessionId = st.sessionId;
  const issueTypeId = deps.issueTypeId;
  const priorityId = deps.priorityId;

  if (relationship === "independent") {
    // 独立: 親なしの新課題。新トピックとして active/originalTask/progress を切替。
    const ref = await deps.createIssue({
      projectId: deps.projectId,
      summary: label,
      issueTypeId,
      priorityId,
      description: buildSplitDescription(sessionId, label, turnPrompt, "独立した新トピックとして自動分割"),
    });
    setActiveIssue(st, { key: ref.issueKey });
    st.originalTask = turnPrompt;
    st.progress = [];
    return;
  }

  if (relationship === "child") {
    // 子: 現 active 課題の子。現 active の数値 id 解決が前提（解決不可なら no-op）。
    const parentId = await deps.getIssueId(activeKey);
    // id 解決失敗時は無言で消えず stderr に1行残す（VEO バグ同型の沈黙消失を防止）。
    if (parentId == null) {
      process.stderr.write(`backlog-sync: id解決失敗で逸脱処理をスキップ: ${activeKey}\n`);
      return;
    }
    const ref = await deps.createIssue({
      projectId: deps.projectId,
      summary: label,
      issueTypeId,
      priorityId,
      parentIssueId: parentId,
      description: buildSplitDescription(sessionId, label, turnPrompt, `親課題 ${activeKey} のサブ作業として自動分割`),
    });
    // 相互リンク（親 → 子 / 子 → 親）。
    await deps.addComment(activeKey, `子課題を作成しました: ${ref.issueKey} ${label}`.trim());
    await deps.addComment(ref.issueKey, `親課題: ${activeKey}`);
    const childKeys = [...(st.childIssueKeys ?? []), ref.issueKey];
    setActiveIssue(st, { key: ref.issueKey, parentKey: activeKey, childKeys });
    // 子は現タスクの一部なので originalTask は維持。progress は子コンテキストとして引き継がない。
    return;
  }

  // relationship === "sibling": 関連する別作業。
  if (st.parentIssueKey) {
    // 既存親エポックがある: その配下に子を1つ追加するだけ（再親子化不要）。
    const parentKey = st.parentIssueKey;
    const parentId = await deps.getIssueId(parentKey);
    // 既存親エポックの id 解決失敗時も無言で消えず stderr に1行残す（沈黙消失の防止）。
    if (parentId == null) {
      process.stderr.write(`backlog-sync: id解決失敗で逸脱処理をスキップ: ${parentKey}\n`);
      return;
    }
    const ref = await deps.createIssue({
      projectId: deps.projectId,
      summary: label,
      issueTypeId,
      priorityId,
      parentIssueId: parentId,
      description: buildSplitDescription(sessionId, label, turnPrompt, `親エポック ${parentKey} 配下の関連作業として自動分割`),
    });
    await deps.addComment(parentKey, `子課題を追加しました: ${ref.issueKey} ${label}`.trim());
    const childKeys = [...(st.childIssueKeys ?? []), ref.issueKey];
    setActiveIssue(st, { key: ref.issueKey, parentKey, childKeys });
    return;
  }

  // 親なし sibling: エポック親を作成 → 現課題を子#1へ後付け → 子#2を作成し active へ。
  const epicSummary = `${st.originalTask?.split(/\r?\n/)[0]?.trim() || activeKey} ほか`;
  const epic = await deps.createIssue({
    projectId: deps.projectId,
    summary: epicSummary.length > 60 ? `${epicSummary.slice(0, 60)}…` : epicSummary,
    issueTypeId,
    priorityId,
    description: buildSplitDescription(sessionId, epicSummary, turnPrompt, "関連する複数作業を束ねるエポックとして自動作成"),
  });
  // 既存現課題（子#1）をエポック配下へ後付け再親子化（S2 で永続化確認済み）。
  await deps.setParent(activeKey, epic.id);
  // 子#2（今回の関連作業）を作成。
  const child2 = await deps.createIssue({
    projectId: deps.projectId,
    summary: label,
    issueTypeId,
    priorityId,
    parentIssueId: epic.id,
    description: buildSplitDescription(sessionId, label, turnPrompt, `エポック ${epic.issueKey} 配下の関連作業として自動分割`),
  });
  // 親 + 両子に分割理由コメント。
  await deps.addComment(epic.issueKey, `関連作業を分割: 子 ${activeKey} / 子 ${child2.issueKey} ${label}`.trim());
  await deps.addComment(activeKey, `エポック ${epic.issueKey} の配下へ再編しました（関連作業 ${child2.issueKey} を分割）`);
  await deps.addComment(child2.issueKey, `エポック ${epic.issueKey} 配下の関連作業（兄弟課題 ${activeKey}）`);
  const childKeys = [...(st.childIssueKeys ?? []), activeKey, child2.issueKey];
  setActiveIssue(st, { key: child2.issueKey, parentKey: epic.issueKey, childKeys });
}
