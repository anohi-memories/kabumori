# common account Phase 1 — production legacy backfill gate (NOT executed)

Status: tooling and plan only. `backfill(true)` has not run against production. The production write needs
its own explicit approval, a same-day read-only check and a production-mutation mutex check.

The foundation (`20261001150000_common_account_lifecycle_foundation.sql`, SHA-256
`e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`) is installed in production with
0 accounts, 0 entitlements and 0 lifecycle operations. The only writer used here is the reviewed
`private.account_lifecycle_backfill(boolean)`; no ad-hoc insert, update or delete, no `db push`, no repair.

| file | what | writes |
|---|---|---|
| `check.sql` | Phase A (foundation and population), Phase B (`backfill(false)` with counts before and after), Phase C (parity recomputed from the base tables, the system's own footprint per login, workspace kinds). One `BEGIN … READ ONLY` transaction, ends in `ROLLBACK`. | none (a write inside it fails: proven) |
| `apply.sql` | the one production write transaction (below) | one transaction, commits only if every assertion holds |
| `proof.sh` | local disposable rehearsal of both files | local only |

Both files print `label=<json>` lines with aggregate counts and flags only — no user id, e-mail, provider
subject, handle, token or user content.

## apply.sql — fail-closed single transaction

Run as `postgres` through the session pooler with `psql -X -q -A -t -v ON_ERROR_STOP=1`, the approved
numbers passed as psql variables (`exp_auth_users`, `exp_accounts_to_create`, `exp_kab_to_create`,
`exp_kab_activity`, `exp_kab_profile_only`, `exp_x_to_create`, `exp_x_verified`, `exp_x_pending`,
`exp_x_excluded_admin`, `exp_auth_only`). Inside one READ COMMITTED transaction with
`lock_timeout = 5s` and `statement_timeout = 120s`:

1. precondition: settings `shadow / not_started`; 0 accounts, 0 entitlements, 0 operations;
2. a fresh `backfill(false)` equals the approved numbers (any new login, profile, workspace or
   admin since approval changes it);
3. `backfill(true)` — the reviewed function: per login in id order, `FOR KEY SHARE` on the `auth.users`
   row (GoTrue's ordinary updates are not blocked; only a delete of that login is), then the account row;
4. postcondition: created counts equal the plan; one active account per login and none missing;
   entitlements all `active / legacy_backfill` with the approved evidence split; no admin holds an X
   entitlement; Auth-only logins have no entitlement; every account's version is 1 + its entitlements;
   0 lifecycle operations; settings unchanged;
5. `backfill(false)` again leaves nothing to create;
6. `COMMIT`, then a `COMMITTED=` line.

Any failed assertion raises (`BACKFILL_PRECONDITION_STATE`, `BACKFILL_PLAN_CHANGED`,
`BACKFILL_POSTCONDITION`, `BACKFILL_NOT_IDEMPOTENT`), as does a lock wait over 5 s or any error; psql exits
3 and the whole transaction rolls back, including rows already created for earlier logins.

## Failure behaviour

| outcome | meaning | operator action |
|---|---|---|
| exit 0 with `COMMITTED=` | all assertions held, committed | read-only read-back (`check.sql`, runner `status`) |
| exit 3 with `STOP=` / `BACKFILL_*` | refused before or after the write; rolled back | stop; send output; nothing to repair |
| exit 3 with `lock timeout` | a login was locked by another transaction (e.g. its deletion); rolled back | stop; review; a new attempt is a new approval |
| exit 2 / connection lost / no `COMMITTED=` line | outcome unknown | do NOT rerun; run `check.sql` read-only and classify: 0 accounts = not applied; exactly the approved rows and nothing to create = applied; anything else = STOP |

A rerun after a commit is refused by the precondition (proven). Partial states cannot be committed by
`apply.sql`; manual repair is never part of this gate.

## Local rehearsal

`CAL_PGHOST=/private/tmp/<socket dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_lifecycle_backfill/proof.sh`
builds the lifecycle suite's production-shaped baseline plus the foundation, seeds 7 fake logins (Kabumori
with activity and admin, profile only, X verified, X pending, login only, an admin who solely owns a verified
self-service workspace, an owner of an internal workspace) and proves: check is READ ONLY and writes nothing;
its dry-run and its independently recomputed parity agree; a write smuggled into it is refused; apply commits
exactly the approved rows; a rerun after commit, a changed plan, wrong approved numbers, a missing number, a
lock held on one login, and an altered row after the write all exit 3 with nothing committed.
