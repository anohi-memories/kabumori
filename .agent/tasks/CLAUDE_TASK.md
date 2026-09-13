# Claude Task 2

- task_id: x-multibrand-phase3g-ai-lab-live-readiness-20260913
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet 5
- purpose: 会社員AIラボの初回実X投稿直前まで安全に仕上げる。cross-brand dedupeを実データへ接続し、AI Lab posting windowを無効状態で準備し、brand_id→social_account→Vault token refsの実経路をread-onlyで証明する。まだlive化・X実投稿・write scope追加は行わない。

## Source of truth

会社員AIラボの投稿内容・文体・note送客・ブランド運用の正本は、別の「会社員AIラボ」ChatGPTプロジェクト側。今回も本repo側で新しい人格・投稿戦略を創作しない。

## Prior approved state

Phase 3F K2 PASS。

- Phase 3F commits: `b77c8c7` → `215eeff` on `feature/multibrand-foundation`
- `brand-post-dry-run` deployed and byte-verified
- real OpenAI generation confirmed with `brand_id=ai_salaryman_lab`
- AI Lab remains `publish_mode=dry_run`, `publish_enabled=false`
- X write calls = 0
- legacy Kabumori token reads on AI Lab path = 0
- AI Lab OAuth scopes remain read-only: `tweet.read users.read offline.access`
- `20260913130000_fix_post_execution_logs_brand_attribution.sql` production-applied and 10 RPCs read-back verified
- `20260913120000_add_published_content_fingerprints.sql` is still production-unapplied
- posting_windows for AI Lab not yet created
- live Vault token loader path not yet proven end-to-end
- Mio untouched

## Start / parallel safety

Before work:
- read `.agent/ORCHESTRATION.md`
- read `.agent/CURRENT_STATE.md`
- read this TASK
- read other active slot TASK files only for conflict detection
- fresh-check `origin/main`
- fresh-check `origin/feature/multibrand-foundation`
- use isolated clean worktree/clone
- do not touch/stage/commit existing uncommitted changes from another workstream

If any other slot is changing the same migration/RPC/Function/workflow/production config, stop and report the exact conflict.

Use Sonnet 5 normally. If a DB/RPC/Cron redesign or unclear production inconsistency appears, stop before broad changes and recommend Opus.

## Goal

Complete the final non-posting live-readiness layer for AI Lab:

1. safely production-apply `20260913120000_add_published_content_fingerprints.sql` if preflight matches expectations
2. replace synthetic cross-brand probe with a real-data dedupe path suitable for live routing
3. verify recent/published Kabumori content can be fingerprinted/read without cross-tenant leakage
4. prepare AI Lab posting window in production only as disabled/inactive
5. prove `ai_salaryman_lab -> social_account -> Vault token refs` resolution in read-only/no-secret mode
6. identify whether `publish_claims` needs brand-aware work before first live `brand_post`
7. leave AI Lab fully non-live at end

## A. published_content_fingerprints production migration

Migration candidate:
`supabase/migrations/20260913120000_add_published_content_fingerprints.sql`

Before applying:
- inspect exact migration SQL
- read-only preflight live schema for target table/index/function dependencies
- confirm no destructive DDL
- confirm no overlap with another slot
- confirm migration history mismatch does NOT require repair/reconcile

If safe and exact:
- apply only this exact migration
- `supabase db push` prohibited
- migration history repair/reconcile prohibited
- read back table/index/constraints/RLS/grants as applicable
- record exact production change

If live schema differs materially, do not apply; stop and report.

## B. Real-data cross-brand dedupe

Replace Phase 3F synthetic-only proof with a production-like real-data path.

Requirements:
- normalized exact duplicate across different brands must block
- distinct wording about the same broad topic must remain allowed
- same-brand behavior must not be accidentally over-blocked
- no full production post bodies in logs unless strictly necessary
- do not expose secrets
- preserve `brand_id` throughout

Use the new fingerprint table for actual recent published content where safe.

At minimum prove:
- a known published Kabumori post fingerprint can be read/represented
- an AI Lab candidate identical after normalization would block as cross-brand duplicate
- a sufficiently distinct AI Lab candidate would allow
- no Kabumori token/OAuth access is required for dedupe

Do not create a real X post just to test dedupe.

## C. AI Lab posting_windows preparation

Inspect current posting window schema/selection logic first.

Prepare AI Lab schedule only if it can be done without changing Kabumori behavior.

