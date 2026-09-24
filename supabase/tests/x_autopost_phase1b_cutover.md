# Phase1b queue candidate: cutover gate (not production instructions)

This migration is source-only. It must **not** be applied or used to publish while the
legacy `x-test-post` dispatcher still calls `claim_due_post()` and resolves X credentials
from `brand_id`. The new queue is deliberately not wired to that dispatcher.

## Creator/dispatcher audit

- `plan_daily_posts(date)` creates tip/interaction/window rows. It has `posting_windows.brand_id`
  but no trusted account argument; current rows stay unbound. The candidate
  `plan_daily_posts_v2(brand_id, social_account_id, date)` takes an **explicit** caller-provided
  account and delegates to `schedule_account_bound_post_v2`.
- `plan_morning_report(date)`, `plan_close_report(date)`,
  `plan_us_premarket_report(date)` and `plan_weekly_useful_tips(date)` have no trusted
  account input. Their current source remains legacy/unbound. A later reviewed caller
  must supply an exact account to the generic `schedule_account_bound_post_v2` or
  version these planners; selecting an account by brand/count/`limit=1` is prohibited.
- `x-test-post/index.ts` calls legacy `claim_due_post`, then `loadBrandContext` from
  the row's brand. The latter currently selects the first brand X account. It also
  calls legacy type-specific complete/retry/fail RPCs. None of those calls were
  changed in Phase1b. They cannot consume the new attempt ledger safely yet.
- Other direct `scheduled_posts` inserts are historical migration definitions; the
  live creator list above was checked read-only. No new migration rewrites old logs.

## Required separate cutover review

1. Inventory terminal (`succeeded`/`failed`) rows: leave them unbound historical data.
2. Inventory live `pending`/`running` rows. For each row, require an explicit,
   contemporaneous account assignment from its creator/user intent and verify the
   account id, brand, X platform, identity, and publish permission. A brand with
   one X account is **not** sufficient evidence. If provenance is absent, keep the
   row unbound and require operator choice or cancellation. No automatic backfill.
3. Resolve all in-flight legacy `running` rows and uncertain provider outcomes before
   switching. Do not make a previously attempted X call retryable by inference.
4. In a future separately approved release, version every active planner/caller to
   pass the exact account id; route the dispatcher by the claim result's account id,
   never by `brand_id`; bind X credentials to that same account. Replace all
   type-specific completion/retry/failure paths with the v2 ledger transitions,
   preserving their existing domain side effects in one reviewed transaction.
5. Only then switch the existing dispatch path from legacy claim to v2 claim.
   Ensure legacy and v2 claimers never run against the same bound rows; no Cron
   cadence change is inherently needed. Reconcile **pre-X** attempts only.
6. Verify account isolation, fair progress, no duplicate X post, post history/admin
   visibility, and unknown-outcome manual resolution in staging before production.

The v2 claim ignores unbound rows; old pending rows will not disappear, but will
remain on the legacy path until a separate explicit disposition is approved.
