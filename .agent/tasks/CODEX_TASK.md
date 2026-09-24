# Codex Task

- task_id: x-autopost-phase1f-ledger-atomic-completion-final-review-20260924
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: K3 PASS済みPhase1Fのprovider outcome state machine、typed atomic completion、provider-step ledger、ACL hardening、execution-log semanticsを独立レビューする。production apply/deploy/X API callは行わない。

## Target

Implementation commit:
- `0b752925b28b1b922b94a4cb7629ee942f82120f`

Primary files:
- `supabase/migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql`
- `supabase/functions/_shared/x_v2_outcome_ledger.ts`
- `supabase/functions/_shared/x_v2_outcome_ledger_test.ts`
- `supabase/functions/x-test-post/atomic_completion_migration_test.ts`
- `supabase/tests/x_autopost_phase1f_fixture.sql`
- `supabase/tests/x_autopost_phase1f_behavior.sql`
- `supabase/tests/x_autopost_phase1f_run.sh`
- `supabase/tests/x_autopost_phase1f_atomic_completion.md`

K3 evidence:
- source-only candidate complete
- typed atomic completions for interaction/useful_tip/morning_report/close_report/us_premarket_report
- tip/morning_greeting/brand_post remain disabled
- durable x_rejected outcome added
- provider-step ledger foundation added
- focused 55/55 PASS
- x-test-post 429/429 PASS
- _shared 120/120 PASS
- important-news-monitor 431/431 PASS
- disposable PostgreSQL Phase1F behavior/race PASS
- production mutation/X API calls = 0

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read G3 Phase1F TASK/Report
5. Read Phase1B/1C/1D/1E review history relevant to ledger/completion
6. Fresh fetch origin/main
7. Confirm independent H1 worktree/checkout
8. Confirm no overlap with active H2/G1/G2/G4 work
9. Review implementation commit and current main for drift
10. Do not deploy/apply anything

## Review A — state machine safety

Verify:
- pre_x -> retryable/terminal only before provider-start
- provider_started cannot regress to pre_x
- x_rejected is durable terminal and non-reclaimable
- x_outcome_uncertain non-reclaimable
- x_confirmed_db_incomplete non-reclaimable
- completed exactly-once
- duplicate calls cannot duplicate side effects
- older attempt cannot overwrite a newer claim
- wrong claim token/account/post/brand rejected
- no path can silently convert uncertain into retryable

Try adversarial state transitions.

## Review B — typed atomic completion fidelity

For each supported type:
- interaction
- useful_tip
- morning_report
- close_report
- us_premarket_report

Compare Phase1F typed completion side effects against legacy source semantics.

Verify one transaction covers:
- scheduled_posts status/timestamps
- v2 attempt outcome/x id
- post_execution_logs
- type-specific side effects
- report-run linkage/metadata where applicable
- interaction/topic/tip metrics as applicable

Inject or reason through mid-function failure and confirm full rollback.

Check idempotency and concurrent duplicate completion.

## Review C — disabled types are truly disabled

Verify:
- tip cannot use a generic one-id completion path
- morning_greeting cannot use a generic single-create path
- brand_post remains disabled without repository-source completion fidelity
- no dispatcher path can accidentally select these typed completions

Assess provider-step ledger foundation for:
- strictly ordered steps
- no duplicate start
- uncertain step blocks later unsafe replay
- thread reply chain identity
- media/create separation

Do not require full implementation of disabled types in this review.

## Review D — observability/logging

Verify:
- v2 started log timing is semantically correct
- success only written after atomic confirmed completion
- rejected/uncertain/incomplete logging does not imply reclaimability
- failure/error codes do not leak secret/token data
- duplicate completion does not duplicate logs
- trigger behavior cannot recursively or multiply log

## Review E — ACL/security

Review:
- SECURITY DEFINER functions
- fixed empty search_path
- schema qualification
- service_role-only public RPCs
- internal helper/trigger EXECUTE revoked
- ledger tables read-only to service_role where intended
- default privileges / PUBLIC windows closed
- no direct API-role writes that bypass state-machine invariants
- no regression of Phase1D/1E ACL assumptions

Pay special attention to hardening Phase1B ledger table DML grants.

## Review F — migration safety

Assess:
- dependencies on 1B/1D/1E
- explicit transaction semantics
- nested transaction/apply-tool risk
- non-idempotency
- partial-apply behavior
- whether Phase1F can only be applied as part of an ordered bundle
- whether retiring `complete_post_x_confirmed_v2` is safe before dispatcher activation
- live-definition assumptions still requiring production read-back

No production apply.

## Required verification

At minimum:
- focused Phase1F
- Phase1B/1D/1E regressions
- x-test-post
- _shared
- important-news-monitor
- disposable PostgreSQL behavior
- duplicate-completion concurrency/race proof
- Deno/static checks
- bash -n
- git diff --check

If a concrete bug is found, minimal Phase1F-scope source-only fix is allowed with rerun.

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- deploy
- Cron/OAuth/Vault/token mutation
- X API/posts/media
- dispatcher/producers enable
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work
- unrelated MIC work

## Production mutation budget

0.

## Completion / C1

Update `.agent/CODEX_REPORT.md` with:
- verdict PASS / PASS-WITH-FIX / FAIL
- findings by severity
- exact changed files/fix commit if any
- state-machine assessment
- typed-completion fidelity
- disabled-type assessment
- observability assessment
- ACL assessment
- migration/apply safety
- exact tests/counts
- whether Phase1F is safe to keep as source candidate
- whether production activation is authorized (expected NO)
- remaining blockers
- production mutation=0
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.


## Final C1 — Phase1F

Verdict: **PASS-WITH-FIX for source-only candidate**.

Accepted:
- reviewed implementation `0b752925b28b1b922b94a4cb7629ee942f82120f`
- H1 fix commit `b3740cc7c39010f02ad3505721a5b37d2e707dba`
- PR #25 contains the accepted source-only fixes
- P1 direct scheduled_posts API-role DML bypass closed
- P2 provider-step kind/order integrity fixed
- P2 late unfinished-step mutation after terminal attempt fixed
- focused 55/55 PASS
- x-test-post/_shared/important-news-monitor total 980/980 PASS
- disposable Phase1D/1E/1F behavior/concurrency/race proofs PASS
- deno check/lint, bash -n, git diff --check PASS
- production mutation/deploy/token/Cron/X API calls = 0

Decision:
- Phase1F is accepted as a source candidate after the H1 fixes.
- Production activation remains **NO**.
- Next step: G3 fresh-main verify PR #25 -> merge -> post-merge regression.
