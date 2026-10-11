# Agent Orchestration

## 位置づけと優先順位

この文書は、ChatGPT（ちゃ）・Codex（こでさん）・Claude Code（くろちゃん）がGitHub上の最新指示と完了報告を共有するための運用正本です。

- `PROJECT_RULES.md` を最優先とする。
- `AGENTS.md` / `CLAUDE.md` の開始手順にも従う。
- `.agent/` は共有タスク運用専用。既存の別用途handoff文書は勝手に置き換えない。
- 通常の実装主担当はClaude Code。Claude実装枠はG1〜G10の10枠。
- Codexは通常、レビュー・バグ修正・検証を担当。Codex枠はH1〜H5の5枠。
- 全体はCodex 5枠＋Claude 10枠の全15枠。
- Claudeが5時間利用制限に到達した場合など必要時に限り、ChatGPTの判断でCodexへ臨時実装を割り当ててよい。
- 並行作業はtask_idと変更対象が安全に分離されている場合だけ許可する。

### 固定ルーティング（2026-09-24〜）

- `G1` / `G2`: かぶモリアプリ（モバイルアプリ本体）開発
- `G3` / `G4`: X自動投稿アプリ開発
- `G5`〜`G10`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。idleだからという理由だけで自動使用しない。
- ユーザーから個別TASKについて明示指示がある場合はその指示を優先する。
- Codex（H1〜H5）はアプリ・固定プロジェクト専用にしない。原則レビュー・バグ修正・検証を担当する。

### スロット拡張（2026-10-11〜）

- H3〜H5（Codex）とG6〜G10（Claude）を未割当テンプレートとして追加し、全15枠にした。新規枠の初期値は `task_id: none` / `status: idle` / `next_owner: none` / `recommended_model: none`。
- 目的は、これまでTASKを置かずに直接指示で使っていた作業も、明示割当でTASKを置くことで今後 `F` からすべて把握できるようにすること。TASKを置かない直接指示は `F` の確認対象に入らない。
- 既存H1/H2・G1〜G5のTASK / Report / 履歴は保護する。拡張を理由に既存TASKの本文・status・割当を変更しない。

## タスク正本

- Codex H1: `.agent/tasks/CODEX_TASK.md` / `.agent/CODEX_REPORT.md`
- Codex H2: `.agent/tasks/CODEX_TASK_2.md` / `.agent/CODEX_REPORT_2.md`
- Codex H3: `.agent/tasks/CODEX_TASK_3.md` / `.agent/CODEX_REPORT_3.md`
- Codex H4: `.agent/tasks/CODEX_TASK_4.md` / `.agent/CODEX_REPORT_4.md`
- Codex H5: `.agent/tasks/CODEX_TASK_5.md` / `.agent/CODEX_REPORT_5.md`
- Claude G1: `.agent/tasks/CLAUDE_TASK_1.md`（ReportはTASK内）
- Claude G2: `.agent/tasks/CLAUDE_TASK.md`（ReportはTASK内）
- Claude G3: `.agent/tasks/CLAUDE_TASK_3.md`（ReportはTASK内）
- Claude G4: `.agent/tasks/CLAUDE_TASK_4.md`（ReportはTASK内）
- Claude G5: `.agent/tasks/CLAUDE_TASK_5.md`（ReportはTASK末尾の `## Report`）
- Claude G6: `.agent/tasks/CLAUDE_TASK_6.md`（ReportはTASK末尾の `## Report`）
- Claude G7: `.agent/tasks/CLAUDE_TASK_7.md`（ReportはTASK末尾の `## Report`）
- Claude G8: `.agent/tasks/CLAUDE_TASK_8.md`（ReportはTASK末尾の `## Report`）
- Claude G9: `.agent/tasks/CLAUDE_TASK_9.md`（ReportはTASK末尾の `## Report`）
- Claude G10: `.agent/tasks/CLAUDE_TASK_10.md`（ReportはTASK末尾の `## Report`）

`.agent/ACTIVE_TASK.md` は全15枠の索引、`.agent/CURRENT_STATE.md` は短い現在地として扱う。詳細指示と割当の正本は各TASK/Report。

## 役割

### Claude Code（くろちゃん）

