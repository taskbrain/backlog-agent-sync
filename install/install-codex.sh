#!/usr/bin/env bash
# backlog-agent-sync を Codex CLI へ導入する。
#
# Codex CLI（0.137.0 実機検証）では config.toml の [[hooks.*]] 形式は trust されず
# 黙ってスキップされるため、フックは以下の方式で登録する:
#   - フック定義 : ~/.codex/hooks.json へマージ（他ツールの既存フックは完全保全・冪等）
#   - trust 登録 : ~/.codex/config.toml の [hooks.state."..."] へ trusted_hash を自動登録/更新
#                  （手動の承認は不要。マージとハッシュ計算は install/codex-register.mjs が行う）
#   - MCP        : ~/.codex/config.toml へ [mcp_servers.backlog] をマージ（既存があればスキップ）
#   - AGENTS.md  : 意味的ポリシー snippet を追記（マーカーコメントで冪等）
#   - 旧方式（config.toml 内の [[hooks.*]] ブロック）が残っていれば削除
#   - 変更前にタイムスタンプ付きバックアップを作成
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN="${ROOT}/bin/backlog-sync"
SNIPPET="${ROOT}/codex/AGENTS.md.snippet"
REGISTER="${SCRIPT_DIR}/codex-register.mjs"

CODEX_HOME="${CODEX_HOME:-${HOME}/.codex}"
CONFIG="${CODEX_HOME}/config.toml"
HOOKS_JSON="${CODEX_HOME}/hooks.json"
AGENTS="${CODEX_HOME}/AGENTS.md"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "backlog-agent-sync (Codex CLI) installer"
echo "repo root : ${ROOT}"
echo "codex home: ${CODEX_HOME}"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "NG: node が見つかりません（Node >= 20 必須）。" >&2
  exit 1
fi
if [ ! -f "${SNIPPET}" ]; then
  echo "NG: ${SNIPPET} が見つかりません（リポジトリが不完全です）。" >&2
  exit 1
fi
if [ ! -f "${REGISTER}" ]; then
  echo "NG: ${REGISTER} が見つかりません（リポジトリが不完全です）。" >&2
  exit 1
fi

# ビルド成果物（bin/backlog-sync は dist/cli.js を起動する）
if [ ! -f "${ROOT}/dist/cli.js" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "build: dist/cli.js が無いためビルドします..."
    (cd "${ROOT}" && npm install && npm run build)
  else
    echo "WARN: dist/cli.js がありません。フックを動かす前にビルドしてください:" >&2
    echo "  (cd \"${ROOT}\" && npm install && npm run build)" >&2
  fi
fi

mkdir -p "${CODEX_HOME}"
[ -f "${CONFIG}" ] || : > "${CONFIG}"
[ -f "${AGENTS}" ] || : > "${AGENTS}"

# 変更前バックアップ（非空ファイルのみ・本実行で同一ファイルは 1 回だけ）
backup() {
  if [ -s "$1" ] && [ ! -f "$1.bak.${STAMP}" ]; then
    cp "$1" "$1.bak.${STAMP}"
    echo "backup: $1 -> $1.bak.${STAMP}"
  fi
}

# --- 1) フック登録（旧ブロック削除 + hooks.json マージ + trust 自動登録） ---
backup "${CONFIG}"
if [ -f "${HOOKS_JSON}" ]; then
  backup "${HOOKS_JSON}"
fi
node "${REGISTER}" "${BIN}" "${HOOKS_JSON}" "${CONFIG}"

# --- 2) [mcp_servers.backlog] のマージ ---
if grep -q '^\[mcp_servers\.backlog\]' "${CONFIG}"; then
  echo "skip: [mcp_servers.backlog] は既に存在します"
else
  backup "${CONFIG}"
  cat >>"${CONFIG}" <<EOF

# --- backlog-agent-sync: Backlog MCP（added ${STAMP}）---
# BACKLOG_DOMAIN / BACKLOG_API_KEY はシェル環境変数から転送する（値を書かない）
[mcp_servers.backlog]
command = "npx"
args = ["backlog-mcp-server@0.12.0"]
env = { ENABLE_TOOLSETS = "space,project,issue" }
env_vars = ["BACKLOG_DOMAIN", "BACKLOG_API_KEY"]
EOF
  echo "added: [mcp_servers.backlog]"
fi

# --- 3) AGENTS.md へ snippet 追記（マーカーで冪等） ---
if grep -qF "backlog-agent-sync:begin" "${AGENTS}"; then
  echo "skip: AGENTS.md には既に追記済みです"
else
  backup "${AGENTS}"
  printf '\n' >>"${AGENTS}"
  cat "${SNIPPET}" >>"${AGENTS}"
  echo "added: AGENTS.md snippet"
fi

cat <<DONE

完了。フックの trust（trusted_hash）は config.toml の [hooks.state] へ自動登録済みのため、
手動の承認は不要です。フックの command / timeout / statusMessage を変更した場合は、
本スクリプトを再実行すると trusted_hash が更新されます。

次を確認してください:

  1. シェル環境変数（例: ~/.zshrc。値のコミット禁止。
     フックのサブプロセスへは親シェルの環境変数がそのまま渡ります）:
       export BACKLOG_DOMAIN="your-space.backlog.com"
       export BACKLOG_API_KEY="..."
       export BACKLOG_PROJECT="PROJ"
  2. 動作確認: codex 内で backlog MCP のツール（get_myself 等）が見えること。
     セッション終了（Stop）後に Backlog 課題へ集約サマリが付くこと。
DONE
