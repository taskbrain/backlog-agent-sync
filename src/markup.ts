import type { TextFormattingRule } from "./types.js";

export interface MarkupRenderer {
  heading(level: number, text: string): string;
  link(text: string, url: string): string;
  bold(text: string): string;
  listItem(text: string): string;
}

/**
 * textFormattingRule に応じたレンダラ。
 * - markdown: GFM（見出しは # の後にスペース必須）
 * - backlog: Backlog 記法（行頭 *（レベル数）/ [[text>url]] / ''bold''）
 * 裸 URL は両記法とも自動リンクされるため、リンク不能時は裸 URL にフォールバックしてよい。
 */
export function renderer(rule: TextFormattingRule = "markdown"): MarkupRenderer {
  const level = (n: number) => Math.min(6, Math.max(1, Math.floor(n)));
  if (rule === "backlog") {
    return {
      heading: (n, text) => `${"*".repeat(level(n))} ${text}`,
      link: (text, url) => `[[${text}>${url}]]`,
      bold: (text) => `''${text}''`,
      listItem: (text) => `- ${text}`,
    };
  }
  return {
    heading: (n, text) => `${"#".repeat(level(n))} ${text}`,
    link: (text, url) => `[${text}](${url})`,
    bold: (text) => `**${text}**`,
    listItem: (text) => `- ${text}`,
  };
}