通常の新機能開発・大規模変更・継続実装を担当する。基本ルーティングではG1〜G4を使い、予備のG5〜G10は明示割当時だけ使用する。

### Codex（こでさん）

H1〜H5は固定プロジェクト専用にしない。通常は以下を担当する。

- Claude実装後のコードレビュー
- バグ調査・修正
- テスト追加、不足テスト確認、回帰確認
- DB / API / RPC / Edge Function境界の確認
- Auth / Security・権限・境界条件の確認
- deploy前確認
- 実装内容と仕様の整合性確認

Claudeの5時間制限時など必要時だけ、ChatGPTがH1〜H5へ「臨時実装」と明記したTASKを置ける。その場合、対象範囲・安全制約・完了条件もTASKへ明記する。

### ChatGPT（ちゃ）

全体オーケストレーションを担当する。

- 実装タスクをG1〜G4へ安全に分割し、予備のG5〜G10へは明示割当した場合のみ置く
- スロット間の競合を避ける
- 実装の節目と変更リスクからCodexレビューの要否を判断する
- 必要な場合、未割当のH1〜H5へ具体的なレビュー/バグ修正TASKを作る
- Codex結果を確認し、必要ならClaudeへ修正を戻す
- production反映前の確認工程を組み立てる

レビューを検討する代表的な節目:
- 機能単位の実装完了
- DB schema / migration / RPC / Edge Function変更
- API・外部サービス境界変更
- 認証・権限・セキュリティ変更
- 複数ファイル・複数レイヤーにまたがる大きな変更
- 重要バグ修正後
- production deploy前
- 回帰リスクが高い変更後

固定条件ではない。軽微・低リスク変更では省略でき、高リスク変更では途中でもレビューを入れられる。

レビューTASKには対象branch/commit/PR、目的、重点確認事項、安全制約、必要な検証、完了条件を記載する。H1〜H5のTASKには冒頭ヘッダーに `return_to` と `completion_code` も必ず記載する（「Codex完了後の返却先（2026-10-07〜）」参照）。どの枠でも割当時には推薦モデルを必ず設定する（「モデル運用」参照）。既存TASKを上書きしてはならない。

## 作業開始コード

### G1〜G10 — Claude

- `G1`: `.agent/tasks/CLAUDE_TASK_1.md`
- `G2`: `.agent/tasks/CLAUDE_TASK.md`
- `G3`: `.agent/tasks/CLAUDE_TASK_3.md`
- `G4`: `.agent/tasks/CLAUDE_TASK_4.md`
- `G5`: `.agent/tasks/CLAUDE_TASK_5.md`（明示割当済みで `ready` / `in_progress` の場合のみ開始）
- `G6`: `.agent/tasks/CLAUDE_TASK_6.md`（明示割当済みで `ready` / `in_progress` の場合のみ開始）
- `G7`: `.agent/tasks/CLAUDE_TASK_7.md`（明示割当済みで `ready` / `in_progress` の場合のみ開始）
- `G8`: `.agent/tasks/CLAUDE_TASK_8.md`（明示割当済みで `ready` / `in_progress` の場合のみ開始）
- `G9`: `.agent/tasks/CLAUDE_TASK_9.md`（明示割当済みで `ready` / `in_progress` の場合のみ開始）
- `G10`: `.agent/tasks/CLAUDE_TASK_10.md`（明示割当済みで `ready` / `in_progress` の場合のみ開始）

Claudeに単独で `G` が来た場合、G1〜G10のready/in_progressの開始可能枠が1つだけと明白なら開始してよい。G5〜G10も明示割当済みの場合だけ候補に含める。複数なら推測せずG1〜G10の指定を求める。

### H1〜H5 — Codex

- `H1`: `.agent/tasks/CODEX_TASK.md`
- `H2`: `.agent/tasks/CODEX_TASK_2.md`
- `H3`: `.agent/tasks/CODEX_TASK_3.md`
- `H4`: `.agent/tasks/CODEX_TASK_4.md`
- `H5`: `.agent/tasks/CODEX_TASK_5.md`

H1〜H5は原則レビュー・バグ修正・検証用。TASKに「臨時実装」と明記されている場合だけ実装担当として作業してよい。

