# Codex Task 2

- task_id: x-autopost-phase1b-account-bound-queue-schema-and-outcome-ledger-20260924
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase1 C2で確認したsafe boundaryを解消するため、productionを一切変更せず、scheduled_postsを明示的なsocial_account_idへbindするschema/API candidateと、durable provider-attempt/outcome ledgerをsource-only + disposable PostgreSQLで設計・実装する。legacy rowの暗黙推測は禁止。

## C2 finding carried forward

Independent C2 production read-back confirmed:
- scheduled_posts has brand_id/status/attempt_count but no social_account_id/account_id and no durable X outcome fields
- post_execution_logs has brand_id/status/x_post_id/error_code but no account binding/canonical retry outcome
- claim_due_post() globally claims oldest pending row with FOR UPDATE SKIP LOCKED
- retry_scheduled_post() can move running -> pending without a durable provider-call phase
- fail_scheduled_post() marks running -> failed
- therefore current live schema cannot safely support account-scoped fairness/retry without inventing account routing or risking duplicate X posts

Phase1 correctly STOPPED before source migration/RPC changes. Production mutation remained 0.

## Mandatory fresh start

1. git fetch origin main
2. read ORCHESTRATION / CURRENT_STATE / this TASK / latest CODEX_REPORT_2
3. inspect H1/G1/G2 for overlap
4. refresh read-only production metadata for scheduled_posts, post_execution_logs, social_accounts, relevant planner RPCs, claim/retry/fail RPCs
5. inspect all source call sites that create scheduled_posts rows and all paths that dispatch them

If any other slot touches the same queue tables/RPCs/functions/migrations, STOP.

## Scope A — explicit account binding model

Design a source-only migration candidate that introduces an explicit account binding for scheduled work.

Requirements:
- scheduled_posts gains nullable-at-first `social_account_id` (or exact equivalent only if schema conventions require another name)
- FK to public.social_accounts.id
- DB-level integrity that bound account.brand_id matches scheduled_posts.brand_id and account.platform='x'
- do not rely on app-only checks for cross-brand/account integrity
- no default account lookup
- no `limit=1`
- no deriving from brand_id at claim time
- legacy rows remain explicitly unbound until a separately reviewed backfill/cutover policy exists
- planners/callers must be audited and source candidates updated so newly planned rows can carry the intended account when trusted context exists
- if some planner has no trustworthy account source, fail closed/document rather than infer

## Scope B — durable attempt/outcome ledger

Create a production-shaped source candidate for a per-attempt ledger or equivalent guarded columns that records at minimum:
- attempt_id / claim token
- scheduled_post_id
- brand_id
- social_account_id
- phase/provider-call-started marker
- canonical outcome:
  - pre_x_retryable
  - pre_x_terminal
  - x_outcome_uncertain
  - x_confirmed_db_incomplete
  - completed
- stable error_code
- optional confirmed x_post_id
- claimed_at / provider_started_at / finished_at or equivalent bounded timestamps

Requirements:
- no tokens/secrets/provider raw bodies
- confirmed x_post_id preserved
- unique/constraint model prevents double completion/duplicate attempt ambiguity
- account/brand scope enforced at DB boundary
- legacy execution logs remain historical; do not rewrite them in this task

## Scope C — versioned RPC candidates

Prepare new versioned RPCs rather than mutating live claim/retry/fail behavior in place.

Candidate operations:
- claim next eligible work
- mark provider call started
- mark pre-X retryable/terminal
- record uncertain provider outcome
- record confirmed X + DB-incomplete
- complete confirmed X
- reconcile stale pre-X attempts only when durable phase proves provider not started

Requirements:
- SECURITY DEFINER only where necessary
- fixed search_path
- service_role-only EXECUTE for privileged queue operations
- fail closed on missing/mismatched brand/account
- FOR UPDATE SKIP LOCKED or equivalent for atomic claims
- no automatic reclaim of uncertain/confirmed-X states
- old live RPCs remain unchanged/unapplied

