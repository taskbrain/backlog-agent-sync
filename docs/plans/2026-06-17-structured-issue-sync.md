# セッション→課題の構造化・有界化 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1課題のコメント無限増殖を解消し、セッション中のタスク逸脱を親子課題へ自動振り分けし、LLM判定を `claude -p` 非依存でサブスク内に収める。

**Architecture:** 決定論フロア(フック=REST直叩き)+ 抽象境界 Judgment Service(主=Claude Code `prompt` フック / 副=決定論フォールバック)+ 意味ceiling(Backlog MCP)。進捗は説明欄に集約、コメントは節目のみ。逸脱時にLLMが子/兄弟/独立を判定し親子課題化。

**Tech Stack:** TypeScript, vitest, Node(依存最小), Backlog API v2, Claude Code hooks(command/prompt/agent)。

**Spec:** `docs/specs/2026-06-17-structured-bounded-issue-sync-design.md`

**実行戦略:** Phase 0(スパイク)と Phase 1(スパイク非依存の基盤)は**並列実行可能**。Phase 0 の結果(S1/S2/S3)を本プランへ反映してから Phase 2(スパイク依存)を確定実装する。

---

## ファイル構成(作成/変更)

| ファイル | 責務 | フェーズ |
|---|---|---|
| `src/judgment/types.ts`(新) | JudgmentInput/Output/Backend インターフェース | 1 |
| `src/judgment/deterministic.ts`(新) | 決定論backend(分類ヒューリスティック+構造化サマリ) | 1 |
| `src/judgment/prompt-hook.ts`(新) | prompt フックbackend(S1/S3確定後) | 2 |
| `src/judgment/index.ts`(新) | backend選択(init設定/フォールバック) | 1→2 |
| `src/issue/description.ts`(新) | 説明欄(タスク/進捗/最新状況/子課題)の組立・有界化 | 1 |
| `src/issue/lifecycle.ts`(新) | 逸脱→子/兄弟/独立の課題操作・アクティブ課題マッピング | 2 |
| `src/state/store.ts`(変) | drain: no-opスキップ/id一意/index突合/max-attempts | 1 |
| `src/lifecycle/stop.ts`(変) | ターン毎コメント廃止→説明更新+節目コメント | 2 |
| `src/lifecycle/user-prompt-submit.ts`(変/新) | 逸脱判定の発火点 | 2 |
| `src/tracker/backlog-rest.ts`(変) | createChildIssue/setParent(PATCH)/updateDescription | 1(REST)→2(配線) |
| `src/config.ts` `src/types.ts`(変) | judgmentブロック(model/backend) | 1 |
| `src/cli.ts`(変) | init判定モデル選択 / backfill-summary コマンド | 1,2 |
| `spikes/`(新・一時) | スパイク用ハーネス(マージ前に削除 or docsへ要約) | 0 |

---

## Phase 0: スパイク(架構の前提検証・並列実行可)

### Task 0.1: S2 — Backlog で `parentIssueId` を後から設定できるか

**Files:**
- Create(一時): `spikes/s2-reparent.md`(結果記録)

- [ ] **Step 1: 既存課題で parentIssueId の現状を GET 確認**

`.env` を読み、`GET /api/v2/issues/TC-26?apiKey=...` で `parentIssueId` フィールドの有無を確認。

- [ ] **Step 2: テスト課題を2件作成(明示的にテストと分かる件名)**

`POST /api/v2/issues`(projectId=791973, issueTypeId=4236190, priorityId=3, summary="[SPIKE] reparent test parent" / "[SPIKE] reparent test child")。issueKey を記録。

- [ ] **Step 3: 子候補に parentIssueId を PATCH**

`PATCH /api/v2/issues/<child>` body `parentIssueId=<parentのissueId>`。HTTPステータス・レスポンス本文を記録。

- [ ] **Step 4: GET で親子関係が反映されたか検証**

`GET /api/v2/issues/<child>` で parentIssueId が設定されたか、`GET /api/v2/issues?parentIssueId[]=<parent>` で子が返るか確認。

- [ ] **Step 5: テスト課題を削除してクリーンアップ**

`DELETE /api/v2/issues/<child>` `DELETE /api/v2/issues/<parent>`(spikeが作成した課題のみ)。削除確認。

- [ ] **Step 6: 結果を spikes/s2-reparent.md に記録**

「PATCH parentIssueId 可否(可/不可)」+ レスポンス根拠。**不可なら**: Phase 2 の sibling/child 再親子化を「親生成以降の新作業のみ子化+相互リンク」へ縮退する旨を明記。

