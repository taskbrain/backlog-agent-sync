import { describe, it, expect } from "vitest";
import { extractH1, extractLeadingNumber, computePageName, stripTitleSuffix } from "../src/docs/naming.js";
import type { DocsNamingConfig } from "../src/types.js";

describe("extractH1", () => {
  it("単純な # 見出しを抽出する", () => {
    expect(extractH1("# Title\n本文")).toBe("Title");
  });

  it("先頭 frontmatter ブロックを読み飛ばし、その後の H1 を採用する", () => {
    const src = ["---", "title: フロントマターの題名", "tags: [a, b]", "---", "", "# 本物の見出し", "本文"].join("\n");
    expect(extractH1(src)).toBe("本物の見出し");
  });

  it("frontmatter 内の title: は H1 として採用しない（H1 が無ければ undefined）", () => {
    const src = ["---", "title: フロントマターの題名", "---", "", "本文のみ（H1 なし）"].join("\n");
    expect(extractH1(src)).toBeUndefined();
  });

  it("閉じ --- が無い場合は frontmatter とみなさず先頭から走査する", () => {
    // lines[0] が "---" だが閉じが無い → frontmatter 扱いしない。"---" は H1 ではないので、後続の H1 を拾う
    const src = ["---", "title: x", "# 見出し"].join("\n");
    expect(extractH1(src)).toBe("見出し");
  });

  it("フェンスコードブロック内の # は H1 と見なさない", () => {
    const src = ["```", "# fake heading", "```", "", "# 本物"].join("\n");
    expect(extractH1(src)).toBe("本物");
  });

  it("~~~ フェンス内の # も無視する", () => {
    const src = ["~~~", "# fake", "~~~", "# real"].join("\n");
    expect(extractH1(src)).toBe("real");
  });

  it("## は H1 ではない", () => {
    const src = ["## サブ見出し", "", "# トップ見出し"].join("\n");
    expect(extractH1(src)).toBe("トップ見出し");
  });

  it("# のあとに空白が無い #nospace は見出しではない", () => {
    const src = ["#nospace", "", "# 正しい見出し"].join("\n");
    expect(extractH1(src)).toBe("正しい見出し");
  });

  it("マークダウン装飾を正規化する（強調/リンク/コード）", () => {
    expect(extractH1("# **動画** [プロンプト](x) 設計")).toBe("動画 プロンプト 設計");
  });

  it("末尾の閉じ # を除去する（closing ATX）", () => {
    expect(extractH1("# Title ##")).toBe("Title");
  });

  it("先頭に最大 3 個までの空白インデントを許容する", () => {
    expect(extractH1("   # インデント見出し")).toBe("インデント見出し");
  });

  it("H1 が無ければ undefined", () => {
    expect(extractH1("本文だけ\n- リスト\n## 見出し2")).toBeUndefined();
  });

  it("語中アンダースコアは強調と見なさず保持する（snake_case 破壊回避）", () => {
    expect(extractH1("# api_v2_design")).toBe("api_v2_design");
    expect(extractH1("# foo_bar_baz")).toBe("foo_bar_baz");
    expect(extractH1("# 設定_詳細_メモ")).toBe("設定_詳細_メモ");
  });

  it("語境界の真の強調（* / **）は従来どおり除去する", () => {
    expect(extractH1("# *強調* タイトル")).toBe("強調 タイトル");
    expect(extractH1("# **太字**設計")).toBe("太字設計");
  });

  it("インラインコードは従来どおり除去する", () => {
    expect(extractH1("# `code`")).toBe("code");
  });

  it("先頭 BOM を除去して H1 を抽出する", () => {
    expect(extractH1("﻿# タイトル")).toBe("タイトル");
  });

  it("BOM + frontmatter でも frontmatter を読み飛ばして H1 を抽出する", () => {
    expect(extractH1("﻿---\ntitle: x\n---\n# 本物")).toBe("本物");
  });

  // BOM を「除去」していることを判別する: BOM + 最大インデント3空白。
  // BOM を空白扱いのまま残すと先頭空白が 4 文字となり \s{0,3} を超えて H1 非該当になる。
  // BOM を slice で取り除けば残り 3 空白で正しく H1 と判定される。
  it("先頭 BOM はインデント計数から除外される（除去の判別ケース）", () => {
    expect(extractH1("﻿   # インデント見出し")).toBe("インデント見出し");
  });
});

