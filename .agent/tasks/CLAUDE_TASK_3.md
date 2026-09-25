# Claude Task 3

- task_id: x-universal-oauth-refresh-productionization-20260925
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: 会社員AIラボで連続発生している X_REQUEST_FAILED:401 を根本修復し、今後追加する全ブランド・全ユーザーのXアカウントで同じ事故を繰り返さない、exact-account / Vault-backed / refresh-token-rotation-safe な共通OAuth refresh基盤をproduction-readyにする。Phase1Iでレビュー済みのexact-account refresh実装を土台にし、AI Lab固有のallowRefresh=false暫定経路を廃止可能な共通アカウント経路へ統合する。production activation/deploy/real token refreshはCodexレビュー前に行わない。

## Incident facts — read-only confirmed

Project: stock-x-autopost

AI Lab social account:
- id: `ai_salaryman_lab_x`
- brand_id: `ai_salaryman_lab`
- handle: `kaishain_ai_lab`
- publish_enabled: true
- connection_status: identity_verified
- Vault access-token ref: configured
- Vault refresh-token ref: configured
- oauth_client_ref: default

Observed:
- last confirmed successful AI Lab post: 2026-09-23 22:33 UTC / 2026-09-24 07:33 JST
- first confirmed `X_REQUEST_FAILED:401`: 2026-09-24 00:51 UTC / 09:51 JST
- all observed AI Lab brand_post attempts after that have failed with 401
- current live `x-test-post` loads AI Lab tokens from Vault but explicitly sets `allowRefresh:false`
- `postToX()` therefore throws immediately on 401 without using the configured refresh token
- `social_accounts.connection_status` remains `identity_verified` and `last_connection_error_code` remains null despite persistent 401s, so observability/state is misleading

Important:
- do not assume the refresh token itself is invalid
- do not log/read out plaintext tokens to reports
- do not touch Kabumori legacy credentials as a shortcut

## Architectural goal

Build one generic X credential lifecycle for every current/future social account:

`scheduled/queued post -> exact social_account_id -> exact account metadata -> exact Vault refs -> access token -> pre-X refresh decision / 401 recovery -> OAuth token endpoint -> rotate only that exact account's Vault secrets -> commit account refresh state -> retry the intended X request at most once when safe`

Required properties:
- no brand-first lookup
- no first-row lookup
- no hardcoded AI Lab account exception
- no fallback to another brand/account's token
- no fallback to Kabumori `oauth_token_store` for a Vault-backed account
- exact `social_account_id` is the authority
- access and refresh Vault refs must belong to that same account and be distinct
- refresh request is single-attempt, manual-redirect, no blind retry
- refresh token rotation handled safely
- stale account/attempt/ref mutation cannot commit
- provider-started X write must never trigger refresh replay
- unknown/ambiguous provider outcome becomes `uncertain`, not automatic replay
- invalid_grant / revoked refresh credential becomes `reauth_required`
- connection state exposed truthfully

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read G3 Phase1I TASK/Report and H1/C1 Phase1I review
5. Fresh fetch `origin/main`
6. Confirm dedicated independent G3 worktree/checkout
7. Confirm no overlap with active G4 `apps/admin/**` work
8. Inspect current:
   - `supabase/functions/x-test-post/index.ts`
   - `supabase/functions/_shared/brand/*token*`
   - Phase1I refresh helper/migration/tests
   - `social_accounts` schema/state fields
   - Vault read/write RPCs
   - X OAuth connect/reconnect flows
   - current scheduler/claim path
9. Read production definitions/grants in read-only mode where needed
10. Do not deploy/apply/refresh real tokens before review

## Scope A — immediate incident containment design

Do not silently leave AI Lab in an endless failing state.

Implement source/state handling so repeated 401s lead to an explicit account health state rather than endless opaque failure:
- classify access-token unauthorized separately from generic X request failure
- preserve `identity_verified` only when appropriate
- expose/use `refreshing`, `connected/identity_verified`, `reauth_required`, `uncertain` or the closest existing reviewed state model
- maintain a fixed non-secret `last_connection_error_code`
- repeated scheduled jobs for a known `reauth_required` account must fail closed before generation/X write, without consuming unnecessary OpenAI generation cost
- do not create automatic infinite retry loops
- do not disable all brands globally

If a minimal production-only emergency containment mutation is truly required before reviewed activation, STOP and report the exact proposed mutation; do not perform it in this implementation task.

## Scope B — generalize Phase1I to all Vault-backed social accounts

Reuse the reviewed Phase1I exact-account lease/commit model instead of creating a parallel weaker refresh system.

