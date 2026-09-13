# Codex Report

- task_id: `broad-news-display-and-notification-presets-phase3-20260913`
- result: `review_required` — Phase 3のアプリ表示・通知プリセットをローカル実装し、回帰テストまで完了。本番変更は0件
- model_used: GPT-5.6 Sol
- source_base: `origin/main` `2c7e3745885d659af0b67af1261587af3ed39eff`
- implementation_branch: `codex/broad-news-presets-phase3-20260913`
- commit_hash: `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`
- next_owner: chatgpt

## App visibility

- current_app_visibility: 本番RPCは、登録銘柄の既存companyニュースと、登録銘柄の業種に関連するmarket-wide critical/highを表示する。market mediumは対象外で、登録銘柄0件ならアプリ側がRPCを呼ばず空表示だった。
- new_app_visibility: companyは既存の保有/監視紐付けを維持してmedium以上を表示。market-wideは関連業種があるmedium/high/criticalを表示し、emergencyは登録銘柄・業種一致なしでも表示。lowは収集・分類に残すが一覧には出さない。登録銘柄0件でもRPCを呼ぶ。表示用app copyはFact-passedだけを返し、emergencyは元見出しが日本語でも独立したFact check済みcopyを要求する。
- category_labels: list/detailの両方に16カテゴリの日本語チップを追加（地政学、災害、金融政策、為替、金利、原油・エネルギー、コモディティ、海運・物流、半導体、AI・テック、米国市場、日本市場、政策・規制、企業、決算、金融システム）。
- severity_labels: `emergency=緊急`, `critical=最重要`, `high=重要`, `medium=注目`。

## Notification policy

- current_notification_logic: companyはX publish後の個別producer、market criticalは既存market producerが対象判定し、dispatcher/claim RPCが配信直前に `push_enabled` / `important_news` / `market_critical_news` を再確認する。
- proposed_or_implemented_presets:
  - `quiet / 静かめ`: company critical以上、market emergencyのみ。
  - `standard / 標準`: company high以上、market critical以上。
  - `many / 多め`: company medium以上、market high以上。
  - `all_useful / かなり多め`: company/marketともmedium以上。
  - lowは全プリセットでPushしない。
- legacy_settings_compatibility: 既存行はmigration時に新2列をNULLのまま残す。producer上のNULL presetは既存company相当のstandard、NULL emergencyはOFF。既存 `market_critical_news` はdispatcher互換ゲートとして維持し、保存RPCが同一トランザクションで同期する。UIは既存rowのmarket=trueをstandard、falseをquietとして表示する。既存false rowは保存するまでcompany thresholdが従来どおりstandardで、保存後に明示したquietへ移行する。新規rowだけstandard/emergency ONがdefault。
- emergency_behavior: Fact-passed日本語copy、freshness、exact/cross-source event dedupe、push_enabled、important_news、emergency_alertsを必須化。market emergencyはtracked stock/sector一致不要で、通知行の `tracked_stock_id` もNULL。
- category_setting_behavior: `alert_category_settings(user_id, category, enabled)` の行形式。RLSは本人のみ。設定行なし・候補カテゴリなしは有効扱い。複数カテゴリ候補は1つでもONなら対象。

## Database / producer

- schema_changes: `alert_settings.notification_preset` / `emergency_alerts` を既存行safeなnullable追加（新規rowのみdefault）。owner-only RLS付き `alert_category_settings`、atomic保存RPC、NULL-stock market通知のpartial unique index、更新版app-copy selector/feed RPC、service-role専用統一producer RPCを追加するmigrationを作成。
- producer_changes: `important-news-monitor` の実runでapp copy完了後、およびpublish成功後に統一producer RPCを呼ぶ。eligibilityはSQL producerが決定し、既存notifications queueへだけenqueue。dry-runでは呼ばない。
- dispatcher_changes: none。`send-push-notifications` と `claim_pending_push_notifications` は変更なし。

## Read-only production estimate (2026-09-13 JST)

- 7day_notification_volume_estimate:
  - 母数: profiles 1、alert_settings 1、Push/important_news有効1、market_critical_news有効1、tracked user 1、Push token user 1。
  - 現在の実ユーザー・実候補へFact-passed日本語/対象条件を当てた見込み: quiet 0、standard 1、many 3、all_useful 3。
  - 7日窓ではcompany対象0、market対象はstandard 1 / many 3 / all_useful 3。
  - 実送信、candidate注入、settings変更はしていない。
- medium_feed_volume_estimate: effective severityはemergency 0、critical 1、high 7、medium 8、low 40。現行critical/high相当8件からmedium以上16件へ最大+8件の見込み。
- emergency_false_positive_review: 7日窓のemergency候補0件。誤検出0件で誤検出クラスなし。ただし実例母数0のため自然データ監視が必要。

## Tests

