import { open } from "node:fs/promises";

export interface ReadLastAssistantOptions { maxBytes?: number; maxChars?: number; }

const DEFAULT_MAX_BYTES = 262144; // 末尾 256KiB のみ読む（巨大 transcript 対策）
const DEFAULT_MAX_CHARS = 600;

/**
 * Claude transcript（JSONL）から最後の assistant テキストを抽出する。
 * - ファイル末尾 maxBytes だけ読み、行を後方から走査
 * - type==="assistant" の message.content[].type==="text" を連結（text が無い行は遡る）
 * - パース不能行（破損 / maxBytes 境界の途切れ）はスキップ
 * - いかなる失敗でも例外を投げず undefined を返す
 */
export async function readLastAssistantText(path: string, opts: ReadLastAssistantOptions = {}): Promise<string | undefined> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  try {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      if (len <= 0) return undefined;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // 破損行 / 境界で途切れた行はスキップ
        }
        if (obj?.type !== "assistant") continue;
        const content = obj?.message?.content;
        if (!Array.isArray(content)) continue;
        const text = content
          .filter((c: any) => c?.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        if (!text) continue; // tool_use のみの assistant 行は遡る
        return text.slice(0, maxChars);
      }
      return undefined;
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}
