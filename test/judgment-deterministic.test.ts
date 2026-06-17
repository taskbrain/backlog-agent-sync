import { describe, it, expect } from "vitest";
import { DeterministicBackend } from "../src/judgment/deterministic.js";
import { getBackend } from "../src/judgment/index.js";
import type { JudgmentInput } from "../src/judgment/types.js";

const backend = new DeterministicBackend();

function input(partial: Partial<JudgmentInput>): JudgmentInput {
  return {
    sessionId: "s1",
    originalTask: "ログイン機能を実装する。OAuth と JWT を含む",
    currentSummary: "",
    ...partial,
  };
}

describe("classifyDivergence", () => {
  it("継続（語彙が原タスクと重なる）は in_scope", async () => {
    const d = await backend.classifyDivergence(
      input({ turnPrompt: "ログインの JWT トークン検証を直す" }),
    );
    expect(d.kind).toBe("in_scope");
  });

  it("turnPrompt 無し（情報不足）は保守的に in_scope", async () => {
    const d = await backend.classifyDivergence(input({ turnPrompt: undefined }));
    expect(d.kind).toBe("in_scope");
  });

  it("明確な新トピック（語彙が全く重ならない）は divergent / 既定 independent", async () => {
    const d = await backend.classifyDivergence(
      input({ turnPrompt: "請求書 PDF の帳票レイアウトをデザインしてほしい" }),
    );
    expect(d.kind).toBe("divergent");
    if (d.kind === "divergent") {
      expect(d.relationship).toBe("independent");
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it("明示キーワード『別タスク』があれば乖離寄り（divergent）", async () => {
    const d = await backend.classifyDivergence(
      input({ turnPrompt: "別タスクだけど、ついでにログインのログ出力も整えて" }),
    );
    expect(d.kind).toBe("divergent");
  });

  it("明示キーワード『別件』があれば divergent", async () => {
    const d = await backend.classifyDivergence(
      input({ turnPrompt: "別件: README を更新したい" }),
    );
    expect(d.kind).toBe("divergent");
  });

  it("わずかに語彙が重なる程度では保守的に in_scope（乱立防止）", async () => {
    const d = await backend.classifyDivergence(
      input({ turnPrompt: "機能のドキュメントを少し直す" }),
    );
    // "機能" がかすかに重なる程度。明確な乖離ではないので既定 in_scope。
    expect(d.kind).toBe("in_scope");
  });

  it("子課題の明示キーワード『サブタスク』は relationship=child", async () => {
    const d = await backend.classifyDivergence(
      input({ turnPrompt: "サブタスク: 帳票レイアウトのデザインを別で進める" }),
    );
    expect(d.kind).toBe("divergent");
    if (d.kind === "divergent") {
      expect(d.relationship).toBe("child");
    }
  });
});

describe("updateSummary", () => {
  it("最新状況を上書きした構造化サマリを返す", async () => {
    const r = await backend.updateSummary(
      input({
        currentSummary: "## タスク\nログイン機能を実装する。OAuth と JWT を含む\n## 最新状況\n古い状況",
        turnResult: "JWT 検証のリファクタを進めている",
      }),
    );
    expect(r.summary).toContain("## 最新状況");
    expect(r.summary).toContain("JWT 検証のリファクタを進めている");
    expect(r.summary).not.toContain("古い状況");
  });

  it("完了語（完了）を検出すると isMilestone=true", async () => {
    const r = await backend.updateSummary(
      input({ turnResult: "ログイン機能の実装が完了しました" }),
    );
    expect(r.isMilestone).toBe(true);
  });

  it("状態語（デプロイ）を検出すると isMilestone=true", async () => {
    const r = await backend.updateSummary(
      input({ turnResult: "本番へデプロイした" }),
    );
    expect(r.isMilestone).toBe(true);
  });

  it("英語の done でも isMilestone=true", async () => {
    const r = await backend.updateSummary(
      input({ turnResult: "Refactor done, tests green" }),
    );
    expect(r.isMilestone).toBe(true);
  });

  it("単なる進行中の報告では isMilestone=false", async () => {
    const r = await backend.updateSummary(
      input({ turnResult: "原因を調査している最中です" }),
    );
    expect(r.isMilestone).toBe(false);
  });

  it("turnResult 欠落時は現サマリを保持し isMilestone=false", async () => {
    const r = await backend.updateSummary(
      input({ currentSummary: "## タスク\nA\n## 最新状況\n既存", turnResult: undefined }),
    );
    expect(r.isMilestone).toBe(false);
    expect(r.summary).toContain("既存");
  });
});

describe("getBackend", () => {
  it("現状は決定論 backend を返す", () => {
    const b = getBackend();
    expect(b).toBeInstanceOf(DeterministicBackend);
  });
});