Generalize hardcoded/special-case parts so the common refresh path accepts the exact account resolved from the post/claim.

It must validate:
- exact social_account_id
- brand_id matches post/claim
- platform = x
- publish_enabled = true
- connection state allows publish/refresh
- oauth_client_ref resolves to an approved server-side client configuration
- access/refresh Vault refs exist, are valid, distinct and exclusively owned as required
- account identity/ref snapshot remains unchanged through commit
- attempt/post remains eligible and pre-X
- no provider step has started

No caller may pass arbitrary Vault secret IDs as authority.

## Scope C — OAuth client routing for future accounts

Make `oauth_client_ref` a real server-side routing key rather than AI-Lab-specific hardcoding.

Requirements:
- approved mapping from `oauth_client_ref` -> server-side client id/client secret configuration
- client secret never stored in social_accounts/client/browser/logs
- unknown client ref fails closed with fixed error
- support current `default` client safely
- architecture should allow additional OAuth client registrations later without source changes to account-specific logic
- no user-controlled URL/token endpoint
- token endpoint remains fixed X endpoint

Do not expose secrets in admin/mobile bundles.

## Scope D — refresh policy

Support both:
1. proactive refresh when trustworthy expiry/refresh-needed state says refresh is required before X provider-start
2. reactive refresh on a first X 401 only when the X request is known not to have been accepted/provider-started and the operation is safe to retry

Rules:
- max one refresh execution per publish attempt
- max one retry of the exact intended X request after successful refresh
- never refresh after durable provider-start
- never retry ambiguous/non-idempotent provider outcomes
- redirect disabled/manual
- network/timeout/408/5xx/ambiguous -> uncertain; no blind replay
- invalid_grant / invalid refresh credential -> reauth_required
- malformed 2xx -> fail closed
- rotated refresh token updates both exact Vault refs atomically as far as Phase1I reviewed DB/Vault boundary permits
- if provider omits new refresh token, preserve the existing refresh token
- no token value in error text/log

## Scope E — live dispatch integration, source-only candidate

Replace the AI Lab `allowRefresh:false` dead-end with the common exact-account refresh port.

Also make the integration suitable for every future Vault-backed X account.

Important:
- do not switch Kabumori legacy credential source blindly in this task if it is not yet Vault-backed
- preserve current Kabumori behavior unless a clean migration path is explicitly part of the reviewed design
- new/future accounts must default toward the generic Vault-backed resolver, not a new brand-specific helper
- remove/retire AI-Lab-only credential branching where safe, but do not break production before reviewed rollout

## Scope F — account health / observability

Ensure operators can distinguish:
- healthy/connected
- refresh in progress
- reauth required
- uncertain/manual reconciliation required
- generic publish error

At minimum update/consume existing:
- `connection_status`
- `last_connection_error_code`
- `verified_at` or a better existing reviewed timestamp where semantically correct

Do not mark a credential healthy merely because the identity was verified days ago.

Add deterministic fixed error codes for:
- access token unauthorized
- refresh invalid_grant / revoked
- refresh timeout/network/5xx uncertainty
- account changed during refresh
- Vault write/commit failure
- unsupported oauth_client_ref

No plaintext provider response body in persisted errors.

## Scope G — tests

Add adversarial tests covering at least:

### AI Lab incident reproduction
- valid Vault refs + expired/invalid access token
- X first request 401
- generic refresh path runs once
- rotated token committed to same exact account
- exact request retried once
- succeeds without touching Kabumori credentials

### future account
- a second synthetic brand/social account works via the same generic resolver without code special-casing that brand
- distinct Vault refs and account identity preserved

### cross-account safety
- wrong social_account_id
- brand/account mismatch
- shared/swapped access ref
- shared/swapped refresh ref
- ref changed mid-refresh
- account disabled mid-refresh
- oauth_client_ref changed mid-refresh
- attempt settled mid-refresh
- provider-started attempt cannot refresh
- stale lease cannot commit

### provider semantics
- invalid_grant -> reauth_required
- timeout/network/5xx -> uncertain
- 3xx not followed
- malformed 2xx
- rotated refresh token
- omitted refresh token preserves old
- second 401 after one refresh fails closed
- no infinite retry

### observability
- repeated known reauth_required stops before generation/X call
- healthy state restored only after successful verified refresh/reconnect
- error codes contain no token material

Rerun:
- Phase1I focused/helper/static/dispatcher
- Phase1B–1I focused
- x-test-post full
- _shared
- important-news-monitor
- greeting/tip-specific
- disposable PostgreSQL Phase1I behavior/concurrency
- relevant Phase1D/E/F/G/H proofs
- deno check/lint
- bash -n
- git diff --check
- targeted secret scan