### 共通開始条件

開始前に `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、自分のTASK、Git状態を確認し、必要に応じて`origin/main`をfresh-checkする。

statusが`ready`または`in_progress`のTASKだけ開始する。`idle` / `done` / `review_required`では開始しない。

新しいTASKは「未割当」であることが明確な枠だけに置く。全15枠とも、`idle`などstatusだけを空き判定に使わない。task_id、既存TASK本文、Report、next_ownerも確認し、既存割当を保護する。曖昧なら上書きせず停止する。

### Mac移行後のローカル開発基準（2026-10-05〜）

- 新Macで新規slotを開始するときの clean base は `/Users/yuya/Developer/kabumori-fresh`。
- 旧 `/Users/yuya/Developer/kabumori` は既存worktree保護のため保持し、新規slotのbaseには使わない。
- 既存worktreeは対応TASK完了まで継続可。旧repo / 旧worktreeの削除・rename・prune・resetは禁止。
- 新規slotは `kabumori-fresh` の fresh `origin/main` から専用の独立worktree / checkoutを作成する。`kabumori-fresh` 本体を複数slotで共有しない。
- 開始コードと完了コードの意味は変更なし。2026-10-11追加のH3〜H5 / G6〜G10も同じclean base・独立worktree / checkoutルールに従う。

## 完了確認コード

### C1〜C5 — Codex

- `C1`: H1だけを確認（`.agent/tasks/CODEX_TASK.md` / `.agent/CODEX_REPORT.md`）
- `C2`: H2だけを確認（`.agent/tasks/CODEX_TASK_2.md` / `.agent/CODEX_REPORT_2.md`）
- `C3`: H3だけを確認（`.agent/tasks/CODEX_TASK_3.md` / `.agent/CODEX_REPORT_3.md`）
- `C4`: H4だけを確認（`.agent/tasks/CODEX_TASK_4.md` / `.agent/CODEX_REPORT_4.md`）
- `C5`: H5だけを確認（`.agent/tasks/CODEX_TASK_5.md` / `.agent/CODEX_REPORT_5.md`）
- 単独`C`は使用しない

対象TASK、対応Codex Report、必要な範囲のCURRENT_STATEを確認し、レビュー内容、修正内容、テスト、commit/push/deploy、残課題、安全確認を評価する。他スロットを勝手に完了処理しない。

`C1`〜`C5` をどのちゃの部屋へ送るかは、対応するH TASKの `return_to` で決まる（「Codex完了後の返却先（2026-10-07〜）」参照）。

### K1〜K10 — Claude

- `K1`: G1
- `K2`: G2
- `K3`: G3
- `K4`: G4
- `K5`: G5のみ。`.agent/tasks/CLAUDE_TASK_5.md` と同TASK末尾の `## Report` を確認
- `K6`: G6のみ。`.agent/tasks/CLAUDE_TASK_6.md` と同TASK末尾の `## Report` を確認
- `K7`: G7のみ。`.agent/tasks/CLAUDE_TASK_7.md` と同TASK末尾の `## Report` を確認
- `K8`: G8のみ。`.agent/tasks/CLAUDE_TASK_8.md` と同TASK末尾の `## Report` を確認
- `K9`: G9のみ。`.agent/tasks/CLAUDE_TASK_9.md` と同TASK末尾の `## Report` を確認
- `K10`: G10のみ。`.agent/tasks/CLAUDE_TASK_10.md` と同TASK末尾の `## Report` を確認

対応TASK内のReportと必要な範囲のCURRENT_STATEを確認する。TASK完了条件、実装、テスト、commit/push/deploy、残課題、他スロット影響を評価し、Codexレビューが必要かChatGPTが判断する。

単独`K`は、G1〜G10の未評価の完了対象Claude枠が1つだけと明白な場合だけ使用する。複数ならK1〜K10を指定する。

#### 会社員AIラボ開発日記の更新判定（K1〜K10 共通・必須）

K1〜K10 のどの完了確認でも、ChatGPT（ちゃ）は上記の評価に加えて、必ず次を判定する。ユーザーから毎回「開発メモを更新して」と指示されることを前提にしない。