### Task 0.2: S1+S3 — `prompt` フックの発火と結果受け渡し

**Files:**
- Create(一時): `spikes/s1-prompt-hook/`(最小Claude Codeプロジェクト), `spikes/s1-prompt-hook.md`(結果)

- [ ] **Step 1: 最小プロジェクトに prompt フックを設定**

一時dirに `.claude/settings.json` を作り、`UserPromptSubmit` と `Stop` に `type:"prompt"` ハンドラ(`model:"haiku"`, `prompt` に「入力 $ARGUMENTS を分類し JSON で返せ」)を設定。比較用に `type:"command"` フックも併設し、command フックが受け取る stdin / 環境を記録するようにする。

- [ ] **Step 2: セッションを起動してフック発火を観測**

一時dir で `claude -p "テスト発話" </dev/null`(※スパイクの起動手段としてのみ `claude -p` を使用。本番では使わない)を実行し、(a) prompt フックが UserPromptSubmit/Stop で発火するか、(b) prompt フックの戻り(decision/JSON)がどこに出るか、(c) **prompt フックの結果が command フックや state ファイル経由で決定論フロアへ渡せるか**(additionalContext/環境変数/ファイル等)を観測・記録。

- [ ] **Step 3: 自由記述テキストの返却可否を確認**

prompt フックに「短い要約文(自由記述)を JSON フィールドで返せ」と指示し、decision 以外の自由記述フィールドが取得できるか確認。

- [ ] **Step 4: 結果を spikes/s1-prompt-hook.md に記録し、Phase 2 方針を確定**

判定: ①prompt フックが UserPromptSubmit/Stop で発火する(Yes/No) ②結果をフロアへ渡せる経路(あり/なし・方式) ③自由記述テキスト返却(可/不可)。
- ①または②が No → **縮退**: 逸脱分類・サマリ生成は決定論backend(Phase 1)で運用。prompt-hook.ts は作らないか、`additionalContext`+メインモデルがBacklog MCPを呼ぶ ceiling 経路を別途検討。
- ③が不可 → サマリ生成は決定論、分類のみ prompt フック。

- [ ] **Step 5: スパイクharnessを撤去**

`spikes/` 配下の一時プロジェクトを削除(結果 .md のみ残すか docs へ要約移設)。

---

## Phase 1: スパイク非依存の基盤(並列実行可・TDD)

### Task 1.1: drain で no-op ステータス遷移をスキップ

**Files:**
- Modify: `src/state/store.ts`(drain), `src/lifecycle/stop.ts`(enqueue時ガード), `src/tracker/backlog-rest.ts`(`isNoChangeError`参照)
- Test: `test/store-drain.test.ts`

- [ ] **Step 1: 失敗テストを書く** — 「現在statusと同値の update_issue op は drain で打たれずスキップ(成功扱いで除去)される」ことを検証。`backlog-rest` をモックし、同値遷移opを与えると `updateIssue` が呼ばれずキューから消えることをアサート。
- [ ] **Step 2: テスト実行で失敗確認** — `npx vitest run test/store-drain.test.ts`(現状は更新を試みるので失敗)。
- [ ] **Step 3: 実装** — drain で op が status遷移かつ「opの目標statusId == 既知の現在statusId」なら REST を呼ばず除去。現在statusId は state の lastStatus か、必要なら drain前に1度 GET。`isNoChangeError`(seed/apply.ts既存)を drain 経路でも捕捉し、code7 を成功(除去)扱いに。
- [ ] **Step 4: テスト通過確認** — `npx vitest run test/store-drain.test.ts`。
- [ ] **Step 5: コミット** — `git commit -m "fix(store): no-op ステータス遷移を drain でスキップ(code7永久失敗の解消)"`。

### Task 1.2: op.id 一意化 + index ベース突合 + max-attempts

**Files:**
- Modify: `src/state/store.ts`(drain結果突合), `src/lifecycle/stop.ts`(id採番)
- Test: `test/store-drain.test.ts`

- [ ] **Step 1: 失敗テスト** — (a) 同一idのopが複数あっても各々個別に成否判定・除去される(index突合) (b) attempts が上限(例:5)を超えたopは破棄され1回警告 — を検証。
- [ ] **Step 2: 失敗確認** — `npx vitest run`。
- [ ] **Step 3: 実装** — drain の成否を `op.id` キー Map ではなく**配列index**で突合。stop-status の id 採番に turn/連番サフィックスを必須化(無サフィックス禁止)。`maxAttempts`(既定5)超過opは drop+`warn` 1回。
- [ ] **Step 4: 通過確認** — `npx vitest run`。
- [ ] **Step 5: コミット** — `git commit -m "fix(store): drainのid重複潰し合いをindex突合で解消+max-attempts上限"`。

