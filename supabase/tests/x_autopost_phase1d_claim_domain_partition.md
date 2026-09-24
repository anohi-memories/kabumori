# X autopost Phase1D — claim-domain partition and planner authority

Status: **source-only candidate**. Nothing here is applied to production. Do not apply or deploy without a separately approved activation that also completes the Phase1C prerequisites (exact-account credential resolver, atomic per-type completion, provider-step outcome model).

Files:

- `supabase/migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql` (requires Phase1B `20260924023133`)
- `supabase/tests/x_autopost_phase1d_fixture.sql`, `x_autopost_phase1d_behavior.sql`, `x_autopost_phase1d_run.sh`
- `supabase/functions/x-test-post/claim_domain_partition_migration_test.ts`

## 1. Claim-domain contract

| Row | Domain | Who may claim | Who may change lifecycle columns |
| --- | --- | --- | --- |
| `social_account_id IS NULL` | legacy | `claim_due_post_legacy_unbound_v2()` (and, until retired, live `claim_due_post()`) | legacy RPCs, never a v2 RPC |
| `social_account_id IS NOT NULL` | v2 | `claim_due_post_v2()` only | the nine Phase1B v2 RPCs only |

Enforced in the database, not by caller discipline:

1. **Select-time fence.** The versioned legacy claim selects and updates only `social_account_id IS NULL`. Phase1B `claim_due_post_v2()` already selects only bound rows through `post_queue_account_turns_v2`.
2. **Binding is immutable.** Trigger `scheduled_posts_claim_domain_v2` rejects any UPDATE that changes `social_account_id` (`CLAIM_DOMAIN_IMMUTABLE`): no bind at claim time, no rebind on retry, no unbind, no legacy backfill through any path.
3. **Bound creation and lifecycle are v2-only.** After the activation gate opens, a bound INSERT outside a v2 RPC is still rejected (`BOUND_ROW_REQUIRES_V2_PATH`), and an INSERT cannot start already `running`/terminal or with a nonzero attempt count or timestamps (`BOUND_ROW_INVALID_INITIAL_STATE`). An UPDATE that changes `status`, `attempt_count`, `scheduled_for`, `started_at` or `finished_at` on a bound row is rejected unless it runs inside a v2 RPC. This covers live `retry_scheduled_post`, `fail_scheduled_post`, every `complete_*_post`, the morning-report stale reconciler (`morning_report_retry_logic.ts` → `fail_scheduled_post`) and direct PostgREST writes.
4. **Bound routing identity is immutable.** An UPDATE to `brand_id`, `schedule_date`, `post_type` or `slot_no` on a bound row is rejected even if its lifecycle tuple is unchanged (`BOUND_ROW_ROUTING_IMMUTABLE`). Unrelated updates to historical terminal rows remain possible.
5. **v2 never touches unbound rows.** Inserting or updating an unbound row inside a v2 RPC raises `UNBOUND_ROW_IN_V2_DOMAIN`.
6. **Activation gate.** No bound row can be inserted, and no bound row can move `pending → running`, while live `claim_due_post()` is still executable by `anon`, `authenticated` or `service_role` (`LEGACY_UNPARTITIONED_CLAIM_ACTIVE`, helper `x_queue_legacy_claim_retired_v2()`). If EXECUTE is ever re-granted, v2 claim fails closed and the old claim raises instead of taking a bound row.

"Inside a v2 RPC" is a transaction-local setting `kabumori.x_queue_domain = 'v2'`. A non-superuser owner (Supabase `postgres`) cannot attach a custom setting with `ALTER FUNCTION … SET` (verified: `permission denied to set parameter`), so each reviewed Phase1B function is renamed to `*_core` **byte-for-byte unchanged**, all EXECUTE on the cores is revoked (including `service_role`), and the public v2 name becomes a service_role-only wrapper that sets the domain, calls the core and restores the previous value. PostgREST cannot call `set_config`, so the marker is not reachable from an API role; it guards against code-path mistakes, not against a privileged SQL session.

