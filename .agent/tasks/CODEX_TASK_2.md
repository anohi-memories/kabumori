# Codex Task 2

- task_id: x-autopost-phase1-common-queue-idempotency-foundation-20260924
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase0c2でbrand-scoped uniquenessのproduction rolloutがC2 PASSした後の次段階として、複数ブランド/複数Xアカウント運用に必要な共通queue・idempotency・retry/outcome分類のfoundationをsource-onlyで設計・実装・disposable proofする。production mutationは0。

## Context carried forward

Production now has:
- x-test-post v119 with brand-scoped publish_claim behavior
- legacy global UNIQUE constraints removed
- brand-scoped unique indexes active
- four planner RPCs using brand-scoped scheduled_posts conflict targets

Known next risks from the architecture audit:
- claim_due_post() globally claims the oldest due row and has no brand fairness
- retry/outcome states do not yet cleanly distinguish:
  - safe pre-X retry
  - uncertain X outcome
  - confirmed X but DB completion failed
  - terminal failure
- stale running reconciliation/observability is incomplete
- confirmed X must never be retried merely because DB completion is uncertain
- queue/account/idempotency behavior must remain brand/account scoped

## Mandatory fresh start

1. git fetch origin main
2. fresh origin/main
3. read ORCHESTRATION / CURRENT_STATE / this TASK / latest CODEX_REPORT_2
4. inspect H1/G1/G2 scopes for overlap
5. inspect current x-test-post scheduler/claim/completion/logging code and live read-only metadata
6. identify exact tables/RPCs/functions involved before writing

If another slot touches x-test-post queue/claim/retry/log tables or the same migration/RPC/function files, STOP.

## Scope A — current-state audit

Read-only/source audit:
- claim_due_post() exact ordering/locking/claim semantics
- scheduled_posts lifecycle/status/attempt_count fields
- post_execution_logs write lifecycle
- publish_claims relationship to generic scheduled posting
- existing retry helpers and stale-running logic
- AI Lab confirmed-X completion protection
- existing dedupe/fingerprint tables and completion paths
- current Cron cadence and invocation contract (read-only)

Produce a concise invariant map before implementation.

## Scope B — canonical outcome model

Design a small shared outcome/state contract for scheduled posting that distinguishes at minimum:

1. pre_x_retryable
2. pre_x_terminal
3. x_outcome_uncertain
4. x_confirmed_db_incomplete
5. completed

Requirements:
- no automatic retry for x_outcome_uncertain
- no automatic retry for x_confirmed_db_incomplete
- confirmed X post id, when known, is preserved
- retry eligibility is explicit and machine-testable
- no provider response body/token/secret persistence
- normalized stable error codes only

Do not overfit to one brand.

## Scope C — queue claim foundation

Prepare source-only migration/RPC candidate and/or shared logic that:
- keeps claims atomic with FOR UPDATE SKIP LOCKED or equivalent
- scopes deterministic claim/idempotency identity by brand and target account where available
- avoids one noisy brand permanently starving others
- supports bounded concurrency/fairness without changing Cron cadence yet
- prevents duplicate simultaneous claim of the same scheduled row
- records enough state for stale-running reconciliation
- fails closed on ambiguous/missing brand/account context

If exact account_id is not yet reliably available on scheduled_posts, do not invent a fake fallback. Document the minimum schema/API change required and stop at the safe boundary.

## Scope D — stale-running reconciliation

Design/implement source-only reconciliation logic that can classify stale running rows without causing duplicate X posts.

At minimum prove:
- pre-X stale work can become retryable under strict conditions
- rows with uncertain provider outcome do not auto-retry
- rows with confirmed X id but incomplete DB completion become repair/manual-reconcile, not republish
- terminal failures stay terminal unless explicitly reset by an operator path not built in this task

## Scope E — disposable PostgreSQL proof

Use fake-only PostgreSQL fixtures to prove:
- two brands with due work can both make progress under the proposed claim policy
- same row cannot be claimed twice concurrently
- brand isolation
- retryable pre-X row can re-enter safely
- uncertain-X row cannot be reclaimed
- confirmed-X/db-incomplete row cannot be republished
- stale reconciliation transitions only the allowed categories
- rollback/cleanup leaves no residue

No production data writes.

## Scope F — tests

Add focused tests for:
- outcome classification
- retry gating
- no-double-claim
- fairness/bounded selection
- stale reconciliation
- confirmed-X no-retry invariant
- brand/account fail-closed behavior
- exact migration/static assertions

Run relevant x-test-post regression and git diff --check.

## Explicit non-goals / forbidden

- production migration apply
- Function deploy
- Cron change
- OAuth/Vault/token mutation
- X API call/post/media/repost
- Netlify/Vercel change
- apps/admin/**
- G2 brand selector/query parameterization
- generic token-router implementation
- account onboarding/OAuth changes
- blind db push/history repair
- broad x-test-post rewrite unrelated to queue/idempotency

## Production mutation budget

0.

## Completion / C2

When complete:
- status -> review_required
- next_owner -> chatgpt
- update CODEX_REPORT_2

Report:
1. fresh source commit
2. current queue invariant map
3. proposed outcome model
4. exact claim/fairness design
5. stale reconciliation design
6. migration/RPC/source candidate paths
7. disposable proof results
8. tests/regression counts
9. changed files
10. production mutation=0 proof
11. remaining blocker for account-scoped routing if any
12. exact next production/source gate
13. commit/push/fresh-origin verification

Then STOP for C2.