Production row is allowed only when:
- `brand_id=ai_salaryman_lab`
- disabled/inactive (`is_active=false` or exact equivalent)
- no Cron behavior can claim/publish it while inactive
- no existing Kabumori row is edited

Do NOT guess final posting times if not already specified by the AI Lab source-of-truth. If exact times are not known, either:
- create only a structurally valid disabled placeholder with clearly non-operational semantics, if safe, or
- leave DB unchanged and report the exact required input.

No Cron changes in Phase 3G.

## D. Vault token routing read-only proof

Verify the intended live routing:

`brand_id=ai_salaryman_lab`
→ social account lookup
→ Vault access_token/refresh_token references
→ token loader result metadata

Safety:
- do not print token values
- do not refresh tokens unless strictly required for a non-writing verification and explicitly safe
- no X POST/media upload
- no fallback to Kabumori legacy `oauth_token_store`
- no Kabumori OAuth/token mutation

Preferred proof returns only metadata such as:
- brand/account matched
- expected handle/account identity
- token refs present / resolvable
- token source = Vault-backed brand account
- legacy fallback used = false

If validating token liveness would require changing scopes or writing to X, do not do it in this phase.

## E. publish_claims readiness

Inspect whether `brand_post` requires `publish_claims` in the first live path.

- If not required for initial live AI Lab posting, document why and leave unchanged.
- If required and existing logic is Kabumori/default-brand dependent, draft the minimal brand-aware change and tests.
- Do not production-apply a broad publish_claims redesign in this task unless the change is trivially isolated and clearly required; otherwise leave for the next live-post task.

## F. Brand/account isolation

Add/keep tests proving:
- `ai_salaryman_lab` never resolves to `kabumori`
- AI Lab handle is `kaishain_ai_lab`
- Kabumori internal id remains `kabumori`, X handle remains `yume_daka`
- dedupe data lookup is cross-brand content-only, not cross-brand credentials
- AI Lab token route has zero legacy Kabumori token reads
- Mio is unaffected

## Required tests

At minimum:
- fingerprint normalization exact-match tests
- cross-brand real-table/proxy repository tests
- same-brand non-regression
- distinct-text allow case
- AI Lab brand attribution preserved
- AI Lab posting window inactive/non-claimable test if a row/path is added
- Vault route metadata-only test
- legacy Kabumori token fallback = 0 on AI Lab path
- existing Kabumori publish/generation regression tests
- all relevant Edge Function tests
- `git diff --check`
- `deno check` changed files; if blocked by known environment issue, prove same issue on unchanged baseline and report it

## Production changes allowed in Phase 3G

Allowed only after read-only preflight:
- exact `20260913120000_add_published_content_fingerprints.sql` migration
- an AI Lab posting-window row only in disabled/inactive state, if exact schedule semantics are known and safe
- deployment of a narrowly scoped read-only/dry-run helper Function if needed for proof

## Production prohibitions

Strictly prohibited:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- `tweet.write` / `media.write` scope addition
- AI Lab X post/test post/media upload
- Kabumori manual test/retry post
- Kabumori OAuth/token/handle/Cron changes
- Mio changes
- Cron changes
- blind `supabase db push`
- migration history repair/reconcile
- destructive DB change
- secret/token/password/2FA output or storage in Report

## Completion / Report

When finished:
- set status `review_required`
- set next_owner `chatgpt`
- append `## Report`
- safely sync control info to origin/main

Report must include:
- task_id
- result
- model_used
- source_base
- fingerprint_migration_status
- real_data_dedupe_result
- posting_window_status
- vault_token_routing_result
- publish_claims_readiness
- brand_isolation_result
- changed_files
- migrations/rpcs/functions changed
- tests
- production_changes
- deploy_status
- commit_hash
- push
- remaining_issues
- exact steps before first AI Lab live post
- safety_checks
- next_recommendation

## Success gate

Phase 3G PASS requires:
- cross-brand dedupe proven against real production-backed fingerprint data or an equivalently faithful production table path
- AI Lab posting window either safely prepared inactive or explicitly blocked pending exact source-of-truth schedule input
- Vault-backed AI Lab credential routing proven without exposing secrets and with zero Kabumori legacy fallback
- publish_claims requirement for first live post clearly resolved
- Kabumori regression tests pass
- AI Lab remains dry_run + publish_disabled
- X write = 0
- write scopes still absent
- no Kabumori/Mio/Cron regression

