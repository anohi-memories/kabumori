# Codex Report

- task_id: important-news-throughput-and-coverage-hardening-20260909
- result: review_required
- next_owner: chatgpt
- commit_hash: `e7391cf1681fb04dc348612761209d7b1885687c`
- push: `origin/main`へpush済み（`ccce2d1..e7391cf`）
- deploy: `important-news-monitor` version 33 ACTIVE

## Summary

重要ニュース監視のpublish/QA/runtimeを最小変更で修正した。DB migration、schema、RLS、GRANT、RPC、Cron、Edge Function以外の本番設定、X投稿手動実行は行っていない。既存のcutover条件を維持し、auto-publish対象はcutover後に生成された候補だけに限定した。

## Changed files

- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/publish_logic.ts`
- `supabase/functions/important-news-monitor/rate_control_logic.ts`
- `supabase/functions/important-news-monitor/post_generation_logic.ts`
- `supabase/functions/important-news-monitor/importance_judgement_logic.ts`
- `supabase/functions/important-news-monitor/official_source_fetchers.ts`
- `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`
- 上記ロジックの回帰テスト4ファイル
- `.agent/tasks/CODEX_TASK.md`（`review_required` / `next_owner: chatgpt`）

## Root causes and fixes

1. `ready_for_publish`のpublish選択が`most_important`限定で、`important`はclaimにもX APIにも到達しなかった。両tierを選択・検証対象にし、queue orderは`most_important`優先のままにした。
2. `most_important`だけrate-controlをbypassしていたため、両tierとも既存の10分cooldownを通すようにした。深夜1:00–5:00 JSTの既存holdは`important`に維持し、`most_important`の既存bypassも維持した。
3. `MISSING_EXPLICIT_YEAR`が本文中の1930年・2022年など歴史的/法令/metadata年まで要求していた。title/judgementReasonの年を必須とし、bodyはcandidate published yearの±1年だけを検証するよう変更した。
4. Voiceの軽微な市場影響表現・未確認事項の弱化可能な指摘を最大1回のtargeted retry対象にした。数字・主体・企業・source・安全性・根拠のない断定はhard failのまま。
5. TDnet一覧、company IR feed、market macro、breaking-market、OpenAI判定/生成requestにtimeoutを追加した（source系15秒、breaking/OpenAI系60秒）。1 sourceやモデルrequestの無応答で20分超runになるリスクを下げ、既存のpartial-error処理は維持した。

## Coverage investigation

直近7日をread-only集計したところ、既存のbreaking/market-macro laneでFX、geopolitics、tariffs、war_ceasefire、major_security_incident、semiconductor_ai、FRB/BOJを取得済み。例としてbreaking_marketには`fx ready_for_publish 2`、`geopolitics ready_for_publish 1`、`war_ceasefire ready_for_publish 3`、`major_security_incident ready_for_publish 1`があり、取得ゼロが主因ではなく、rejected/generation_failed/旧publish filterが主な損失だった。キーワードを無制限に広げる変更は行っていない。

28日間のproduction候補集計（変更前のread-only観測）:

- `ready_for_publish`: important 29、most_important 6
- 上記の`publish_attempts > 0`: important 0、most_important 0
- `generation_failed`: important Fact failed 43、Fact passed/Voice failed 10、most_important Fact failed 8、Fact passed/Voice failed 1

## Tests

- `deno test --no-check --allow-read supabase/functions/important-news-monitor/*_test.ts`: **265 passed / 0 failed**
- 追加timeout対象の判定・生成テスト: **120 passed / 0 failed**
- 変更したpure moduleの`deno check --no-config`: **pass**
- `index.ts`全体のDeno checkは既存の`_shared/x_oauth2_post.ts` BufferSource型エラーと既存のStoredGenerationCandidate `id` optional型エラーで失敗。今回変更箇所由来の新規型エラーは確認されていない。
- `git diff --check`: pass

## Production verification and safety

- `important-news-monitor` version 33をACTIVEでread-back確認。version 32 deploy後の10:40 UTC runはstaleになり、version 33 deploy後の11:20 UTC runもstaleになったが、次の11:40 UTC runは`fetched_count=183`、`new_candidate_count=2`、約24秒でcompletedした。
- `important-news-company-ir_sources` active countは0で、今回のstale連続の直接原因とは確認できなかった。外部fetch timeout未設定が残る経路を修正した。
- 自然publish Cronで`important`候補が`publish_attempts=1`、`status=published`、`x_post_id=2097633619498143775`となることを確認。手動X投稿・手動candidate注入は行っていない。
- cutover `2026-09-08 14:02:56+00`より前に生成されたcandidateの投稿は0件、cutover後投稿は1件だった。旧backlog一括投稿は発生していない。
- `stocks_master`、DB schema、Cron設定、secrets、OAuth、他Edge Functionは変更していない。

## Remaining / next action

1. 追加の長期観測でstale再発がないことを確認する。今回のversion 33後は少なくとも1サイクルが24秒でcompletedした。
2. 自然Cronでのpublish priority/cooldownが継続することを監視する。
