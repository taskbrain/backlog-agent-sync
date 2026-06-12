# 設計書: docs → Backlog Wiki/Document 同期

- **日付**: 2026-06-12 / 調査済み(一次情報47 findings+実機プローブ)
- **目的**: 人間向け=Backlog(Wiki/Document)、コード向け=リポジトリ docs/ の分業。完全同期ではなく「適切なタイミングの push 同期」。

## 確定事実(実機+公式)
- **Wiki API**: 一覧/取得/追加(POST /wikis: projectId,name,content,mailNotify)/更新(PATCH /wikis/:id)/削除 完備 → 冪等同期の主経路
- **Document API**: 追加(POST /documents: projectId,title,content=Markdownパース,emoji,parentId,addLast)/取得/tree/削除のみ。**更新APIは存在しない**(update-document=404、公式SDK/MCPにも無し)。Delete は管理者権限。content は ProseMirror JSON 化されラウンドトリップ不可
- ページ名に「/」で Wiki ツリー表示。Home はリネーム/削除不可(本プロジェクトではユーザー手書きのため**同期対象外・不可侵**)
- 一覧APIは content を返さない → ローカル台帳(ハッシュ)で差分スキップが必須
- mailNotify=false 明示必須(通知スパム防止)。先頭「[」はタグ解釈→警告

## 設計
### 構成(`project.json` の `docsSync`)
```jsonc
"docsSync": {
  "target": "wiki",                 // "wiki"(既定・更新可能) | "documents"(ワンショット投入・更新=削除再作成でURL変動)
  "root": "docs",                  // 同期ルート
  "overviewSource": "README.md",   // 概要ページの元(リポジトリルート相対)
  "overviewPage": "プロジェクト概要",  // 概要のWikiページ名(Homeは不可侵)
  "exclude": ["assets/", "superpowers/research/"],
  "maxFileKb": 100                  // 超過は警告スキップ(本文上限が未公表のため)
}
```

### CLI
`backlog-sync docs [--dry-run] [--prune]`
- 走査: root 配下 *.md(exclude 除外、maxFileKb 超過は警告スキップ)
- ページ名 = root からの相対パス(.md 除去)。overviewSource → overviewPage
- 変換(convert): 
  - 相対 .md リンク → `[[ページ名]]`(コードフェンス内は不変換)
  - 相対 .md 以外(コード/画像) → vcs があれば GitHub permalink(G19 linker 再利用、rev=HEAD)、無ければ素通し+警告
  - 画像 `![](相対)` → リンク化のみ(添付同期は v2)
- 差分: docs-ledger.json(path → {name, wikiId|documentId, hash})。hash 一致はスキップ
- wiki backend: 起動時 GET /wikis 1回で name→id 辞書 → 有→PATCH/無→POST(201のidを台帳へ)。POST重複エラー時は辞書再取得しPATCHフォールバック。mailNotify=false
- documents backend: 台帳に id 無→POST(parentId でツリー再現: ディレクトリごとに親ドキュメント自動作成)。有+hash 変化→ **--recreate 指定時のみ** DELETE→POST(URL変動を警告)。既定は「変更検出を警告表示のみ」
- 概要ページ: overviewSource 変換後に「## ドキュメント一覧」(同期ページの [[リンク]] ツリー)を自動追記
- --prune: 台帳にあるがローカルに無いページを削除(opt-in。Home/台帳外ページは対象外)
- プリフライト: textFormattingRule==="markdown" 検証(backlog記法プロジェクトはリンク記法を [[t>url]] へ切替)・Wiki書込不可(Document移行済み)エラーの明示

### 同期タイミング
v1=手動(`/backlog-sync-docs` コマンド)。完全同期はしない方針(ユーザー要件)。README に「ドキュメント更新後に実行」を記載。

## 検証計画
1. 単体: 変換(リンク/フェンス/画像)・台帳差分・ページ名マッピング・dry-run
2. 実機(TC): dry-run → 適用(90ファイル規模)→ Backlog 上でツリー表示・[[リンク]]遷移・GitHub permalink を確認 → 再実行で全スキップ(冪等)
3. documents backend は小規模(2-3ファイル)の実機ワンショットで検証
