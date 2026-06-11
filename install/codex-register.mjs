#!/usr/bin/env node
/**
 * backlog-agent-sync: Codex CLI フック登録ヘルパ（install-codex.sh から呼ばれる）
 *
 * Codex CLI（0.137.0 実機検証）では config.toml の [[hooks.*]] 形式は trust されず
 * 黙ってスキップされる。正しい方式:
 *   1. フック定義を ~/.codex/hooks.json に置く
 *   2. config.toml の [hooks.state."<hooks.json絶対パス>:<event_label>:<groupIndex>:<handlerIndex>"]
 *      に trusted_hash = "sha256:..." を登録する（これで自動実行される）
 *
 * 本スクリプトの処理:
 *   a. config.toml から旧方式（マーカー付き [[hooks.*]] ブロック）を削除
 *   b. hooks.json へ 5 イベントのフックをマージ（他ツールの既存フックは完全保全・冪等）
 *   c. config.toml の [hooks.state."..."] へ trusted_hash を登録/更新（重複セクションなし）
 *
 * 使い方: node codex-register.mjs <bin-path> <hooks-json-path> <config-toml-path>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const [binPath, hooksJsonPath, configPath] = process.argv.slice(2);
if (!binPath || !hooksJsonPath || !configPath) {
  console.error("usage: node codex-register.mjs <bin-path> <hooks-json-path> <config-toml-path>");
  process.exit(1);
}

const EVENTS = [
  { name: "SessionStart", label: "session_start", cli: "session-start", timeout: 30, statusMessage: "Backlog: session sync" },
  { name: "UserPromptSubmit", label: "user_prompt_submit", cli: "user-prompt-submit", timeout: 30 },
  { name: "PostToolUse", label: "post_tool_use", cli: "post-tool", timeout: 30 },
  { name: "SubagentStop", label: "subagent_stop", cli: "subagent-stop", timeout: 30 },
  { name: "Stop", label: "stop", cli: "stop", timeout: 60, statusMessage: "Backlog: session summary" },
];

// ---------------------------------------------------------------------------
// trusted_hash 算出（Codex 0.137.0 / superset 既知ハッシュ 3 件で検算済みのアルゴリズム）
// ---------------------------------------------------------------------------

/** 辞書キーを再帰的にソートした canonical 構造を返す。 */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/**
 * normalized handler:
 *   {"type":"command","command":<そのまま>,"async":false,"timeout":<指定値、未指定600、min 1>}
 *   + statusMessage があれば含める（無ければキー自体省略）
 * identity:
 *   {"event_name":<snake_caseラベル>,"hooks":[normalized handler]} + matcher があれば含める
 * canonical 化 → JSON.stringify（JS 既定は separators=(",",":")・非ASCIIそのまま相当）→ sha256 hex
 * 注: Codex は async フック未サポートのため、正規化では async は false 固定。
 */
