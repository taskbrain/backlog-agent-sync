#!/usr/bin/env bash
# backlog-agent-sync を Codex CLI へ導入する。
# - ~/.codex/config.toml へ [mcp_servers.backlog] と [[hooks.*]] をマージ（既存があればスキップ = 冪等）
# - ~/.codex/AGENTS.md へ意味的ポリシー snippet を追記（マーカーコメントで冪等）
# - 変更前にタイムスタンプ付きバックアップを作成
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$ROOT/bin/backlog-sync"
SNIPPET="$ROOT/codex/AGENTS.md.snippet"

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$CODEX_HOME/config.toml"
AGENTS="$CODEX_HOME/AGENTS.md"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "backlog-agent-sync (Codex CLI) installer"
echo "repo root : $ROOT"
echo "codex home: $CODEX_HOME"
echo ""

if [ ! -f "$SNIPPET" ]; then
  echo "NG: $SNIPPET が見つかりません（リポジトリが不完全です）。" >&2
  exit 1
fi

# ビルド成果物（bin/backlog-sync は dist/cli.js を起動する）
if [ ! -f "$ROOT/dist/cli.js" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "build: dist/cli.js が無いためビルドします..."
    (cd "$ROOT" && npm install && npm run build)
  else
    echo "WARN: dist/cli.js がありません。フックを動かす前にビルドしてください:" >&2
    echo "  (cd \"$ROOT\" && npm install && npm run build)" >&2
  fi
fi

mkdir -p "$CODEX_HOME"
[ -f "$CONFIG" ] || : > "$CONFIG"
[ -f "$AGENTS" ] || : > "$AGENTS"

# 変更前バックアップ（非空ファイルのみ・本実行で 1 回だけ）
backup() {
  if [ -s "$1" ] && [ ! -f "$1.bak.$STAMP" ]; then
    cp "$1" "$1.bak.$STAMP"
    echo "backup: $1 -> $1.bak.$STAMP"
  fi
}

# --- 1) [mcp_servers.backlog] のマージ ---
if grep -q '^\[mcp_servers\.backlog\]' "$CONFIG"; then
  echo "skip: [mcp_servers.backlog] は既に存在します"
else
  backup "$CONFIG"
  cat >>"$CONFIG" <<EOF

# --- backlog-agent-sync: Backlog MCP（added $STAMP）---
# BACKLOG_DOMAIN / BACKLOG_API_KEY はシェル環境変数から転送する（値を書かない）
[mcp_servers.backlog]
command = "npx"
args = ["backlog-mcp-server@0.12.0"]
env = { ENABLE_TOOLSETS = "space,project,issue" }
env_vars = ["BACKLOG_DOMAIN", "BACKLOG_API_KEY"]
EOF
  echo "added: [mcp_servers.backlog]"
fi

# --- 2) [[hooks.*]] のマージ（マーカーコメントで冪等） ---
HOOKS_MARKER="# --- backlog-agent-sync: hooks"
if grep -qF "$HOOKS_MARKER" "$CONFIG"; then
  echo "skip: backlog-agent-sync の hooks は既に存在します"
else
  backup "$CONFIG"
  cat >>"$CONFIG" <<EOF

$HOOKS_MARKER（added $STAMP）---
# Codex のフックは command ハンドラのみ。Claude Code と同一 CLI の floor 経路を通す。
# 注: Codex に SessionEnd フックは無い（キュー排出は Stop の drain / \`backlog-sync flush\`）。

[[hooks.SessionStart]]

[[hooks.SessionStart.hooks]]
type = "command"
command = '"$BIN" hook session-start'
timeout = 30
statusMessage = "Backlog: session sync"

[[hooks.PostToolUse]]

[[hooks.PostToolUse.hooks]]
type = "command"
command = '"$BIN" hook post-tool'
timeout = 30

[[hooks.SubagentStop]]

[[hooks.SubagentStop.hooks]]
type = "command"
command = '"$BIN" hook subagent-stop'
timeout = 30

[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = '"$BIN" hook stop'
timeout = 60
statusMessage = "Backlog: session summary"
EOF
  echo "added: [[hooks.SessionStart|PostToolUse|SubagentStop|Stop]]"
fi

# --- 3) AGENTS.md へ snippet 追記（マーカーで冪等） ---
if grep -qF "backlog-agent-sync:begin" "$AGENTS"; then
  echo "skip: AGENTS.md には既に追記済みです"
else
  backup "$AGENTS"
  printf '\n' >>"$AGENTS"
  cat "$SNIPPET" >>"$AGENTS"
  echo "added: AGENTS.md snippet"
fi

cat <<DONE

完了。次を確認してください:

  1. シェル環境変数（例: ~/.zshrc。値のコミット禁止）:
       export BACKLOG_DOMAIN="your-space.backlog.com"
       export BACKLOG_API_KEY="..."
  2. Codex 初回起動時にフック（command）の承認/trust を求められた場合は許可する。
  3. 動作確認: codex 内で backlog MCP のツール（get_myself 等）が見えること。
DONE
