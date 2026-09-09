# Codex Report

- task_id: important-news-throughput-and-coverage-hardening-20260909
- result: review_required
- next_owner: chatgpt
- commit_hash: `afcc79d0e5442deef958e779de95ecad30de2177`
- push: `origin/main`へpush済み（`ccce2d1..afcc79d`）
- deploy: 未実施（Supabase安全ゲートが明示承認待ちで拒否）

## Summary

重要ニュース監視のpublish/QA/runtimeを最小変更で修正した。DB migration、schema、RLS、GRANT、RPC、Cron、Edge Function以外の本番設定、X投稿手動実行は行っていない。既存のcutover条件を維持し、auto-publish対象はcutover後に生成された候補だけに限定した。

## Changed files

- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/publish_logic.ts`
- `supabase/functions/important-news-monitor/rate_control_logic.ts`
- `supabase/functions/important-news-monitor/post_generation_logic.ts`
- `supabase/functions/important-news-monitor/official_source_fetchers.ts`
- `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`
- 上記ロジックの回帰テスト4ファイル
- `.agent/tasks/CODEX_TASK.md`（`review_required` / `next_owner: chatgpt`）

## Root causes and fixes

1. `ready_for_publish`のpublish選択が`most_important`限定で、`important`はclaimにもX APIにも到達しなかった。両tierを選択・検証対象にし、queue orderは`most_important`優先のままにした。
2. `most_important`だけrate-controlをbypassしていたため、両tierとも既存の10分cooldownを通すようにした。深夜1:00–5:00 JSTの既存holdは`important`に維持し、`most_important`の既存bypassも維持した。
3. `MISSING_EXPLICIT_YEAR`が本文中の1930年・2022年など歴史的/法令/metadata年まで要求していた。title/judgementReasonの年を必須とし、bodyはcandidate published yearの±1年だけを検証するよう変更した。
4. Voiceの軽微な市場影響表現・未確認事項の弱化可能な指摘を最大1回のtargeted retry対象にした。数字・主体・企業・source・安全性・根拠のない断定はhard failのまま。
5. TDnet一覧、company IR feed、breaking-market OpenAI requestにtimeoutを追加した（それぞれ15秒、15秒、60秒）。1 sourceの無応答で20分超runになるリスクを下げ、既存のpartial-error処理は維持した。

## Coverage investigation

直近7日をread-only集計したところ、既存のbreaking/market-macro laneでFX、geopolitics、tariffs、war_ceasefire、major_security_incident、semiconductor_ai、FRB/BOJを取得済み。例としてbreaking_marketには`fx ready_for_publish 2`、`geopolitics ready_for_publish 1`、`war_ceasefire ready_for_publish 3`、`major_security_incident ready_for_publish 1`があり、取得ゼロが主因ではなく、rejected/generation_failed/旧publish filterが主な損失だった。キーワードを無制限に広げる変更は行っていない。

28日間のproduction候補集計（変更前のread-only観測）:

- `ready_for_publish`: important 29、most_important 6
- 上記の`publish_attempts > 0`: important 0、most_important 0
- `generation_failed`: important Fact failed 43、Fact passed/Voice failed 10、most_important Fact failed 8、Fact passed/Voice failed 1

## Tests

- `deno test --no-check --allow-read supabase/functions/important-news-monitor/*_test.ts`: **265 passed / 0 failed**
- 変更したpure moduleの`deno check --no-config`: **pass**
- `index.ts`全体のDeno checkは既存の`_shared/x_oauth2_post.ts` BufferSource型エラーと既存のStoredGenerationCandidate `id` optional型エラーで失敗。今回変更箇所由来の新規型エラーは確認されていない。
- `git diff --check`: pass

## Production verification and safety

- production Supabaseはread-only確認のみ。`important-news-monitor`は確認時点でversion 31、active。直近runは10:00 UTC開始のrunning、直前5 runは`NEWS_MONITOR_STALE_RUNTIME_TERMINATION`、08:00 UTC以前は20–30秒程度でcompletedだった。
- `important-news-company-ir_sources` active countは0で、今回のstale連続の直接原因とは確認できなかった。外部fetch timeout未設定が残る経路を修正した。
- 本番Edge Function deployを1回試行したが、Supabase安全ゲートが「service-role DBアクセスとlive X投稿を伴うproduction変更で、信頼済み指示では明示承認されていない」として拒否。CLI等で迂回していない。`important-news-monitor`だけの本番deployを明示承認後に実施し、自然Cron経路でrun/candidate/publish_attemptsを再確認する必要がある。
- deploy前のproduction X API callは0、手動X投稿は0、旧backlog一括投稿は0。`stocks_master`およびDB schemaは変更していない。

## Remaining / next action

1. 本番`important-news-monitor` deployの明示承認を受ける（現在のブロッカー）。
2. deploy後、5分Cronの自然経路で新規cutover後候補がclaimされ、`publish_attempts`またはX投稿まで進むことをread-only確認する（旧候補は対象外のまま）。
3. stale runがtimeout追加後に再発しないことを数サイクル確認する。