### Task 1.3: Judgment Service インターフェース + 決定論backend

**Files:**
- Create: `src/judgment/types.ts`, `src/judgment/deterministic.ts`, `src/judgment/index.ts`
- Test: `test/judgment-deterministic.test.ts`

- [ ] **Step 1: 型を定義**(spec §5 の `JudgmentInput`/`Divergence`/`JudgmentOutput`/`JudgmentBackend` を `types.ts` に転記)。
- [ ] **Step 2: 失敗テスト** — 決定論 `classifyDivergence`: 同一トピック継続→`in_scope`、明確な新トピック(キーワード/低類似度)→`divergent`(関係は保守的に independent 既定)。`updateSummary`: 入力から「## タスク/## 進捗/## 最新状況」構造を組み、最新状況を上書き、節目検出(状態語/完了語)で `isMilestone`。
- [ ] **Step 3: 失敗確認** — `npx vitest run test/judgment-deterministic.test.ts`。
- [ ] **Step 4: 実装** — `deterministic.ts` に `classifyDivergence`(語彙重なり/Jaccard 等の軽量類似度+保守閾値)と `updateSummary`(`src/issue/description.ts` を利用)。`index.ts` は backend を返す(Phase 1では決定論固定、Phase 2でprompt-hook選択を追加)。
- [ ] **Step 5: 通過確認** — `npx vitest run`。
- [ ] **Step 6: コミット** — `git commit -m "feat(judgment): Judgment Service IF+決定論backend"`。

### Task 1.4: 説明欄ビルダー(構造化・有界化)

**Files:**
- Create: `src/issue/description.ts`
- Test: `test/issue-description.test.ts`

- [ ] **Step 1: 失敗テスト** — `buildDescription({originalTask, progress[], latest, children[]})` が「## タスク/## 進捗/## 最新状況/## 子課題」を生成。`appendMilestone` で進捗に1行追加、上限超過で古い完了項目を畳む(有界)。最新状況は常に1ブロック上書き。子課題リンクの整形。
- [ ] **Step 2: 失敗確認** — `npx vitest run test/issue-description.test.ts`。
- [ ] **Step 3: 実装** — `description.ts`。markdown/Backlog記法は既存 `markup.ts` を利用(textFormattingRule準拠)。進捗上限(例:20行)超過で最古完了をまとめる。
- [ ] **Step 4: 通過確認** — `npx vitest run`。
- [ ] **Step 5: コミット** — `git commit -m "feat(issue): 説明欄の構造化ビルダー(進捗有界化)"`。

### Task 1.5: init 判定モデル設定 + REST 親子/説明メソッド

**Files:**
- Modify: `src/config.ts`, `src/types.ts`(judgmentブロック), `src/cli.ts`(init), `src/tracker/backlog-rest.ts`
- Test: `test/config.test.ts`, `test/backlog-rest.test.ts`(モック)

- [ ] **Step 1: 失敗テスト(config)** — project.json の `judgment:{model, backend}` を読み込み・既定(model="haiku", backend="auto")を返す。
- [ ] **Step 2: 失敗テスト(rest)** — `createIssue` が `parentIssueId` を渡せる、`updateDescription(issueKey, body)` が PATCH を出す(モックで検証)。`setParent` は Task 0.1 の結果次第で実装(可なら PATCH parentIssueId、不可ならスタブ+警告)。
- [ ] **Step 3: 失敗確認** — `npx vitest run test/config.test.ts test/backlog-rest.test.ts`。
- [ ] **Step 4: 実装** — config に judgment 追加。init の対話に「判定モデル選択(haiku/sonnet/opus/fable/default)」を1問追加(既存init対話のスタイル踏襲)。backlog-rest に親子・説明更新メソッド。
- [ ] **Step 5: 通過確認** — `npx vitest run`。
- [ ] **Step 6: コミット** — `git commit -m "feat(init): 判定モデル選択+REST親子/説明更新メソッド"`。

---

## Phase 2: スパイク依存(Phase 0 確定後に本プランを更新してから実装)

