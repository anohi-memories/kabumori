# Codex Report

## Latest H1 result — Phase 3I deployment gate (2026-09-14)

- task_id: `x-multibrand-phase3i-runtime-reconciliation-deploy-20260914`
- result: `review_required` — C1-approved candidate and production preflight were verified, but the execution environment's safety review blocked the production deploy before command execution. The review found that trusted user authorization covers review/push, not production deploy; task-file metadata alone is not sufficient. No workaround or alternate deploy path was attempted.
- candidate: branch `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`, exact commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`.
- tests: not rerun during this deploy-gating turn. The C1 report for this exact immutable candidate records 448/448 relevant tests passing and no new Deno type diagnostics versus the v107 baseline.
- preflight: `x-test-post` read-back was ACTIVE v107, `verify_jwt=false`, SHA-256 `54e8dae698415305185bb6e59f0cf4b1d12c0ca1df9750d44ff6d9772364fc71`. No deploy request was sent to Supabase.
- AI Lab read-only state: brand `is_active=true`, `publish_mode=dry_run`; account `ai_salaryman_lab_x`, handle `kaishain_ai_lab`, `connection_status=identity_verified`, `publish_enabled=false`; Vault reference presence checked only as booleans. No token/ref values read.
- candidate checkout: clean exact candidate commit before preflight. A temporary `supabase/config.toml` containing only the verified project ref and `x-test-post` `verify_jwt=false` was removed after the blocked attempt. No implementation source changed.
- production_changes: 0. No DB/RPC/migration, Edge Function, Cron, OAuth/token, publish setting, X, or media mutation. No function invocation or test post.
- next action: direct user approval is required for the exact `x-test-post` deploy from commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`, preserving `verify_jwt=false`. After approval, redeploy only if the same preflight still matches, then immediately byte-compare read-back and perform non-posting checks.
- control_sync: this report, slot-1 task status, and current state are being synced to `origin/main`; no implementation commit was changed.

