# backlog-agent-sync

Claude Code / Codex のエージェント作業を Backlog 課題へ**リアルタイム・漏れなく**同期する、完全ローカルなプラグイン。

- 完全ローカル（Backlog API 以外の外部サービス・別契約なし）
- フックで決定論的に同期（floor）＋ Backlog MCP で意味的更新（ceiling）
- `init`（セットアップ）/ `seed`（現状の初回同期）/ リアルタイム同期

詳細設計: 上位プロジェクトの `docs/superpowers/specs/2026-06-10-backlog-agent-sync-design.md`
