# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-safe-publish-production-activation-20260908
- owner: codex
- status: review_required
- next_owner: chatgpt
- priority: urgent
- purpose: ChatGPT承認済みの安全publish trigger実装を本番へ反映し、過去ready候補を一切投稿せず、反映後に自然発生した新規 `most_important` だけが既存安全条件を満たした時に自動投稿されるproduction状態へ安全に移行する。

## Previous task review

前タスク `important-news-safe-publish-trigger-implementation-20260908` はChatGPTレビューで承認。

承認内容:
- `important_news_monitor_settings.updated_at` をcutover境界として `generated_at >= updated_at` の候補だけauto-publish対象にするguard。
- 明示candidateIdでもcutover以前/不正timestampはclaim前にfail-closed。
- cutover timestamp取得不能時はfail-closed。
- `most_important`限定、ready_for_publish、Fact/Voice passed、HTTPS source、未投稿、atomic claim、duplicate/rate/overnight/publish safetyを維持。
- `publish_ready` を5分間隔で呼ぶCron SQL案。
- important-news全テスト 261 passed / 0 failed、`git diff --check` pass。
- production変更/X投稿は0。

## Critical activation safety

**過去の `ready_for_publish` 候補を投稿してはならない。**

特に、以前から残っている `most_important` backlogをCron有効化直後に拾わないこと。

前実装はsettingsの `updated_at` をcutoverに使うため、単にコードdeploy→Cron有効化だけを行うと、`auto_publish=true` にした時刻以降〜今回deploy前までに生成された候補がcutover後として扱われる可能性がある。

そのため、本番activationでは **deploy完了後かつCron有効化前にcutover時刻を更新** し、その時刻より前の候補が1件もpublish対象にならないことをread-only確認してからCronを有効化する。

## Required pre-check

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、本TASKを確認。
2. origin/mainに前タスクの承認済み実装が含まれ、未承認ローカル差分がないことを確認。
3. Claude/他workstreamが `important-news-monitor`、同一Cron名、同一settings rowを変更中でないことを確認。競合時はproduction変更せず報告。
4. productionの現在値をread-only確認:
   - `important-news-monitor` version/status
   - `auto_publish=true`
   - settings `updated_at`
   - ready_for_publish / most_important backlog件数
   - publish_attempts / x_post_id
5. 実装コードが `generated_at >= settings.updated_at` をclaim前に適用していることを再確認。

## Authorized production activation

以下の順序に限定して許可する。

### Step 1: Edge Function deploy
- 承認済みmainから `important-news-monitor` のみdeploy。
- 他Function deploy禁止。
- deploy後ACTIVE/起動エラーなしを確認。

### Step 2: cutover timestamp refresh
Cronを有効化する**前**に、重要ニュースsettingsのcutover境界 `updated_at` をdeploy後時刻へ更新する。

安全な最小方法を選ぶ:
- settings rowにupdated_atを安全に更新できる既存正規経路があるならそれを使用。
- それがない場合、`auto_publish` を一時 `true -> false -> true` としてupdated_atが確実に更新される既存仕様なら、その2回の設定変更のみ許可。

条件:
- 最終状態は必ず `auto_publish=true`。
- `is_active`, `interval_minutes`, Luna/Sol設定、threshold等は変更しない。
- cutover時刻がdeploy完了後であることをread-back確認。
- `generated_at < cutover` の既存候補がpublish対象に入らないことをread-only確認。

updated_at更新方法が安全に一意特定できない場合はCronを有効化せず `review_required` で停止。

### Step 3: publish_ready Cron activation
- 承認済みmigration/Cron SQL案だけを適用。
- `publish_ready` を5分間隔で呼ぶ単一job。
- `is_active=true` かつ `auto_publish=true` の場合のみ実行。
- 同名job重複なし。
- Fetch/Judgement/Generation既存Cronを変更しない。

## Explicitly forbidden

- 過去candidateのstatus変更・再claim・再生成・backfill
- 手動candidate注入
- テスト目的の手動X投稿
- `important` を自動投稿対象へ拡大
- Fact/Voice/importance thresholdの緩和
- secrets変更/表示
- 不要なmigration/DDL/GRANT
- x-test-post / close_report / morning_report / morning_greeting / useful_tip等の変更
- Claude TASK/Report変更
- 承認済みコード以外の追加実装

## Verification after activation

1. `important-news-monitor` ACTIVE、起動/import errorなし。
2. `auto_publish=true`、cutover `updated_at` がdeploy後時刻。
3. publish_ready Cronが1本だけactive、5分間隔。
4. 既存Fetch/Judgement/Generation Cronはschedule/active不変。
5. cutover以前の既存most_important ready候補について:
   - publish_attemptsが増えていない
   - x_post_idが付いていない
   - claimされていない
6. 次に自然発生するcutover後の新規 `most_important` のみ観測。
7. 自然投稿が成立した場合:
   - candidate id
   - generated_at >= cutover
   - Fact/Voice passed
   - publish claim 1回
   - X post id / timestamp
   - duplicateなし
   をReport。
8. 観測時間内に対象が出なければ人工的に作らず、「自動起動経路有効化済み・初回自然投稿未成立」とReport。

## Completion criteria

- 承認済みsafe trigger実装だけを本番deploy。
- deploy後かつCron有効化前にcutover境界更新。
- 過去ready候補が対象外であることを確認。
- publish_ready Cronを単一経路で有効化。
- 既存安全条件維持。
- 過去候補誤投稿0、手動X投稿0。
- TASK末尾に `## Report` を追加。
- status: `review_required`
- next_owner: `chatgpt`

- commit: TASK/Report更新のみ許可
- push: TASK/Report更新は許可
- deploy: `important-news-monitor` のみ許可
- production migration/Cron: 上記publish_ready jobのみ許可
- production settings write: cutover更新に必要な最小変更のみ許可
- report_mode: inline

## Report

- task_id: important-news-safe-publish-production-activation-20260908
- result: review_required
- deploy: `important-news-monitor` only was deployed successfully from approved origin/main; ACTIVE version is v31 and `verify_jwt=false`.
- precheck: settings were `is_active=true`, `interval_minutes=20`, `auto_publish=true`, `luna_enabled=true`, `sol_escalation_enabled=true`; existing ready backlog was important 23 / most_important 6, with publish_attempts 0 and x_post_id 0.
- cutover: not updated. The production SQL transaction for the required `true -> false -> true` cutover refresh was rejected by the safety gate because explicit user approval for this production setting write was not available in the current turn.
- cron: `important-news-publish-ready` was not applied. Existing Fetch/Judgement/Generation Cron jobs remain unchanged; publish_ready Cron remains 0.
- safety: no candidate status change, no claim, no backfill, no manual publish, no X API/X post, and no other setting/function/deploy change.
- blocker: explicit user approval is required before retrying the production cutover setting write and then applying the single approved publish_ready Cron.
- next_owner: chatgpt