Phase 3G does NOT authorize the first live X post. That requires a separate explicit next task and user approval.
## Report

- task_id: x-multibrand-phase3g-ai-lab-live-readiness-20260913
- result: 成功。cross-brand dedupeを実データ（かぶモリの実際に公開済みのレポート本文4件）に接続し、実呼び出しで動作証明した。Vault token routingもbrand_id→social_account→Vaultトークン参照(uuid)の存在確認をread-only/no-secretで証明。posting_windowsは正本未確定のためDB変更なしで必要入力を明記。publish_claimsはbrand_postに不要と判断し変更なし。実装過程で1件、実バグ（存在しないカラムを参照していた）を実呼び出しで発見・修正・再検証済み。AI Labはlive化・実X投稿を一切行っていない。
- model_used: Claude Sonnet 5
- source_base: feature/multibrand-foundationを`215eeff`（Phase 3F, K2レビュー中）から開始し、本タスクのコミット`8f3b789`→`341e5dc`を積み上げ。他スロットとの競合なし（Codex slot1/slot2、Claude slot1いずれも別領域）。
- fingerprint_migration_status: `supabase/migrations/20260913120000_add_published_content_fingerprints.sql`を本番適用済み（ユーザー許可後）。適用前にexact migration SQLを検査し、対象テーブル未存在・FK型一致（`brands.id`/`social_accounts.id`ともにtext）・破壊的DDLなしをread-onlyで確認。適用は`supabase db query --linked --file`のみで実行（`db push`・migration history repair/reconcileは未使用）。適用後にread-backで以下を確認: 全7カラムが意図通りの型・NULL制約、両インデックス（`published_content_fingerprints_pkey`, `published_content_fingerprints_recent_idx`）、両FK制約とCHECK制約、RLS有効（`relrowsecurity=true`）、`anon`/`authenticated`への権限なし・`service_role`のみSELECT/INSERT。全て意図通りで異常なし。
- real_data_dedupe_result: 実装当初は`post_execution_logs.generated_text`を参照していたが、これは存在しないカラムだったため実呼び出しで`kabumori_posts_checked: 0`となる不具合が発生。ユーザー指示によりread-only調査を実施し、`information_schema.columns`で`post_execution_logs`に`generated_text`列が存在しないこと、実際の投稿本文は投稿タイプ別の`close_report_runs`/`morning_report_runs`/`us_premarket_report_runs`（各`generated_text`/`status`/`brand_id`列を持つ）に保存されていることを確認。read-onlyで実データ件数も確認（`close_report_runs`: `status=succeeded`かつ`brand_id=kabumori`が1件、`morning_report_runs`: 同3件、`us_premarket_report_runs`: 0件）。バックフィルは不要と判断（既存の実データをread-onlyで読めば足りるため）し、`kabumori_recent_fingerprints.ts`をこの3テーブルを並行クエリ・マージする実装に修正。修正版を再デプロイ・byte-verify後、実呼び出しで`kabumori_posts_checked: 4`（read-onlyで確認した件数と一致）、`result.blocked: false`（生成テキストがかぶモリの実データと十分異なるため、意図通り）を確認。生のかぶモリ投稿本文はこの関数内でハッシュ化のためだけに使われ、response・ログのいずれにも一切出力されない（返り値・レスポンスに本文が含まれないことをテストでも実データ呼び出しでも確認）。tip/interaction/useful_tip/morning_greetingは投稿ごとの本文を保存する列がスキーマ上存在しないためこの実データ窓の対象外（将来的に必要になれば別途スキーマ検討が必要）。
- posting_window_status: 変更なし。`posting_windows`には既にbrand_id列とbrand-aware unique index（`brand_id, post_type, slot_no`）が存在し、`plan_daily_posts()`も`is_active=false`の行は`where w.is_active`で完全に除外する設計であることをコード読解で確認済み（安全にinactive行を追加できることは技術的に確認済み）。ただしAI Labの実際の投稿時間帯・スロット数・daily_probabilityは会社員AIラボ側の正本が未確定のため、推測でのDB行追加はせず、DBは無変更のまま必要入力をremaining_issuesに明記した。
- vault_token_routing_result: `_shared/brand/vault_token_routing.ts`（新規）で`brand_id→social_accounts→Vaultトークン参照(uuid)`の存在確認のみを行う読み取り専用モジュールを実装（`vault.readSecret`/`vault.decrypted_secrets`への経路はコード上一切なし）。`brand-post-dry-run`のレスポンスへ`vault_token_routing`として配線し、実呼び出しで確認: `brandId=ai_salaryman_lab`, `socialAccountId=ai_salaryman_lab_x`, `handle=kaishain_ai_lab`, `oauthClientRef=default`, `connectionStatus=identity_verified`, `accessTokenRefPresent=true`, `refreshTokenRefPresent=true`, `tokenSource=vault_backed_social_account`, `legacyFallbackUsed=false`。トークン値そのものは一度も読まれておらず、レスポンスにも含まれない。
- publish_claims_readiness: `publish_claims`は`(post_type, date_jst)`のunique制約による「1日1回」TOCTOU対策で、実際のコード参照は`x-test-post/publish_claim_logic.ts`の`claimPublishSlot`/`completePublishSlot`/`failPublishSlot`のみ、呼び出し元は`morning_greeting`専用（`MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE`）であることをコード調査で確認。`brand_post`（AI Lab）はこの経路を一切呼び出さない。AI Labの初回live投稿は通常の`claim_due_post()`→`plan_daily_posts()`→`scheduled_posts`経路を想定しており、`scheduled_posts`自体に既にbrand-aware unique index（`brand_id, schedule_date, post_type, slot_no`）が存在するため、`publish_claims`の brand対応は不要と判断し、変更していない。
- brand_isolation_result: 新規`_shared/brand/brand_isolation_test.ts`（5テスト）で以下を一括検証: `ai_salaryman_lab`はid/code_profile_key/social_accountいずれもkabumoriと異なる、Kabumoriの内部id=`kabumori`・X handle=`yume_daka`が既存の正本`x-oauth-connect/account_config.ts`と一致、Mioには`resolveOAuthStartConfig`/`resolveOAuthCallbackConfig`いずれにも設定が存在せず例外で拒否される、AI Lab側`loadBrandXTokens`はfetch呼び出し前に拒否される（legacy token読込0）、Kabumori（`oauth_client_ref=default`）のみがlegacy storeへ到達する。Mioは本フェーズで一切変更していない（read-only確認のみ、Phase 3F時点のis_active=false/publish_mode=disabledから不変）。
- changed_files:
  - `supabase/functions/_shared/brand/kabumori_recent_fingerprints.ts`（新規→バグ修正）
  - `supabase/functions/_shared/brand/kabumori_recent_fingerprints_test.ts`（新規→バグ修正に伴い全面改訂）
  - `supabase/functions/_shared/brand/vault_token_routing.ts`（新規）
  - `supabase/functions/_shared/brand/vault_token_routing_test.ts`（新規）
  - `supabase/functions/_shared/brand/brand_isolation_test.ts`（新規）
  - `supabase/functions/_shared/brand/cross_brand_dedupe_probe.ts`（削除、Phase 3Fの合成probeを実データ経路へ置き換え）
  - `supabase/functions/_shared/brand/cross_brand_dedupe_probe_test.ts`（削除）
  - `supabase/functions/brand-post-dry-run/dry_run_handler.ts`（更新、実データdedupe+vault routing配線）
  - `supabase/functions/brand-post-dry-run/dry_run_handler_test.ts`（更新）
  - `supabase/functions/brand-post-dry-run/index.ts`（更新）
