# Claude Task 3

- task_id: x-autopost-phase1e-exact-account-credential-resolver-20260924
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Phase1C/C2で残ったcredential-routing blockerを解消するため、v2 claimの `social_account_id` を唯一の権威としてX資格情報を解決するsource-only exact-account resolverを実装する。production deploy/apply/X API callは行わない。

## Context inherited from Phase1D / C2

Completed and accepted:
- Phase1D claim-domain partition source candidate
- K3 implementation PASS
- H2 C2 verdict: PASS-WITH-FIX for source-only candidate
- H2 fixes:
  - bound INSERT requires v2 domain + valid initial state
  - bound routing identity is immutable
- fix commit: `4468a060d368d6d94c205eba1a86ff58195740e4`
- full x-test-post regression after fix: 416/416 PASS
- production mutation: 0

Production activation remains prohibited until:
- live-definition diff
- atomic migration proof
- remaining Phase1C prerequisites
- staged rollback plan

This TASK addresses only the next Phase1C prerequisite: exact-account credential routing.

## Problem to solve

Current legacy routing has unsafe assumptions:
- `loadBrandContext` may select the first X account for a brand using `limit=1`
- legacy token loading is brand/shared-store derived
- AI Lab token loading has hardcoded account assumptions
- current posting path can refresh/retry after provider start

For v2 dispatch, none of those are acceptable.

Required invariant:

> A v2 claimed post may use credentials only for exactly `claim.social_account_id`. Brand alone, account count, first-row selection, hardcoded account, or implicit fallback must never choose the credential.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read G3 Phase1D Report + H2 Phase1D C2 section in `.agent/CODEX_REPORT_2.md`
6. Fresh fetch origin/main
7. Confirm dedicated independent G3 worktree
8. Inspect G4 ownership and prove no overlap
9. Audit all current X credential resolution / OAuth / Vault / legacy token helpers before editing
10. Do not touch app G1/G2 work or H1/H2 app review tasks

STOP if exact credential files are currently owned by another active X task.

## Scope A — credential-path audit

Map every current path that can provide X credentials to the dispatcher/manual publisher.

Produce a matrix:

caller | credential helper | input authority | account selection behavior | refresh behavior | safe for v2? | reason

At minimum inspect:
- `loadBrandContext`
- `loadBrandXTokens`
- AI Lab Vault/token helper(s)
- social_accounts lookup helpers
- OAuth refresh helpers
- posting helper(s) that may perform retry/refresh
- any `limit(1)`, first-row, hardcoded brand/account, shared token-store fallback

Do not assume a helper is safe from its name.

## Scope B — exact-account resolver

Implement a server-only source candidate with an explicit contract equivalent to:

`resolveXCredentialForClaim(socialAccountId, expectedBrandId)`

Exact shape may follow existing architecture, but it must prove all of these:

1. lookup by exact `social_account_id`
2. account must exist
3. `platform = 'x'`
4. account brand must equal the claim brand
5. account must be in an allowed verified/connected state
6. publishing must be allowed when required by the caller contract
7. credential reference must belong to that exact account
8. no brand-only lookup
9. no `limit=1` inference
10. no fallback to Kabumori shared legacy token
11. no fallback to AI Lab hardcoded token
12. no fallback to another account on missing/invalid credentials
13. failure is fail-closed with a non-secret error code

If production currently stores different credential forms across brands, normalize them behind the resolver without weakening the exact-account invariant.

## Scope C — secret boundary

The resolver must:
- remain server-side only
- never return credential material to mobile/admin/browser clients
- never log access token / refresh token / secret IDs unnecessarily
- never place secret values in thrown error messages
- never expose service_role to client code
- preserve existing Vault/server secret boundary
- distinguish account metadata validation from secret retrieval

If secret retrieval requires a DB/RPC change, do NOT apply it. Prepare a separately reviewable source candidate only if safe and necessary.

## Scope D — one-request provider seam

