# G23改訂: seeding/逸脱発火/活動ノイズの修正 設計書

- 日付: 2026-06-21
- 状態: 設計確定(ユーザー承認済み・実装中)
- 親: docs/specs/2026-06-17-structured-bounded-issue-sync-design.md(G23)
- 契機: G23 デプロイ後、実セッション(TC-26)で「別作業へ移っても課題が分かれない・## タスク/進捗が空・活動が毎ターン増える」と判明。

## 根本原因(Phase1 で3並列調査・実測確定)

1. **(主因)`originalTask`/`activeIssueKey` が本番セッションで永久に未保存** — これらを書くのは `user-prompt-submit.ts` の `!st.issueKey` 初回ブロックのみ。だが**実際の課題作成は Stop の遅延 `ensureSessionIssue`(session-start.ts)経路**で、そこは `issueKey` しか書かない。フックは async のため以降のターンも初回ブロックを通らず、4フィールドは永久に undefined。**本番11セッション全て(TC-26含む)で欠落を実測**。
   - 帰結: 逸脱判定ガード(`getActiveIssue(st).key` = activeIssueKey 依存)が常に false → **`classifyDivergence`(Haiku判定)が一度も呼ばれない** → 別作業でも分割されない。`## タスク` も `originalTask` 空で空欄。
   - 補足: TC-26 の `initialPrompt` は `<task-notification>` の塊で原タスクに使えない。
2. **Haiku は無実**: claude -p はフック内(`BACKLOG_SYNC_IN_HOOK=1`)でも正常動作し、別トピックを `divergent` と正しく返す(実機確認、13〜19秒)。「再帰ガードで Haiku が使われない」仮説は反証。問題は到達しないこと+空入力で渡ること。
3. **活動ログ増加の最大要因 = status の毎ターン トグル(処理中⇄処理済み)=57件**。説明欄の毎ターン無条件 PATCH も加担(5件)。旧ターンコメント34件は凍結(新規増なし)。1ターンあたり約3件の活動ログを生成。

## 修正設計

### F1: originalTask/activeIssueKey の確実な seed + 既存セッション backfill
- **課題作成時(経路を問わず=`ensureSessionIssue` 含む)**に `originalTask` と `activeIssueKey` を設定する。`activeIssueKey = issueKey`。
- `originalTask` の導出: 「最初の**実ユーザープロンプト**」を採用。`<task-notification>`/`<system-reminder>` 等の非ユーザー由来ブロブは除外し、無ければ**課題の summary(件名)**へフォールバック。整形(前置き/巨大ブロブ除去)。
- **resume/既存セッションの自己修復**: `st.originalTask === undefined` を検出したら、次の UserPromptSubmit/issue確立時に backfill(課題の `## タスク` → 無ければ課題 summary → 無ければ当該プロンプト)。一度設定したら以後固定(independent 逸脱時のみ更新)。

### F2: 逸脱判定の確実な発火
- 逸脱検知のガードを **`activeIssueKey` 依存から `issueKey`(= 同期先課題が存在するか)ベース**へ変更。`activeIssueKey` 未設定でも `issueKey` があれば判定対象。
- `originalTask` が有効化されれば、2ターン目以降は毎プロンプトで `classifyDivergence`(既定 backend=claude-p/Haiku、失敗時決定論)が走り、別トピックは independent/child/sibling へ分割。
- 決定論の空入力 in_scope(deterministic.ts:95-96)は originalTask が入れば解消。

### F3: status トグル廃止(ユーザー決定)
- **作業中は `処理中` を維持**。`処理済み` へは**セッション/タスクが本当に完了したと判断したときのみ**遷移。毎ターンの 処理中⇄処理済み 往復を廃止。
- status は**実際に変化する場合のみ PATCH**(現在値と同じなら何もしない=Phase1の no-op skip と整合)。これで活動ログの最大増加源を停止。

### F4: 説明欄 PATCH の差分スキップ
- `updateIssueDescription` を**内容ハッシュ比較**でガード。前回と同一本文なら PATCH しない。state に最後に書いた説明のハッシュを保持。→ 説明変更ログの不要増加を抑制。

### F5: コメントの適正化 + legacy 整理(ユーザー決定)
- 今後: コメントは節目のみ(G23実装済み)。
- **legacy 整理**: 旧「`## ターン #N` / `🤖 ターン要約 #N`」形式の**ツール生成テキストコメントのみ**を削除(マーカー/定型見出しで識別)。**人間が書いたコメントは残す**。説明欄サマリへ一本化。`backlog-sync cleanup-comments <key> [--dry-run]`(or backfill 拡張)で提供。活動ログ(status/description 変更)は Backlog 仕様上削除不可。

## 検証(Before/After)
- Before(現状): TC-26 セッションで別作業→分割されない・## タスク空・活動増加。
- After: (1) 既存セッションが次ターンで originalTask を backfill し `## タスク` が埋まる (2) 別トピックのプロンプトで Haiku が divergent→別/親子課題に分割 (3) status トグルが止まり活動が毎ターン増えない (4) 説明欄が無変更ターンで PATCH されない (5) cleanup-comments で legacy ツールコメントが消える。
- 実機(TC)で Before/After をエビデンス付きで確認。worktree で作業。

## テスト
- F1: ensureSessionIssue 経路で originalTask/activeIssueKey が設定される。task-notification 除外・summary フォールバック・resume backfill。
- F2: issueKey ベースのガードで classifyDivergence が走る。originalTask 有効時に各分岐。
- F3: 完了時のみ resolved、作業中は in_progress 維持、同値 PATCH なし。
- F4: 同一説明はスキップ、変化時のみ PATCH。
- F5: ツール生成コメント識別と削除、人間コメント保持、dry-run。
