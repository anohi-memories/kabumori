# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-safe-publish-trigger-implementation-20260908
- owner: codex
- status: review_required
- next_owner: chatgpt
- priority: urgent
- purpose: `auto_publish=true` 済みの重要ニュースについて、過去のready候補を誤投稿せず、新規の `most_important` 候補だけが既存安全条件を満たした時に自然自動投稿される起動経路を安全に実装する。

## Previous C Review

前タスク `important-news-auto-publish-enable-20260908` の調査結果は承認済み。

確認済み:
- `important-news-monitor` v30 ACTIVE
- `auto_publish=true`
- `publish_ready` mode自体は存在
- Generation完了時の内部publish dispatchは存在しない
- production CronはFetch/Judgement/Generationの3本のみ
- `publish_ready` Cronは0本
- x-test-postのscheduled_posts dispatcherはimportant-news用ではない
- `ready_for_publish` は29件、そのうち `most_important` 6件
- publish_attempts>0 = 0、x_post_idあり = 0
- 過去candidateの再claim・再生成・手動投稿は未実施

前タスクの調査は完了。自動投稿というユーザー目的を達成するには新規の安全な起動経路実装が必要。

## Critical safety requirement

**既存の過去 `ready_for_publish` 候補を自動投稿してはならない。**

特に、現在残っている `most_important` 6件を、Cron追加直後にbacklogとして投稿する実装は禁止。

新しい自動投稿は、今回の安全起動経路を有効化した後に自然発生した新規候補だけを対象にすること。

## Required investigation before implementation

1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, 本TASKを確認。
2. `important-news-monitor` の `publish_ready` repository/claim/order/filterを確認し、現在どのready候補を拾う設計か特定。
3. `important_news_monitor_settings` の既存列（updated_at等を含む）やcandidateのgenerated_at/created_at等を確認し、schema変更なしで安全なcutover境界を作れるか確認。
4. 既存のduplicate protection / atomic claim / rate control / overnight hold / Fact / Voice / https source / `most_important` eligibilityをそのまま維持。
5. Claude側のclose_report/morning_report作業と同一Cron/dispatcher/Functionを変更する必要がある場合は競合として開始せず報告。

## Preferred design

最小で安全なら以下を優先:

- `publish_ready` が「auto_publish有効化後に生成/ready化された候補」だけを対象にできるcutover guardを追加。
- cutover時刻は既存settingの `updated_at` 等、productionで既に確定している安全な時刻を再利用できるなら優先。
- 既存列で安全に表現できない場合、勝手にmigrationせず `review_required` で必要性を報告。
- natural triggerは既存設計に沿った明示的Cronなど、単一路線にする。
- Cronは短時間隔でよいが、既存rate controlとatomic claimを必ず通す。無制限投稿ループは禁止。

## Implementation scope

ローカル実装とテストまで。

許可:
- `important-news-monitor` 内の必要最小限コード変更
- 関連test追加/修正
- Cron SQL/migrationファイルが既存repo運用上必要なら、**本番適用せず**ローカル成果物として作成してよい
- commit / push

禁止:
- production Edge Function deploy
- production Cron追加/変更
- production DB write
- migration/DDL/GRANTの本番適用
- secrets変更/表示
- X API / X投稿
- 過去candidateのstatus変更・再claim・再生成・backfill
- `important` を自動投稿対象へ拡大
- Fact/Voice/importance thresholdの緩和
- close_report/morning_report/morning_greeting/useful_tipの変更
- Claude TASK/Report変更

## Required tests

最低限:

1. backlog safety
- cutover以前の `most_important + ready_for_publish + Fact/Voice passed` はpublish対象にならない。
- cutover以前の既存6件相当fixtureが1件もclaimされない。

2. new candidate path
- cutover後の新規 `most_important` で既存eligibilityを満たす候補だけclaim可能。
- `important` は対象外。
- Fact fail / Voice fail / http source / already posted は対象外。

3. duplicate/rate safety
- atomic claimが維持される。
- 同一candidateの二重投稿が発生しない。
- rate control / overnight holdを迂回しない。

4. trigger
- 自然起動用Cron/trigger案が `publish_ready` を正しいmodeで呼ぶこと。
- 既存Fetch/Judgement/Generation Cronを壊さない。

5. regression
- relevant tests
- important-news-monitor full regression可能範囲
- lint/typecheck可能範囲
- `git diff --check`

## Completion criteria

- 安全なcutover guardと自然publish triggerの実装案が完成。
- 過去ready候補を誤投稿しないテストがpass。
- 既存publish eligibilityを緩めていない。
- production変更0、X投稿0。
- TASK末尾に `## Report` を追加。
- status: `review_required`
- next_owner: `chatgpt`

- commit: 許可
- push: 許可
- deploy: 禁止
- production changes: 禁止
- report_mode: inline

## Report

- task_id: important-news-safe-publish-trigger-implementation-20260908
- result: review_required
- changed_files:
  - `supabase/functions/important-news-monitor/index.ts`
  - `supabase/functions/important-news-monitor/publish_logic.ts`
  - `supabase/functions/important-news-monitor/publish_logic_test.ts`
  - `supabase/functions/important-news-monitor/auto_publish_cutover_logic.ts`
  - `supabase/functions/important-news-monitor/auto_publish_cutover_logic_test.ts`
  - `supabase/functions/important-news-monitor/important_news_publish_cron_test.ts`
  - `supabase/migrations/20260908110000_add_important_news_publish_ready_cron.sql`（ローカル提案のみ・本番未適用）
- implementation:
  - `important_news_monitor_settings.updated_at`を既存cutover境界として読み取り、`generated_at >= updated_at`の候補だけauto-publish選択対象にした。
  - `candidateId`明示時もcutover以前/不正timestampは`NEWS_AUTO_PUBLISH_CUTOVER_BLOCKED`でclaim前に停止。
  - `updated_at`取得不能時は候補選択をfail-closed。
  - `publish_ready`を5分間隔で呼ぶCron SQL案を追加。`is_active=true`かつ`auto_publish=true`のみ呼び出し、重複jobは作成しない。
- safety:
  - `most_important`限定、ready_for_publish、Fact/Voice passed、HTTPS source、未投稿、atomic claim、rate/overnight/publish safetyは維持。
  - `important`の自動投稿拡大、過去候補の再claim/reprocess、X API、production write、deployは未実施。
- tests:
  - 新規cutover/triggerを含むimportant-news全テスト: 261 passed / 0 failed（`deno test --no-check`）。
  - `git diff --check`: pass。
  - `deno check --no-config`: 既存の無関係な2エラーで失敗（`supabase/functions/_shared/x_oauth2_post.ts:66`、既存`important-news-monitor/index.ts:683`）。今回変更箇所のエラーではない。
- production: `auto_publish=true`は既存状態を維持。Cron/migration/deploy/DB write/X投稿は0。
- commit: TASK/Reportと実装コードのローカルcommit/pushは許可。production適用は別レビュー後。
- next_owner: chatgpt
