import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

export type ExecFn = (cmd: string, args: string[], opts: { timeout: number; cwd: string; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: opts.timeout, cwd: opts.cwd, env: opts.env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

const SHORT_PROMPT_MAX = 80; // これ未満の単文は原文で十分（コスト/レイテンシ節約）
const PROMPT_INPUT_MAX = 8000;
const BULLETS_MAX = 8;
const DEFAULT_TIMEOUT_MS = 45000;

// 実測で前置き・逆質問が混ざるため、形式を厳格に指示し、さらに出力側でも検証する
const INSTRUCTION = [
  "あなたは開発依頼を整理する係。以下の依頼プロンプトを、Backlog課題に載せる依頼文として整理せよ。",
  "出力形式: 1行目=目的の要約(体言止め)。2行目以降=「- 」で始まる個別依頼の箇条書き(最大8件・各1行・簡潔に)。",
  "前置き・後置き・質問・確認・コードブロックは一切出力しない。箇条書き以外の文章を含めない。",
].join("\n");

/** 前置き（「要約します」等）や逆質問の行か。 */
function isNoise(line: string): boolean {
  if (/[?？]\s*$/.test(line)) return true; // 逆質問・確認
  return /(要約|整理|まとめ|承知|了解)(し(ます|ました)|いたします)|^以下に|^はい[、。]/.test(line);
}

/**
 * LLM 出力から「1行目=要約 + 箇条書き」のみを抽出する形式検証。
 * 箇条書きが1件も無ければ undefined（呼出側が原文へフォールバック）。
 */
export function extractSummary(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => l.startsWith("- ") && !/[?？]\s*$/.test(l)).slice(0, BULLETS_MAX);
  if (bullets.length === 0) return undefined;
  const first = lines[0];
  const headline = first && !first.startsWith("- ") && !first.startsWith("```") && !isNoise(first) ? first : undefined;
  return [...(headline ? [headline] : []), ...bullets].join("\n");
}

/**
 * 依頼プロンプトを `claude -p`（haiku・1ターン）で箇条書きの依頼文へ整理する。
 * - サブスク認証（OAuth）のまま動作（実機検証済み）
 * - 再帰防止: 子プロセスへ BACKLOG_SYNC_IN_HOOK=1 を付与（hook CLI 入口で即 return）
 * - cwd は os.tmpdir(): プロジェクトフックの誤発火と CLAUDE.md 読込を回避
 * - claude 不在（ENOENT）/ timeout / JSON parse 失敗 / 形式外出力 → undefined（例外を漏らさない）
 */
export async function summarizeRequest(prompt: string, opts: { timeoutMs?: number; exec?: ExecFn } = {}): Promise<string | undefined> {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < SHORT_PROMPT_MAX && !trimmed.includes("\n")) return undefined; // 短い単文は原文で十分
  const exec = opts.exec ?? defaultExec;
  try {
    const input = `${INSTRUCTION}\n\n---\n${trimmed.slice(0, PROMPT_INPUT_MAX)}`;
    const { stdout } = await exec(
      "claude",
      ["-p", input, "--output-format", "json", "--max-turns", "1", "--model", "haiku"],
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cwd: tmpdir(),
        env: { ...process.env, BACKLOG_SYNC_IN_HOOK: "1" },
      },
    );
    const parsed = JSON.parse(stdout) as { result?: unknown };
    return extractSummary(typeof parsed.result === "string" ? parsed.result : undefined);
  } catch {
    return undefined;
  }
}