- task_id: `x-multibrand-phase3i-runtime-reconciliation-20260914`
- result: `review_required` — source reconciliation passed local tests and was pushed for C1 review. Production remains on `x-test-post` v107; no deploy or new DB operation was performed.
- model_used: GPT-5.6 Sol
- production_source_base: `25998fc8927d8bd45a89478b1fec8b4bc5ba782b` (recorded v107 source, independently proven below)
- control_base: fresh `origin/main` `97c624267ab9d2ecb0b03487d5c5cdacdc5ab8dd`
- reviewed_source: Phase 3H commits `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b` and `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
- candidate_branch: `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`
- candidate_commit: `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`
- push: candidate branch pushed to `origin` for C1 review; no force push.
- production_project: `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`), ACTIVE_HEALTHY, Postgres 17.6, `ap-northeast-1`.

## Latest H1 result — Phase 3I runtime reconciliation

### Proven v107 baseline

- `supabase_get_edge_function(x-test-post)` returned ACTIVE version 107, `verify_jwt=false`, 27 runtime files, aggregate SHA-256 `54e8dae698415305185bb6e59f0cf4b1d12c0ca1df9750d44ff6d9772364fc71`.
- Each of the 27 API-returned file contents was compared directly with commit `25998fc8927d8bd45a89478b1fec8b4bc5ba782b`; all 27/27 were byte-identical. The deployed API entrypoint also pointed to this recorded source checkout.
- A second read-only function read after the candidate push still returned version 107 and the same aggregate hash; all 27/27 files matched the pre-work read exactly.
- v107 runtime file list:
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/functions/x-test-post/morning_report_logic.ts`
  - `supabase/functions/x-test-post/us_session_date_logic.ts`
  - `supabase/functions/x-test-post/close_report_logic.ts`
  - `supabase/functions/x-test-post/fixed_hashtags_logic.ts`
  - `supabase/functions/x-test-post/voice_retry_logic.ts`
  - `supabase/functions/x-test-post/close_report_data_logic.ts`
  - `supabase/functions/x-test-post/report_voice_rewrite_logic.ts`
  - `supabase/functions/x-test-post/us_premarket_logic.ts`
  - `supabase/functions/x-test-post/interaction_quality_logic.ts`
  - `supabase/functions/x-test-post/tip_voice_logic.ts`
  - `supabase/functions/_shared/kabumori_voice.ts`
  - `supabase/functions/x-test-post/voice_evaluation_logic.ts`
  - `supabase/functions/x-test-post/report_material_logic.ts`
  - `supabase/functions/x-test-post/morning_candidate_logic.ts`
  - `supabase/functions/x-test-post/morning_lane_response_logic.ts`
  - `supabase/functions/x-test-post/morning_report_retry_logic.ts`
  - `supabase/functions/x-test-post/admin_auth_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_image_logic.ts`
  - `supabase/functions/x-test-post/yume_reference_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_payload_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_scene_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
  - `supabase/functions/x-test-post/publish_claim_logic.ts`
  - `supabase/functions/_shared/x_oauth2_post.ts`
  - `supabase/functions/x-test-post/useful_tip_generation_logic.ts`

### Reconciliation and three-way diff

- v107 → candidate: only `x-test-post/index.ts` changes among the 27 existing runtime files; the other 26 remain byte-identical. Twelve imported brand runtime modules were added for brand context, guarded token routing, AI Lab generation/dispatch, length enforcement, fingerprints, and dedupe.
- Phase 3H `406b53c` → candidate: the three unrelated files `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts` remain at the proven v107 bytes. The unrelated TOPIX/report prompt and live-close selection hunks in `index.ts` were also restored to v107. The approved AI Lab Vault-backed dispatch and completion safeguards remain.
- Non-imported brand context dry-run routing and unrelated standalone OAuth/Vault metadata helper modules/tests from `406b53c` were not carried into this deploy candidate. This keeps the runtime candidate limited to modules imported by the reconciled `x-test-post` path. The two migration files are included unchanged from `406b53c` for source traceability/static security testing; they were not executed in this task.
- Existing-file edits are limited to `x-test-post/index.ts` and two tests whose ordering assertions now match deferred X-auth construction after scheduled-row brand selection. The close-report and hashtag source files and tests are unchanged from v107.

### Changed files

- Runtime entry: `supabase/functions/x-test-post/index.ts`.
- New runtime modules under `supabase/functions/_shared/brand/`: `ai_lab_brand_post_store.ts`, `ai_lab_scheduled_brand_post.ts`, `ai_lab_vault_token_source.ts`, `brand_context.ts`, `brand_post_dispatch_guard.ts`, `brand_post_generator.ts`, `brand_profiles.ts`, `cross_brand_dedupe.ts`, `kabumori_recent_fingerprints.ts`, `post_length_policy.ts`, `publish_guard.ts`, `token_loader.ts`.
- New/updated tests under the same directory: `ai_lab_brand_post_store_test.ts`, `ai_lab_scheduled_brand_post_test.ts`, `ai_lab_vault_token_source_test.ts`, `brand_context_test.ts`, `brand_post_dispatch_guard_test.ts`, `brand_post_generator_test.ts`, `brand_profiles_test.ts`, `cross_brand_dedupe_test.ts`, `dispatch_gate_test.ts`, `kabumori_recent_fingerprints_test.ts`, `post_length_policy_test.ts`, `publish_guard_test.ts`, `token_loader_test.ts`.
- Updated tests in `supabase/functions/x-test-post/`: `morning_greeting_payload_logic_test.ts`, `morning_greeting_publish_logic_test.ts`.
- Included exact, unchanged source files for the migrations already applied in the prior authorized task: `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`, `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`.

### Tests and safety

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 448 passed / 0 failed. Includes 279/280 pass, 281 blocked, dry-run no X callback, fixed AI Lab Vault routing/no legacy fallback/no refresh, duplicate blocking, confirmed-success completion and uncertain-completion duplicate-resend protection, plus Kabumori, close-report, TOPIX-source, and fixed-hashtag regressions.
- `deno check --no-config supabase/functions/x-test-post/index.ts`: six diagnostics, exactly the same six as clean v107 baseline `25998fc` (AES-GCM `Uint8Array/BufferSource`, image `BlobPart/BodyInit`, `retry_count`, timestamp precision). No new diagnostic from reconciliation.
- `deno fmt --check` on the ten core Phase 3H helper/test files: pass. A broader check of the curated 25-file brand directory still reports 10 files from the reviewed source as unformatted; no formatting-only edits were made.
- `git diff --check`: pass.
- Production read-back after work: `x-test-post` still ACTIVE v107, `verify_jwt=false`, same 27 files/hash. No Function deploy, runtime invocation, SQL/migration execution, DB write, migration history edit, Cron/settings/OAuth/token change, X post, or media upload. X/media writes: 0.

### Remaining gate

Candidate awaits C1 review. Stop before any Edge Function deploy; a separate explicit deploy authorization is required after C1. The two pre-existing Phase 3I migrations remain applied and must not be reapplied or replaced.

## Previous task metadata — Phase 3I pre-live rollout

- task_id: `x-multibrand-phase3i-ai-lab-production-prelive-rollout-20260914`
- result: `review_required` — both explicitly authorized migrations were applied and read back successfully. Stopped before Function deploy after discovering material differences between current production `x-test-post` and the exact reviewed commit that would replace non-Phase-3H code.
- model_used: GPT-5.6 Sol
- source_commit: `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`; fresh fetch of `origin/codex/ai-lab-prelive-safeguards-20260913` confirmed the exact remote HEAD. Both reviewed migration files exist in that commit; SHA-256: `342119d0ae523f0eb93a5d6b233395e9f326d7ce79c172f2e61b518e6f205ce6` (`20260913123509_ai_lab_prelive_safeguards.sql`), `88316c9e57f69c719db503fe184ab8cc806d04ebce1c08a70b04f8d544d34317` (`20260913151428_read_ai_lab_x_vault_token.sql`).
- control_base: `6c4a05a9e6aa583d5a7336aac7e41b3ca7af54fb`.
- production_project: `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`), ACTIVE_HEALTHY, Postgres 17.6, `ap-northeast-1`.

## Previous Phase 3I preflight and rollout results

- migrations_applied: only `20260913123509_ai_lab_prelive_safeguards.sql` and `20260913151428_read_ai_lab_x_vault_token.sql`, both read from exact commit `406b53c2...`. Supabase recorded `20260913230852` / `ai_lab_prelive_safeguards` and `20260913231013` / `read_ai_lab_x_vault_token`. No other SQL/migration applied.
- migration_readback: `complete_ai_salaryman_lab_brand_post(uuid,text,text)` and `read_ai_salaryman_lab_x_vault_token(uuid)` are present, both `SECURITY DEFINER`, empty `search_path`, service_role EXECUTE true and anon/authenticated false. Function bodies match the reviewed fixed brand/account/type/handle/identity/ref guards; completion marks only a matching running AI Lab `brand_post` row succeeded after confirmed success and handles fingerprint/log failure without repost eligibility. Partial unique `(social_account_id,x_post_id) WHERE x_post_id IS NOT NULL` index exists. Vault reader was not invoked.
- grants_and_policies: RLS is enabled but not forced on the five checked tables. There are no listed policies on `brands`, `social_accounts`, or `published_content_fingerprints`; `scheduled_posts` and `post_execution_logs` each have an authenticated SELECT policy. Catalog grants also show existing `anon`/`authenticated` REFERENCES, TRIGGER, and TRUNCATE privileges on `scheduled_posts` / `post_execution_logs`, plus authenticated SELECT; this task did not change them. These existing grants need owner review and are not treated as authorization to broaden or repair production permissions here.
- preflight: AI Lab brand is active and `dry_run`; account is `ai_salaryman_lab_x`, handle `kaishain_ai_lab`, `identity_verified`; `publish_enabled=false`. Vault reference presence was checked only as booleans; no reference identifiers or token values were read. `x-test-post` remains v107 ACTIVE / `verify_jwt=false`.
- x_test_post_deploy: none. Production remains v107 ACTIVE / `verify_jwt=false`.
- deployed_source_verification: before deployment, downloaded v107 runtime comparison showed 27 production files vs 40 source-commit modules; 23 were byte-identical, 13 target brand helpers are new, and four existing files differ. `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts` are unchanged by Phase 3H but differ from current production; `index.ts` also differs. Deploying the exact reviewed commit would replace the three non-Phase-3H files, so deployment was stopped to avoid a potential regression of other post types.
- non_posting_runtime_verification: no runtime invocation; X POST/media calls: 0.
- ai_lab_length_guard_result: production runtime not exercised. Reviewed source test suite passed 460/460.
- vault_route_result: fixed AI Lab account metadata still matches `ai_salaryman_lab_x` / `kaishain_ai_lab` / `identity_verified`, publish disabled, both ref columns present; reader ACL/body verified. No token/ref value was read and no token was refreshed.
- fingerprint_dry_run_result: dry-run not invoked; unique index exists; no fingerprint rows were inserted by this task.
- posting_window_status: no AI Lab posting window was present in the prior read-only state; none was created or changed. Exact schedule values remain unsupplied.
- write_scope_status: no OAuth scope change; AI Lab remains read-only (`tweet.read users.read offline.access`).
- tests: `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460/460 pass. Changed-file `deno check --no-config` returns six diagnostics; running the same check at clean base `341e5dc` produces the same six (Uint8Array/BufferSource, Blob/BodyInit, `retry_count`, timestamp precision), so no new type diagnostic. `git diff --check` on reviewed source: pass. Supabase security advisor returned no findings for the two new RPCs; unrelated existing warnings remain.
- production_changes: exactly the two approved migrations (recorded versions above). No Edge Function deploy, runtime invocation, X/media call, Cron/posting-window, OAuth, token, publish flag, or unrelated service change.
- unchanged_components: `important-news-monitor`, other Edge Functions, Cron, OAuth scopes/secrets, Kabumori, Mio, publish flags, and X posting.
- blocker: current production `x-test-post` contains existing code absent from the exact reviewed source commit. The migration layer is complete, but deploy is paused because replacing three unchanged-by-Phase-3H files could regress other post types.
- exact_steps_before_first_live_post: reconcile the production-source drift with a fresh reviewed commit or an explicit decision that the identified existing runtime files may be replaced; deploy/read-back only after that gate; separately supply posting-window values; separately authorize `tweet.write` reauthorization and verify `/2/users/me`; separately approve any publish enablement and first real post. No live/posting step is authorized here.
- safety_checks: only the two explicitly approved migration files changed production schema. No secrets/token values or Vault identifiers were read or recorded; no data rows, Edge Function runtime, publish flags, OAuth scopes, Cron, X post, or media upload were changed.
- next_recommendation: keep v107 deployed until the user resolves the exact-source regression risk; then re-review/deploy only the chosen `x-test-post` source. Do not reapply the two migrations.

