# セッション→課題の構造化・有界化 設計書

- 日付: 2026-06-17
- 状態: 設計確定(ユーザー承認済み・実装プラン作成前)
- 対象: backlog-agent-sync(Claude Code / Codex のセッションを Backlog 課題へ同期する公開ツール)
- 関連: G20(依頼の構造化要約・`claude -p` 導入)、G18(可読件名)、seed の epic マーカー

## 1. 背景と問題

1セッション=1課題・1ターン=1コメント追記という現行設計により、長いセッションでは1課題にコメントが無限増殖する(実例: TC-26 が74コメント=人間がレビューできる粒度ではない)。また、セッション中に当初タスクから別の作業へ逸脱しても同一課題に混在し続け、課題が「何の課題か」曖昧になる。さらに G20 の要約は `claude -p`(ヘッドレス)に依存しており、(a) Anthropic がサブスク枠からの分離を一度告知(2026-06-15 施行予定→当日凍結、無期限延期=再導入の可能性が残る)、(b) フック環境に `ANTHROPIC_API_KEY` が残っていると `claude -p` が**API従量課金**される実害(公開 issue で高額請求の実例)があり、サブスク依存として脆い。

## 2. ゴール / 非ゴール

### ゴール
- 1課題のコメントが無限に増えない(進捗は説明欄に集約、コメントは節目のみ)。
- セッション中の当初タスクからの逸脱を検知し、新しい作業を別課題として切り出す。
- 作業内容に応じて親子課題へ自動的に振り分ける(関連作業は親エポック配下の子に)。
- 課題も無限に増えない(単一タスクのセッションでは余計な課題を作らない)。
- LLM 判定を **Claude Code のサブスクリプション内で完結**させ、`claude -p` 依存を撤廃する。
- 判定モデルを導入時ダイアログでユーザーが選べる。

### 非ゴール
- 既存の肥大課題のコメントを削除・圧縮すること(履歴は残す。説明欄の現状サマリ補完のみ)。
- Codex セッションでの LLM 判定(本設計の主対象は Claude Code。Codex は決定論フォールバックで動作)。
- Backlog 以外のトラッカー対応。

## 3. 主要な設計決定(ユーザー合意済み)

| # | 論点 | 決定 |
|---|------|------|
| D1 | 進捗の見せ方 | 説明欄に進捗サマリを集約更新+コメントは節目のみ(ターン毎コメント廃止) |
| D2 | 逸脱検知 | LLM 自動判定。判定モデルは導入時に選択(haiku/sonnet/opus/fable/既定) |
| D3 | LLM 実行基盤 | `claude -p` を撤廃し、Claude Code ネイティブの `prompt`/`agent` フックで完結 |
| D4 | 親子構造 | 単一課題で開始→逸脱時に LLM が「子/共有親の兄弟/独立」を判断、関連時は親エポックを生成し再親子化 |
| D5 | サマリ生成 | `prompt` フックで知的生成(自由記述テキストが返せない場合は決定論的構造化へフォールバック) |
| D6 | オーケストレーション | 自然な境界で段階判定(UserPromptSubmit=逸脱判定 / Stop=サマリ更新・節目コメント)。最大2回/ターン |
| D7 | 既存課題の遡及 | 新挙動は今後のみ。既存の肥大課題は説明欄サマリを1回だけ補完(コメント削除なし) |

## 4. 全体アーキテクチャ

既存の「決定論フロア(フック=REST 直叩き)+ 意味 ceiling(Backlog MCP)」を維持しつつ、意味判定を抽象境界 **Judgment Service** に集約する。

