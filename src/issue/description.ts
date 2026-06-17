import type { TextFormattingRule } from "../types.js";
import { renderer } from "../markup.js";

/** 子課題リンクの素材。url 無しは label のみ（リンク化しない）。 */
export interface ChildLink {
  key: string;
  label: string;
  url?: string;
}

/** 構造化説明欄の入力。4 ブロック（タスク / 進捗 / 最新状況 / 子課題）の素材。 */
export interface DescriptionInput {
  /** ## タスク: 初回プロンプト由来の原タスク（不変の本旨）。 */
  originalTask: string;
  /** ## 進捗: マイルストーン行の配列（有界・古い順）。 */
  progress: string[];
  /** ## 最新状況: 常に 1 ブロックで上書きされる直近サマリ。 */
  latest: string;
  /** ## 子課題: 乖離検出で分割された関連課題へのリンク。 */
  children: ChildLink[];
}

/** ## タスク / ## 進捗 / ## 最新状況 / ## 子課題 の 4 ブロックを生成（順序固定・見出しは常に出力）。 */
export function buildDescription(input: DescriptionInput, rule: TextFormattingRule = "markdown"): string {
  const md = renderer(rule);
  const lines: string[] = [];

  lines.push(md.heading(2, "タスク"));
  if (input.originalTask.trim()) lines.push(input.originalTask.trim());

  lines.push(md.heading(2, "進捗"));
  for (const p of input.progress) {
    if (p.trim()) lines.push(md.listItem(p.trim()));
  }

  lines.push(md.heading(2, "最新状況"));
  if (input.latest.trim()) lines.push(input.latest.trim());

  lines.push(md.heading(2, "子課題"));
  for (const c of input.children) {
    const label = c.label.trim() || c.key;
    lines.push(md.listItem(c.url ? md.link(label, c.url) : label));
  }

  return lines.join("\n");
}

/**
 * 進捗配列に 1 行追加し、maxLines を超える場合は最古の完了項目群を 1 行へ畳む（有界化）。
 * 畳み込み行は先頭に置き、「ほか N 件: …」形式で最古の内容を要約する。
 */
export function appendMilestone(progress: string[], line: string, maxLines = 20): string[] {
  const next = [...progress, line];
  if (next.length <= maxLines) return next;

  // 超過分（先頭側の最古項目）を 1 行へ畳む。畳み込み後の合計が maxLines に収まるよう、
  // 末尾 (maxLines - 1) 行を残し、それ以前を 1 行に要約する。
  const keep = next.slice(-(maxLines - 1));
  const folded = next.slice(0, next.length - keep.length);
  const summary = foldLines(folded);
  return [summary, ...keep];
}

/** 最古の項目群を 1 行へ要約。先頭項目を温存しつつ件数を併記する。 */
function foldLines(folded: string[]): string {
  if (folded.length === 0) return "（過去ログ省略）";
  // 既に畳み込み行が含まれる場合（連続畳み込み）はその件数を引き継ぐ。
  const head = folded[0];
  const carried = parseFoldedCount(head);
  const freshCount = carried != null ? folded.length - 1 : folded.length;
  const baseLabel = carried != null ? stripFoldPrefix(head) : head;
  const total = (carried ?? 0) + freshCount;
  return `（${baseLabel} ほか ${total} 件を要約）`;
}

const FOLD_RE = /^（(.*) ほか (\d+) 件を要約）$/;

function parseFoldedCount(line: string): number | null {
  const m = FOLD_RE.exec(line);
  return m ? Number(m[2]) : null;
}

function stripFoldPrefix(line: string): string {
  const m = FOLD_RE.exec(line);
  return m ? m[1] : line;
}
