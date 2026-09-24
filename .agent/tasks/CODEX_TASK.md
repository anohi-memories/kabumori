# Codex Task

- task_id: x-autopost-phase1e-auth-secret-provider-final-review-20260924
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みのPhase1E exact-account credential resolver / one-request provider seamを、Auth・secret/Vault境界・RPC ACL・provider outcome semanticsの観点で最終レビューする。production apply/deploy/X API callは行わない。

## Review target

Primary implementation commit:
- `1868cc0e418ebda15ecfdfc88c55c9dd25a471f7`

Primary source files:
- `supabase/migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql`
- `supabase/functions/_shared/x_v2_claim_credentials.ts`
- `supabase/functions/_shared/x_v2_claim_credentials_test.ts`
- `supabase/functions/_shared/x_v2_one_request_provider.ts`
- `supabase/functions/_shared/x_v2_one_request_provider_test.ts`
- `supabase/functions/x-test-post/claim_bound_credential_reader_migration_test.ts`
- `supabase/tests/x_autopost_phase1e_fixture.sql`
- `supabase/tests/x_autopost_phase1e_behavior.sql`
- `supabase/tests/x_autopost_phase1e_run.sh`
- `supabase/tests/x_autopost_phase1e_exact_account_credentials.md`

K3 evidence:
- exact-account resolver implementation PASS
- resolver 11/11 PASS
- provider seam 12/12 PASS
- Phase1E static 6/6 PASS
- Phase1B+1D focused static 19/19 PASS
- x-test-post 422/422 PASS
- _shared 114/114 PASS
- important-news-monitor 431/431 PASS
- production mutation/deploy/token refresh/X API calls = 0

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G3 TASK including Phase1E Report + Final K3
5. Read prior Phase1D C2 review findings relevant to claim binding and ACL
6. Fresh fetch origin/main
7. Confirm independent H1 worktree/checkout
8. Inspect H2/G3/G4 ownership and prove no overlap
9. Review exact implementation commit and current main for semantic drift
10. Do not deploy/apply anything

## Review scope A — exact-account authority

Verify the v2 credential path cannot select credentials by:
- brand only
- first row / `limit=1`
- current account count
- legacy Kabumori shared token store
- env fallback
- AI Lab hardcoded account
- another account after failure

Prove:
- `claim.social_account_id` is the sole credential authority
- expected brand is cross-checked
- platform must be X
- identity/connection state is sufficiently verified
- publish-enabled requirement is enforced when required
- claim attempt/token/account/brand must all match
- no missing-data fallback silently switches identity

Try adversarial same-brand multi-account cases.

## Review scope B — RPC / Vault / ACL

Review `read_x_publish_credential_for_claim_v2` for:
- SECURITY DEFINER correctness
- fixed/empty search_path safety
- exact table/schema qualification
- service_role-only EXECUTE
- anon/authenticated/public denial
- function owner / default EXECUTE concerns
- Vault reference ownership to the exact account
- no refresh-token exposure
- no generic secret-id reader capability
- no token/secret-id leakage in errors
- read-only behavior
- failure masking

Flag any case where service_role or another role could call a lower-level primitive and bypass exact-account checks.

## Review scope C — TS secret boundary

Verify:
- token is server-only
- no client/mobile/admin import path
- serialization/inspection redaction is effective enough
- bearer header construction is the only intended token use
- error types/codes never embed token material
- logging/catch paths do not leak raw RPC responses
- no accidental token retention in structured result objects

If a redaction limitation exists, classify whether it is merely defense-in-depth or a blocker.

## Review scope D — one-request provider guarantee

Audit `createXTextPostOnceV2` / composition path:
- pre-X identity check occurs before durable provider-start
- provider-start mark completes before create request
- exactly one POST /2/tweets occurs after provider-start
- no automatic refresh/retry loop after provider-start
- 401 after provider-start never triggers another create
- network timeout/5xx/408 become uncertain, not silently retried
- 2xx without tweet id is uncertain
- confirmed rejection vs uncertain outcome is classified safely
- resolver failure causes zero X requests
- pre-X 401/refresh-required does not create an X post

Review whether GET /2/users/me before provider-start has side effects or rate-limit implications that matter to correctness.

## Review scope E — outcome-model seam

Assess the current result mapping against Phase1B ledger states.

Specifically:
- `pre_x_retryable`
- `pre_x_terminal`
- `x_created`
- `x_rejected`
- `x_outcome_uncertain`

Confirm K3's note that `x_rejected` currently lacks a dedicated Phase1B ledger outcome.
Determine whether future dispatcher must map it to uncertain until a dedicated safe terminal contract exists.

Do not redesign the whole ledger in this review unless a concrete correctness bug requires a minimal source-only fix.

## Review scope F — migration/source safety

Review Phase1E migration for:
- dependency on Phase1B/1D objects
- production schema assumptions
- default grants
- transaction/partial-apply risk
- non-idempotency
- compatibility with current source-only activation plan
- live-definition assumptions that still require production read-back

No production apply.

## Required verification

At minimum:
- focused resolver/provider tests
- Phase1E static tests
- relevant Phase1D regression
- full x-test-post if feasible
- _shared tests if feasible
- important-news-monitor regression if feasible
- disposable PostgreSQL behavior proof if local environment permits
- Deno/static checks
- git diff --check
- secret/logging grep

If any cannot run, state exactly why.

## Bugfix authority

If a concrete correctness/security bug is found:
- make only the minimal source-only fix within Phase1E files/tests/docs
- rerun affected tests
- push the fix safely
- do not alter live dispatcher/legacy credential routing unless strictly necessary for a source-only defect and explicitly justified

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- Edge Function deploy
- Cron mutation
- OAuth/Vault production mutation
- token rotation/refresh
- X API calls/posts/media uploads
- switching live dispatcher
- enabling v2 producers
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 Netlify work
- unrelated MIC work

## Production mutation budget

0.

## Completion / C1

Update `.agent/CODEX_REPORT.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- fresh main SHA
- reviewed commit SHA
- findings by severity
- exact changed files if any
- exact-account authority assessment
- RPC/Vault/ACL assessment
- TS secret-boundary assessment
- one-request provider assessment
- outcome-model assessment
- migration/source safety assessment
- exact tests/counts
- whether Phase1E is safe to keep as source candidate
- whether it is safe for production activation now (expected: NO unless all later prerequisites also pass)
- remaining blockers
- production mutation=0
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.


## Final C1 — Phase1E

Verdict: **PASS-WITH-FIX for source-only candidate**.

Accepted:
- reviewed implementation commit `1868cc0e418ebda15ecfdfc88c55c9dd25a471f7`
- H1 fix commit `7406c1c60506323400247b6c24162a5da4097419`
- PR #22 contains the accepted source-only fixes
- P1 redirect/replay risk fixed with manual redirects and conservative 3xx handling
- P1 Vault-origin error leakage fixed with nested masking to fixed code
- P2 PUBLIC EXECUTE window closed with transactional CREATE/REVOKE/GRANT
- focused Phase1E 31/31 PASS
- Phase1B+1D focused static 13/13 PASS; combined static 19/19
- x-test-post 422/422 PASS
- _shared 116/116 PASS
- important-news-monitor 431/431 PASS
- disposable PostgreSQL proof PASS
- production mutation/deploy/token refresh/X API calls = 0

Decision:
- Phase1E is accepted as a source candidate.
- Production activation remains **NO**.
- Next step is G3 fresh-main integration/merge of PR #22 and post-merge verification before Phase1F work.