```
[Claude Code セッション]
   │ UserPromptSubmit / Stop / SessionStart (フック)
   ▼
[決定論フロア] ── 状態/台帳管理・REST 直叩き(課題作成/親子化/説明更新/節目コメント)
   │ 文脈(原タスク・現サマリ・今回差分)を渡す
   ▼
[Judgment Service] ── インターフェース。出力 = {逸脱区分, 親子関係, 節目フラグ, 進捗サマリ}
   ├─ 主 backend: prompt/agent フック(サブスクモデル, model は init 選択)
   └─ 副 backend: 決定論(分類ヒューリスティック + 構造化サマリ組立。LLM 不使用)
```

**設計上の核心**: 「prompt フックが自由記述テキストを返せるか」「判定結果を決定論フロアへどう受け渡すか」という不確実性を、Judgment Service の境界内に隔離する。backend が要件を満たせない場合は副 backend(決定論)へ自動縮退し、フロアの挙動は変えない。

## 5. Judgment Service インターフェース

```ts
interface JudgmentInput {
  sessionId: string;
  originalTask: string;        // 課題の原タスク(初回プロンプト由来)
  currentSummary: string;      // 説明欄の現在の進捗サマリ
  turnPrompt?: string;         // 今回のユーザープロンプト(逸脱判定用)
  turnResult?: string;         // 今回の最終アシスタント回答(サマリ更新用)
  changedFiles?: string[];     // 変更ファイル(任意)
}

type Divergence =
  | { kind: "in_scope" }
  | { kind: "divergent"; relationship: "child" | "sibling" | "independent"; label: string };

interface JudgmentOutput {
  divergence?: Divergence;     // UserPromptSubmit フェーズで使用
  isMilestone?: boolean;       // Stop フェーズ: コメントすべき節目か
  progressSummary?: string;    // Stop フェーズ: 更新後の説明欄サマリ
}

interface JudgmentBackend {
  classifyDivergence(input: JudgmentInput): Promise<Divergence>;
  updateSummary(input: JudgmentInput): Promise<{ summary: string; isMilestone: boolean }>;
}
```