---

## Phase 3H implementation details (previous report, carried forward)

## Length policy

- length_policy_design: shared discriminated union: finite `{mode: "limited", maxChars: positive integer}` or explicit `{mode: "unlimited", maxChars: null}`. Suitable for future app settings; no magic large maximum.
- Character counting uses JavaScript Unicode code points (`Array.from(text).length`): Japanese code points count one each and a surrogate-pair emoji such as 😀 counts one. This is not claimed to match X weighted-length rules.
- ai_lab_280_char_result: AI Lab profile sets 280. The generation prompt requests the limit; post-generation validation fails closed above 280 without truncation or retry. Tests cover 279/280 pass and 281 rejection, including Japanese and surrogate-pair emoji cases.
- unlimited_mode_design: tested explicitly; removes only the finite count limit. Brand, post type, and publish gates remain separate.
- Kabumori regression: its profile remains without a finite policy and retains the previous 200–400-character prompt; no live Kabumori dispatch code changed.
- dispatch_length_guard_result: wired into the AI Lab scheduled `brand_post` path and independently rejects over-limit text immediately before X dispatch. Wrong brand/type fails closed. No live post was made.

## Fingerprints / dispatch

- fingerprint_persistence_result: after a confirmed X success, `x-test-post` calls `complete_ai_salaryman_lab_brand_post`, which inserts the normalized-content fingerprint under a unique `(social_account_id, x_post_id)` key and marks the scheduled row terminal. Fingerprint insert failure is reported while terminal completion prevents automatic repost. If completion confirmation itself is uncertain after X success, a dedicated error path skips generic scheduled-post failure/retry handling to avoid duplicate resend. Dry-run does not call this live completion path; regression-tested.
- vault_dispatch_routing_result: AI Lab scheduled `brand_post` routes only through the fixed `ai_salaryman_lab_x` account, expected handle `kaishain_ai_lab`, `identity_verified` state, and that row's Vault token reference. A new local SQL RPC returns only the referenced token for that fixed account and is executable by `service_role` only. AI Lab has no fallback to Kabumori `oauth_token_store`; refresh is disabled. No token value was read or logged.
- posting_window_status: no AI Lab/`brand_post` posting-window row was present in the prior read-only check; none was added. Exact source-of-truth values still needed: post type confirmation, local start/end time(s), timezone, slot count/slot numbers, and `daily_probability` per slot.
- write_scope_readiness: no OAuth scope change or reauthorization. Existing AI Lab scopes remain read-only (`tweet.read users.read offline.access`); text posting requires separately approved `tweet.write`. `media.write` is only needed for a future media-upload flow. Before enabling publishing, separately reauthorize and verify `/2/users/me` still returns `kaishain_ai_lab`. No scope is authorized by this task.