> **スパイク確定(2026-06-18):** S2=可(PATCH parentIssueId で後付け再親子化OK→縮退不要)。S1/S3=不可(prompt/agent フック共に判定結果をコードへ受け渡せない)。**確定方針(ユーザー承認): 判定 backend = ガード付き `claude -p` 側呼び出し + 決定論フォールバック**(API_KEY検出時/失敗時は決定論へ、再帰ガード `BACKLOG_SYNC_IN_HOOK=1`、判定モデルは init 選択)。よって Task 2.1 は「guarded claude -p backend」を実装、Task 2.4 は「claude -p 撤廃」ではなく「ガード付き利用+API_KEY警告+G20統合」とする。Task 2.2 の再親子化は縮退不要。

### Task 2.1: prompt フック backend(S1/S3 が Yes の場合)

**Files:** Create `src/judgment/prompt-hook.ts`、Modify `src/judgment/index.ts`、`.claude` フック設定テンプレート, `install/*`。
- [ ] S1/S3 の findings に基づき `classifyDivergence`(prompt フック分類)を実装。`updateSummary` は S3 可なら prompt フック、不可なら決定論へ委譲。backend 選択を `index.ts` に追加(judgment.backend と発火可否で決定)。テスト=モックでフック入出力契約を検証。コミット。
- [ ] **S1/S3 が No の場合:** 本タスクはスキップし、`index.ts` は決定論backend固定。その旨を spec/plan に追記。

### Task 2.2: ライフサイクル — 逸脱→子/兄弟/独立

**Files:** Create `src/issue/lifecycle.ts`、Modify `src/lifecycle/user-prompt-submit.ts`, `src/state/*`(activeIssueKey/parent/children マッピング)。
- [ ] 失敗テスト → 実装 → 通過 → コミット。`classifyDivergence` 結果で: independent=新規独立課題、child=現課題の子(`parentIssueId`=現)、sibling=親エポック生成+現課題を子#1へ(Task 0.1 可なら再親子化、不可なら縮退)+新作業を子#2。`activeIssueKey` 切替。マーカー `[[bas:session:<sid>]]`+親子マーカーを本文へ。分割時は親子双方に分割コメント1件。保守的閾値で乱立防止。

### Task 2.3: Stop — ターン毎コメント廃止→説明更新+節目コメント

**Files:** Modify `src/lifecycle/stop.ts`。
- [ ] 失敗テスト → 実装 → 通過 → コミット。Stop で `updateSummary` を呼びアクティブ課題の説明欄を更新(`description.ts`)。`isMilestone` の節目のみコメント投稿。従来のターン毎 `add_comment` を撤去。activityBuffer は説明更新の材料に集約。

### Task 2.4: サブスク堅牢化 — claude -p 撤廃 + APIキー混入ガード

**Files:** Modify G20 要約呼び出し箇所(`src/lifecycle/*` の `claude -p` 起動), `src/*`(起動時チェック)。
- [ ] 失敗テスト → 実装 → 通過 → コミット。G20 の `claude -p` 起動を Judgment Service 経由へ置換・該当コード削除。起動時に `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` がフック環境に存在すれば1回警告(従量課金リスク告知)。

### Task 2.5: backfill-summary コマンド(既存課題の遡及補完)

**Files:** Modify `src/cli.ts`。
- [ ] 失敗テスト → 実装 → 通過 → コミット。`backlog-sync backfill-summary <issueKey>`: 既存コメントは削除せず、`description.ts`+判定backendで現状サマリを1回だけ説明欄へ再構築。dry-run対応。

---

## 仕上げ

- [ ] 全テスト緑(`npx vitest run`)・`npx tsc --noEmit`・`npm run build` 緑。
- [ ] 独立レビュー(reviewer)で後方互換・サブスク非依存・親子化の安全性を検証。
- [ ] 実機検証: AISNS で新セッションを1本流し、(a)説明欄に進捗集約 (b)ターン毎コメントが出ない (c)逸脱で子課題化 (d)claude -p 不使用 を確認。既存 TC-26 で `backfill-summary` を dry-run→apply。
- [ ] PR 作成 → main マージ → worktree 撤去 → メモリ更新(G22 同様)。

## 自己レビュー(spec網羅チェック)

- D1 進捗集約+節目コメント → Task 1.4/2.3 ✓
- D2 逸脱LLM判定+モデルinit選択 → Task 1.5/2.1 ✓
- D3 claude -p撤廃 → Task 2.4 ✓
- D4 親子(子/兄弟/独立)+再親子化 → Task 2.2(+0.1) ✓
- D5 サマリ生成(prompt/決定論) → Task 1.3/2.1 ✓
- D6 段階判定(UPS/Stop) → Task 2.2/2.3 ✓
- D7 既存遡及補完 → Task 2.5 ✓
- §10 キュー衛生 → Task 1.1/1.2 ✓
- §13 スパイク → Phase 0 ✓
