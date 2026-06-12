# backlog-agent-sync

Sync Claude Code / Codex agent sessions to Backlog issues in real time — deterministic hooks (floor) + Backlog MCP (ceiling), fully local with no external services beyond the Backlog API.

Claude Code / Codex のエージェント作業を Backlog 課題へ**リアルタイム・漏れなく**同期するツールです。

## 概要

2 層のハイブリッド構成で「漏れなく」と「意味のある記録」を両立します。

| 層 | 担当 | 経路 |
|---|---|---|
| **floor（決定論）** | フックが課題の作成・活動記録・集約サマリ・状態遷移を機械的に保証 | フック → `backlog-sync` CLI → Backlog REST |
| **ceiling（意味）** | エージェントがチケット読解・リッチなコメント・子課題昇格を補完 | エージェント → Backlog MCP（`backlog-mcp-server@0.12.0`） |

- **完全ローカル**: 実行時に必要なネットワークは Backlog API のみ。外部ホスティング・別契約・Webhook 受信基盤は不要です。
- **非ブロッキング**: Backlog 障害やオフラインでもセッションを止めません（オフラインキューへ耐久記録し、後で排出）。
- **冪等**: イベントの重複起動・seed の再実行で二重投稿/重複作成しません。

### 前提

- Node.js >= 20
- Backlog の個人 API キー（スペースの個人設定で発行）
- MCP を使う場合は `npx`（初回のみ `backlog-mcp-server@0.12.0` を取得）

## インストール（Claude Code）

### A. マーケットプレイス経由（推奨）

Claude Code 内で:

```
/plugin marketplace add taskbrain/backlog-agent-sync
/plugin install backlog-agent-sync@backlog-agent-sync
```

有効化時に userConfig の入力を求められます:

| キー | 内容 |
|---|---|
| `BACKLOG_DOMAIN` | 例: `your-space.backlog.com` / `.jp` |
| `BACKLOG_API_KEY` | 個人 API キー（sensitive 指定 — マスク入力・OS キーチェーン保存） |
| `BACKLOG_PROJECT` | 同期対象プロジェクトのキー（例: `PROJ`） |

プラグインとして hooks / MCP（`backlog`）/ skills / コマンドが自動登録されます。`.mcp.json` の手編集は不要です。

### B. 開発時（ローカル読み込み）

```bash
git clone https://github.com/taskbrain/backlog-agent-sync.git
claude --plugin-dir ./backlog-agent-sync
```

セッション中の再読込は `/reload-plugins`。

### C. 手動（プラグインを使わない場合）

環境変数ファイルを作り（**git 管理外に置くこと**）:

```bash
# .claude/backlog-agent-sync/.env
BACKLOG_DOMAIN=your-space.backlog.com
BACKLOG_API_KEY=...
BACKLOG_PROJECT=PROJ
```