- 判定: その作業内容に、会社員AIラボの「今日の個人開発」として外部公開してよい開発内容があり、開発日記共有メモへ残す価値があるか。
- 題材として優先するもの: 新しく作った機能、UI改善、バグ修正、開発中に分かったこと、AIとの開発で試したこと、テストや確認で苦労したこと、個人開発上の工夫、仕様変更や設計改善。単なる内部作業ログではなく、「非エンジニア会社員がAIと個人開発している日記」の題材になるものを優先し、外部公開して安全な粒度へ要約する。
- 判定結果は、そのKの完了記録（`.agent/CURRENT_STATE.md` の Final K 項目）に1行で残す。記録不要の場合も残す。
  - 記録価値あり: `- AI Lab diary: 候補あり — <外部公開してよい1〜2文の要約>`
  - 記録不要: `- AI Lab diary: 記録不要 — <短い理由>`
- 候補の要約と日記本文には、次を絶対に含めない: branch名、TASK ID、commit hash、PR番号、内部URL、email、token / JWT、password / secret、Authorization header、DB table名、RPC名、Edge Function内部名、Vault情報、production security情報、raw `.agent` 内容、その他攻撃面や内部構造を不必要に公開する情報。既存のdiary sanitizer / safetyルールは弱めない。
- 記録価値ありの場合の反映:
  - 共有メモの正本は `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`。通常のK1〜K10では、ChatGPT（ちゃ）がFinal Kに残した公開安全な候補だけを使い、実際の作業日付でこのMarkdownへ直接追記する。通常の日記更新のためにG3 / G4を消費しない。
  - ChatGPTが通常の日記更新で直接編集してよいのは上記Markdown正本だけ。生成物 `ai_lab_dev_diary_context.snapshot.ts` は直接編集しない。
  - Markdownのmain push後は `.github/workflows/ai-lab-diary-snapshot.yml` が自動でcanonical generatorを実行し、snapshotを再生成する。workflowはparity / freshness・calendar-date / sanitizer・関連brand regressionを検証し、すべてPASSした場合だけ生成snapshotをmainへfast-forwardでcommitする。
  - workflowはMarkdown正本だけをtrigger対象とし、snapshotだけのbot commitでは再起動しない。raceやテスト失敗時はfail-closedでpushせず、既存内容を上書きしない。
  - workflow失敗時はChatGPTがFinal KまたはCURRENT_STATEに失敗を記録する。コードやworkflowの修理が必要な場合だけ、本当に空いているG3 / G4へ修正TASKを作る。単なる通常の日記追記ではTASKを作らない。
  - 自動workflowはproduction deploy、scheduler invoke、X投稿、DB / RLS / RPC / Auth / Vault / Cron / settings / secret変更を行わない。新しいsnapshotをproductionへ反映する必要がある場合は、従来のaccepted commit固定・isolated directory・single target・read-backを使う別のproduction gateとして扱う。
  - 日記エントリは直近数日分だけが自動投稿の題材になる。古い候補を反映するために、実施日を偽って新しい日付で書かない。
- この判定は、Codexレビュー要否の判断とは独立して毎回行う。

### F — 全体統括

`F`は特定タスクの完了コードではない。Codex 5枠＋Claude 10枠の**全15枠**を対象に、必ず以下を確認する。

- `.agent/ACTIVE_TASK.md`
- `.agent/CURRENT_STATE.md`
- H1〜H5のTASK（`.agent/tasks/CODEX_TASK.md`、`CODEX_TASK_2.md`〜`CODEX_TASK_5.md`）
- H1〜H5のReport（`.agent/CODEX_REPORT.md`、`CODEX_REPORT_2.md`〜`CODEX_REPORT_5.md`）
- G1〜G10のTASK（`.agent/tasks/CLAUDE_TASK_1.md`、`CLAUDE_TASK.md`、`CLAUDE_TASK_3.md`〜`CLAUDE_TASK_10.md`）と各TASK末尾（またはTASK内）の `## Report`

全15枠について、最低限次を整理する。

