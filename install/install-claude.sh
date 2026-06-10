#!/usr/bin/env bash
# backlog-agent-sync を Claude Code へ導入する（ローカル開発向け）。
# 冪等: ユーザー設定（~/.claude 等）への書込は一切行わない。
# 前提検証 + 必要ならビルド + 導入コマンドの提示のみ。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "backlog-agent-sync (Claude Code) installer"
echo "plugin root: $ROOT"
echo ""

# 1) 前提チェック
if ! command -v claude >/dev/null 2>&1; then
  echo "NG: claude CLI が見つかりません。https://code.claude.com/docs を参照してインストールしてください。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "NG: node が見つかりません（Node >= 20 必須）。" >&2
  exit 1
fi

# 2) ビルド成果物（bin/backlog-sync は dist/cli.js を起動する）
if [ ! -f "$ROOT/dist/cli.js" ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "build: dist/cli.js が無いためビルドします..."
    (cd "$ROOT" && npm install && npm run build)
  else
    echo "WARN: dist/cli.js がありません。導入前にビルドしてください:" >&2
    echo "  (cd \"$ROOT\" && npm install && npm run build)" >&2
  fi
fi

# 3) 導入方法の提示（既存設定は変更しない）
cat <<GUIDE

導入方法（どちらか）:

  A. ローカル開発（このリポジトリを直接読み込む）:
     claude --plugin-dir "$ROOT"
     セッション中の再読込は /reload-plugins

  B. 公開マーケットプレイス経由（公開後）:
     claude 内で
       /plugin marketplace add <owner>/backlog-agent-sync
       /plugin install backlog-agent-sync

有効化時に userConfig（BACKLOG_DOMAIN / BACKLOG_API_KEY / BACKLOG_PROJECT）の
入力を求められます。API キーは sensitive 指定のためマスク・キーチェーン保存されます。

導入後の初期化:
  /backlog-sync-init   # 機械セットアップ（auth 検証 / statusMap 解決）
  /backlog-sync-seed   # 現状の初回同期（dry-run プレビュー → 確定）
GUIDE
