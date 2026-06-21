import { describe, it, expect } from "vitest";
import { isRealUserPrompt, deriveOriginalTask } from "../src/issue/original-task.js";

describe("isRealUserPrompt", () => {
  it("空 / 空白のみは false", () => {
    expect(isRealUserPrompt(undefined)).toBe(false);
    expect(isRealUserPrompt("")).toBe(false);
    expect(isRealUserPrompt("   \n  ")).toBe(false);
  });

  it("通常の依頼文は true", () => {
    expect(isRealUserPrompt("ログインバグを直して")).toBe(true);
    expect(isRealUserPrompt("文字起こしを元に設計をまとめてほしい")).toBe(true);
  });

  it("<task-notification> で始まるブロブは false", () => {
    const blob = "<task-notification>\nThe user has assigned a new task...\n</task-notification>";
    expect(isRealUserPrompt(blob)).toBe(false);
  });

  it("<system-reminder> で始まるブロブは false", () => {
    expect(isRealUserPrompt("<system-reminder>do X</system-reminder>")).toBe(false);
  });

  it("<local-command-stdout> 等のコマンド系ブロブは false", () => {
    expect(isRealUserPrompt("<local-command-stdout>foo</local-command-stdout>")).toBe(false);
    expect(isRealUserPrompt("<command-name>/clear</command-name>")).toBe(false);
  });

  it("非ユーザー由来タグで占有される場合は本文があっても false", () => {
    const blob = "<task-notification>巨大な通知本文がここに延々と続く...</task-notification>";
    expect(isRealUserPrompt(blob)).toBe(false);
  });

  it("先頭に実プロンプトがあればタグが後続しても true", () => {
    expect(isRealUserPrompt("ログインを直して\n<system-reminder>noise</system-reminder>")).toBe(true);
  });
});

describe("deriveOriginalTask", () => {
  it("実プロンプトがあれば整形して採用する", () => {
    expect(deriveOriginalTask("ログインバグを直して", "件名")).toBe("ログインバグを直して");
  });

  it("前置き（依頼:）を除去して整形する", () => {
    expect(deriveOriginalTask("依頼: テストを書いて", "件名")).toBe("テストを書いて");
  });

  it("実プロンプトでない（task-notification 占有）なら summary へフォールバック", () => {
    const blob = "<task-notification>通知本文</task-notification>";
    expect(deriveOriginalTask(blob, "文字起こしを元に設計をまとめる")).toBe("文字起こしを元に設計をまとめる");
  });

  it("実プロンプトも summary も無ければ undefined", () => {
    expect(deriveOriginalTask("<task-notification>x</task-notification>", "")).toBeUndefined();
    expect(deriveOriginalTask(undefined, undefined)).toBeUndefined();
  });

  it("候補が undefined でも summary があれば採用する", () => {
    expect(deriveOriginalTask(undefined, "課題の件名")).toBe("課題の件名");
  });

  it("過剰に長い場合は切り詰める", () => {
    const long = "あ".repeat(600);
    const out = deriveOriginalTask(long, "件名")!;
    expect(out.length).toBeLessThanOrEqual(501); // 500 + …
    expect(out.endsWith("…")).toBe(true);
  });
});
