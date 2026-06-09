---
name: backlog-seeding
description: プロジェクトの現状(docs/README/git)を読み、Backlog への初回同期プラン(SeedPlan)を提案して preview→確定→冪等適用する。
---

# Backlog Seeding（現状の初回同期）

1. `README` / `docs/` / 主要モジュール / 直近 git log を読む。
2. 主要モジュール/領域ごとに「エピック案」（slug, summary, status）を作り `SeedPlan` JSON を組む。
3. `backlog-sync seed --dry-run` 相当の preview をユーザーに提示し、**確定を得てから**適用する。
4. 適用は `backlog-sync` の冪等 apply（マーカー `[[bas:epic:<slug>]]`）で行い、再実行で重複しない。
