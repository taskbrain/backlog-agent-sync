---
description: リポジトリの docs/ を Backlog Wiki へ同期する(dry-run→確認→適用)
---

まず `backlog-sync docs --dry-run` を実行し、create/update/skip の preview と警告をユーザーに提示してください。ユーザーが内容を確認・了承したら `backlog-sync docs` で適用してください。

注意:
- ローカルから消えたページの削除は `--prune` を明示された場合のみ付けてください（台帳管理外のリモートページと Home は削除されません）。
- `--target documents` は更新 API が無いワンショット投入です。変更の反映には `--recreate`（削除→再作成・URL 変動）が必要なことをユーザーに伝えてください。
- 実行後は created/updated/skipped/pruned の集計と警告を報告してください。
