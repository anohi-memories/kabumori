# Claude Task 3

- task_id: x-autopost-phase1e-exact-account-credential-resolver-20260924
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
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
