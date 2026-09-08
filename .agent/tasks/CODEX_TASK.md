# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-auto-publish-enable-20260908
- owner: codex
- status: ready
- next_owner: codex
- priority: high
- purpose: 本番検証済みの重要ニュース自動生成について、既存のpublish eligibilityを一切緩めず `auto_publish` のみを安全に有効化し、最初の自然投稿経路を確認する。

## Background

直前タスクで `important-news-monitor` v30 を本番deployし、自然20分サイクルを2回確認済み。

- `most_important` 1件が Fact/Voiceともpassedし `ready_for_publish` まで正常到達。
- 別の `important` 1件は `MISSING_EXPLICIT_YEAR` のFact retry後もfailedとなり、安全停止した。
- 現在確認済み設定は `auto_publish=false`。
- 取得・判定・生成・Fact/Voice安全停止は本番自然サイクルで確認済み。

今回の目的は投稿条件を広げることではなく、既存の安全なpublish eligibilityをそのまま使って自動投稿を有効化すること。

## Concurrency

- Claude slot 1 は `close-report-auto-post-enable-20260908` を進行中。
- Claude slot 2 は `morning-report-us-holiday-session-labeling-20260908` がready。
- 本タスクは `important-news-monitor` の `auto_publish` 設定のみを対象とし、close_report / morning_report / x-test-post / posting_windows 等には触れない。
- 同一DB row / 同一設定 / 同一Edge Functionを他slotが変更中と判明した場合は、production変更せず `review_required` で競合報告する。

## Required pre-check

production write前に必ず確認する。

1. 現在の `important-news-monitor` がACTIVEで、直前deployのv30相当が稼働していること。
2. 現在の重要ニュース設定で `auto_publish=false` であること。
3. `auto_publish=true` が既存コード上どの候補を自動投稿対象にするか確認する。
4. `important` / `most_important` の判定、Fact、Voice、publish eligibility、duplicate protection、claim条件を変更しないことを確認する。
5. `auto_publish=true` にするだけで、ユーザー意図より広く「全importantを無条件投稿」等になる場合はONにせず停止して報告する。

## Authorized production change

上記pre-checkで既存の安全なpublish eligibilityが維持されると確認できた場合に限り、productionの重要ニュース設定について:

- `auto_publish: false -> true`

のみ変更を許可する。

その他のproduction設定変更は禁止。

## Explicitly forbidden

- コード変更
- Edge Function deploy
- migration / DDL / GRANT
- Cron変更
- secrets変更・表示
- `is_active`, `interval_minutes`, Luna/Sol設定、重要度threshold等の変更
- important / most_important 判定条件の緩和
- Fact / Voice checkerの緩和
- publish eligibilityの変更
- 過去candidateのstatus変更・再claim・再生成・backfill
- 手動candidate注入
- テスト投稿のための手動X投稿
- close_report / morning_report / morning_greeting / useful_tip 等、他投稿種別の設定変更
- Claude側TASK/Reportの変更

## Verification after enabling

`auto_publish=true` 反映後:

1. 設定read-backで `auto_publish=true` を確認。
2. 他の重要ニュース設定が変更されていないことを確認。
3. 既存Cron/Function healthが正常であることをread-only確認。
4. 過去の `ready_for_publish` 候補を勝手に再処理しないこと。
5. 次に自然発生する新規候補のみを対象に、既存の通常経路を観測する。
6. 観測時間内に新しい投稿対象が自然発生した場合:
   - Fact/Voice passed済みであること
   - publish claimが1回だけであること
   - X投稿成功時はpost id / timestamp / candidate idをReport
   - duplicate投稿がないこと
7. 自然な投稿対象が発生しない場合は、人工的に作らず「初回自然投稿は未成立」とReportする。

## Observation policy

- 設定ON後、すぐに人工投稿はしない。
- 長時間待機が必要な場合、設定反映とhealth確認までで `review_required` にしてよい。
- 初回自然投稿確認が未成立でも、設定ON自体が安全に完了していればその旨を明確にReportする。

## Completion criteria

- pre-checkでauto_publishの実際の対象範囲を確認。
- 安全条件を満たす場合のみ `auto_publish=true` をproduction反映。
- 変更したproduction値はその1項目のみ。
- read-back確認済み。
- 可能な範囲で初回自然投稿経路をread-only観測。
- TASK末尾に `## Report` を追加。
- status: `review_required`
- next_owner: `chatgpt`

- commit: TASK/Report更新のみ許可
- push: TASK/Report更新は許可
- deploy: 禁止
- report_mode: inline