`.claude/settings.local.json` に 5 フックを登録します（`path/to/backlog-agent-sync` は本リポジトリの配置先に読み替え）:

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup", "hooks": [ { "type": "command",
        "command": "cd \"${CLAUDE_PROJECT_DIR:-.}\" && set -a && . .claude/backlog-agent-sync/.env && set +a && exec path/to/backlog-agent-sync/bin/backlog-sync hook session-start",
        "timeout": 20, "statusMessage": "Backlog課題と同期中" } ] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "cd \"${CLAUDE_PROJECT_DIR:-.}\" && set -a && . .claude/backlog-agent-sync/.env && set +a && exec path/to/backlog-agent-sync/bin/backlog-sync hook post-tool",
        "async": true } ] }
    ],
    "SubagentStop": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "cd \"${CLAUDE_PROJECT_DIR:-.}\" && set -a && . .claude/backlog-agent-sync/.env && set +a && exec path/to/backlog-agent-sync/bin/backlog-sync hook subagent-stop",
        "async": true } ] }
    ],
    "Stop": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "cd \"${CLAUDE_PROJECT_DIR:-.}\" && set -a && . .claude/backlog-agent-sync/.env && set +a && exec path/to/backlog-agent-sync/bin/backlog-sync hook stop",
        "async": true } ] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [ { "type": "command",
        "command": "cd \"${CLAUDE_PROJECT_DIR:-.}\" && set -a && . .claude/backlog-agent-sync/.env && set +a && exec path/to/backlog-agent-sync/bin/backlog-sync hook session-end",
        "async": true } ] }
    ]
  }
}
```

ポイント: `SessionStart` は `startup` matcher のみ（resume で課題を二重作成しない）。トラッカー系フックは `async: true` で非ブロッキング。

## インストール（Codex CLI）

```bash
./install/install-codex.sh
```

スクリプトが行うこと（**冪等**・実行前にタイムスタンプ付きバックアップを自動作成）:

- `~/.codex/hooks.json` へ 5 イベント（SessionStart / UserPromptSubmit / PostToolUse / SubagentStop / Stop）のフック定義をマージ（他ツールの既存フックは完全保全。`backlog-sync` のエントリが既にあれば追加しません）
- `~/.codex/config.toml` の `[hooks.state."<hooks.json絶対パス>:<event_label>:<groupIndex>:<handlerIndex>"]` へ `trusted_hash` を**自動登録/更新** — 手動の承認なしでフックが自動実行されます。フックの command / timeout / statusMessage を変更した場合は、スクリプトを再実行するとハッシュが更新されます
- `~/.codex/config.toml` へ `[mcp_servers.backlog]` をマージ（既に `backlog` エントリがあればスキップ）
- `~/.codex/AGENTS.md` へ意味的ポリシー snippet を追記（マーカーコメントで冪等）
- 旧方式（config.toml への `[[hooks.*]]` 直書き）のブロックが残っていれば削除します — Codex は config.toml 内のフック定義を trust せず黙ってスキップするため、この方式は機能しません

シェル環境変数が必要です（例: `~/.zshrc`。値のコミット禁止。フックのサブプロセスへは親シェルの環境変数がそのまま渡ります）:

```bash
export BACKLOG_DOMAIN="your-space.backlog.com"
export BACKLOG_API_KEY="..."
export BACKLOG_PROJECT="PROJ"   # フック CLI が使用
```

MCP サーバへは `env_vars` whitelist で `BACKLOG_DOMAIN` / `BACKLOG_API_KEY` を転送します（config に値を書きません）。手動導入する場合は `codex/config.toml.example`（MCP 設定）と `codex/hooks.json.example`（フック定義）を参照してください。手動の場合も `[hooks.state]` への `trusted_hash` 登録が必要なため、インストーラの利用を推奨します。

## 初期セットアップ（init → seed）

### 1. `backlog-sync init` — 機械セットアップ（1 回）

```bash
backlog-sync init
# => init OK: project=PROJ projectId=123 user=... issueTypeId=4 priorityId=3
```

- `get_myself` で認証を検証
- **statusMap / 課題種別 / 優先度を実値で解決**し `.claude/backlog-agent-sync/project.json` にキャッシュ（`未対応=1` 等のデフォルトをハードコードしません）

### 2. `backlog-sync seed` — 現状の初回同期（dry-run → 適用）

プロジェクトの現状（モジュール・ドキュメント領域）をエピック課題群として Backlog に反映します。plan JSON（stdin または `--plan <file>`）を渡します:

```jsonc
{
  "epics": [
    { "slug": "module-billing", "summary": "M5: 課金", "status": "in_progress", "description": "..." }
  ]
}
```

```bash
backlog-sync seed --plan plan.json --dry-run   # プレビュー（一切書き込まない）
backlog-sync seed --plan plan.json             # 適用
```

**冪等性は二重化**されています: 各エピックの説明文先頭にマーカー `[[bas:epic:<slug>]]` を埋め込み、ローカル台帳 `.claude/backlog-agent-sync/seed-ledger.json` にも記録。再実行時は台帳 → マーカー全文検索の順で既存を検出し、**更新のみ**行います（重複作成しません）。

Claude Code ではスラッシュコマンド `/backlog-sync-init` `/backlog-sync-seed`（エージェントが現状を読解して plan を提案 → 確認後に適用）も使えます。

## VCS 連携とフィールド自動設定

### VCS 自動検出（init）

`backlog-sync init` が `git remote get-url origin` を解析してリポジトリ種別を自動検出し、`project.json` の `vcs` に保存します:

| kind | 検出条件 | リンク生成 |
|---|---|---|
| `github` | host が `github.com`（owner/repo を抽出） | `https://github.com/{owner}/{repo}/blob・commit・pull/...` |
| `backlog` | host が `*.git.backlog.com / .jp` 系（プロジェクトの Git リポジトリ実在確認つき。無ければ警告して generic） | `{webBase}/git/{PROJ}/{repo}/...` |
| `generic` | その他 / remote なし | なし（パスのみ表記） |