Audit current provider helpers for hidden automatic retry/refresh.

Create a v2-compatible provider seam such that, after the durable “provider started” boundary:
- one logical provider-create step performs at most one X create request
- no implicit second X create attempt after 401/refresh
- token refresh, if needed, must occur before the durable provider-start boundary or return a pre-X retryable outcome
- provider response classification remains explicit

This TASK does NOT need to convert every post type to v2 dispatch yet.

It only needs a safe primitive that future v2 dispatch can call.

Do not redesign tip threads or morning_greeting multi-step media flows here; document them as not yet compatible with the one-request primitive.

## Scope E — integration boundary

Wire the resolver/provider seam only where it can be done without activating v2 production dispatch.

Preferred:
- source-only helper + tests
- optional test-only or disabled v2 path integration

Forbidden:
- switching live dispatcher to v2
- replacing live legacy credential routing
- enabling bound producers
- production OAuth/token mutation
- real X calls

## Scope F — tests

Required adversarial cases:

Credential resolver:
- exact matching account succeeds
- same brand with two X accounts never picks the wrong one
- different-brand account rejected
- non-X account rejected
- missing account rejected
- disconnected/unverified account rejected
- publish-disabled account rejected when publish permission is required
- missing credential reference rejected
- no fallback to another account
- no fallback to legacy shared token
- no fallback to hardcoded AI Lab token
- no secret values appear in errors/log captures

Provider seam:
- exactly one X create request on success
- 401 after provider-start does not cause hidden second create request
- refresh-required-before-start returns pre-X outcome or fails closed
- network uncertain outcome is distinguishable from confirmed failure
- no provider call occurs when resolver validation fails

Regression:
- existing legacy X posting tests continue to pass
- Phase1D claim-domain tests continue to pass
- `git diff --check`
- changed-file Deno/static/type checks

Report exact counts.

## Scope G — documentation

Document:
- exact-account invariant
- which current legacy helpers remain legacy-only
- which new helper is v2-safe
- where token refresh is allowed
- where token refresh is forbidden
- which post types remain blocked for v2 and why
- next prerequisite after this task

Expected remaining next prerequisite after Phase1E:
- atomic per-post-type v2 completion/provider-step outcome model
- especially tip thread and morning_greeting multi-request flows

## Forbidden

