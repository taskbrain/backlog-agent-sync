# Changelog

## [Unreleased]

## [0.1.0] - 2026-06-11

初回公開リリース。Claude Code / Codex のエージェント作業を Backlog 課題へ完全ローカルで同期する。

### Added

- **init**: `get_myself` による認証検証、statusMap / 課題種別 / 優先度の実値解決と `.claude/backlog-agent-sync/project.json` へのキャッシュ（デフォルト ID のハードコードなし）
- **seed**: 現状の初回同期。plan JSON（stdin / `--plan`）→ `--dry-run` プレビュー → 適用。説明文マーカー `[[bas:epic:<slug>]]` + ローカル seed-ledger の二重化による冪等（再実行は更新のみ・重複作成なし）
- **フックライフサイクル**（決定論 floor）: SessionStart（課題 find-or-create + 状態「処理中」+ pull 注入）/ PostToolUse（ローカルバッファのみ）/ SubagentStop・Stop（集約サマリコメント + 状態遷移、送信前にキューへ耐久記録）/ SessionEnd（オフラインキュー排出）
- **インバウンド pull**: 担当課題（`updatedSince` カーソル）+ 新着コメント（`minId` カーソル）の差分取得。SessionStart で additionalContext として注入、`pull [--session <id>]` で随時取得
- **Codex wiring**: `turn_id` 基点の正規化（`normalizeCodex` / 自動判別 `normalizeAuto`）、`codex/config.toml.example`（`[mcp_servers.backlog]` + `[[hooks.*]]`）、`install/install-codex.sh`（config.toml / AGENTS.md への冪等マージ・バックアップ自動）
- **Claude Code プラグイン**: hooks / MCP（`backlog-mcp-server@0.12.0`, `ENABLE_TOOLSETS=space,project,issue`）/ skills / スラッシュコマンドの自動登録、marketplace 対応（`taskbrain/backlog-agent-sync`）、userConfig による API キーのキーチェーン保存
- **レート制御**: 更新・検索系 ≥1 req/s の間隔制御、429 時は `X-RateLimit-Reset` まで待機して再試行
- **冪等・非ブロッキング**: 冪等キー `session_id` + `tool_use_id`（Claude）/ `turn_id`（Codex）と処理済み台帳、原子的書込 + ロックの状態ストア、オフラインキュー（`flush [--session <id>]` / `status` ユーティリティ）。フックは exit 0 固定で Backlog 障害時もセッションを止めない
