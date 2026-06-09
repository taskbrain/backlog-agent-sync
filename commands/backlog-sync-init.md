---
description: backlog-agent-sync の初期セットアップ(auth検証/statusMap解決/設定書込)を実行する
---

`backlog-sync init` を実行し、Backlog の認証・対象プロジェクト・statusMap を解決して `.claude/backlog-agent-sync/project.json` を作成してください。失敗時は不足している環境変数（BACKLOG_DOMAIN/BACKLOG_API_KEY/BACKLOG_PROJECT）を案内してください。
