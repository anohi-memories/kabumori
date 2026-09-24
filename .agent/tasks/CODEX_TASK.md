# Codex Task

- task_id: x-autopost-phase1c-dispatcher-planner-account-bound-cutover-candidate-20260924
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: GPT-5.6 Sol Medium
- purpose: C2 PASS済みPhase1Bの明示的 social_account_id binding / durable attempt ledger / v2 queue RPC candidateを前提に、X自動投稿のactive planner/dispatcher/credential routingを account-bound に揃える production未適用のsource-only cutover candidateを作る。claim.social_account_id以外から投稿先アカウントを推測しない。

## Context carried forward

Phase1B C2 PASS済み:
- scheduled_posts に nullable-at-first social_account_id を追加するsource candidate
- social_accountsとのbrand/platform整合をDB boundaryで強制
- durable attempt/outcome ledger candidate
- versioned service-role-only v2 claim/reconcile RPC candidate
- uncertain-X / confirmed-X-db-incomplete は自動再投稿禁止
- fairness/concurrency/retry/stale proof PASS
- production mutation 0

Important cutover boundary:
- Phase1B migrationだけをold dispatcher下で適用してはいけない
- claim_due_post_v2をactive planners/dispatcher/credential routingが揃う前に有効化してはいけない
- live legacy pending rowsは暗黙backfill禁止

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read .agent/tasks/CODEX_TASK_2.md and latest .agent/CODEX_REPORT_2.md
6. Fresh fetch origin/main
7. Inspect G1/G2 current ownership and prove no overlap
8. Audit all active scheduled_posts producers/planners and x-test-post dispatch paths
9. Audit all credential-selection paths for X posting
10. Audit all completion/failure/retry side effects by post type

If another slot currently owns the same x-test-post file, migration, RPC, workflow, or queue object, STOP and report the exact overlap.

## Scope A — dispatcher v2 candidate

Create a source-only dispatcher path that:
- claims only through the reviewed v2 account-bound RPC candidate
- treats claim.social_account_id as authoritative
- loads exactly the matching social_accounts row
- verifies brand_id/account/platform consistency again at the application boundary
- selects OAuth credentials strictly for that claimed social_account_id
- never falls back to "first account for brand"
- never uses LIMIT 1 as routing
- never derives account from brand_id alone
- fails closed if the bound account is missing, disabled, mismatched, non-X, or lacks required credentials

Do not mutate the live legacy dispatcher in place unless a versioned wrapper/cutover seam preserves safe rollback and coexistence.

## Scope B — planner/caller account propagation

Audit every active path that creates future scheduled_posts rows.

For each active planner/caller:
- identify where trusted social_account_id context comes from
- propagate explicit social_account_id into new scheduled work
- if no trustworthy account context exists, fail closed or leave that planner on legacy path and document the exact blocker
- do not infer "one account per brand"
- do not silently bind legacy rows
- do not change posting cadence/content rules except where necessary to pass the explicit account id

Produce a coverage matrix:
planner/caller -> post type -> current source of brand/account -> candidate behavior -> cutover readiness.

## Scope C — provider attempt lifecycle integration

Wire the source candidate to the reviewed Phase1B attempt/outcome model.

Required ordering:
1. claim creates/returns an attempt identity
2. local/pre-X validation failures record pre_x_retryable or pre_x_terminal
3. immediately before the first provider request, mark provider_started
4. if provider result is unknown/transport ambiguous, record x_outcome_uncertain
5. if X confirms a post id but downstream DB finalization fails, persist x_confirmed_db_incomplete with x_post_id
6. only successful finalization becomes completed

Safety:
- never automatically reclaim x_outcome_uncertain
- never automatically republish x_confirmed_db_incomplete
- retry only durable pre-X states within cap
- stable error codes; no raw provider response/tokens/secrets in ledger
- preserve confirmed x_post_id

## Scope D — post-type side effects

Audit current successful completion behavior for every active post type handled by the dispatcher.

The v2 candidate must preserve required existing side effects, including where applicable:
- scheduled_posts status/final timestamps
- x_post_id persistence
- execution logs
- source/report/candidate linkage
- published markers
- any Important News or market-report completion markers
- retry counters / terminal failure semantics

Do not invent new product behavior.
If a legacy side effect cannot safely be reproduced under v2, document and fail the cutover candidate rather than silently dropping it.

## Scope E — coexistence and cutover design

Design a source-only staged cutover that avoids split-brain publishing.

Must specify:
- how legacy dispatcher and v2 dispatcher coexist before activation
- exact activation gate
- how new account-bound rows are prevented from being claimed by legacy code
- how legacy unbound rows are prevented from being claimed by v2
- rollback behavior before any X provider call
- behavior after provider_started where rollback/retry is unsafe
- whether a feature flag/versioned RPC/function entrypoint is required
- exact order for future production migration + deploy + planner activation

Do not activate anything in production.

## Scope F — legacy pending-row disposition analysis

Read-only classify current legacy pending/running rows by available evidence.

Do not modify/backfill them.

For each class, document:
- whether explicit account mapping is provable
- what evidence would be required
- safe future disposition: explicit map / allow legacy drain / cancel / manual review

No "brand has one account" shortcut.

## Scope G — disposable proof

Use fake/disposable data only. No X API calls.

Prove at minimum:
- two brands / two X accounts route to the correct credentials
- no cross-brand/account credential leakage
- missing/mismatched/disabled account fails closed before provider_started
- unbound legacy row cannot be claimed by v2
- account-bound v2 row cannot be accidentally consumed by legacy candidate path
- concurrent workers do not double-claim
- pre-X retryable can retry within cap
- provider_started cannot be auto-retried
- uncertain outcome cannot be reclaimed
- confirmed-X/db-incomplete cannot be republished
- completion preserves all required side effects for each active post type
- rollback/cleanup of disposable fixtures

## Scope H — tests

Run focused tests plus the full relevant x-test-post regression suite.

Report exact pass/fail counts.
Run git diff --check.
Run appropriate static/type checks for changed code.
No provider/network posting calls.

## Forbidden

- production migration apply
- production DDL/DML/backfill
- live RPC replacement
- Edge Function deploy
- Cron change
- OAuth/Vault/token mutation
- X API post/media/repost
- manual production candidate/scheduled row injection
- account inference from brand_id
- LIMIT 1 account fallback
- apps/admin/**
- consumer mobile/**
- Netlify/Vercel production change
- Important News business logic/cadence/content change
- blind supabase db push
- migration history repair
- editing Phase1B accepted semantics without returning for C1

## Production mutation budget

0.

## Completion / C1

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT.md with:
  - fresh main SHA
  - exact changed files
  - planner/caller coverage matrix
  - credential routing proof
  - attempt/outcome integration
  - per-post-type side-effect audit
  - coexistence/cutover design
  - legacy-row disposition analysis
  - disposable proof
  - test counts
  - commit/push/fresh-origin status
  - production mutation=0
  - exact remaining blockers before any production rollout
- STOP for C1.

Do not apply Phase1B/Phase1C to production in this task.
