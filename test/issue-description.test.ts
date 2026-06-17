import { describe, it, expect } from "vitest";
import { buildDescription, appendMilestone } from "../src/issue/description.js";

describe("buildDescription", () => {
  it("4ブロック（## タスク / ## 進捗 / ## 最新状況 / ## 子課題）を生成する", () => {
    const body = buildDescription({
      originalTask: "ログイン機能を実装する",
      progress: ["設計を完了", "API を実装"],
      latest: "テストを追加中",
      children: [{ key: "PROJ-2", label: "OAuth 対応" }],
    });
    expect(body).toContain("## タスク");
    expect(body).toContain("ログイン機能を実装する");
    expect(body).toContain("## 進捗");
    expect(body).toContain("- 設計を完了");
    expect(body).toContain("- API を実装");
    expect(body).toContain("## 最新状況");
    expect(body).toContain("テストを追加中");
    expect(body).toContain("## 子課題");
    // ブロック順序を保証
    const idxTask = body.indexOf("## タスク");
    const idxProgress = body.indexOf("## 進捗");
    const idxLatest = body.indexOf("## 最新状況");
    const idxChildren = body.indexOf("## 子課題");
    expect(idxTask).toBeLessThan(idxProgress);
    expect(idxProgress).toBeLessThan(idxLatest);
    expect(idxLatest).toBeLessThan(idxChildren);
  });

  it("子課題は markdown 既定でリンク整形する", () => {
    const body = buildDescription({
      originalTask: "親タスク",
      progress: [],
      latest: "",
      children: [{ key: "PROJ-3", label: "子課題A", url: "https://example.com/PROJ-3" }],
    });
    expect(body).toContain("- [子課題A](https://example.com/PROJ-3)");
  });

  it("子課題は backlog 記法で整形する", () => {
    const body = buildDescription(
      {
        originalTask: "親タスク",
        progress: [],
        latest: "",
        children: [{ key: "PROJ-3", label: "子課題A", url: "https://example.com/PROJ-3" }],
      },
      "backlog",
    );
    expect(body).toContain("** タスク"); // backlog 見出し（レベル2 = **）
    expect(body).toContain("[[子課題A>https://example.com/PROJ-3]]");
  });

  it("url 無しの子課題は label のみ（または key 併記）でリンク化しない", () => {
    const body = buildDescription({
      originalTask: "親タスク",
      progress: [],
      latest: "",
      children: [{ key: "PROJ-4", label: "子課題B" }],
    });
    expect(body).toContain("子課題B");
    expect(body).not.toContain("[子課題B](");
  });

  it("空の進捗・子課題でも 4 見出しは常に出力する", () => {
    const body = buildDescription({
      originalTask: "タスクのみ",
      progress: [],
      latest: "",
      children: [],
    });
    expect(body).toContain("## タスク");
    expect(body).toContain("## 進捗");
    expect(body).toContain("## 最新状況");
    expect(body).toContain("## 子課題");
  });
});

describe("appendMilestone（進捗の有界化）", () => {
  it("上限未満なら末尾に1行追加する", () => {
    const next = appendMilestone(["A", "B"], "C", 20);
    expect(next).toEqual(["A", "B", "C"]);
  });

  it("上限超過時は最古の項目を畳んで上限を維持する", () => {
    const initial = Array.from({ length: 20 }, (_, i) => `項目${i + 1}`);
    const next = appendMilestone(initial, "新項目", 20);
    // 上限を超えない
    expect(next.length).toBeLessThanOrEqual(20);
    // 新項目は末尾に残る
    expect(next[next.length - 1]).toBe("新項目");
    // 畳み込み行（要約）が先頭に存在し、最古の生項目は消えている
    expect(next[0]).toContain("項目1");
    expect(next).not.toContain("項目2"); // 畳まれた古い項目は単独行として残らない
  });

  it("複数回 append しても上限を超えない（連続畳み込み）", () => {
    let acc = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    for (let i = 0; i < 5; i++) {
      acc = appendMilestone(acc, `extra${i}`, 20);
    }
    expect(acc.length).toBeLessThanOrEqual(20);
    expect(acc[acc.length - 1]).toBe("extra4");
  });

  it("maxLines 既定は 20", () => {
    const initial = Array.from({ length: 20 }, (_, i) => `x${i}`);
    const next = appendMilestone(initial, "y");
    expect(next.length).toBeLessThanOrEqual(20);
    expect(next[next.length - 1]).toBe("y");
  });

  it("空配列への追加", () => {
    expect(appendMilestone([], "first", 20)).toEqual(["first"]);
  });
});
