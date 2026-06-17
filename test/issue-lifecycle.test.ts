import { describe, it, expect, vi } from "vitest";
import type { SessionState } from "../src/types.js";
import type { Divergence } from "../src/judgment/types.js";
import { handleDivergence, type DivergenceDeps } from "../src/issue/lifecycle.js";

/** 最小の SessionState。アクティブ課題を与えて各分岐をテストする。 */
function baseState(over: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "s1",
    statusMap: { open: 1, in_progress: 2, resolved: 3, closed: 4 },
    todoToChecklist: {},
    processedEvents: [],
    pendingQueue: [],
    activityBuffer: [],
    issueKey: "PROJ-1",
    issueId: 1001,
    activeIssueKey: "PROJ-1",
    originalTask: "最初の依頼",
    progress: ["着手"],
    ...over,
  };
}

/**
 * createIssue は呼ばれるたびに連番の id/key を返す（呼出順に PROJ-200, PROJ-201, ...）。
 * setParent / addComment は記録のみ。getIssueId は active 課題 id を返すモック。
 */
function makeDeps(over: Partial<DivergenceDeps> = {}): DivergenceDeps & {
  createIssue: ReturnType<typeof vi.fn>;
  setParent: ReturnType<typeof vi.fn>;
  addComment: ReturnType<typeof vi.fn>;
  getIssueId: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  const createIssue = vi.fn(async (_input: any) => {
    const id = 200 + n;
    const issueKey = `PROJ-${200 + n}`;
    n++;
    return { id, issueKey };
  });
  const setParent = vi.fn(async () => undefined);
  const addComment = vi.fn(async () => undefined);
  const getIssueId = vi.fn(async (_key: string) => 1001);
  return {
    projectId: 10,
    issueTypeId: 4236190,
    priorityId: 3,
    createIssue,
    setParent,
    addComment,
    getIssueId,
    ...over,
  } as any;
}