Not changed: live `claim_due_post`, `retry_scheduled_post`, `fail_scheduled_post`, all `complete_*_post`, all planners, Phase1B bodies, `x-test-post` runtime.

## 2. Planner authority matrix

Sources: live-source migrations on fresh main; the Phase1C read-only production audit (`.agent/CODEX_REPORT_2.md`, 2026-09-24) for the live five-planner claim. No production query was run in this task (see §6).

| Planner / caller | Post types | Brand authority | Account authority | Class | Candidate binding | Claim domain | Readiness / blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plan_daily_posts()` via legacy claim | `tip`, `interaction`, `morning_greeting`, `brand_post` (active `posting_windows`) | `posting_windows.brand_id` | none | 3 | unbound | legacy | stays legacy; no account input exists |
| `plan_morning_report()` via legacy claim | `morning_report` | `morning_report_settings` (brand PK) | none | 3 (→2 possible) | unbound | legacy | an explicit, operator-set account column on the settings row would make it class 2; not present |
| `plan_close_report()` via legacy claim | `close_report` | `close_report_settings` | none | 3 (→2 possible) | unbound | legacy | same; keep JPX timing/collision rules |
| `plan_us_premarket_report()` via legacy claim (last) | `us_premarket_report` | `us_premarket_report_settings` | none | 3 (→2 possible) | unbound | legacy | same; must stay last for the ±20 min collision check |
| `plan_weekly_useful_tips()` via legacy claim | `useful_tip` | weekly schedule / brand | none | 3 | unbound | legacy | no account input |
| `plan_daily_posts_v2(brand, account, date)` | caller-selected windows | explicit argument | explicit argument, verified X account of that brand | 2 | bound | v2 | no trusted producer calls it yet; gate keeps it closed until legacy claim is retired |
| `schedule_account_bound_post_v2(...)` | any | explicit | explicit, verified | 2 | bound | v2 | same |
| Direct/manual row writers (admin, SQL) | — | not established | not established | 3 | unbound only; bound insert requires v2 marker after activation and routing identity remains fixed | legacy | admin pages read `scheduled_posts` only; a privileged SQL session can set a custom GUC, so this is not an authorization boundary |
| Important News | — | separate Function/table | — | n/a | not a `scheduled_posts` producer | n/a | out of scope |

Class 1 (trusted `social_account_id` already available): **none today**. Nothing infers an account from `brand_id`, from `(brand_id, platform)` uniqueness, or from a `limit 1` lookup. Current production has exactly one X account per brand; that is not routing authority.

Slot collisions: the unique key `(brand_id, schedule_date, post_type, slot_no)` means an unbound legacy row and a bound row cannot share a slot. `schedule_account_bound_post_v2` fails with `ACCOUNT_BINDING_CONFLICT` if a legacy row already holds the slot; the legacy row stays unbound (proved). A slot's legacy producer must be retired before its account-bound producer writes.

## 3. Retry / stale / reconcile invariants (all proved on disposable PostgreSQL)

- Legacy retry (`retry_scheduled_post`) returns an unbound row to `pending` with `social_account_id` still NULL; the legacy lane reclaims it; legacy fail keeps NULL.
- v2 pre-X retry (`settle_post_pre_x_v2`, retryable) returns the row to `pending` with the same account; only `claim_due_post_v2` reclaims it, on the same account.
- `reconcile_stale_pre_x_v2` reconciles only v2 `pre_x` attempts; a stale unbound `running` row is invisible to it. The attempt FK `(scheduled_post_id, brand_id, social_account_id)` keeps unbound rows out of the v2 ledger.
- Legacy retry/fail/complete and direct writes cannot change a bound row (`BOUND_ROW_REQUIRES_V2_PATH`), and leave no log for it.
- `x_outcome_uncertain` and `x_confirmed_db_incomplete` rows are claimable by neither lane and not reconciled; legacy retry/fail are no-ops on them. Only `complete_post_x_confirmed_v2` may finish a confirmed-incomplete row.
- Provider outcome semantics are unchanged from Phase1B.

## 4. Coexistence / future activation order (design only — nothing here is authorized)

1. **Migrations (no behavior change).** Apply Phase1B then Phase1D together. Before applying, diff live `pg_get_functiondef` of `claim_due_post`, `retry_scheduled_post`, `fail_scheduled_post` and the five planners against this candidate's assumptions (§6). The gate is closed, so no bound row can exist yet; the live dispatcher keeps using the unchanged `claim_due_post()`.
2. **Deploy the legacy dispatcher switch.** Change exactly one call in `x-test-post/index.ts` `claimDuePost()`: `"claim_due_post"` → `"claim_due_post_legacy_unbound_v2"`. Retry/fail/complete calls stay as they are (the trigger fences them). This must ship **after** step 1: deploying it first would make every scheduled dispatch fail on a missing RPC. The static test `dispatcher is intentionally unchanged until the activation step` must be updated in the same change.
3. **Drain and verify.** Confirm the deployed runtime source calls only the versioned claim and that no in-flight invocation still uses the old one.
4. **Retire the unpartitioned claim.** `revoke execute on function public.claim_due_post() from service_role` (and verify `x_queue_legacy_claim_retired_v2()` is `true`). This opens the gate. **Rollback point:** until a bound row exists, re-granting EXECUTE and redeploying the old dispatcher is a full rollback; nothing has called X through v2.
5. **Still disabled at this point:** bound producers (`plan_daily_posts_v2`, report/useful-tip v2 planners that do not exist yet), and any v2 dispatcher. Legacy pending rows are drained by the legacy lane or disposed of under a separately approved plan; they are never bound.
6. **Only after the Phase1C prerequisites pass** (exact-account resolver from `claim.social_account_id`, one-request provider adapter, atomic per-type completion, tip-thread and greeting media/receipt outcome model): enable a v2 dispatcher gated OFF, retire the legacy producer for a slot, then let a trusted producer write bound rows for that slot. After bound rows exist, do not re-grant the old claim; rollback of bound rows needs its own reviewed plan (the gate will fail v2 claims closed if the old claim is re-granted).

## 5. Observation on Phase1B (not changed here)

`claim_due_post_v2_core` iterates account turns with a PL/pgSQL `FOR … FOR UPDATE SKIP LOCKED` cursor. The cursor prefetches, so one open claim transaction locks every eligible turn row (diagnostic: 0 of 2 turns lockable by a second worker). A concurrent second v2 claim therefore returns nothing instead of serving the other account. It is non-blocking and never double-claims, and the RPC commits immediately under PostgREST, so the effect is a deferred claim, not a correctness issue. A later Phase1B change could pick one turn at a time (`… limit 1` inside a loop) if parallel v2 workers are needed.

## 6. Verification

Runner (disposable local cluster only; refuses non-`/tmp` sockets; drops its databases):

```bash
PHASE1D_PGHOST=/private/tmp/<sock> PHASE1D_PGPORT=<port> PHASE1D_PGSUPER=<local superuser> \
  supabase/tests/x_autopost_phase1d_run.sh
```

It creates two throwaway databases owned by a **non-superuser** role, with Supabase-style default EXECUTE grants to `anon`/`authenticated`/`service_role`, applies fixture → Phase1B → Phase1D, runs `x_autopost_phase1d_behavior.sql` (gate closed/open, lane fences, immutability, legacy RPC fences, v2 retry, stale reconciliation, uncertain/confirmed outcomes, mismatched brand/account, non-X account, legacy planner rows unbound, slot conflict, v2-domain misuse, re-grant fail-closed, API-role denial), then a four-worker race (two legacy + two v2 workers holding their claim transactions open), a follow-up claim, and the lock diagnostic.

Live-definition caveat: a read-only production `pg_get_functiondef` check was not run in this task. The fixture uses the live-source bodies from main (`20260830093000` claim, `20260828203000`/`20260903060000` retry/fail) and the Phase1C production audit's description of the live claim (five planners, global oldest due `pending` row, `FOR UPDATE SKIP LOCKED`, `started` log). Production also carries the multibrand foundation (brand columns, log brand trigger) whose source is not on main. Step 1 of §4 must diff the live definitions first.