- slot / status / task_id / owner / next_owner
- return_to（H枠）
- completion_code（H枠は `C1`〜`C5`、G枠は対応する `K1`〜`K10`）
- 実際の空き状況（statusだけで判断せず、task_id・TASK本文・Report・next_ownerから判断）
- 作業中（`ready` / `in_progress`）
- 完了確認待ち・`review_required`
- deploy待ち
- blocker
- 競合（同じファイル・DB migration/RPC・Edge Function・workflow・production設定・API境界など）
- worktree / checkout分離状況（分かる範囲）
- 次工程

H1〜H5については、Codex作業中（`ready` / `in_progress`）か、完了して `C1`〜`C5` の確認待ち（`review_required`）か、どのちゃへ返すべきかを示す。`return_to` が欠落・不明・矛盾している場合や `completion_code` が自枠と不一致の場合は「返却先未確定」と表示し、推測で補わない。

`F`は整理と提案だけを行う。別チャット担当の個別TASKを文脈なしに完了扱い・再割当したり、次工程へ進めたりしない。

## 完了報告のGitHub同期

作業終了・停止時は自分のスロットのTASK/Reportだけを更新し、可能な場合はGitHubへ同期する。

- H1: `.agent/tasks/CODEX_TASK.md` + `.agent/CODEX_REPORT.md`
- H2: `.agent/tasks/CODEX_TASK_2.md` + `.agent/CODEX_REPORT_2.md`
- H3: `.agent/tasks/CODEX_TASK_3.md` + `.agent/CODEX_REPORT_3.md`
- H4: `.agent/tasks/CODEX_TASK_4.md` + `.agent/CODEX_REPORT_4.md`
- H5: `.agent/tasks/CODEX_TASK_5.md` + `.agent/CODEX_REPORT_5.md`
- G1〜G10: 各TASK末尾の`## Report`

Reportにはtask_id、result、changed_files、tests、commit_hash、push、deploy、remaining_issues、safety_checks、next_recommendationを含める。H1〜H5のReportには、加えて `return_to` と `completion_code`（未確定の場合はその旨と理由）を含める。既存Reportの履歴は削除・改変しない。

実装コードを安全にpushできない場合でも、他workstreamの変更を混ぜず、clean worktree等の安全な方法で自分の制御ファイルだけを同期できるか検討する。non-fast-forwardや同じ制御ファイルの競合があれば上書きせず停止する。

## Codex完了後の返却先（2026-10-07〜）

H1〜H5の完了後に、ユーザーが `C1`〜`C5` をどのちゃの部屋へ送ればよいか迷わないようにするための運用詳細（2026-10-11にH3〜H5へ拡張）。方針の正本は `PROJECT_RULES.md` の同名節。

### TASK作成時（ChatGPT）

- ChatGPTはH1〜H5へ新しいTASK（レビュー・バグ修正・検証。臨時実装を含む）を作る時点で、TASK冒頭のヘッダーに必ず `return_to` と `completion_code` を記入する。空欄や後で埋める前提のプレースホルダのまま置かない。
- `return_to`: ユーザーが実際に戻るチャットを判別できる人間向け名称。G番号だけ（例: `G1`）にしない。原則として、そのレビュー・バグ修正・検証を依頼した元チャット（結果を `C1`〜`C5` で確認する部屋）を書く。
  - 例: `かぶモリアプリG1のちゃ` / `かぶモリアプリG2のちゃ` / `X自動投稿アプリG3のちゃ` / `X自動投稿アプリG4のちゃ` / `共通アカウントG5のちゃ` / `MICのちゃ` / その他、実際にレビュー依頼を出した元チャットの名称
- `completion_code`: 各枠に1対1で固定する。その他の値は使わない。

| 枠 | TASK | completion_code |
| --- | --- | --- |
| H1 | `.agent/tasks/CODEX_TASK.md` | `C1` |
| H2 | `.agent/tasks/CODEX_TASK_2.md` | `C2` |
| H3 | `.agent/tasks/CODEX_TASK_3.md` | `C3` |
| H4 | `.agent/tasks/CODEX_TASK_4.md` | `C4` |
| H5 | `.agent/tasks/CODEX_TASK_5.md` | `C5` |

- 未割当枠だけを使う・既存TASKを上書きしない・推薦モデル必須などの既存ルールは変わらない。

ヘッダー記入例（H1）:

