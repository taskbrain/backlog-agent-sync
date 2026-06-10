---
description: 未送信のオフラインキューをBacklogへ手動排出する
---

`backlog-sync flush` を実行し、全セッションの未送信キューを Backlog へ排出してください。特定セッションのみ排出する場合は `backlog-sync flush --session <id>` を使用してください。排出結果（成功件数/残件数）を報告し、残件がある場合は原因（ネットワーク/認証など）を確認してください。
