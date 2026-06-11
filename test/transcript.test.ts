import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLastAssistantText } from "../src/transcript.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bas-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeJsonl(name: string, lines: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", "utf8");
  return path;
}

const assistantText = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const assistantToolUse = () => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Edit", input: {} }] } });
const userLine = (text: string) => ({ type: "user", message: { role: "user", content: text } });

describe("readLastAssistantText", () => {
  it("末尾の assistant text を抽出する（tool_use のみの行は遡る）", async () => {
    const path = writeJsonl("t.jsonl", [
      assistantText("古い回答"),
      userLine("追加依頼"),
      assistantText("最終回答です"),
      assistantToolUse(), // text 無し → ひとつ前の text へ遡る
    ]);
    expect(await readLastAssistantText(path)).toBe("最終回答です");
  });

  it("複数 text ブロックは連結する", async () => {
    const path = writeJsonl("t.jsonl", [
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "前半" }, { type: "text", text: "後半" }] } },
    ]);
    expect(await readLastAssistantText(path)).toBe("前半\n後半");
  });

  it("破損行はスキップして前の有効な assistant を返す", async () => {
    const path = writeJsonl("t.jsonl", [
      assistantText("有効な回答"),
      "{ this is not json",
      "garbage line",
    ]);
    expect(await readLastAssistantText(path)).toBe("有効な回答");
  });

  it("maxChars で切り詰める", async () => {
    const path = writeJsonl("t.jsonl", [assistantText("x".repeat(1000))]);
    const out = await readLastAssistantText(path, { maxChars: 600 });
    expect(out?.length).toBe(600);
  });

  it("maxBytes より前にしか assistant が無い巨大ファイルでは undefined（末尾のみ走査）", async () => {
    const filler = Array.from({ length: 50 }, (_, i) => userLine(`padding ${i} ${"y".repeat(100)}`));
    const path = writeJsonl("t.jsonl", [assistantText("範囲外の回答"), ...filler]);
    expect(await readLastAssistantText(path, { maxBytes: 500 })).toBeUndefined();
  });

  it("末尾 maxBytes 内の assistant は抽出できる", async () => {
    const filler = Array.from({ length: 50 }, (_, i) => userLine(`padding ${i} ${"y".repeat(100)}`));
    const path = writeJsonl("t.jsonl", [...filler, assistantText("範囲内の回答")]);
    expect(await readLastAssistantText(path, { maxBytes: 500 })).toBe("範囲内の回答");
  });

  it("ファイルが無い場合は undefined（例外を投げない）", async () => {
    expect(await readLastAssistantText(join(dir, "missing.jsonl"))).toBeUndefined();
  });

  it("assistant 行が無い場合は undefined", async () => {
    const path = writeJsonl("t.jsonl", [userLine("依頼のみ")]);
    expect(await readLastAssistantText(path)).toBeUndefined();
  });
});
