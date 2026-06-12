# 設計書: VCS連携(GitHub/Backlog Git)・課題フィールド動的設定・内容充実

- **日付**: 2026-06-12 / **ステータス**: 確定(調査済み・一次情報URL付き)
- **背景**: 課題に書かれるファイル参照がローカルパスのままで他のメンバーが開けない。優先度・担当者等が固定値。説明が簡素で「依頼→処理」の流れが追いにくい。
- **調査**: Backlog API v2 / GitHub / Claude Code hooks / Codex hooks の 2026-06-12 時点仕様を並列調査(13エージェント)。本書の決定は全て一次情報に基づく。

## 1. VCS 連携(R1)

### 1.1 設定モデル
`project.json` に `vcs` を追加:
```jsonc
"vcs": {
  "kind": "github" | "backlog" | "generic",   // generic=リンク生成なし
  // github: remote から抽出
  "owner": "taskbrain", "repo": "AISNStsukurukun",
  // backlog: Web UI ベース(API に blob/commit が無いため URL 組み立て)
  "webBase": "https://space.backlog.com", "projectKey": "TC", "repoName": "app"
},
"textFormattingRule": "markdown" | "backlog"
```

### 1.2 初期化フロー(`backlog-sync init` 拡張)
1. `git remote get-url origin` を解析(https / scp風 / ssh:// の3形式対応、`.git` 任意)
   - host が `github.com` → **github**(owner/repo 抽出。`gh repo view --json nameWithOwner` があれば優先=insteadOf 対応)
   - host が `*.git.backlog.com|jp` / `*.backlogtool.com` 系 → **backlog**(space/projectKey/repoName 抽出。GET /projects/:key/git/repositories で実在確認)
   - その他/remoteなし → **generic**
2. 検出結果を表示し、`--vcs github|backlog|generic` フラグで上書き可(非対話CLI原則)。
3. `textFormattingRule` を GET /projects/:key から取得し保存。
4. **対話的な選択は ceiling に委譲**: `/backlog-sync-init` スラッシュコマンドを更新し、エージェントが検出結果をユーザーに確認してから init を実行する手順を記述(ユーザー提案の「初期設定ダイアログ」は、CLI側は自動検出+フラグ、対話はエージェント側で実現するのが Claude Code の作法に合う)。

### 1.3 リンク生成(`src/vcs/linker.ts` — URL形式は本モジュールに隔離)
| 対象 | github | backlog |
|---|---|---|
| ファイル | `https://github.com/{o}/{r}/blob/{sha}/{path}` (+`#L10-L20`) | `{webBase}/git/{PROJ}/{repo}/blob/{rev}/{path}` |
| コミット | `/commit/{fullSha}` | `{webBase}/git/{PROJ}/{repo}/commit/{sha}` |
| PR | `/pull/{number}` | `{webBase}/git/{PROJ}/{repo}/pullRequests/{number}` |
- ファイルリンクの ref は**そのターンの HEAD SHA**(permalink)。未 push の場合は `(未push)` を注記(リンクは push 後に有効)。
- Backlog Web UI 形式は公式リファレンス非掲載(gitb 実装由来)のためリスクコメントを付し、変更時は linker のみ修正。

### 1.4 ターン中の git 認識(`src/vcs/git.ts`)
- **UserPromptSubmit 時**: `state.turnStartHead = git rev-parse HEAD`(失敗は無視)
- **Stop 時**:
  - コミット列挙: `git rev-list turnStartHead..HEAD`(時刻非依存で確実)。turnStartHead 不在/到達不能(amend/rebase)時はスキップ+注記。
  - push 判定: `git branch -r --contains <sha>`(fetch はしない。誤判定の可能性は注記で吸収)
  - ブランチ名: `git rev-parse --abbrev-ref HEAD`
  - PR 検出: github → `gh pr view --json url,number,title`(exit 4=未認証→スキップ、exit 1 + stderr `no pull requests found` =PRなし、それ以外の exit 1=エラー扱いでスキップ)。backlog → PR一覧APIから branch 一致を検索し、**未関連なら PATCH pullRequests/:number に issueId(数値ID)で課題へ自動関連付け**。
- すべて best-effort・非ブロッキング(git の無い cwd でも壊れない)。

## 2. 記法対応(`src/markup.ts`)
- `textFormattingRule` で出し分け: markdown=GFM(`## 見出し` / `[t](url)` / `**強調**`)、backlog=Backlog記法(`* 見出し` / `[[t>url]]` / `''強調''`)。
- 裸URLは両記法で自動リンクされるため、迷ったら裸URLにフォールバック。
- 生成テンプレは GFM 準拠(2025-10 のBacklogクラウドGFM移行に対応)。

## 3. 課題フィールドの動的設定(R2)

### 3.1 init キャッシュ拡張
`categories` / `versions(=マイルストーン兼発生バージョン)` / `resolutions` / `myself` を project.json へキャッシュ(statuses/issueTypes/priorities は既存)。

### 3.2 決定論ルール(floor)
| フィールド | ルール(既定) | 設定キー(project.json `fieldRules`) |
|---|---|---|
| 担当者 | 課題作成時に **自分(APIキー所有者)** | `assignSelf: true` |
| 優先度 | プロンプトのキーワード判定: 緊急/至急/障害/本番/critical→高、軽微/typo/タイポ→低、他→中 | `priorityKeywords: {high:[],low:[]}` |
| カテゴリ | キーワード→カテゴリ名のルール表(プロンプト+変更ファイルパスに対しマッチ) | `categoryRules: {"<カテゴリ名>": ["kw1","パス片"]}` |
| マイルストーン | `"current"`= startDate≦今日≦releaseDueDate の未アーカイブ先頭 / 名前指定 / off(既定 off) | `milestone: "current"\|"<name>"\|"off"` |
| 発生バージョン | バグ系キーワード時のみ、名前指定があれば設定(既定 off) | `affectedVersion: "<name>"\|"off"` |
| 完了理由 | **処理済み/完了への遷移と同一 PATCH で resolutionId=0(対応済み)** を送信(id:0 の falsy 罠に注意した実装) | `resolutionOnResolve: true` |
- ルールで決められない高度な判断(本当の優先度・適切な担当者)は **ceiling**: skills/backlog-tracking に「MCP の update_issue で上書きする」ポリシーを明記。

## 4. 課題内容の充実(R3)

### 4.1 課題説明(作成時)
```
## 概要
<初回プロンプトの先頭段落を整形(改行・記号正規化)>

## 依頼(原文)
<初回プロンプト全文(4,000字まで)>

## 環境
- エージェント: Claude Code (model) / Codex
- リポジトリ: <リンク(github: https://github.com/o/r / backlog: webBase/git/...)>
- ブランチ: <branch> / 作業ディレクトリ: <cwd>
- 開始: <ISO> / session_id: <sid>
[[bas:session:<sid>]]
```

### 4.2 ターン要約コメント v2(Stop)
```
## ターン #n
### 依頼
<このターンのプロンプト(500字)>
### 結果
<last_assistant_message(1,200字)>   ← Claude も Stop stdin で直接受領(transcript 解析はフォールバックへ降格)
### 変更
- [path/to/file.ts(2)](blobリンク)
- コミット: [abc1234 件名](commitリンク) (未pushなら注記)
- PR: [#12 タイトル](PRリンク)
### 実行
- npm test ほか N 件
（ツール使用 N 件）
```
- 文字上限: コメント約40,000字で安全側に切り詰め(公式上限は未公表・実測50,000字)。
- **LLM 要約(opt-in)**: `summarize: "claude"` 設定時のみ `claude -p --bare --output-format json --max-turns 1` で「依頼と結果の1段落要約」を生成し「### 概要」をコメント先頭に追加。既定 off(理由: --bare は ANTHROPIC_API_KEY 必須/2026-06-15以降はAgent SDKクレジット消費/last_assistant_message で大半をカバー)。再帰防止に `BACKLOG_SYNC_IN_HOOK=1` ガード。

## 5. その他の設計判断
- **SessionEnd フックの既定予算は1.5秒**(調査で判明)→ キュー排出の主体は Stop。SessionEnd は best-effort のまま。README に `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` 案内を追記。
- Claude Stop の `last_assistant_message` を normalize で取得(Codex と同経路に統一)。transcript 抽出は後方互換フォールバックとして維持。
- 既存課題への遡及適用はしない(新セッションから適用)。

## 6. 実装タスク
| # | 内容 | ファイル |
|---|---|---|
| A1 | vcs 検出(`detect.ts`)・リンク生成(`linker.ts`)・git 認識(`git.ts`) | src/vcs/* |
| A2 | markup レンダラ | src/markup.ts |
| A3 | lifecycle 統合(UPS: turnStartHead+フィールド適用 / Stop: git digest+リンク付き要約+resolution付き遷移 / 説明v2) | src/lifecycle/* |
| A4 | normalize: Claude last_assistant_message | src/events/normalize.ts |
| B1 | REST 追加(categories/versions/resolutions/gitRepos/PR list+update) | src/tracker/backlog-rest.ts |
| B2 | init 拡張(vcs検出配線・textFormattingRule・キャッシュ・fieldRules雛形) + `--vcs` フラグ | src/init.ts, src/cli.ts |
| B3 | fields 動的解決 | src/fields.ts |
| C | テスト一式・README・skills 更新 | test/*, README.md, skills/ |

## 7. 検証計画
1. 単体: linker(3形式×remote3表記)/markup(2記法)/fields(優先度・マイルストーン・resolution=0)/git digest(rev-list・フォールバック)
2. 実機: AISNS(github/markdown)で合成イベント→説明・コメントのリンクが**実際に開ける**ことを確認 → backlog 記法・Backlog Git はユニットで担保(実スペースに Backlog Git が無いため。リスク明記)
3. `codex exec` パリティ → 公開リポジトリへ PR → マージ