## Scope H — rollout plan (document, do not activate yet)

Produce an explicit staged production plan:

Stage 0:
- live schema/function/grant/read-back
- exact account rows and Vault ref ownership checks
- confirm AI Lab refresh ref exists without revealing secret

Stage 1:
- apply only reviewed required migration/RPC changes
- deploy exact reviewed Edge source
- keep any new global gate OFF if introduced

Stage 2 — AI Lab recovery:
- controlled single refresh/post-safe validation for `ai_salaryman_lab_x`
- prove only AI Lab refs changed
- prove Kabumori refs/store unchanged
- verify connection_status/error cleared correctly
- restore scheduled posting only after safe success

Stage 3 — generic future-account proof:
- synthetic/dry-run or non-posting account-path proof
- no real X write required

Stage 4:
- enable generic refresh policy for all Vault-backed accounts
- monitor reauth_required/uncertain/refresh success counts
- rollback plan

Do not execute these stages before ChatGPT K3 + Codex review.

## Production mutation budget

This implementation task:
- DB/schema/migration apply: 0
- Edge deploy: 0
- real OAuth refresh/token rotation: 0
- production Vault write: 0
- real X API post/media: 0
- Cron/settings mutation: 0
- business-data mutation: 0

Read-only production inspection is allowed.

## Forbidden

- reading/logging plaintext Vault tokens into Report
- copying token values into env/files/issues
- changing Kabumori legacy tokens as a shortcut
- brand-first/first-row credential fallback
- arbitrary secret-id caller authority
- blind retry after ambiguous provider result
- more than one refresh per attempt
- automatic reauth user impersonation
- OAuth/Vault/DB production activation before independent review
- G4 `apps/admin/**` changes
- overwriting H2 deferred task
- unrelated cleanup/refactor

## Completion / K3

Report:
- exact root cause confirmation
- architecture before/after
- changed files
- whether AI Lab special-case refresh dead-end is removed
- how future accounts use the same path
- account health state model
- provider retry/ambiguity semantics
- exact-account/Vault safety proof
- tests/counts
- production read-only findings
- production mutation=0
- rollout plan
- remaining blockers
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3

Because this crosses OAuth/Vault/X publish/concurrency boundaries, independent Codex review is mandatory before production activation.

## Review routing after K3

Expected:
- H1 if free
- recommended model: Codex Sol（高）
- review scope should be tightly limited to OAuth/Vault/exact-account/concurrency/production rollout safety, not a broad repo review

## Report

- task_id: x-universal-oauth-refresh-productionization-20260925
- result: K3 ready — source-only implementation complete; production mutation 0. Needs Codex review (H1, Sol高) before any activation.
- root_cause (read-only confirmed): live `x-test-post` built AI Lab auth with `allowRefresh:false`, so the first expired-access-token 401 threw `X_REQUEST_FAILED:401` without ever using the stored refresh token. Last success 09-23 22:33 UTC; every AI Lab run from 09-24 00:51 UTC failed with 401 (19 consecutive by 09-25 13:24 UTC), while `social_accounts` still showed `identity_verified` / null error. Each failed run also paid for generation before the 401. Production has no v2 chain (1B–1I unapplied) and `scheduled_posts` has no `social_account_id`, so reviewed Phase1I alone could not serve the live path.
- architecture:
  - before: Kabumori → `oauth_token_store`/env + legacy refresh; AI Lab → hardcoded Vault reader, no refresh (dead-end); future brands → no resolver.
  - after: standalone core migration `20260925140000_x_account_credential_refresh_core.sql` (applies alone on the current production baseline) owns the single per-account lease table `x_account_refresh_state_v2` (lease kinds `legacy_post` / `v2_attempt`), `read_x_publish_credential_for_legacy_post`, `begin/commit_x_account_refresh_legacy_post`, generic `release_x_account_refresh_v2`, `record_x_account_rejected_after_refresh`, `record_x_account_access_unauthorized`, health mirror trigger, reconnect-reset trigger. Phase1I restructured to build on it (adds only the `v2_attempt` begin/commit + provider guard on the same table) → one single-flight lease per account across both publish paths. TS: `_shared/x_v2_account_refresh.ts` `runXTokenRefresh` = the one token-request site (v2 `refreshXAccountPreX` and the live port both use it) + `xOAuthClientRegistryFromEnv`; new `x-test-post/vault_account_auth.ts` (`VaultAccountXAuth` + PostgREST adapter); `index.ts` routes every non-Kabumori brand through it.
