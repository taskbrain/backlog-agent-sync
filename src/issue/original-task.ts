/**
 * originalTask（## タスク の素材 / classifyDivergence の originalTask 基準）の導出ヘルパ。
 *
 * 背景（G23 改訂 F1）: 本番セッションの initialPrompt は `<task-notification>` 等の
 * 非ユーザー由来ブロブで占有されることがあり、そのまま原タスクに使うと
 * ## タスク が無意味な塊になり、逸脱判定の基準も壊れる。
 * 「実ユーザープロンプトか」を判定し、駄目なら課題件名（summary）へフォールバックする。
 */

const MAX_LEN = 500;

/**
 * 非ユーザー由来ブロブの先頭タグ（フック注入 / システム / ローカルコマンド系）。
 * これらで始まる、または占有されるテキストは「実ユーザープロンプト」ではない。
 */
const NON_USER_TAG_RE =
  /<\/?(?:task-notification|system-reminder|local-command-[a-z-]*|command-[a-z-]*|command_[a-z_]*|user-prompt-submit-hook)\b/i;

/** 整形時に剥がす定型の前置き（依頼の頭に付くノイズ）。 */
const LEADING_PREFIX_RE = /^(?:\s*(?:依頼[:：]|お願い[:：]|prompt[:：]))/i;

/**
 * 「実ユーザープロンプト」か判定する。
 * - 空 / 空白のみ → false
 * - 非ユーザー由来タグで始まる → false
 * - 全体が非ユーザー由来タグブロブで占有される（タグ除去後に実質ゼロ） → false
 * それ以外（人間が書いた依頼文）は true。
 */
export function isRealUserPrompt(text: string | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;

  // 先頭が非ユーザー由来タグ（< 直後にホワイトスペースが入る変種も拾う）
  if (/^<\s*\/?\s*(?:task-notification|system-reminder|local-command-|command-|command_|user-prompt-submit-hook)/i.test(t)) {
    return false;
  }

  // タグ要素（開始〜終了 or 自己完結）を除いた残りが実質ゼロなら非ユーザー由来ブロブ占有
  const stripped = t
    .replace(/<(task-notification|system-reminder|local-command-[a-z-]*|command-[a-z-]*|command_[a-z_]*|user-prompt-submit-hook)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return false;

  return true;
}

/** 依頼文を整形する（前置き除去・空白正規化・適度な長さ）。1行目を優先採用しつつ全体を見て切り詰める。 */
function tidy(text: string): string {
  let t = text.trim().replace(LEADING_PREFIX_RE, "").trim();
  // 改行は保持しすぎず、過剰な空行を畳む
  t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  if (t.length > MAX_LEN) t = `${t.slice(0, MAX_LEN)}…`;
  return t;
}

/**
 * originalTask を導出する。
 * 優先順:
 *   1) candidatePrompt が実ユーザープロンプト → 整形して採用
 *   2) issueSummary（課題件名）が有効 → それを採用（TC-26 の「文字起こしを元に…設計」等）
 *   3) いずれも無ければ undefined（呼び出し側は seed しない）
 */
export function deriveOriginalTask(
  candidatePrompt: string | undefined,
  issueSummary: string | undefined,
): string | undefined {
  if (isRealUserPrompt(candidatePrompt)) {
    return tidy(candidatePrompt!);
  }
  const summary = (issueSummary ?? "").trim();
  if (summary) return tidy(summary);
  return undefined;
}
