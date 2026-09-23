# Codex Task 2

- task_id: x-autopost-phase0-disposable-global-uniqueness-migration-proof-20260923
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: GPT-6 Luna
- purpose: C2で確認したX自動投稿複数ブランド化のP0 blockerについて、productionへ一切適用せず、disposable PostgreSQLだけで最小migration候補とrollback proofを作り、安全にbrand-scoped uniquenessへ移行できることを証明する。

## Background / confirmed production blocker

Productionには以下が併存している:
- `posting_windows`
  - intended: UNIQUE `(brand_id, post_type, slot_no)`
  - obsolete blocker: UNIQUE `(post_type, slot_no)`
- `scheduled_posts`
  - intended: UNIQUE `(brand_id, schedule_date, post_type, slot_no)`
  - obsolete blocker: UNIQUE `(schedule_date, post_type, slot_no)`
- `publish_claims`
  - intended: UNIQUE `(brand_id, post_type, date_jst)`
  - obsolete blocker: UNIQUE `(post_type, date_jst)`

This task does not authorize production apply.

## Mandatory fresh start

1. `git fetch origin main`
2. fresh `origin/main`
3. read `.agent/ORCHESTRATION.md`
4. read `.agent/CURRENT_STATE.md`
5. read this TASK
6. read latest `.agent/CODEX_REPORT_2.md`
7. inspect H1/G1/G2 for overlap
8. read-only production metadata refresh for exact current constraint/index names
9. inspect migration history/source for where brand-scoped indexes and old constraints originated

If another slot touches these three tables/migrations/constraints, STOP.

## Scope A — production read-only preflight

Read-only confirm:
- exact table/constraint/index names
- whether legacy uniqueness is backed by a named table constraint or standalone unique index
- brand_id nullability/default/backfill state
- duplicate-risk rows that would violate intended brand-scoped uniqueness
- existing rows with null brand_id
- dependent FKs/RPCs/functions that reference the obsolete constraint/index names directly
- planner/on-conflict code that depends on the old conflict target

Do not expose row content or identifiers; aggregate/safe metadata only.

## Scope B — minimal migration candidate

Create one source-only forward migration candidate that:
- removes only the three obsolete global uniqueness blockers
- preserves the three brand-scoped unique indexes/constraints
- does not rename unrelated objects
- does not modify data unless absolutely required and separately justified
- fails closed if the expected current objects do not match
- avoids blind `DROP INDEX IF EXISTS` if a stronger exact-object assertion is possible
- documents rollback strategy

Important:
- determine whether `ON CONFLICT (...)` statements in current RPC/functions depend on the old global key.
- if they do, the same candidate must include the minimum exact update needed to switch conflict target to brand-scoped keys, or STOP and report that a larger migration is required.
- do not alter queue fairness, token routing, retry semantics, or publisher code in this phase.

## Scope C — disposable PostgreSQL proof

Use fake-only/disposable PostgreSQL.

Prove at minimum:

### posting_windows
- brand A can insert `post_type=X, slot=1`
- brand B can insert same `post_type=X, slot=1`
- same brand duplicate still fails

### scheduled_posts
- brand A and B can insert same date/post_type/slot independently
- same brand duplicate still fails

### publish_claims
- brand A and B can claim same date/post_type independently
- same brand duplicate still fails

Also prove:
- current representative legacy rows survive migration
- any required `ON CONFLICT` function/RPC still behaves correctly
- migration apply succeeds from a production-shaped baseline
- rollback/reverse script restores the original uniqueness state in disposable DB
- cleanup leaves no residual proof objects/container

## Scope D — source/static tests

Add narrow tests for:
- exact obsolete object names
- exact brand-scoped replacement remains present
- no unrelated table/index/constraint change
- no `supabase db push`
- no production apply path

Run relevant migration/static tests and `git diff --check`.

## Forbidden

- production migration apply
- production DDL/DML
- changing live Cron
- x-test-post deploy
- Function deploy
- X API call/post
- OAuth/Vault/token change
- publish_enabled change
- Netlify/Vercel change
- unrelated publisher refactor
- queue/retry/token/account-routing changes

## Production mutation budget

Exactly 0.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- prepend/update `.agent/CODEX_REPORT_2.md`

Report must include:
1. fresh source commit
2. exact production preflight findings
3. exact obsolete object names
4. exact intended brand-scoped objects
5. whether any ON CONFLICT / RPC dependency required adjustment
6. migration candidate path
7. disposable baseline shape
8. apply result
9. two-brand coexistence proof
10. same-brand duplicate rejection proof
11. rollback proof
12. tests
13. changed files
14. production mutation = 0 proof
15. remaining risks
16. exact recommended production rollout gate
17. commit/push/fresh-origin verification

Then STOP for C2.

## Next gate after PASS

Only after C2 PASS:
- separately authorize production preflight + exact migration apply
- read back constraints/indexes and conflict behavior
- do not combine with publisher/account/token refactor in the same production gate