```text
# Codex Task H1 — CURRENT TASK

- task_id: <task_id>
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- recommended_model: <推薦モデル>
- return_to: かぶモリアプリG1のちゃ
- completion_code: C1
```

H2〜H5では `slot: codex-2`〜`codex-5`、`completion_code: C2`〜`C5` とし、`return_to` には依頼元（例: `X自動投稿アプリG4のちゃ`）を書く。

H3記入例:

```text
# Codex Task H3 — CURRENT TASK

- task_id: <task_id>
- owner: codex
- slot: codex-3
- status: ready
- next_owner: codex
- start_code: H3
- finish_code: C3
- recommended_model: <推薦モデル>
- return_to: かぶモリアプリG1のちゃ
- completion_code: C3
```

### 返却先の判定（Codex）

- 返却先は推測しない。自分のTASKヘッダーの `return_to` / `completion_code` だけを正本とし、ACTIVE_TASK・CURRENT_STATE・PR内容・レビュー対象のG枠・過去TASKから補わない。
- 次のいずれかに当たる場合は「返却先未確定」とする。
  - `return_to` または `completion_code` が欠落・空欄・プレースホルダのまま
  - `return_to` がG番号だけ等で、戻るチャットを特定できない
  - TASK内に異なる返却先が複数ある等、記載が矛盾している
  - `completion_code` が自分の枠と一致しない（例: H1なのに `C2`、H3なのに `C1`、その他の値）。これはエラーとして扱う。
- 返却先未確定でも、レビュー・検証の結果自体は通常どおりReportへ記録してよい。ただし勝手に別の部屋へ返すよう案内せず、ChatGPT確認待ちにする。status `review_required` / next_owner `chatgpt` の通常フローは変えない。

### 完了報告（Codex）

- Report（`.agent/CODEX_REPORT.md` / `.agent/CODEX_REPORT_2.md`〜`.agent/CODEX_REPORT_5.md`）には通常項目に加えて `return_to` と `completion_code` を記録する。未確定なら `return_to: 返却先未確定（<理由>）` と書く。
- ユーザー向け最終報告（チャットへの最終返信）の末尾には、必ず「返却先」を置く。PASS等の完了時だけでなく、BLOCKED・STOP等で作業を終える場合も同じ。

H1例:

```text
返却先
かぶモリアプリG1のちゃへ `C1` を送ってください。
```

H2例:

```text
返却先
X自動投稿アプリG4のちゃへ `C2` を送ってください。
```

H3例（H4 / H5も同様に `C4` / `C5`）:

```text
返却先
かぶモリアプリG1のちゃへ `C3` を送ってください。
```

返却先未確定の例:

```text
返却先
返却先未確定 — ChatGPT確認待ち：TASKの `return_to` が欠落しているため、送り先を案内できません。
```

### 既存TASKの扱い

- 本ルール導入前から割り当て済みのTASK（ready / in_progress / review_required等）へ `return_to` / `completion_code` を機械的に後付けしない。TASK本文・Reportを保護する。
- そうしたTASKを完了するCodexも推測で補わず、上記の「返却先未確定」として報告する。

## 並行作業と競合防止

- H1〜H5 / G1〜G10（全15枠）を並行稼働させる場合、各slotは**専用の独立Git worktreeまたは独立checkout**を使う。同一ディレクトリを複数セッション/slotで共有しない。Git branchが別でも作業ディレクトリが同じなら独立とはみなさない。
- 作業開始時に、`git worktree list`等で自分の作業ディレクトリとbranchを確認し、他slotと共有されていないことを確かめる。既存の別slotのworktree/checkoutへ切り替えて作業しない。
- 各slotは他slotのbranchをcheckout/reset/rebaseしない。他slot所有の未コミット変更・作業ファイルを変更、削除、stage、commitしない。必要な変更の引き継ぎは所有者と内容を確認し、明示的に合意した安全な方法で行う。
- dev serverは可能な限り自分のworktreeから起動し、他slotのserverを停止・再起動しない。serverの作業ディレクトリや所有者が確認できない場合は操作しない。
- shared checkoutしか利用できず、安全な独立worktree/checkoutを作成できない場合は作業開始前に停止し、理由と必要な対応を報告する。共有状態のままbranch切替やreset等で作業を進めない。
- 全15枠は別task_idかつ変更対象が分離される場合のみ同時進行可能。
- 同じファイルを複数枠で同時編集しない。
- 同じDB migration / RPC / Edge Function / workflow / production設定 / API境界 / 認証・権限ロジックを複数枠で同時変更しない。
- 一方のpush後、他枠はpush前にfresh `origin/main`確認をやり直す。
- 既存未コミット変更は他workstreamの所有物として扱い、変更・削除・stage・commitしない。
- scope、所有者、競合可能性を安全に判断できない場合は作業を開始せず、具体的な競合箇所を報告する。
- 未実施を成功扱いにしない。push / merge / deployは実際に確認できた場合だけ完了として報告する。