検出結果は `--vcs github|backlog|generic` フラグで上書きできます。検出された VCS に基づき、課題説明・ターン要約コメントの変更ファイル・コミット・PR が**ブラウザで開けるリンク**になります（ファイルリンクはそのターンの HEAD SHA の permalink。未 push のコミットは注記つき）。Backlog Git では、ブランチに対応する PR が課題に未関連なら自動で関連付けます。

### フィールド自動設定（fieldRules）

課題作成時に、プロンプトのキーワードから担当者・優先度・カテゴリ・マイルストーンを決定論ルールで設定します。`project.json` の `fieldRules` で調整できます（init が雛形を書き込み、既存のユーザー設定は保持されます）:

```jsonc
"fieldRules": {
  "assignSelf": true,                  // 担当者 = API キー所有者（既定 true）
  "priorityKeywords": {                // 優先度キーワード（未指定は既定セット。該当なしは「中」）
    "high": ["緊急", "至急", "障害", "本番障害", "critical", "クリティカル"],
    "low": ["軽微", "typo", "タイポ", "些細"]
  },
  "categoryRules": {                   // カテゴリ名 → キーワード（プロンプトに含まれたら設定）
    "フロントエンド": ["liff", "ui"],
    "インフラ": ["deploy", "cloudflare"]
  },
  "milestone": "off",                  // "current"（期間内・未アーカイブの先頭）| "<名前>" | "off"
  "resolutionOnResolve": true,         // 処理済み遷移と同一 PATCH で完了理由「対応済み」を設定（id:0 対応済み）
  "summarize": "claude"                // 依頼文の LLM 整理（既定 ON。"off" で無効化）
}
```

- キーワードで決められない高度な判断（真の優先度・適切な担当者・カテゴリ）は、エージェント側が MCP `update_issue` で上書きします（skills/backlog-tracking のポリシー）。

### 依頼文の LLM 整理（summarize — 既定 ON）

原文プロンプトの貼り付けは読みにくいため、**依頼を「目的1行 + 箇条書き」へまとめ直して主役に**し、原文は課題説明の「元プロンプト」枠に残します:

- 課題説明: `## 依頼内容`（まとめ直し）/ `## 環境` / `## 元プロンプト`（原文）
- ターン要約コメント: `### 依頼` にまとめ直しを表示（整理に失敗した場合は原文の先頭 500 字へ自動フォールバック）

仕組みと注意:

- `claude -p --model haiku --max-turns 1` を**ターンごとに 1 回**呼びます（haiku 1 呼び出し相当の軽量なコスト）。**サブスクリプション認証（OAuth）のままで動作**し、`ANTHROPIC_API_KEY` は不要です。
- 再帰防止: 子プロセスには `BACKLOG_SYNC_IN_HOOK=1` が付与され、本ツールのフック CLI はこの環境変数があると即終了します（子の cwd も `os.tmpdir()` のためプロジェクトフックは発火しません）。
- 80 字未満の単文プロンプトは LLM を呼ばず原文をそのまま使います。`claude` CLI が無い環境・タイムアウト時も自動で原文フォールバックします（Codex セッションでは呼びません）。
- 無効化する場合は `fieldRules.summarize: "off"`。

## コマンドリファレンス

```
backlog-sync init [--vcs github|backlog|generic]
                                           # auth検証 / statusMap・課題種別・優先度・カテゴリ・バージョン・完了理由の解決
                                           # / VCS 自動検出（--vcs で上書き）/ project.json 書込
backlog-sync seed [--plan <file>] [--dry-run]
                                           # 現状の初回同期（plan は stdin でも可。dry-run はプレビューのみ）
backlog-sync hook <event>                  # フック用（stdin=イベントJSON）
                                           #   event: session-start | user-prompt-submit | post-tool | subagent-stop | stop | session-end
backlog-sync pull [--session <id>]         # 担当課題・新着コメントの差分取得（--session 指定でカーソル保存）
backlog-sync status                        # セッション⇄課題の対応・キュー/バッファ状況の一覧
backlog-sync flush [--session <id>]        # オフラインキューの手動排出
```

## 動作（セッションライフサイクル）