- **主 backend(prompt/agent フック)**: `classifyDivergence` は yes/no・分類(prompt フックが確実に得意)。`updateSummary` は自由記述生成(prompt フックで返せるか #1 スパイクで検証。不可なら副へ)。`model` は init 設定値。
- **副 backend(決定論)**: `classifyDivergence` = ヒューリスティック(新規トップレベルプロンプトの内容類似度・キーワード・プラン生成検知等)。`updateSummary` = 構造化組立(原タスク + 節目箇条書き + 最新状況を機械的に組む)。LLM 不使用。
- 選択は init で検出/設定。実行時に backend 失敗(タイムアウト・非対応)時も副へフォールバック。

## 6. セッション→課題ライフサイクル

### 6.1 アクティブ課題マッピング
- state に「セッション→現在アクティブな issueKey」を保持。1セッションが複数課題(親+子)を持ちうるため、`activeIssueKey` と `parentIssueKey?`、`childIssueKeys[]` を管理。
- 課題本文に `[[bas:session:<sid>]]` マーカー(既存)+ 親子関係マーカーを埋め、再照合に使う。

### 6.2 UserPromptSubmit(逸脱検知)
新プロンプト毎に `classifyDivergence` を呼ぶ:
- **in_scope** → 構造変更なし(同一アクティブ課題で継続)。
- **divergent / independent** → 新規独立課題を作成し `activeIssueKey` を切替。親子化しない。
- **divergent / child** → 現アクティブ課題の**子**を作成(`parentIssueId` = 現アクティブ課題)、`activeIssueKey` を子へ切替。
- **divergent / sibling** → 現アクティブ課題に親が無ければ**親エポックを生成**し、現アクティブ課題を子#1へ**再親子化**、新作業を子#2として作成。親が既にあれば子を追加。`activeIssueKey` を新しい子へ切替。

逸脱判定は誤検知でタスク乱立を招かないよう**保守的閾値**(明確な新トピックのみ divergent)。

### 6.3 Stop(進捗+節目)
- `updateSummary` を呼び、アクティブ課題の**説明欄**を更新(後述の構造)。
- `isMilestone` が真の節目(状態変更/完了/方針転換/分割発生/エラー)のみ**コメント**を1件投稿。それ以外はコメントしない。

## 7. 進捗の見せ方(有界化)

### 7.1 説明欄(現在地)
```
## タスク
<原タスク(初回プロンプト由来、簡潔化)>

## 進捗
- [完了] <節目1>
- [完了] <節目2>
- [進行中] <現フォーカス>

## 最新状況
<直近ターンの結果 1〜3行>

## 子課題
- TC-XX <ラベル>
- TC-YY <ラベル>
```
- **最新状況**: 毎ターン上書き(増えない)。
- **進捗**: 節目のみ追記(ターン単位では増えない)。長大化を避けるため上限行数を設け、超過時は古い完了項目を1行へ畳む。
- **子課題**: 親子化時に自動維持。

### 7.2 コメント(出来事)
- 節目(状態変更・完了・方針転換・分割・エラー)のみ。これによりコメント無限増殖を解消。
- 分割時は親/子双方に「分割: 親 TC-XX / 子 TC-YY <理由>」の1コメントを残し追跡可能にする。

## 8. 親子課題の実装(Backlog)

- TC は `subtaskingEnabled=true` 確認済み。子課題=作成時に `parentIssueId` 指定。
- **再親子化(既存課題を後から子化)**: REST `PATCH /issues/:id` で `parentIssueId` を設定できるかを **#2 スパイク**で確認。
  - 可能 → 設計どおり既存課題を子#1へ再親子化。
  - 不可 → 縮退: 親エポック生成「以降」の新作業のみ子化し、元課題は親の説明から相互リンク(再親子化はしない)。
- 親エポックの件名/説明は判定の `label` と原タスクから決定論的に生成。

## 9. サブスク堅牢化(claude -p 撤廃)

- G20 の `claude -p` 要約呼び出しを Judgment Service(prompt フック backend)へ置換。フック内サブプロセス起動・JSON パース・タイムアウト管理を撤去。
- **API キー混入ガード**: 起動時に `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` がフック環境に存在するかを検出し、存在時は「サブスクではなく API 従量課金になる恐れ」を1回警告(判定 backend はそもそも `claude -p` を呼ばないので直接の課金経路は無いが、利用者保護のため検出する)。
- `prompt`/`agent` フックは **SessionStart 非対応**・`agent` は **experimental**。よって SessionStart は従来 command フック(pull のみ)を維持し、判定は UserPromptSubmit / Stop に限定する。

## 10. キュー衛生(滞留 bug 修正)

今回の調査で判明した既存バグ(無害だが修正対象):
- **同値ステータス遷移 op のスキップ**: 現在値と同じ statusId への遷移 op は enqueue しない/drain で打たない(Backlog は同値 PATCH を code 7 で拒否し永久失敗する)。`isNoChangeError` 検出を seed 経路だけでなく drain 経路でも使う。
- **op.id 重複の解消**: 旧 `stop-status:<sid>`(turn サフィックス無し)が drain の id キー Map で潰し合い除去されない件を、id 一意化(turn/連番サフィックス必須化)+ drain の成否突合を index ベースに変更して解消。
- **max-attempts 上限**: 一定回数を超えた op は破棄し1回だけ警告(無限リトライ・state 肥大の防止)。

## 11. 導入ダイアログ(init)拡張

- 「逸脱検知・サマリ生成に使う判定モデル」を選択(haiku[既定・低コスト]/sonnet/opus/fable/default)。`project.json` の `judgment` ブロックに記録。
- 判定 backend(prompt フック or 決定論)を検出/選択。prompt フック非対応バージョンや Codex では決定論を既定にする。

## 12. 既存課題の遡及(ワンタイム補完)

- 新挙動は実装後の新ターンから適用。
- 既存の肥大課題向けに `backlog-sync backfill-summary <issueKey>`(仮)コマンドを提供: 既存コメントは**削除せず**、説明欄に現状サマリ(§7.1 構造)を1回だけ再構築する。判定 backend でサマリ生成(不可なら決定論)。

## 13. 実機スパイク(実装初手で確定)

| # | 検証項目 | 縮退方針 |
|---|----------|----------|
| S1 | `prompt` フックの判定結果を決定論フロアへ受け渡せるか / 自由記述テキストを返せるか | 不可なら: 分類は決定論ヒューリスティック、サマリは決定論構造化。もしくは意味 ceiling(メインモデルが Backlog MCP を呼ぶ)経路を検討 |
| S2 | REST `PATCH /issues/:id` で `parentIssueId` を後から設定可能か | 不可なら親生成以降の新作業のみ子化+相互リンク |
| S3 | `prompt`/`agent` フックが UserPromptSubmit / Stop で実際に発火し判定を返すか(対象 Claude Code バージョン) | 発火しないイベントは決定論にフォールバック |

スパイクは実装プランの最初のフェーズで実施し、結果を本設計に反映してから本実装へ進む。

### スパイク結果と方針確定(2026-06-18)
- **S2 = 可**: `PATCH /api/v2/issues/<key>` の `parentIssueId` で既存課題の後付け再親子化が可能(HTTP200・永続化・親フィルタ取得を実機確認)。§8 の縮退は不要。
- **S1/S3 = 不可**: `prompt` フックは発火するが判定結果を私たちのコードへ受け渡す経路が無い(allow/blockゲートとして内部消費)。追加検証した `agent` フックも subagent が read-only(Write/Bash不可)で state へ書き戻せない。**= フック経由のサブスク内LLM判定は不可能**。
- **確定方針(ユーザー承認)**: 判定 backend は「**ガード付き `claude -p` 側呼び出し + 決定論フォールバック**」。claude -p が判定結果を既知パスへ書き、決定論コードが読む。ガード: ①`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` 検出時は課金回避で claude -p を使わず決定論へ ②claude -p 失敗/タイムアウト/将来不可時も決定論へ自動フォールバック ③再帰ガード `BACKLOG_SYNC_IN_HOOK=1`。判定モデルは init で選択(haiku/sonnet/opus/fable/default)。Phase1の決定論 backend がフォールバック層。
- これに伴い §9 の「claude -p 撤廃」は「**ガード付き利用 + 決定論フォールバック**」へ更新(完全撤廃ではなく、安全に使えるときだけ使い、不可時は劣化動作)。G20 の既存 claude -p 要約は判定 backend へ統合。

## 14. エラー処理・テスト・分離

- **エラー処理**: 判定 backend のタイムアウト/失敗は副 backend へフォールバックし、同期自体は止めない(フロアの REST は best-effort、失敗は state にキューして次回 drain)。
- **テスト**: Judgment Service をインターフェース化しモック backend でユニットテスト。逸脱分類の各分岐(in_scope/child/sibling/independent)、説明欄構造の組立・有界化、親子化・再親子化、キュー衛生(no-op スキップ・id 一意・max-attempts)を網羅。後方互換(判定無効時=従来挙動)もテスト。
- **分離**: 本作業は backlog-agent-sync の **git worktree**(`feat/structured-issue-sync`)で実施。PR でマージ。

## 15. リスク・未解決

- S1(prompt フック受け渡し)が本設計の最大リスク。不可の場合、サマリの「知的生成」は決定論へ縮退し文面品質が下がる(機能は維持)。
- 逸脱判定の保守的閾値のチューニングは実データ(実セッション)での観察が必要。初期は保守寄り。
- Codex セッションでは prompt フック非対応のため決定論 backend で動作(逸脱検知精度は下がる)。

## 16. スコープ外(将来)

- 既存コメントの自動圧縮・削除。
- 兄弟課題間の依存関係(ブロック)自動設定。
- Backlog 以外のトラッカー対応。