- important-news-monitor全runtime suite: 395 passed / 0 failed。
- dispatcher + personalized report regression: 48 passed / 0 failed。
- app presentation/label tests: 27 passed / 0 failed。
- 変更Expoアプリファイル限定TypeScript strict check: pass。
- iOS Expo export: pass（1,638 modules、Hermes bundle 4.3 MB）。
- `git diff --check`: pass。
- `deno check supabase/functions/important-news-monitor/index.ts`: 変更外の既知エラー `supabase/functions/_shared/x_oauth2_post.ts:66`（Uint8Array/BufferSource型差）で停止。変更ファイル由来の新規エラーは検出されていない。
- migrationはC1前の本番適用禁止を守り、PostgreSQL実行パーサでは未実行。静的契約テストとproduction schema read-only監査まで。

## Production / deployment

- production_changes: 0件。DB row/schema/RPC/user settings、Push、candidate、Cron、X、secretを変更していない。
- deploy_status: 未deploy。C1承認待ち。
- production_read_only_audit: schema/RLS/grants/RPC、migration履歴乖離、直近7日候補と現在audienceだけをread-only確認。通常の `supabase db push` / `--include-all` は未使用。

## Changed files

- `docs/news-coverage/REDESIGN.md`
- `src/app/news/[id].tsx`
- `src/app/news/index.tsx`
- `src/components/important-news-alert-settings.tsx`
- `src/lib/alert-settings.ts`
- `src/lib/important-news.ts`
- `src/lib/news-labels.ts`
- `supabase/functions/important-news-monitor/app_copy_logic.ts`
- `supabase/functions/important-news-monitor/app_copy_logic_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/market_critical_sql_static_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_wiring_test.ts`
- `supabase/functions/important-news-monitor/notification_presets_sql_static_test.ts`
- `supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`
- `tests/app/news-labels_test.ts`

## Remaining issues

- iOS simulator/Development Buildの実画面操作は未実施。未適用schema/RPCへ接続すると設定画面が失敗するため、C1後にexact migration適用とFunction deployを行ってから確認する。
- 新migrationの本番SQL実行、Function deploy、自然Cronでのenqueue/Push到達は未実施。
- 7日窓にemergency実例がなく、false-positive評価は自然候補で継続が必要。
- repository全体のtyped Deno suiteには上記の変更外型エラーがある。runtime suiteは全通過。

## Safety checks

- isolated clean worktreeを使用し、元worktreeの未コミット変更へ未接触。
- 最新 `origin/main` へrebase済み。競合なし。
- dispatcher/claim RPC、他Edge Function、他migration、Cron、X投稿、secrets、OAuth、他post_typeは変更なし。
- service roleはproducer RPCだけ。アプリはauthenticated/RLS経路だけを使用。
- synthetic/manual Push 0、synthetic candidate 0、production write 0。

## Push

- push: implementation commit `f7c17b915c551ba81b1dfc62a0731fd3eba6f008` と本completion control情報を `origin/main` / `origin/codex/broad-news-presets-phase3-20260913` へfast-forward同期済み。

## Next recommendation

`C1` でmigration SQL、legacy互換、通知量試算、app UI、producer境界をレビューする。承認後も一括db pushは使わず、exact migration適用 → 関数/ACL/RLS read-back → `important-news-monitor` のみdeploy → iOS Simulator/Development Build → 自然Cron監視の順で進める。

---

## Previous report — kabumori-x-oauth-recovery-20260913

- task_id: kabumori-x-oauth-recovery-20260913
- result: review_required — Kabumori本人OAuth再認証、暗号化token置換、refresh-only proof、本番read-backまで完了
- next_owner: chatgpt
- implementation_branch: `codex/kabumori-x-oauth-recovery-20260913`
- commit_hashes: `ed4c8c038e88274e59460997fa75e3f4721dfbf7`, `13cb948`
- push: `origin/codex/kabumori-x-oauth-recovery-20260913` へpush済み
- production_deploy: `x-oauth-connect` v13 ACTIVE / `verify_jwt=false`; 12 runtime filesをdeploy後にread-backし完全一致
- production_migrations:
  - repo `20260912232914_add_kabumori_oauth_recovery_rpc.sql` / production history `20260912235802`
  - repo `20260913000926_correct_kabumori_x_handle.sql` / production history `20260913010947`

## Root cause

- 2026-09-13 `morning_greeting` は既存refresh tokenでX token endpointがHTTP 400を返し、`X_TOKEN_REFRESH_FAILED:400` で失敗した。
- 本番開始probeでlegacy token storeは現行 `X_CLIENT_SECRET` 由来鍵により復号可能だった。このため「client secret変更 → legacy復号失敗 → server-secret fallback」の第一仮説は否定された。
- 旧refresh失敗のX response bodyは既存実装が保存していないため、`invalid_grant` 等の厳密なsubtypeは未確定。事実として確認できる範囲では、保存済みrefresh tokenがX側で無効だった。
- 初回再認証ではDBの誤登録handle `kabumori` と実アカウントが一致せず、token保存前に `X_IDENTITY_HANDLE_MISMATCH` で安全停止した。ユーザー確認で実X handleは `yume_daka` と判明し、固定allowlist・DB row・Kabumori専用RPCを訂正した。