| フック | 動作 |
|---|---|
| `SessionStart`（startup のみ） | statusMap 読込 + 既存課題の再照合。同時に `pull` を実行し、**担当課題・新着コメントを additionalContext としてエージェントに注入** |
| `UserPromptSubmit` | 初回プロンプトで課題を作成（タイトル/説明はプロンプト由来。LLM 整理成功時は説明を「依頼内容/環境/元プロンプト」構成へ更新）。2 回目以降は依頼を記録して状態を「処理中」へ。ターン開始時の HEAD SHA も控える |
| `PostToolUse` | **ローカルバッファへ記録のみ**（ツール毎には投稿しない） |
| `SubagentStop` | コメントは投稿しません（冪等記録のみ）。サブエージェントの変更は親の `Stop` のターン要約に折り込まれます |
| `Stop` | ターン要約コメント（依頼 / 結果 / 変更ファイル・コミットのリンク）+ 状態遷移（処理済み）。送信前にキューへ耐久記録してから排出 |
| `SessionEnd` | オフラインキューの排出・後始末 |

- **遅延作成**: `SessionStart` が発火しない環境（`codex exec` 等）では、最初の `Stop` / `SubagentStop` 時に課題を遅延 find-or-create します。
- **インバウンド**: `pull` は `assigneeId=自分` + `updatedSince` カーソルで担当課題を、`minId` カーソルで新着コメントを差分取得します（取りこぼしなし・カーソルはセッション状態に保存）。
- **レート制御**: 更新系・検索系リクエストは ≥1 req/s に間隔制御。429 時は `X-RateLimit-Reset`（UTC epoch）まで待機して 1 回だけ再試行します。
- **非ブロッキング**: フックは `async` 起動・失敗しても exit 0。Backlog 障害時は操作をオフラインキューへ耐久記録し、`SessionEnd` / `flush` が排出します。**Backlog の障害でセッションは止まりません。**
- **冪等**: 冪等キーは `session_id` + `tool_use_id`（Claude Code）/ `turn_id`（Codex）。処理済み台帳で重複イベントを排除します。
- **コメントの住み分け**: フックの機械生成コメントは 🤖 マーカー付き。MCP 経由の意味的コメント（エージェントが「何を・なぜ」を書く）と重複しません。

## 状態ファイルの場所

フック実行時のルートディレクトリは次の優先順で決まります:

```
BACKLOG_SYNC_ROOT > CLAUDE_PROJECT_DIR > イベントの cwd
```

（CLI を直接実行した場合はカレントディレクトリ）。配下に以下を保存します:

| パス | 内容 |
|---|---|
| `.claude/state/<session_id>.json` | セッション⇄課題の対応・活動バッファ・オフラインキュー・pull カーソル |
| `.claude/backlog-agent-sync/project.json` | `init` が解決した statusMap / 課題種別 / 優先度 / カテゴリ / バージョン / 完了理由 / vcs / fieldRules |
| `.claude/backlog-agent-sync/seed-ledger.json` | seed の slug→課題キー台帳 |

`.gitignore` への追加を推奨します:

```gitignore
.claude/state/
.claude/backlog-agent-sync/
```

## Codex 利用時の注意

- **SessionEnd フックはありません**（Codex のフックイベントに存在しない）。オフラインキューの排出は `Stop` 時の drain と `backlog-sync flush` で代替します。
- **`codex exec`（非対話モード）では `SessionStart` が発火しません**。課題は最初の `Stop` 時に遅延作成されます。
- Codex のフックは command ハンドラのみのため、MCP の自動呼出はありません。意味的更新（チケット読解・状態遷移コメント）は `AGENTS.md` に追記されるポリシーがエージェントを誘導します。なお async フックは未サポート（設定すると警告付きスキップ）のため、フック定義に `async` は書きません。
- フックの trust（`trusted_hash`）は `install/install-codex.sh` が `config.toml` の `[hooks.state]` へ自動登録するため、手動の承認は不要です。フック定義を変更した場合はスクリプトを再実行してください。
- `PostToolUse` は一部のツール実行（unified_exec 系）を傍受しないため発火しないことがあります。活動記録が欠けても、`Stop` での集約サマリと遅延作成でカバーされます。

## 検証

- **ユニットテスト**: Vitest 93 件（normalize / 冪等 / レート制御・429 / adapter / seed / pull）

  ```bash
  npm install
  npm test
  npm run typecheck
  ```

- **E2E**: taskbrain の実 Backlog スペースで検証済み（課題作成の重複なし / 状態遷移 / 集約コメント / seed 再実行の冪等 / オフライン復帰後のキュー排出）

## License

MIT
