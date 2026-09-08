# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-auto-publish-enable-20260908
- owner: codex
- status: review_required
- next_owner: chatgpt
- priority: high
- purpose: 本番検証済みの重要ニュース自動生成について、既存のpublish eligibilityを一切緩めず、自動投稿が実際に自然実行されるproduction経路まで安全に有効化する。

## Background

直前タスクで `important-news-monitor` v30 を本番deployし、自然20分サイクルを2回確認済み。

- `most_important` 1件が Fact/Voiceともpassedし `ready_for_publish` まで正常到達。
- 別の `important` 1件は `MISSING_EXPLICIT_YEAR` のFact retry後もfailedとなり、安全停止した。
- 取得・判定・生成・Fact/Voice安全停止は本番自然サイクルで確認済み。

本タスク第1段階で `public.important_news_monitor_settings.auto_publish` は `false -> true` に変更済み。

確認結果:
- `important-news-monitor`: ACTIVE v30 / `verify_jwt=false`
- publish eligibilityは `most_important`、`ready_for_publish`、generated textあり、Fact passed、Voice passed、https source URL、未投稿を要求
- `important` は自動投稿対象外
- duplicate/claim/rate control/overnight hold/publish safetyは変更なし
- settings read-back: `is_active=true`, `interval_minutes=20`, `auto_publish=true`, `luna_enabled=true`, `sol_escalation_enabled=true`
- ただし production Cron は Fetch/Judgement/Generation の既存3本のみで、`publish_ready` Cron は0本
- 設定反映後のimportant_news自然X投稿も0件

このため `auto_publish=true` だけでは、実際の自動投稿起動経路が存在しない/未確認の可能性がある。ユーザー意図は「設定値だけON」ではなく「重要ニュースが条件を満たしたら自然に自動投稿される状態」にすること。

## C Review continuation

- review_result: follow_up_required
- reviewed_by: chatgpt
- reason: `auto_publish=true` の反映自体は承認できるが、`publish_ready` の自然起動経路が確認できず、自動投稿というユーザー目的の完了をまだ確認できない。
- previous production change `auto_publish=false -> true` は維持してよい。
- 過去candidateの再処理や手動X投稿は禁止のまま。

## Required investigation before any additional production write

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、本TASKを確認する。
2. 既存コード/DB/Cron/dispatcherを調査し、`publish_ready` が本来どの正規経路で呼ばれる設計か特定する。
   - Generation完了時の内部dispatchなのか
   - pg_cron / scheduler / dispatcher経由なのか
   - `x-test-post` 等の別Function経由なのか
   - 現在欠落しているのか
3. 既存の duplicate protection / atomic claim / rate control / overnight hold / auto_publish判定がどこで適用されるか確認する。
4. `most_important` だけが既存publish eligibilityを満たした時に投稿されることを再確認する。
5. Claude側の close_report / morning_report 作業と同一Cron・同一dispatcher・同一Functionを変更する必要がある場合は、競合としてproduction変更せず報告する。

## Authorized continuation

ユーザーは重要ニュースの「自動投稿ON」を明示承認済み。調査で正規の自動起動経路が一意に特定でき、既存安全条件を維持できる場合に限り、重要ニュース `publish_ready` を自然実行させるための最小限のproduction設定/Cron有効化を許可する。

許可条件:
- 既存設計に沿った正規経路のみ
- `most_important` + ready_for_publish + Fact passed + Voice passed + https source + 未投稿など既存eligibilityを維持
- duplicate protection / atomic claim / rate control / overnight holdを維持
- 投稿頻度・重要度thresholdを広げない
- 他投稿種別へ影響させない

もし新規コード実装、Edge Function変更/deploy、migration、複数経路の新設が必要なら、このTASKでは実施せず `review_required` で必要事項を報告する。

## Explicitly forbidden

- 重要度判定条件の緩和
- Fact / Voice checkerの緩和
- `important` を自動投稿対象へ広げること
- 過去candidateのstatus変更・再claim・再生成・backfill
- 手動candidate注入
- テスト目的の手動X投稿
- secrets変更・表示
- migration / DDL / GRANT
- close_report / morning_report / morning_greeting / useful_tip 等の設定変更
- Claude側TASK/Reportの変更
- 正規経路が不明なまま新しいCronを推測で追加すること

## Verification after activation

正規の自然起動経路を有効化できた場合:

1. production設定/Cron read-backで意図した項目だけ変更されたことを確認。
2. `auto_publish=true` が維持されていることを確認。
3. Function/Cron healthをread-only確認。
4. 過去の `ready_for_publish` 候補を勝手に再処理しないこと。
5. 次に自然発生する新規 `most_important` 候補のみを観測する。
6. 自然投稿が成立した場合:
   - candidate id
   - Fact/Voice passed
   - publish claim 1回
   - X post id / timestamp
   - duplicate投稿なし
   をReportする。
7. 観測時間内に自然対象が出なければ人工的に作らず、「自動起動経路有効化済み・初回自然投稿未成立」とReportする。

## Completion criteria

- `publish_ready` の正規起動経路を特定。
- 必要なら安全な最小production設定/Cron変更のみ実施。
- 自動投稿が自然に起動可能な状態であることをread-back/healthで確認。
- 過去候補の再処理0、手動X投稿0。
- TASK末尾に新しい `## Report` を追加。
- status: `review_required`
- next_owner: `chatgpt`

- commit: TASK/Report更新のみ許可
- push: TASK/Report更新は許可
- code change: 禁止
- Edge Function deploy: 禁止
- report_mode: inline

## Previous Report

- production_change: `public.important_news_monitor_settings.auto_publish` のみ `false -> true`
- existing publish eligibilityは安全条件を維持
- `publish_ready` Cron: 0本
- natural X post: 0件
- DB writeはauto_publish設定1項目のみ
- migration/code/deploy/Cron/secrets/X手動投稿: 0

## Report

- task_id: important-news-auto-publish-enable-20260908
- result: review_required
- investigation: `publish_ready` の正規自然起動経路は現行コード・DB・Cronから特定できず
- code: `important-news-monitor` は `mode=publish_ready` を受けた場合だけ既存publish処理へ進む。Generation完了時の内部publish dispatchは存在しない。
- cron: productionのimportant-news CronはFetch/Judgement/Generationの3本のみ。`publish_ready` Cronは0本。x-test-postの既存dispatcherはscheduled_posts用で、important-newsのpublish_readyを呼ばない。
- eligibility: `most_important`、`ready_for_publish`、generated text、Fact passed、Voice passed、https source URL、未投稿を維持。`important`は自動投稿対象外。
- production_readback: `is_active=true`, `interval_minutes=20`, `auto_publish=true`, `luna_enabled=true`, `sol_escalation_enabled=true`
- candidates: `ready_for_publish` 29件（important 23件、most_important 6件）、publish_attempts>0 0件、x_post_idあり0件。既存candidateの変更・再claim・再生成なし。
- production_change: 追加変更なし（auto_publish=trueは既存反映を維持）
- deploy: 0
- manual_publish: 0
- x_api: 0
- x_post: 0
- next_action: 正規経路のコード実装または新規Cronが必要なら、別タスクで設計・レビュー後に実施する。今回は推測で作成せず停止。