describe("extractLeadingNumber", () => {
  it("00-overview → { number: '00', rest: 'overview' }", () => {
    expect(extractLeadingNumber("00-overview")).toEqual({ number: "00", rest: "overview" });
  });

  it("07_sns → { number: '07', rest: 'sns' }（アンダースコア区切り）", () => {
    expect(extractLeadingNumber("07_sns")).toEqual({ number: "07", rest: "sns" });
  });

  it("番号なし superpowers → { rest: 'superpowers' }", () => {
    expect(extractLeadingNumber("superpowers")).toEqual({ rest: "superpowers" });
  });

  it("2026-06-09-foo → { number: '2026', rest: '06-09-foo' }（最初の数字塊のみ）", () => {
    // 仕様明記: 先頭の連続数字を number とし、最初の区切り 1 文字を消費して残りを rest にする
    expect(extractLeadingNumber("2026-06-09-foo")).toEqual({ number: "2026", rest: "06-09-foo" });
  });

  it("元の桁を文字列として保持する（先頭ゼロを失わない）", () => {
    expect(extractLeadingNumber("00-x").number).toBe("00");
    expect(extractLeadingNumber("07-x").number).toBe("07");
  });
});

describe("computePageName 後方互換（fast path）", () => {
  it("naming 未指定なら relPath の .md 除去と一致する", () => {
    expect(computePageName("00-overview/00-executive-summary.md", "見出し", undefined)).toBe("00-overview/00-executive-summary");
  });

  it("fileSource:filename + numberPrefix:none は旧挙動と一致する", () => {
    const naming: DocsNamingConfig = { fileSource: "filename", numberPrefix: "none" };
    expect(computePageName("guide/b.md", "H1", naming)).toBe("guide/b");
  });

  it("空オブジェクト {}（全デフォルト）も旧挙動と一致する", () => {
    expect(computePageName("a.md", "H1", {})).toBe("a");
  });

  it("dirNames を渡しても fileSource:filename + numberPrefix:none なら fast path（dirNames 無視）", () => {
    const naming: DocsNamingConfig = { fileSource: "filename", numberPrefix: "none", dirNames: { "00-overview": "概要" } };
    expect(computePageName("00-overview/x.md", "H1", naming)).toBe("00-overview/x");
  });
});

describe("computePageName 一般パス（案C: 大分類のみ番号）", () => {
  it("dir 番号付与 + dirNames + H1（基本例）", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", dirNames: { "00-overview": "概要" } };
    expect(computePageName("00-overview/00-executive-summary.md", "エグゼクティブサマリー", naming)).toBe("00 概要/エグゼクティブサマリー");
  });

  it("要件定義の例", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", dirNames: { "01-requirements": "要件定義" } };
    expect(computePageName("01-requirements/01-personas.md", "ペルソナ", naming)).toBe("01 要件定義/ペルソナ");
  });

  it("SNS自動投稿の例", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", dirNames: { "07-sns-integration": "SNS自動投稿" } };
    expect(computePageName("07-sns-integration/02-tiktok.md", "TikTok連携", naming)).toBe("07 SNS自動投稿/TikTok連携");
  });

  it("多段の番号なしディレクトリ（番号は付かない）", () => {
    const naming: DocsNamingConfig = {
      fileSource: "h1",
      numberPrefix: "dir",
      dirNames: { superpowers: "補足資料", "superpowers/specs": "設計仕様書" },
    };
    expect(
      computePageName("superpowers/specs/2026-06-09-video-prompt-dynamic-generation-design.md", "動画プロンプト動的生成 設計", naming),
    ).toBe("補足資料/設計仕様書/動画プロンプト動的生成 設計");
  });

  it("dirNames に無い番号付きディレクトリは番号を剥がして表示し、番号を再付与する", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir" };
    expect(computePageName("03-architecture/x.md", "アーキ", naming)).toBe("03 architecture/アーキ");
  });

  it("numberPrefix:all はファイルにも番号を付ける", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "all", dirNames: { "00-overview": "概要" } };
    expect(computePageName("00-overview/00-executive-summary.md", "サマリー", naming)).toBe("00 概要/00 サマリー");
  });

  it("numberPrefix:none + fileSource:h1 は番号なし・dirNames 適用・H1 使用（一般パス）", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "none", dirNames: { "00-overview": "概要" } };
    expect(computePageName("00-overview/00-executive-summary.md", "サマリー", naming)).toBe("概要/サマリー");
  });

  it("fileSource:h1 だが H1 なし → ファイル名スラグへフォールバック（番号剥がし）", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir" };
    expect(computePageName("00-overview/00-executive-summary.md", undefined, naming)).toBe("00 overview/executive-summary");
  });

  it("ルート直下ファイル（ディレクトリ無し・numberPrefix:dir なのでファイルに番号は付かない）", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir" };
    expect(computePageName("00-intro.md", "はじめに", naming)).toBe("はじめに");
  });

  it("dirNames の値が空文字なら未設定扱いで番号剥がしスラグへフォールバックする", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", dirNames: { "00-overview": "" } };
    expect(computePageName("00-overview/x.md", "T", naming)).toBe("00 overview/T");
  });

  it("dirNames の値が空白のみなら未設定扱いでフォールバックする", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", dirNames: { "00-overview": "   " } };
    expect(computePageName("00-overview/x.md", "T", naming)).toBe("00 overview/T");
  });
});

// EM DASH = U+2014。スペースの有無で 3 種の末尾サフィックスを区別する。
const SUFFIXES = [" — AI SNSつくるくん", "— AI SNSつくるくん", "AI SNSつくるくん"];

