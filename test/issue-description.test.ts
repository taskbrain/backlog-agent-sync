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

  // ---- 境界テスト（PROGRESS_MAX_LINES=20 / off-by-one / 件数引き継ぎ） ----

  it("ちょうど 20 件に達しても畳まれない（20 行維持・off-by-one 下限）", () => {
    // 19 件へ 1 件追加 = 20 件。next.length <= maxLines のため畳み込みは起きない。
    let acc = Array.from({ length: 19 }, (_, i) => `項目${i + 1}`);
    acc = appendMilestone(acc, "項目20", 20);
    expect(acc).toHaveLength(20);
    expect(acc.some((l) => l.includes("件を要約"))).toBe(false); // 畳み込み行なし
    expect(acc[0]).toBe("項目1"); // 最古の生項目が温存される
    expect(acc[acc.length - 1]).toBe("項目20");
  });

  it("21 件目で初めて畳まれ、合計は上限以内（off-by-one 上限）", () => {
    // 20 件へ 1 件追加 = 21 件 > maxLines。先頭側を 1 行へ畳む。
    const initial = Array.from({ length: 20 }, (_, i) => `項目${i + 1}`);
    const next = appendMilestone(initial, "項目21", 20);
    expect(next).toHaveLength(20); // 上限ちょうどに収まる
    // 先頭は畳み込み行（最古2件＝項目1・項目2 を要約）。「ほか 2 件を要約」
    expect(next[0]).toBe("（項目1 ほか 2 件を要約）");
    expect(next).not.toContain("項目2"); // 畳まれた古い項目は単独行として残らない
    // 末尾 19 行（項目3〜項目21）が生のまま残る
    expect(next[next.length - 1]).toBe("項目21");
    expect(next.slice(1)).toEqual(Array.from({ length: 18 }, (_, i) => `項目${i + 3}`).concat("項目21"));
  });

  it("連続畳み込みで件数 N が累積する（畳み込み行の件数引き継ぎ）", () => {
    // 21 件目で「ほか 2 件を要約」になった状態から、さらに 1 件追加すると
    // 先頭の畳み込み行(N=2)＋新たに畳まれる 1 件＝N=3 へ累積する。
    const initial = Array.from({ length: 20 }, (_, i) => `項目${i + 1}`);
    const afterFirst = appendMilestone(initial, "項目21", 20);
    expect(afterFirst[0]).toBe("（項目1 ほか 2 件を要約）");

    const afterSecond = appendMilestone(afterFirst, "項目22", 20);
    expect(afterSecond).toHaveLength(20);
    // 畳み込み件数が 2 → 3 へ引き継がれ累積する（baseLabel=項目1 は温存）
    expect(afterSecond[0]).toBe("（項目1 ほか 3 件を要約）");
    expect(afterSecond[afterSecond.length - 1]).toBe("項目22");

    // さらに 1 件追加 → N=4 へ累積
    const afterThird = appendMilestone(afterSecond, "項目23", 20);
    expect(afterThird[0]).toBe("（項目1 ほか 4 件を要約）");
    expect(afterThird).toHaveLength(20);
  });

  it("多数回 append しても畳み込み件数が単調に増え整合する（累積の通し検証）", () => {
    let acc = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    // 10 回追加。各回 1 件ずつ畳み込みへ移るため N は 2,3,...,11 と増える。
    for (let i = 1; i <= 10; i++) {
      acc = appendMilestone(acc, `extra${i}`, 20);
      expect(acc).toHaveLength(20); // 常に上限以内
      const m = /^（m1 ほか (\d+) 件を要約）$/.exec(acc[0]);
      expect(m, `畳み込み行が想定形式（${acc[0]}）`).not.toBeNull();
      expect(Number(m![1])).toBe(i + 1); // 1 回目=2, ..., 10 回目=11
    }
    expect(acc[acc.length - 1]).toBe("extra10");
  });
});