- ai_lab_dead_end_removed: yes. `index.ts` no longer imports `loadAiLabVaultBackedXTokens`; no `allowRefresh:false`-only credential source. (`_shared/brand/ai_lab_vault_token_source.ts` + its test remain as unused source, not deleted to keep the diff scoped.) Kabumori legacy path (`loadBrandXTokens`, `refreshXTokens`, `oauth_token_store`) unchanged. Content guards unchanged (non-Kabumori brands: `brand_post` only; only AI Lab has a content dispatcher).
- future_accounts: any brand ≠ `kabumori` uses the same `VaultAccountXAuth` path, no brand branch. Authority = running post → its brand → the brand's one X account; DB re-counts (`X_ACCOUNT_NOT_UNIQUE_FOR_BRAND`) and requires it to equal the caller's `social_account_id` (`X_CLAIM_ACCOUNT_MISMATCH`), backed by production `UNIQUE (brand_id, platform)` + `platform = 'x'`; Phase1B-bound rows are refused (v2 path). `oauth_client_ref` routes to server-side clients: `default` → `X_CLIENT_ID/SECRET`; approved ref `r` → `X_OAUTH_CLIENT_<R>_ID/_SECRET`; unknown/malformed/half-configured → `X_REFRESH_CLIENT_NOT_CONFIGURED`, zero token requests; token endpoint constant.
- health_model: refresh state `idle/refreshing/uncertain/reauth_required` mirrored to `social_accounts`: reauth → `connection_status='failed'` + fixed code (refused before generation as `X_ACCOUNT_NOT_VERIFIED`; also blocks v2 claim); uncertain/not-rotated/401 → fixed `last_connection_error_code` with `identity_verified` kept; committed refresh clears the code; `verified_at` never touched by refresh; `updated_at` only with `connection_status`. Reconnect (OAuth completion stamps `verified_at` with `identity_verified`) auto-resets uncertain/reauth to idle. Fixed codes: `X_ACCESS_TOKEN_UNAUTHORIZED`, `X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH`, `X_REFRESH_GRANT_REJECTED`, `X_REFRESH_NETWORK_UNCERTAIN`, `X_REFRESH_HTTP_<status>`, `X_REFRESH_RESPONSE_INVALID`, `X_REFRESH_ACCOUNT_CHANGED`, `X_REFRESH_LEASE_LOST`, `X_REFRESH_PERSIST_FAILED`, `X_REFRESH_CLIENT_NOT_CONFIGURED`, `X_REFRESH_ALREADY_USED_FOR_ATTEMPT`, `X_REFRESH_IN_PROGRESS`, `X_REFRESH_BLOCKED_UNCERTAIN`.
- retry_semantics: proactive refresh when stored `access_expires_at` ≤ 5 min; reactive only on a 401 (X did not accept the request) with no prior refresh and no accepted X write in the attempt; then re-read the stored token through the exact-account reader and retry the exact request once. Second 401 → reauth_required. Max one refresh per post attempt enforced in DB (post id + attempt_count). Network/timeout/3xx/408/5xx/malformed 2xx → uncertain, never replayed; invalid_grant → reauth; 429/other 4xx → not rotated. Omitted refresh_token keeps the stored one. All failures end the attempt via existing `fail_scheduled_post` (no loop). Gate: Edge env `X_VAULT_ACCOUNT_REFRESH=enabled`; gate off → no token request, 401 recorded as `X_ACCESS_TOKEN_UNAUTHORIZED`.
- safety: no secret-id parameter in any API; tokens written only to the account's own two refs; commit rechecks lease kind/token, same running post + attempt_count, brand, X user id, client ref, both refs, publish_enabled, updated_at, exclusive ref ownership and brand uniqueness under a self-conflicting `SHARE ROW EXCLUSIVE` table lock (plain `SHARE`, as in merged Phase1I, deadlocks two commits whose health mirror writes `social_accounts` — reproduced, fixed in both files); Vault errors masked; nothing logs tokens/bodies; `VaultAccountXAuth` redacted in JSON/String/inspect; Vault-backed auth context throws on direct `tokens` access.
- changed_files:
  - new: `supabase/migrations/20260925140000_x_account_credential_refresh_core.sql`, `supabase/functions/x-test-post/vault_account_auth.ts`, `supabase/functions/x-test-post/vault_account_auth_test.ts`, `supabase/functions/x-test-post/account_refresh_core_migration_test.ts`, `supabase/tests/x_account_refresh_core_{fixture.sql,behavior.sql,run.sh}`, `supabase/tests/x_account_refresh_core.md`
  - modified: `supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql`, `supabase/functions/_shared/x_v2_account_refresh.ts` (+ `_test.ts`), `supabase/functions/x-test-post/index.ts`, `supabase/functions/x-test-post/account_refresh_migration_test.ts`, `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post_test.ts` (pin test now asserts the generic port), `supabase/tests/x_autopost_phase1i_{fixture.sql,behavior.sql,run.sh,account_refresh.md}`
