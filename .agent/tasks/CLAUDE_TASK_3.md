# Claude Task 3

- task_id: x-universal-oauth-refresh-productionization-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
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

- pending