- migrations/rpcs/functions changed:
  - migration: `supabase/migrations/20260913120000_add_published_content_fingerprints.sql` — 本番適用済み
  - Edge Function: `brand-post-dry-run` — 更新・再デプロイ済み（バグ修正のため2回デプロイ: 1回目は実データ配線版、2回目はpost_execution_logs参照バグの修正版）。他のFunctionは一切デプロイ・変更していない。
- tests: `deno test --no-check --allow-env --allow-read --allow-net=127.0.0.1 supabase/functions`で769/769 pass（Phase 3F終了時点747 + 本フェーズ新規/更新22）。`git diff --check`で空白エラーなし。`deno check`は本フェーズ変更ファイルで新規エラーなし（`brand-post-dry-run/index.ts`のみ既知の`@supabase/functions-js/edge-runtime.d.ts`型解決問題があったが、これはPhase 3F由来の問題で既に対処済み。それ以外の`@types/node`解決エラーは既存未変更ファイルでも同一コマンドで再現する既知の環境要因で、リグレッションではない）。
- production_changes:
  1. `published_content_fingerprints`テーブルを新規追加（読み取り専用preflight → 適用 → read-back検証済み）
  2. `brand-post-dry-run` Edge Functionを更新・再デプロイ（2回、うち2回目はバグ修正）
  - 上記以外の本番変更なし（他Function、DB、OAuth、token、Cronは一切触れていない）
