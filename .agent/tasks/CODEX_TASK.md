# Codex Task

- task_id: x-universal-oauth-refresh-final-review-20260925
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みの universal exact-account Vault-backed X OAuth refresh 実装を、OAuth/Vault/exact-account/concurrency/production rollout safety に限定して独立最終レビューする。広いrepoレビューはしない。production mutationは禁止。

## Target

Implementation:
- `acbac42`

Primary scope:
- `supabase/migrations/20260925140000_x_account_credential_refresh_core.sql`
- `supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql`
- `supabase/functions/_shared/x_v2_account_refresh.ts`
- `supabase/functions/_shared/x_v2_account_refresh_test.ts`
- `supabase/functions/x-test-post/vault_account_auth.ts`
- `supabase/functions/x-test-post/vault_account_auth_test.ts`
- `supabase/functions/x-test-post/index.ts`
- core/Phase1I PostgreSQL behavior+race proof files

## Review focus

### A. exact-account / cross-account safety
Verify:
- exact social_account_id / brand / platform / account identity remain authoritative.
- no brand-first / first-row / other-account fallback.
- access and refresh Vault refs cannot be swapped/shared/cross-written.
- future non-Kabumori accounts use the same generic path without account-specific hardcoding.
- Kabumori legacy token path is not accidentally migrated or mutated.

### B. OAuth refresh semantics
Verify:
- max one refresh per publish attempt.
- max one retry of the exact intended X request after a safe 401 recovery.
- no retry after provider-start or ambiguous outcome.
- redirects not followed; no blind retry.
- invalid_grant/revoked -> reauth_required.
- timeout/network/408/5xx/malformed response -> uncertain/fail closed.
- omitted refresh token preserves the existing refresh token.
- second 401 after refresh fails closed.
- no plaintext token/provider body leakage.

### C. Vault / RPC / ACL
Verify:
- only exact account refs are writable.
- caller cannot supply arbitrary secret IDs as authority.
- SECURITY DEFINER/search_path/grants/default PUBLIC EXECUTE windows are safe.
- migration ordering is valid on the documented current production baseline.
- health mirror/reset triggers cannot create privilege or cross-account bypass.
- residual service_role direct Vault powers are documented accurately and not widened.

### D. concurrency
Attack/review:
- same-account parallel refresh.
- two-account parallel refresh.
- stale lease.
- account/ref/client/publish state changes mid-refresh.
- post attempt settlement mid-refresh.
- reconnect racing refresh commit.
- stuck refreshing lease recovery assumptions.
Determine whether the documented reconnect-vs-table-lock deadlock residual is acceptable fail-closed behavior or needs a fix before rollout.

### E. production rollout safety
Review Stage 0–2 only:
- Stage 0 live read-back.
- Stage 1 core migration + exact reviewed Edge deploy with gate OFF.
- Stage 2 one controlled AI Lab recovery.
Confirm rollback limits, especially irreversible X refresh-token rotation.
Do not activate Stage 3/4.

## Required verification

Run focused tests/proofs only:
- core migration static tests
- vault_account_auth tests
- x_v2_account_refresh tests
- focused x-test-post
- disposable PostgreSQL core behavior/race
- stacked Phase1I behavior/race as needed
- deno check/lint targeted changed modules
- git diff --check
- targeted secret scan

Add minimal adversarial regressions/fixes only if a concrete issue is found.

## Production safety

Read-only production inspection only.

Forbidden:
- migration apply
- Edge deploy
- real OAuth refresh
- Vault writes
- X API/media/post
- Cron/settings mutation
- business-data mutation
- secret/token plaintext output
- H2 task overwrite
- unrelated important-news/common-search work

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- reviewed/fixed head
- exact-account/Vault findings
- concurrency verdict
- provider retry semantics
- ACL/migration verdict
- Stage 0–2 rollout recommendation
- tests/counts
- production mutation=0
- remaining risks
- whether AI Lab controlled recovery may proceed

When complete:
- status -> review_required
- next_owner -> chatgpt
- update `.agent/CODEX_REPORT.md`
- STOP for C1.