### Production並行運用（2026-10-08〜）

- G5のcritical-path優先は、**競合時にG5を優先する**という意味であり、G5のTASK期間中に他slotを全面停止する意味ではない。
- 別ファイル・別機能・別production resourceで変更境界が分離されていれば、実装・テスト・commit・push・PR更新・mergeは通常どおり並行してよい。
- production write/deployも、G5と具体的なmutation boundaryが分離され、各TASK固有の承認・安全ゲートを満たすなら一律停止しない。
- ただし同じDB migration/table/RPC/function、Auth/RLS/権限、Edge Function、secret/settings/Cron/workflow、API境界などが重なる場合は同時実行しない。競合時はG5を優先する。
- 同一Supabase DBのmigration/DDLは、論理対象が別でもmigration history/catalog/preflight fingerprintを共有するため、**実際のDDL/write区間だけ**直列化する。先行側のpostflight後、後続側はfresh baselineを取り直して続行する。
- production mutation windowは実write直前に開き、postflight/read-back完了直後に閉じる。ユーザー入力待ち・夜間待機・レビュー待ち・自然配信待ちを理由に長時間ACTIVEを保持しない。
- 待機が発生したら、実writeが無い限りwindowを閉じ、再開時にfreshな競合確認を行う。
- slot名だけで競合判定しない。実際に触るファイル・DB object・Auth/RLS・Edge・settings・workflow・production resourceを比較する。
- scope/所有者/競合可能性が曖昧な場合だけ停止し、具体的な競合箇所を報告する。

## 基本フロー

原則:

Claude実装 → ChatGPT完了確認 → ChatGPTがレビュー要否判断 → 必要なら空きH枠へCodexレビュー/バグ修正 → ChatGPT確認 → 必要ならClaudeへ差し戻し → 最終確認 → deploy

小規模・低リスク変更ではCodexレビューを省略してよい。高リスク変更では複数回レビューを入れてよい。

## モデル運用（2026-09-24〜）

H1〜H5 / G1〜G10 のどの枠でも、TASKを割り当てる時は必ず推薦モデル（`recommended_model`）を設定する。未割当テンプレートだけは `recommended_model: none` とする。

Claude向けTASK（G1〜G10）の候補:

- Sonnet5（中）
- Sonnet5（高）
- Sonnet5（極高）
- Opus5.5（中）
- Opus5.5（高）
- Opus5.5（極高）

Sonnet5で安全に処理できる作業はSonnet5を優先する。設計判断、複数レイヤーにまたがる変更、認証/権限、DB/RPC/Edge Function、高リスクなproduction変更などはOpus5.5を使用する。

Codex向けTASK（H1〜H5）の候補（2026-10-11明記）:

- Luna（中）
- Luna（高）
- Luna（極高）
- Sol（中）
- Sol（高）
- Sol（極高）

## MICおよびその他案件

G1〜G10の既存TASK/Reportを保護する。G1〜G4に安全かつ利用許可のある空き枠がない場合、既存スロットへ無理に割り込ませず、ChatGPTが直接コピーしてClaudeへ渡せる完成指示を作る。G1〜G4に空きがないという理由だけでG5〜G10へ自動投入しない。G5〜G10がidleでもMIC用に自動消費しない。ユーザーまたはChatGPTが対象予備枠（G5〜G10）の使用を明示的に許可・割当し、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATE・fresh `origin/main`から真の未割当と非競合を確認し、専用の独立worktree/checkoutを用意できる場合のみ使う。
