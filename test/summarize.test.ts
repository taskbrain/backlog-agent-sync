import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { summarizeRequest, extractSummary, type ExecFn } from "../src/summarize.js";

// 短文スキップ（80字未満かつ改行なし）を回避するため改行入りプロンプトを使う
const LONG_PROMPT = "ログインフォームのバグを修正してほしい。\n再現手順:\n1. フォームを送信する\n2. 500エラーになる";

function execOk(result: string): ExecFn {
  return vi.fn().mockResolvedValue({ stdout: JSON.stringify({ result }) });
}

describe("summarizeRequest", () => {
  it("整形済み出力（要約1行+箇条書き）をそのまま返し、claude を正しい引数で呼ぶ", async () => {
    const exec = execOk("ログインバグの修正\n- 500エラーの原因調査\n- 修正とテスト追加");
    const out = await summarizeRequest(LONG_PROMPT, { exec });
    expect(out).toBe("ログインバグの修正\n- 500エラーの原因調査\n- 修正とテスト追加");
    const [cmd, args, opts] = (exec as any).mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--max-turns");
    expect(args).toContain("haiku");
    expect(opts.cwd).toBe(tmpdir()); // プロジェクトフックの誤発火回避
    expect(opts.env.BACKLOG_SYNC_IN_HOOK).toBe("1"); // 再帰ガード
    expect(String(args[1])).toContain(LONG_PROMPT); // 指示文+原文
  });

  it("前置き・逆質問の行は除去して箇条書きのみ返す", async () => {
    const exec = execOk("了解しました。以下のように整理します。\n- バグを直す\n- テストを追加\nこの方針でよろしいですか？");
    const out = await summarizeRequest(LONG_PROMPT, { exec });
    expect(out).toBe("- バグを直す\n- テストを追加");
  });

  it("箇条書きが1件も無ければ undefined（原文フォールバック）", async () => {
    const exec = execOk("把握しました。対応します。");
    expect(await summarizeRequest(LONG_PROMPT, { exec })).toBeUndefined();
  });

  it("短い単文（80字未満・改行なし）は LLM を呼ばず undefined", async () => {
    const exec = execOk("- 呼ばれないはず");
    expect(await summarizeRequest("バグを直して", { exec })).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("claude 不在（ENOENT）/ timeout は undefined（例外を漏らさない）", async () => {
    const exec: ExecFn = vi.fn().mockRejectedValue(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    await expect(summarizeRequest(LONG_PROMPT, { exec })).resolves.toBeUndefined();
  });

  it("stdout が JSON でなければ undefined", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: "not json" });
    expect(await summarizeRequest(LONG_PROMPT, { exec })).toBeUndefined();
  });
});

describe("extractSummary", () => {
  it("箇条書きは最大8件に切り詰める", () => {
    const raw = "目的\n" + Array.from({ length: 12 }, (_, i) => `- 項目${i + 1}`).join("\n");
    const out = extractSummary(raw);
    expect(out?.split("\n").length).toBe(9); // 見出し1 + 箇条書き8
    expect(out).toContain("- 項目8");
    expect(out).not.toContain("- 項目9");
  });

  it("質問で終わる箇条書きは除去する", () => {
    expect(extractSummary("目的\n- 直す\n- どのファイルですか？")).toBe("目的\n- 直す");
  });

  it("コードブロック開始行は見出しに採用しない", () => {
    expect(extractSummary("```\n- 直す")).toBe("- 直す");
  });
});