- tests:
  - disposable PostgreSQL 17 (non-superuser owner): core ALONE on production-shaped fixture `CORE_BEHAVIOR_PASS` / `CORE_RACE_PASS` (one lease per account; parallel two-account commits with health mirror, no deadlock) / `CORE_CLEANUP_PASS`; re-apply refused. Stacked Phase1D/E/F/G/H/I all PASS (1I now core → 1I). Mutation check: removing attempt check, one-per-attempt, commit shared-ref/uniqueness, reauth→failed mirror, or SHARE lock (real deadlock) each fails the proof.
  - Deno: x-test-post 500 passed / 0 failed (new: vault_account_auth 15, core static 8; 1I static 6; v2_dispatcher unchanged); _shared 141 / 0 (refresh helper 12); important-news-monitor 473 / 0. TS mutation check on vault_account_auth (5 mutations) all caught. `deno check` new/changed files OK (index.ts: same 6 pre-existing errors as baseline, none new); `deno lint` new/changed files clean except 16 pre-existing `require-await` in an untouched part of ai_lab_scheduled_brand_post_test.ts (same as baseline); `bash -n` OK; `git diff --check` OK; secret scan (JWT/sk-/project ref/long tokens) clean.
- commit_hash: implementation `acbac42` (+ this report commit)
- push: origin/main
- deploy: none
- production_read_only_findings: AI Lab row `identity_verified`, publish true, client `default`, both refs present and distinct; Kabumori row has no Vault refs (token in `oauth_token_store`/env); a user account `sa_bfdab0e0…` has refs, publish false; shared refs across accounts = 0; `social_accounts` has no triggers; `connection_status` CHECK = unconnected/authorization_pending/connected/identity_verified/failed; `scheduled_posts` has `attempt_count`, no `social_account_id`; `vault.update_secret(uuid,text,text,text,uuid)` owner supabase_admin; **service_role can SELECT `vault.decrypted_secrets` and EXECUTE `vault.update_secret` directly** (separate hardening decision); `complete_ai_salaryman_lab_oauth_connection` requires `publish_enabled=false` and stamps `verified_at` (compatible with the reconnect reset).
- production_mutation: 0 (DB apply 0 / Edge deploy 0 / real OAuth refresh 0 / Vault write 0 / X post 0 / cron-settings 0 / business data 0). Only metadata SELECTs, no secret values.
- rollout_plan: `supabase/tests/x_account_refresh_core.md` §6 — Stage 0 read-back; Stage 1 apply core alone + deploy reviewed Edge with gate off (byte-verify deploy); Stage 2 AI Lab recovery (gate on, one observed run: 1 token request, commit, 201; prove only AI Lab's two secrets changed, Kabumori store untouched; invalid_grant → reconnect path); Stage 3 synthetic future-account proof (no X write); Stage 4 enable for all Vault-backed accounts + monitoring + rollback (unset gate / previous Edge; rotations are not reversible → reconnect). Not executed.
- proposed_emergency_containment (NOT executed; owner decision): each hourly AI Lab run still pays for generation then fails 401. Optional: `update public.social_accounts set publish_enabled = false, updated_at = now() where id = 'ai_salaryman_lab_x';` until Stage 2.
- remaining_issues:
  - reconnect (`select … for update` then `update social_accounts`) racing an in-flight commit can deadlock against the commit's table lock (same shape existed with Phase1I's SHARE lock); Postgres aborts one side and the result is fail-closed (`uncertain` → reconnect again). Review whether to reorder.
  - a stuck `refreshing` lease (worker died between begin and commit/release) still needs reviewed owner SQL.
  - legacy-path authority depends on `UNIQUE (brand_id, platform)`; if multi-account-per-brand is introduced before Phase1B binding, the core refuses (`X_ACCOUNT_NOT_UNIQUE_FOR_BRAND`) rather than guessing.
  - `ai_lab_vault_token_source.ts` is now unused (retire after rollout).
  - service_role direct Vault privileges (finding above).
- safety_checks: dedicated G3 worktree only; no G4 `apps/admin/**`, no shared rule files, no H2 task touched; fresh origin/main checked before push (no overlap); no plaintext token read/logged/copied; Kabumori legacy credentials untouched.
- next_recommendation: ChatGPT K3 → Codex H1 review (Sol高), scope limited to OAuth/Vault/exact-account/concurrency/rollout; then owner decision on containment and Stage 0–2.