- production migration/DDL/DML/backfill
- production RPC apply
- `supabase db push`
- migration-history repair
- Edge Function deploy
- Cron mutation
- OAuth production mutation
- Vault production mutation
- real token rotation/refresh
- X API calls
- X posts/media uploads
- switching live dispatcher
- enabling v2 producers
- apps/admin/**
- consumer mobile/**
- G4 Netlify/admin work
- G1/G2 app work
- unrelated MIC work

## Production mutation budget

0.

## Completion / K3

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  1. fresh main SHA
  2. worktree/branch
  3. credential-path audit matrix
  4. exact changed files
  5. exact-account resolver contract
  6. secret-boundary proof
  7. one-request provider seam behavior
  8. legacy behavior intentionally unchanged
  9. exact tests/counts
  10. commit/push status
  11. production mutation=0
  12. remaining blockers
  13. next recommendation

STOP for K3.

Do not deploy or activate Phase1E in production.

## Report

- task_id: `x-autopost-phase1e-exact-account-credential-resolver-20260924`
- result: **source-only candidate complete; production mutation 0; X API calls 0.** A claim-bound, read-only credential RPC, an exact-account resolver and a one-request provider seam exist as unwired sources. Legacy credential/posting helpers and the live dispatcher are unchanged. Stop for K3.
1. fresh main SHA: started `e60ad3b`; pre-commit fresh fetch `fbc6b74`, then `bfe165f` at push (G1/G2/H2 app + control files only, no overlap); implementation rebased onto `bfe165f`.
2. worktree/branch: dedicated G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`, branch `claude/g3-phase1e-account-resolver` (new branch from fresh main). Shared checkout, other slots' worktrees/branches and the repo stash list untouched.
3. credential-path audit matrix: `supabase/tests/x_autopost_phase1e_exact_account_credentials.md` §2. Unsafe for v2: `loadBrandContext` (brand-only, `limit=1` first X account), `loadBrandXTokens`/`loadXTokens` (Kabumori-only shared `oauth_token_store` `limit=1`, silent env `X_OAUTH2_*` fallback), important-news `loadXTokens`+env (global), `loadAiLabVaultBackedXTokens` (hardcoded `ai_salaryman_lab_x`, production-only RPC `read_ai_salaryman_lab_x_vault_token`), `loadVaultBackedXTokens` as wired (refs chosen outside, account from `limit=1`), `read_social_mobile_history_access_token` (owner/history scope, one-X-account-per-brand), x-test-post `postToX`/`postThreadToX` and `_shared` `postToXWithRefresh`/`requestXWithAuthRefresh` (401 → refresh → second request; rotated tokens written to the shared store). Safe: the two new sources only.
4. changed_files (all new): `supabase/migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql`; `supabase/functions/_shared/x_v2_claim_credentials.ts` + `_test.ts`; `supabase/functions/_shared/x_v2_one_request_provider.ts` + `_test.ts`; `supabase/functions/x-test-post/claim_bound_credential_reader_migration_test.ts`; `supabase/tests/x_autopost_phase1e_{fixture.sql,behavior.sql,run.sh,exact_account_credentials.md}`; this TASK. No existing file edited.
5. exact-account resolver contract: RPC `read_x_publish_credential_for_claim_v2(attempt_id, claim_token, social_account_id, expected_brand_id, require_publish_enabled default true)` — authority is the open `pre_x` v2 attempt; caller account/brand must equal the attempt's; post must be `running` and bound to it; account read by PK; checks exists → `x` → brand → `identity_verified` + platform_user_id → `publish_enabled` (explicit waiver only) → the row's own access-token Vault ref → decrypted secret. Returns `social_account_id, brand_id, platform_user_id, access_token` only. Fixed `P0001` codes (`X_CREDENTIAL_REQUEST_INVALID`, `X_CLAIM_NOT_PRE_X`, `X_CLAIM_ACCOUNT_MISMATCH`, `X_CLAIM_NOT_RUNNING`, `X_ACCOUNT_NOT_FOUND`, `X_ACCOUNT_NOT_X`, `X_ACCOUNT_BRAND_MISMATCH`, `X_ACCOUNT_NOT_VERIFIED`, `X_ACCOUNT_PUBLISH_DISABLED`, `X_CREDENTIAL_NOT_CONFIGURED`, `X_CREDENTIAL_UNAVAILABLE`); others masked. TS `resolveXCredentialForClaim(claim, reader)` validates claim shape, requires exactly one row, discards any credential whose identity differs from the claim. No brand-only lookup, no `limit=1`, no legacy store, no env, no hardcoded account, no other-account fallback.
6. secret-boundary proof: RPC is service_role-only (anon/authenticated 42501 proved), read-only (row hashes unchanged proved), never selects the refresh-token ref, reads the Vault ref only after metadata checks, masks DB errors; errors proved free of fake tokens and Vault ids. TS: token in a private field, redacted in JSON/String/inspect; resolver/seam contain no `console.*`; RPC error bodies (including one containing a fake token) reduced to fixed codes; console capture during tests saw no token. Module is `_shared` server code only; nothing under `apps/**`/mobile imports it.
7. one-request provider seam: `createXTextPostOnceV2` = pre-X `GET /2/users/me` identity check (must equal the account's `platform_user_id`; 401 → `pre_x_retryable X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X`, mismatch/403 → `pre_x_terminal`, outage → `pre_x_retryable`) → awaits `markProviderStarted` (failure → pre-X, nothing sent) → exactly one `POST /2/tweets` with timeout, no refresh/retry/loop. 2xx+id `x_created`; 2xx w/o id, network/timeout, 408/5xx `x_outcome_uncertain`; other 4xx incl. 401/429 `x_rejected`. `publishClaimedXTextPostV2` composes resolver + seam; resolver failure → zero X requests.
8. legacy behavior intentionally unchanged: `loadBrandContext`, `loadBrandXTokens`, `loadXTokens`, `loadVaultBackedXTokens`, `loadAiLabVaultBackedXTokens`, `postToX`/`postThreadToX`/`refreshXTokens`/`saveXTokens` in x-test-post, `_shared/x_oauth2_post.ts`, important-news publish, morning_greeting publish, live dispatcher (`claim_due_post`), all migrations before Phase1E. Static test asserts the dispatcher does not reference the new reader/seam.
9. tests:
   - disposable PostgreSQL 17 (local, non-superuser owner, Supabase-style default grants, fake vault/legacy store/AI Lab token): Phase1E behavior **PASS** ×3 runs, cleanup PASS. Phase1D runner re-run **PASS** (behavior, race, cleanup).
   - resolver tests **11/11**, provider seam tests **12/12**, Phase1E static **6/6** (focused static incl. Phase1D 7 + Phase1B 6: **19/19**).
   - full `x-test-post` **422/422** (416 + 6 new); full `_shared` **114/114** (includes the 23 new); `important-news-monitor` **431/431** (legacy X posting path unchanged). Re-run after rebase.
   - `deno check --no-config` on all 5 new TS files: PASS. `git diff --cached --check`: PASS. `bash -n` runner: PASS. (Plain `deno check` in a fresh worktree still fails on missing `npm:@types/node` for every file — environment, pre-existing.)
   - Pre-existing, not Phase1E: Phase1B's standalone `x_autopost_phase1b_behavior.sql` stacked on Phase1D now fails at its raw bound-row INSERTs, because H2's Phase1D fix `4468a06` rejects them earlier with `BOUND_ROW_REQUIRES_V2_PATH` instead of the FK violation the Phase1B test expects. Reproduced without the Phase1E migration. Stricter, not weaker; Phase1B/1D files not changed here.
10. commit_hash: implementation `1868cc0` (`Add X autopost Phase1E exact-account credential resolver candidate`); this Report is a separate control commit on top.
    push: both commits pushed to `origin/main` from the G3 worktree after a fresh fetch (fast-forward); post-push read-back confirms both are ancestors of `origin/main`.
11. production mutation: **0** (migration/DDL/DML/RPC apply 0, deploy 0, Cron 0, OAuth/Vault/token 0, token refresh/rotation 0, X API calls/posts/media 0, dispatcher/producer switch 0). A generated `deno.lock` from local test runs was removed, not committed.
12. remaining blockers:
    - `x_rejected` has no Phase1B ledger outcome; until added, a future dispatcher must record it as uncertain (never auto-retry).
    - No per-account pre-X token refresh writer exists; v2 treats an expired token as pre-X and needs out-of-band refresh.
    - Kabumori's credential lives only in the shared `oauth_token_store`/env; its `social_accounts` row needs its own Vault refs (operator step) or the resolver fails closed. AI Lab's `vault_*` columns and read RPC are production-only source (not on main) — the live-definition diff must cover them and `social_accounts` columns.
    - Atomic per-type completion (Phase1C blocker 3); tip threads and morning_greeting media+create are not compatible with the one-request primitive; interaction polls not in the text-only seam.
    - Earlier gates still open: live-definition diff, atomic migration proof, staged rollback plan.
13. next_recommendation: K3, then Codex review (auth/secret boundary + provider semantics). Next implementation prerequisite: per-post-type atomic v2 completion + provider-step outcome model (with `x_rejected`), then tip-thread / morning_greeting multi-request steps and a per-account pre-X refresh writer.