describe("handleDivergence", () => {
  it("in_scope: 何もしない（課題作成・親子化・コメントなし、active 不変）", async () => {
    const st = baseState();
    const deps = makeDeps();
    const div: Divergence = { kind: "in_scope" };
    await handleDivergence(deps, st, div, "続けて実装して");
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(deps.setParent).not.toHaveBeenCalled();
    expect(deps.addComment).not.toHaveBeenCalled();
    expect(st.activeIssueKey).toBe("PROJ-1");
    expect(st.originalTask).toBe("最初の依頼");
    expect(st.progress).toEqual(["着手"]);
  });

  it("divergent/independent: 新課題を作成し active を切替・originalTask 更新・progress リセット", async () => {
    const st = baseState();
    const deps = makeDeps();
    const div: Divergence = { kind: "divergent", relationship: "independent", label: "別件: README整備" };
    await handleDivergence(deps, st, div, "別件: README整備\n章立てを直す");

    expect(deps.createIssue).toHaveBeenCalledOnce();
    const input = deps.createIssue.mock.calls[0][0];
    expect(input.summary).toBe("別件: README整備"); // 件名 = label
    expect(input.parentIssueId).toBeUndefined(); // 独立 = 親なし
    expect(input.description).toContain("[[bas:session:s1]]"); // 機械マーカー維持
    // 親子化なし・相互リンクコメントなし
    expect(deps.setParent).not.toHaveBeenCalled();
    expect(deps.addComment).not.toHaveBeenCalled();
    // active 切替
    expect(st.activeIssueKey).toBe("PROJ-200");
    expect(st.parentIssueKey).toBeUndefined();
    // 新トピックなので originalTask 更新 + progress リセット
    expect(st.originalTask).toBe("別件: README整備\n章立てを直す");
    expect(st.progress).toEqual([]);
  });

  it("divergent/child: 現アクティブ課題の子として作成・相互リンクコメント・active を子へ", async () => {
    const st = baseState();
    const deps = makeDeps();
    const div: Divergence = { kind: "divergent", relationship: "child", label: "サブ: 入力バリデーション" };
    await handleDivergence(deps, st, div, "サブタスク: 入力バリデーションを追加");

    // 現 active の id を解決して parentIssueId に渡す
    expect(deps.getIssueId).toHaveBeenCalledWith("PROJ-1");
    expect(deps.createIssue).toHaveBeenCalledOnce();
    const input = deps.createIssue.mock.calls[0][0];
    expect(input.parentIssueId).toBe(1001); // 現 active の数値 id
    expect(input.summary).toBe("サブ: 入力バリデーション");
    expect(input.description).toContain("[[bas:session:s1]]");

    // 相互リンク: 親へ「子課題: <childKey>」、子へ「親: <親key>」
    const targets = deps.addComment.mock.calls.map((c) => String(c[0]));
    expect(targets).toContain("PROJ-1"); // 親
    expect(targets).toContain("PROJ-200"); // 子
    const parentComment = deps.addComment.mock.calls.find((c) => c[0] === "PROJ-1")![1] as string;
    const childComment = deps.addComment.mock.calls.find((c) => c[0] === "PROJ-200")![1] as string;
    expect(parentComment).toContain("PROJ-200");
    expect(childComment).toContain("PROJ-1");

    // active を子へ・親キーを記録・childKeys に追加
    expect(st.activeIssueKey).toBe("PROJ-200");
    expect(st.parentIssueKey).toBe("PROJ-1");
    expect(st.childIssueKeys).toContain("PROJ-200");
    // 子は現タスクの一部なので originalTask は維持・progress は維持しない（子は新コンテキスト）
    expect(st.originalTask).toBe("最初の依頼");
  });

  it("divergent/sibling（親なし）: エポック親を作成→現課題を子#1へ後付け再親子化→子#2を作成し active へ", async () => {
    const st = baseState({ parentIssueKey: undefined });
    const deps = makeDeps();
    const div: Divergence = { kind: "divergent", relationship: "sibling", label: "関連: 認証リファクタ" };
    await handleDivergence(deps, st, div, "関連だが別作業: 認証をリファクタ");

    // createIssue は2回（親エポック → 子#2）
    expect(deps.createIssue).toHaveBeenCalledTimes(2);
    const parentInput = deps.createIssue.mock.calls[0][0];
    const child2Input = deps.createIssue.mock.calls[1][0];
    expect(parentInput.parentIssueId).toBeUndefined(); // 親エポックは最上位
    expect(child2Input.parentIssueId).toBe(200); // 親エポックの id 配下
    expect(child2Input.summary).toBe("関連: 認証リファクタ");

    // 既存現課題（PROJ-1）を親エポック配下へ後付け再親子化
    expect(deps.setParent).toHaveBeenCalledWith("PROJ-1", 200);

    // active を子#2へ
    expect(st.activeIssueKey).toBe("PROJ-201");
    expect(st.parentIssueKey).toBe("PROJ-200");

    // 親 + 両子に分割コメント
    const targets = deps.addComment.mock.calls.map((c) => String(c[0]));
    expect(targets).toContain("PROJ-200"); // 親
    expect(targets).toContain("PROJ-1"); // 子#1（旧現課題）
    expect(targets).toContain("PROJ-201"); // 子#2
  });

  it("divergent/sibling（親あり）: 既存親エポック配下に子を1つ追加し active へ（再親子化しない）", async () => {
    const st = baseState({ activeIssueKey: "PROJ-2", parentIssueKey: "PROJ-100", childIssueKeys: ["PROJ-2"] });
    const deps = makeDeps({ getIssueId: vi.fn(async (key: string) => (key === "PROJ-100" ? 900 : 1001)) as any });
    const div: Divergence = { kind: "divergent", relationship: "sibling", label: "関連: ログ整備" };
    await handleDivergence(deps, st, div, "ついでにログも整備したい");

    // 既存親の id を解決して子#Nを1つだけ作成
    expect((deps.getIssueId as any)).toHaveBeenCalledWith("PROJ-100");
    expect(deps.createIssue).toHaveBeenCalledOnce();
    const input = deps.createIssue.mock.calls[0][0];
    expect(input.parentIssueId).toBe(900);
    expect(input.summary).toBe("関連: ログ整備");

    // 後付け再親子化は不要
    expect(deps.setParent).not.toHaveBeenCalled();

    // active を新しい子へ・親は既存親のまま
    expect(st.activeIssueKey).toBe("PROJ-200");
    expect(st.parentIssueKey).toBe("PROJ-100");
    expect(st.childIssueKeys).toContain("PROJ-200");
  });

  it("init 未解決（issueTypeId/priorityId 欠落）なら課題を作成しない（非ブロッキング no-op）", async () => {
    const st = baseState();
    const deps = makeDeps({ issueTypeId: undefined, priorityId: undefined });
    const div: Divergence = { kind: "divergent", relationship: "independent", label: "別件" };
    await handleDivergence(deps, st, div, "別件の依頼");
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(st.activeIssueKey).toBe("PROJ-1"); // 切替なし
  });

  it("child: 現 active の id 解決に失敗（getIssueId が undefined）なら作成せず no-op", async () => {
    const st = baseState();
    const deps = makeDeps({ getIssueId: vi.fn(async () => undefined) as any });
    const div: Divergence = { kind: "divergent", relationship: "child", label: "サブ作業" };
    await handleDivergence(deps, st, div, "サブタスク: 作業A");
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(st.activeIssueKey).toBe("PROJ-1");
  });
});