function trustHash(label, handler, matcher) {
  const t = Number(handler.timeout);
  const normalized = {
    type: "command",
    command: String(handler.command),
    async: false,
    timeout: Number.isFinite(t) ? Math.max(1, t) : 600,
  };
  if (handler.statusMessage !== undefined) normalized.statusMessage = handler.statusMessage;
  const identity = { event_name: label, hooks: [normalized] };
  if (matcher !== undefined) identity.matcher = matcher;
  const ser = JSON.stringify(canonical(identity));
  return "sha256:" + createHash("sha256").update(ser, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// b. hooks.json マージ（既存フックは保全。backlog-sync を含む command があればスキップ）
// ---------------------------------------------------------------------------

let hooksDoc = { hooks: {} };
let hooksJsonExisted = false;
if (existsSync(hooksJsonPath)) {
  const text = readFileSync(hooksJsonPath, "utf8").trim();
  if (text) {
    hooksJsonExisted = true;
    try {
      hooksDoc = JSON.parse(text);
    } catch (e) {
      console.error(`NG: ${hooksJsonPath} の JSON 解析に失敗しました: ${e && e.message ? e.message : e}`);
      process.exit(1);
    }
  }
}
if (!hooksDoc || typeof hooksDoc !== "object") hooksDoc = { hooks: {} };
if (!hooksDoc.hooks || typeof hooksDoc.hooks !== "object") hooksDoc.hooks = {};

const results = [];
let hooksChanged = false;

for (const ev of EVENTS) {
  if (!Array.isArray(hooksDoc.hooks[ev.name])) hooksDoc.hooks[ev.name] = [];
  const groups = hooksDoc.hooks[ev.name];

  // 既存の backlog-sync エントリ検出（冪等: 追加せず trust の登録/更新のみ行う）
  let gidx = -1;
  let hidx = -1;
  for (let g = 0; g < groups.length && gidx < 0; g++) {
    const hs = groups[g] && Array.isArray(groups[g].hooks) ? groups[g].hooks : [];
    for (let h = 0; h < hs.length; h++) {
      if (hs[h] && typeof hs[h].command === "string" && hs[h].command.includes("backlog-sync")) {
        gidx = g;
        hidx = h;
        break;
      }
    }
  }

  if (gidx < 0) {
    // 注: async は未サポート（警告付きスキップになる）ため書かない
    const handler = { type: "command", command: `"${binPath}" hook ${ev.cli}`, timeout: ev.timeout };
    if (ev.statusMessage) handler.statusMessage = ev.statusMessage;
    groups.push({ hooks: [handler] });
    gidx = groups.length - 1;
    hidx = 0;
    hooksChanged = true;
    console.log(`hooks.json: ${ev.name} を追加（group ${gidx}）`);
  } else {
    console.log(`hooks.json: ${ev.name} は既存エントリを使用（group ${gidx}, handler ${hidx}）`);
  }

  const group = groups[gidx];
  results.push({ ev, gidx, hidx, handler: group.hooks[hidx], matcher: group.matcher });
}

if (hooksChanged || !hooksJsonExisted) {
  writeFileSync(hooksJsonPath, JSON.stringify(hooksDoc, null, 2) + "\n", "utf8");
  console.log(`write: ${hooksJsonPath}`);
}

// ---------------------------------------------------------------------------
// a. config.toml の旧 [[hooks.*]] ブロック削除 + c. [hooks.state] trust 登録/更新
// ---------------------------------------------------------------------------

const cfgOriginal = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
let cfg = cfgOriginal;

// a. 旧方式クリーンアップ: マーカー行から「'[' で始まり '[[hooks.' でも '[hooks.' でもない行」
//    または EOF まで削除
{
  const lines = cfg.split("\n");
  const out = [];
  let skipping = false;
  let removed = false;
  for (const line of lines) {
    if (!skipping && line.startsWith("# --- backlog-agent-sync: hooks")) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping) {
      if (line.startsWith("[") && !line.startsWith("[[hooks.") && !line.startsWith("[hooks.")) {
        skipping = false;
        out.push(line);
      }
      continue;
    }
    out.push(line);
  }
  if (removed) {
    cfg = out.join("\n");
    console.log("config.toml: 旧方式の [[hooks.*]] ブロックを削除しました");
  }
}

// c. trust 登録/更新（同一キーの既存セクションは trusted_hash を書き換える。重複セクション禁止）
function upsertTrust(text, key, hash) {
  const header = `[hooks.state."${key}"]`;
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim() === header);
  if (idx < 0) {
    let t = text;
    if (t.length && !t.endsWith("\n")) t += "\n";
    t += `\n${header}\ntrusted_hash = "${hash}"\n`;
    return { text: t, action: "登録" };
  }
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("[")) {
      end = i;
      break;
    }
  }
  for (let i = idx + 1; i < end; i++) {
    if (/^\s*trusted_hash\s*=/.test(lines[i])) {
      const unchanged = lines[i].includes(hash);
      lines[i] = `trusted_hash = "${hash}"`;
      return { text: lines.join("\n"), action: unchanged ? "変更なし" : "更新" };
    }
  }
  lines.splice(idx + 1, 0, `trusted_hash = "${hash}"`);
  return { text: lines.join("\n"), action: "更新" };
}

const absHooksPath = resolve(hooksJsonPath);
for (const r of results) {
  const key = `${absHooksPath}:${r.ev.label}:${r.gidx}:${r.hidx}`;
  const hash = trustHash(r.ev.label, r.handler, r.matcher);
  const res = upsertTrust(cfg, key, hash);
  cfg = res.text;
  console.log(`trust ${res.action}: ${key}`);
}

if (cfg !== cfgOriginal) {
  writeFileSync(configPath, cfg.endsWith("\n") ? cfg : cfg + "\n", "utf8");
  console.log(`write: ${configPath}`);
}
