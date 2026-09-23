# Codex Task 2

- task_id: x-autopost-phase0b-publish-claim-brand-scope-and-migration-reconciliation-20260923
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase0 C2で確認されたblockerを解消するため、productionを一切変更せず、publish_claim clientをtrusted brand_idでbrand-scoped化するsource candidateと、multibrand foundation migration/source-history driftの安全な解消案を作る。完成後にPhase0 migration proofを再実行可能な状態へ戻す。

## C2 finding carried forward

Phase0 disposable proof itselfは成立したが、production rollout candidateとしては未完成。

Confirmed blocker:
- `publish_claim_logic.ts` uses PostgREST conflict target `post_type,date_jst`
- insert body has no explicit `brand_id`
- completion/failure PATCH filters omit `brand_id`
- removing legacy global publish_claims UNIQUE first would break the claim path and could make updates cross-brand ambiguous

Also confirmed:
- live multibrand brand columns/scoped indexes are represented in an older feature-branch migration source, but that migration is not in current `origin/main` ancestry / production migration history under the expected version.
- blind history repair or `supabase db push` is forbidden.

## Mandatory fresh start

1. fetch fresh `origin/main`
2. read ORCHESTRATION / CURRENT_STATE / this TASK / latest REPORT2
3. inspect other slots for `x-test-post`, publish_claims, the three scheduler tables, or migration overlap
4. read-only refresh production definitions for publish_claims and affected planner RPCs
5. inspect exact call sites for `claimPublishSlot`, `completePublishSlot`, `failPublishSlot`

If overlap exists, STOP.

## Scope A — trusted brand propagation

Design/implement source-only minimal change so publish claim calls use a trusted server-side brand identity.

Requirements:
- claim function requires `brandId`
- insert explicitly writes `brand_id`
- PostgREST conflict target becomes `brand_id,post_type,date_jst`
- completion PATCH filters by `brand_id + post_type + date_jst + status`
- failure PATCH filters the same way
- callers derive brandId from trusted server-side context, not request/client input
- current Kabumori morning-greeting path must pass explicit trusted `kabumori` brand identity
- no generic client-selectable brand/account/token authority
- preserve existing exactly-once / no-auto-retry semantics

Audit every call site. Do not leave optional/default brand parameters that could silently fall back across brands.

## Scope B — tests

Add/adjust tests proving:
- two brands can hold same `post_type/date_jst` claim independently
- same brand duplicate still blocked
- complete/fail for brand A cannot mutate brand B row
- claim request uses exact `on_conflict=brand_id,post_type,date_jst`
- body always contains trusted brand_id
- current Kabumori greeting uses `kabumori`
- confirmed-X completion/failure behavior remains unchanged
- full relevant x-test-post regression passes

No X API call.

## Scope C — planner / ON CONFLICT migration candidate completeness

Re-audit the four planner RPCs that use old scheduled_posts conflict target:
- `plan_daily_posts(date)`
- `plan_morning_report(date)`
- `plan_close_report(date)`
- `plan_us_premarket_report(date)`

Prepare exact source-only SQL updates needed to switch each to brand-scoped conflict behavior when the old global scheduled_posts constraint is removed.

Also inspect migration-time posting_windows upserts. If only historical seed-time behavior is affected, document the safe source migration strategy; do not mutate production.

## Scope D — source/history drift reconciliation

Do not repair production history.

Produce a precise reconciliation recommendation covering:
- live objects that exist but whose originating multibrand migration is absent from current main ancestry/history under expected version
- whether the new migration can safely assert the live schema and proceed forward without backfilling/replaying the old migration
- whether a baseline/marker migration is needed in source only
- exact reason blind replay is unsafe

Prefer an idempotent forward-only reconciliation strategy that validates current live shape instead of replaying old DDL.

## Scope E — re-run disposable proof

Once source candidate is complete, rerun disposable PostgreSQL with:
- production-shaped legacy constraints + brand-scoped indexes
- updated planner routines
- updated publish_claim behavior contract represented in tests
- forward migration removing obsolete globals
- 2-brand coexistence
- same-brand duplicate rejection
- rollback proof

The source candidate may be committed/pushed only if complete and self-consistent. Do not push the previously blocked incomplete draft as-is.

## Forbidden

- production migration apply
- production DDL/DML
- x-test-post deploy
- Function deploy
- Cron change
- X API call/post
- OAuth/Vault/token change
- publish_enabled change
- Netlify/Vercel change
- queue fairness/refactor beyond required ON CONFLICT targets
- token/account routing refactor
- migration history repair

## Production mutation budget

0.

## Completion

When complete:
- status -> review_required
- next_owner -> chatgpt
- update CODEX_REPORT_2 with:
  - exact call-site changes
  - trusted brand derivation proof
  - publish claim tests
  - planner SQL changes
  - drift reconciliation recommendation
  - disposable apply/behavior/rollback result
  - full test counts
  - changed files
  - commit/push/fresh-origin proof
  - production mutation=0
  - exact next production gate

Then STOP for C2.