- deploy_status: 成功（2回）。1回目: 実データdedupe配線+vault routing追加版をデプロイ、byte-verify完全一致確認、実呼び出しで`kabumori_posts_checked: 0`という想定外の結果を検出。2回目: 原因調査後の修正版（`341e5dc`）を再デプロイ、byte-verify完全一致確認、実呼び出しで`kabumori_posts_checked: 4`を確認し修正を実証。両回とも`brand-post-dry-run`以外のFunctionはアップロード対象に含まれていないことをデプロイログで確認済み。
- commit_hash: `341e5dc`（`8f3b789`の後続）、feature/multibrand-foundationへpush済み
- push: origin/feature/multibrand-foundationへpush済み（`8f3b789`, `341e5dc`）
- remaining_issues:
  1. AI Labのposting_windows実行時間帯・スロット数・daily_probabilityは会社員AIラボ側ちゃでの確認が必要（確認でき次第、`is_active=false`の行として安全に追加可能なことは技術検証済み）
  2. `published_content_fingerprints`テーブルは作成済みだが、実際のlive publish完了経路からの書き込み配線（Kabumori/AI Lab双方）は別タスク（このテーブルへの書き込みが始まれば、read経路もこのテーブル優先へ切り替える設計変更が必要）
  3. tip/interaction/useful_tip/morning_greeting投稿タイプは本文保存列が無いため、cross-brand dedupeの実データ窓の対象外のまま（close_report/morning_report/us_premarket_reportのみ対象）
  4. Vault実tokenの生存確認（実際にリフレッシュ・使用可能かの検証）は本フェーズでは未実施（スコープ外、Section Dの指示通り）
  5. 管理者専用dry-run入口は依然`ai_salaryman_lab`のみ許可のハードコード
- exact steps before first AI Lab live post:
  1. 会社員AIラボ側ちゃでの実際の投稿方針（トピック配分・文面ニュアンス）確定（Phase 3F由来、継続）
  2. AI Labの投稿時間帯・スロット数・daily_probabilityの確定 → `posting_windows`へ`is_active=false`の行を追加 → レビュー後に`is_active=true`へ
  3. live publish完了経路から`published_content_fingerprints`への書き込み配線（Kabumori/AI Lab両方）
  4. Vault token loaderの実配線（`loadVaultBackedXTokens`を実際のdispatch経路へ接続）とtoken生存確認
  5. `tweet.write`等のwrite scope追加判断（AI Lab用に必要な場合のみ、別途承認）
  6. 管理者による最終レビューと、`publish_enabled=true`/`publish_mode=live`への段階的・手動承認ゲート付き切り替え
- safety_checks:
  - AI Lab: `publish_mode=live`にしていない / `publish_enabled=true`にしていない / write scope追加なし / 実X投稿・メディアアップロードなし（実呼び出しで`x_write_calls=0`を確認）
  - Kabumori: OAuth/token/ハンドル/Cron一切変更なし、実投稿・手動テスト投稿も一切なし
  - Mio: 一切触れていない
  - DBマイグレーション: 適用は`published_content_fingerprints`のみ、`db push`・migration history repair/reconcileは未使用、破壊的変更なし、事前・事後のread-only検証を実施
  - Vault: 実token値は一度も読み取っていない・表示していない（`vault_token_routing.ts`に`readSecret`呼び出し経路が存在しないことをソース検査テストで確認）
  - cross-brand dedupe: 生のかぶモリ投稿本文はresponse/ログに一切出力されない（ハッシュ化のみに使用、テスト・実呼び出し両方で確認）
  - 秘密情報: token/password/2FA/service role keyの値をチャット・ログ・Reportに一切記載していない
- next_recommendation: 次の技術タスクとして、(a) live publish完了経路から`published_content_fingerprints`への書き込み配線、(b) Vault token loaderの実配線とtoken生存確認、の2つを進めるのが良い。並行して会社員AIラボ側ちゃとの投稿時間帯・トピック確定を進め、両方揃った時点で`posting_windows`の`is_active=false`行追加→レビュー→段階的live化、という順序を推奨。