## Scope D — fairness design

Implement a source candidate that demonstrates bounded fairness across explicit (brand_id,social_account_id) queues.

Acceptable strategies:
- round-robin/last-served cursor
- per-account oldest eligible followed by global bounded selection
- another deterministic scheme with proof

Must prove:
- one noisy brand/account cannot permanently starve another
- no same-row double claim
- deterministic/account-scoped behavior
- no Cron cadence change required yet

## Scope E — legacy row cutover plan

Do NOT backfill production.

Produce a precise plan that classifies existing scheduled_posts rows:
- terminal/succeeded historical rows that need no routing
- pending/running future/live rows requiring explicit mapping
- rows that cannot be mapped with high confidence

State exactly what evidence would be required for any future backfill. No implicit "one account per brand" shortcut.

## Scope F — disposable PostgreSQL proof

Fake-only proof must cover:
- FK/account-brand/platform integrity
- two brands/two accounts making progress
- no double claim under concurrent workers
- unbound row is not claimable by new RPC
- mismatched brand/account rejected
- provider-started attempt cannot be auto-retried
- uncertain outcome cannot be reclaimed
- confirmed-X/db-incomplete cannot be republished
- pre-X retryable can safely re-enter within cap
- stale reconciliation only touches durable pre-X phase
- rollback/cleanup

## Scope G — tests

Add focused static/unit/migration tests and run relevant x-test-post regression.

Report exact counts. No X API call.

## Forbidden

- production migration apply
- production DDL/DML/backfill
- Function deploy
- Cron change
- OAuth/Vault/token mutation
- X API call/post/media/repost
- apps/admin/**
- Netlify/Vercel change
- blind db push/history repair
- live RPC replacement
- account routing inferred from brand_id

## Production mutation budget

0.

## Completion / C2

When complete:
- status -> review_required
- next_owner -> chatgpt
- update CODEX_REPORT_2 with exact schema/RPC candidates, call-site audit, planner coverage, legacy cutover plan, disposable proof, tests, changed files, commit/push/fresh-origin, production mutation=0, and next gate
- STOP for C2.


## Final C2 — 2026-09-24

PASS.

Accepted as a source-only foundation candidate.

Independent review confirmed:
- production remains untouched: `scheduled_posts.social_account_id` absent, v2 queue tables absent, v2 RPCs absent.
- live scheduled_posts counts remain 205 succeeded / 63 failed / 15 pending / 0 running, matching the report.
- the candidate adds explicit nullable account binding with no default and DB-level brand/account/platform integrity.
- no implicit brand->account lookup, no `limit=1` routing fallback, and no production backfill is introduced.
- durable attempt state distinguishes pre-X, provider-started, uncertain-X, confirmed-X/db-incomplete, and completed outcomes.
- uncertain-X and confirmed-X/db-incomplete paths are non-retryable by automatic claim/reconcile logic.
- legacy claim/retry/fail RPCs remain untouched; v2 RPCs are versioned, service-role-only, SECURITY DEFINER with fixed empty search_path.
- fairness is account-scoped and the final disposable proof covers two-brand progress, account integrity, retry cap, stale pre-X reconciliation, uncertain/confirmed-X no-reclaim, and rollback cleanup.
- tests accepted: focused 6/6 PASS, full x-test-post regression 409/409 PASS, diff check PASS.
- production mutation 0 is independently consistent with current production catalog.

Important cutover boundary:
- do NOT apply this migration by itself under the old dispatcher.
- do NOT activate claim_due_post_v2 until active planners/dispatcher/credential routing all use the same explicit social_account_id.
- the 15 current pending legacy rows require separately reviewed explicit mapping or disposition; one-account-per-brand is not sufficient evidence.

Next recommended task:
- source-only dispatcher/planner cutover candidate that routes credentials strictly by claim.social_account_id, versions the remaining active planners/callers, preserves each post type's completion side effects, and proves coexistence/cutover behavior in disposable tests before any production migration.