## Changed files

- `supabase/functions/x-oauth-connect/index.ts`
- `supabase/functions/x-oauth-connect/start_logic.ts`
- `supabase/functions/x-oauth-connect/account_config.ts`
- `supabase/functions/x-oauth-connect/legacy_token_store.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery.ts`
- `supabase/functions/x-oauth-connect/rpc_test.ts`
- `supabase/functions/x-oauth-connect/account_config_test.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery_test.ts`
- `supabase/functions/_shared/brand/oauth_connection_test.ts`
- `supabase/migrations/20260912232914_add_kabumori_oauth_recovery_rpc.sql`
- `supabase/migrations/20260913000926_correct_kabumori_x_handle.sql`

## Implementation

- OAuth開始は既存admin JWTまたはDashboard secret-keyのPOST開始専用経路のみ。
- Kabumori/AI Labを固定allowlistで分離。AI Labは既存read-only scope、dry_run、Vault保存を維持。
- KabumoriはPKCE、random state、expiry、一回限りconsume、`GET /2/users/me` のhandle照合を通過してからlegacy token storeへAES-GCM暗号化保存。
- fresh refresh tokenを即時に一度rotateし、同じ保存先から再読込・復号後に `GET /2/users/me` で同一本人を再確認。
- Kabumori専用RPC 3件は `SECURITY DEFINER`、空の `search_path`、service roleのみEXECUTE。brand/account/handleを固定し、publish設定を変更しない。
- OAuth Function runtimeにはX投稿・media upload endpointを実装していない。

## Tests

- 対象テスト: 15 passed / 0 failed。
- Supabase Edge Function全テスト: 705 passed / 0 failed。
- `deno check --config supabase/functions/x-oauth-connect/deno.json supabase/functions/x-oauth-connect/index.ts`: pass。
- `git diff --check`: pass。
- 2つのmigrationをローカルPostgresのBEGIN/ROLLBACK内で検証。handle guard、state consume、本人完了、RPC ACL、空search_pathを確認し、永続テストデータ0件。
- Supabase advisors: 今回追加した3関数はmutable search_path / anon / authenticated SECURITY DEFINER警告の対象外。既存の別オブジェクトに関する警告は本タスクで変更していない。

## Production proof

- callback: success / `connection_status=identity_verified`。
- refresh-only proof:
  - X token endpoint 2xx
  - rotated tokenを暗号化保存
  - 同じruntimeで再読込・復号成功
  - `GET /2/users/me` で `yume_daka` 本人を再確認
  - X post API 0 call
  - media upload API 0 call
- `oauth_token_store` は2026-09-13 10:15 JST頃に更新され、有効期限は同日12:15 JST頃。暗号文と16文字base64 IVのみ保存されていることをread-only確認。
- `kabumori_x`: handle=`yume_daka`、`identity_verified`、platform user id設定済み、既存publish_enabled=trueを維持、Vault token refsなし。
- OAuth stateは2回ともconsume済み、unconsumed 0。初回handle mismatchではtoken metadata不変。
- publish claimsは開始前後ともtotal 11 / published 4。最新の9/13 morning_greeting claimは従来のfailedのままで、人工retryや新規投稿は行っていない。
- `ai_salaryman_lab_x` のidentity、Vault refs、`publish_enabled=false`、brand `dry_run` は開始前後で不変。
- Cron、scheduler、`x-test-post`、他Edge Function、他ブランド、Push領域は変更なし。

## Remaining issues

- 旧refresh tokenがX側で無効になった厳密な理由は、旧400 response bodyが記録されていないため確定不能。
- 自然Cron経路での次回投稿到達はまだ発生していない。手動投稿は禁止のため実施していないが、同じrefresh・保存・復号経路はrefresh-only proofで検証済み。

## Safety checks

- 手動X投稿0件、手動candidate/scheduled row注入0件、Cron変更0件。
- AI Lab token/Vault row変更0件、live化0件、publish有効化0件。
- secret/token/code/verifier値はGit・Report・DB平文列・Function responseへ記録していない。Dashboard secret keyはPOST開始専用の組み込み操作だけで使用。
- 本番DDLは上記2migrationのみ。通常の一括db push、`--include-all`、migration history修復は未実施。

## Next recommendation

`C1` で本報告と実装branchをレビューする。次回の自然投稿でpublish到達を確認し、旧9/13 failed rowは人工再実行しない。