describe("stripTitleSuffix", () => {
  it("末尾サフィックス（スペース + EM DASH + スペース）を除去する", () => {
    expect(stripTitleSuffix("TikTok連携 — AI SNSつくるくん", SUFFIXES)).toBe("TikTok連携");
  });

  it("先頭スペース無しの EM DASH サフィックスも除去する", () => {
    expect(stripTitleSuffix("設計— AI SNSつくるくん", SUFFIXES)).toBe("設計");
  });

  it("素の AI SNSつくるくん（ダッシュ無し・スペース前置）も除去する", () => {
    expect(stripTitleSuffix("概要 AI SNSつくるくん", SUFFIXES)).toBe("概要");
  });

  it("全角丸括弧は保持し、サフィックスのみ除去する", () => {
    expect(stripTitleSuffix("機能一覧（詳細） — AI SNSつくるくん", SUFFIXES)).toBe("機能一覧（詳細）");
  });

  it("半角丸括弧も保持し、サフィックスのみ除去する", () => {
    expect(stripTitleSuffix("Plan (v2) — AI SNSつくるくん", SUFFIXES)).toBe("Plan (v2)");
  });

  it("プレフィクス出現（先頭の AI SNSつくるくん）は除去しない", () => {
    expect(stripTitleSuffix("AI SNSつくるくん 仕様-実装ギャップ実装計画書", SUFFIXES)).toBe(
      "AI SNSつくるくん 仕様-実装ギャップ実装計画書",
    );
  });

  it("中間出現（括弧内の AI SNSつくるくん）は除去しない", () => {
    expect(stripTitleSuffix("LINE Messaging API 仕様（AI SNSつくるくん 実装観点）", SUFFIXES)).toBe(
      "LINE Messaging API 仕様（AI SNSつくるくん 実装観点）",
    );
  });

  it("タイトル全体がサフィックスなら除去しない（ガード: 除去後が空）", () => {
    expect(stripTitleSuffix("AI SNSつくるくん", SUFFIXES)).toBe("AI SNSつくるくん");
  });

  it("EM DASH + サフィックスのみのタイトルも除去しない（除去後が空のため）", () => {
    expect(stripTitleSuffix("— AI SNSつくるくん", SUFFIXES)).toBe("— AI SNSつくるくん");
  });

  it("最長一致で除去する（X — AI SNSつくるくん → X、末尾の — を残さない）", () => {
    expect(stripTitleSuffix("X — AI SNSつくるくん", SUFFIXES)).toBe("X");
  });

  it("suffixes が undefined なら無変更", () => {
    expect(stripTitleSuffix("Foo — AI SNSつくるくん", undefined)).toBe("Foo — AI SNSつくるくん");
  });

  it("suffixes が空配列なら無変更", () => {
    expect(stripTitleSuffix("Foo — AI SNSつくるくん", [])).toBe("Foo — AI SNSつくるくん");
  });

  it("どのサフィックスにも一致しなければ無変更", () => {
    expect(stripTitleSuffix("ただのタイトル", SUFFIXES)).toBe("ただのタイトル");
  });
});

describe("computePageName + stripTitleSuffix 統合", () => {
  it("H1 由来タイトルから末尾サフィックスを除去してページ名を組み立てる", () => {
    const naming: DocsNamingConfig = {
      fileSource: "h1",
      numberPrefix: "dir",
      dirNames: { "07-sns-integration": "SNS自動投稿" },
      stripTitleSuffix: SUFFIXES,
    };
    expect(computePageName("07-sns-integration/02-tiktok.md", "TikTok連携 — AI SNSつくるくん", naming)).toBe(
      "07 SNS自動投稿/TikTok連携",
    );
  });

  it("slugFallback（H1 無し）にはサフィックス除去を適用しない", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", stripTitleSuffix: SUFFIXES };
    expect(computePageName("00-overview/00-exec.md", undefined, naming)).toBe("00 overview/exec");
  });

  it("fileSource:filename にはサフィックス除去を適用しない", () => {
    const naming: DocsNamingConfig = { fileSource: "filename", numberPrefix: "dir", stripTitleSuffix: SUFFIXES };
    // filename 由来。H1 は無視され、ファイル名スラグが使われる（サフィックス除去対象外）
    expect(computePageName("07-sns-integration/02-tiktok.md", "TikTok連携 — AI SNSつくるくん", naming)).toBe(
      "07 sns-integration/tiktok",
    );
  });

  it("stripTitleSuffix 未指定なら H1 サフィックスは残る（後方互換）", () => {
    const naming: DocsNamingConfig = { fileSource: "h1", numberPrefix: "dir", dirNames: { "07-sns-integration": "SNS自動投稿" } };
    expect(computePageName("07-sns-integration/02-tiktok.md", "TikTok連携 — AI SNSつくるくん", naming)).toBe(
      "07 SNS自動投稿/TikTok連携 — AI SNSつくるくん",
    );
  });
});