## Files and database code

- changed_files:
  - `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/ai_lab_vault_token_source.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/post_length_policy.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_profiles.ts`
  - `supabase/functions/_shared/brand/brand_post_generator.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_post_dispatch_guard.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_post_dry_run_test.ts`
  - `supabase/functions/_shared/brand/kabumori_recent_fingerprints.ts` / `_test.ts` (optional strict failure mode for future live dedupe; existing default fail-safe behavior unchanged)
  - `supabase/functions/_shared/brand/ai_lab_brand_post_store.ts` / `_test.ts`
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`
  - `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`
- migrations/rpcs/functions_changed: two **local, unapplied** migrations. The first adds fingerprint idempotency and `complete_ai_salaryman_lab_brand_post`; the second adds fixed-account `read_ai_salaryman_lab_x_vault_token` (`SECURITY DEFINER`, empty `search_path`, `service_role` EXECUTE only). `x-test-post` is the only Edge Function source changed; it is not deployed.

## Tests

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460 passed / 0 failed, including AI Lab routing/guard/completion and Kabumori regression tests.
- `deno check --no-config` for the changed helpers and `x-test-post/index.ts` reports the same six pre-existing diagnostics as a clean source-base checkout. They concern AES-GCM `Uint8Array`/`BufferSource`, `Uint8Array` Blob/body typing, missing `retry_count`, and unknown timestamp precision. No new type issue was identified versus baseline.
- `deno fmt --check` on the five new helper/test/migration files: pass. `git diff --check`: pass. The existing ~4.5k-line `x-test-post/index.ts` was not reformatted wholesale.
- Test files ran with `--no-check` because this worktree has no installed `npm:@types/node`; changed non-test modules were separately type-checked. SQL was not applied or executed in a local Postgres instance; `psql`/Docker were unavailable.

## Production, blocker, and next steps

- production_changes: 0. This code-only continuation did not access production. The prior read-only state remains the last verified state: AI Lab `publish_mode=dry_run`, `publish_enabled=false`; no token values were read. No production DDL/data/RPC write occurred.
- deploy_status: none; no Edge Function deployed. X POST/media calls: 0. Cron, OAuth scopes, secrets, account settings, Kabumori, and Mio were not changed.
- remaining_issues: C1 review. Separately, static/review and exact approval are needed before applying either local migration; production deploy/read-back; confirmed schedule data; separately approved `tweet.write` reauthorization and identity check; separate approval before changing live flags or sending a first post. iOS is not relevant to this Edge Function task.
- exact steps before first AI Lab live post: (1) C1 review this code and both migrations; (2) obtain separate exact approval before applying the two migrations, then read back function definition/ACL and verify the fixed account/token reference guard; (3) obtain separate approval before deploying only `x-test-post`, then verify deployed source/version; (4) confirm exact AI Lab posting-window values from its source of truth (do not invent or change Cron); (5) separately approve OAuth reauthorization adding `tweet.write` while retaining current read scopes, then use read-only `/2/users/me` to verify `kaishain_ai_lab`; (6) only after separate explicit approval may publishing flags be changed and a first real X text post be sent. No step beyond local implementation/testing is authorized here.
- safety_checks: no live mode/publish enablement, DB change, deploy, X post, media upload, token refresh, OAuth scope change, Cron/posting-window change, Kabumori token/path change, or Mio change. AI Lab routing has no legacy fallback and does not refresh. Secret/token values were not emitted to logs, responses, Git, or this report.
- next_recommendation: C1 review the pushed branch/diff and commit integrity. Stop here; do not apply migrations, deploy, change OAuth scopes or publishing flags, or send an X post without their separate explicit approvals.

---

## Previous Codex report — broad-news-display-and-notification-presets-phase3-20260913

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
