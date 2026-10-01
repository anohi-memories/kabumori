# Common account v1 — Phase 1: lifecycle foundation

Status: **source candidate**. Nothing here is applied, deployed or backfilled in
production. Production mutation by this work: **0**.

- Migration candidate: `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
- Rollback: `supabase/tests/common_account_lifecycle_rollback.sql`
- Proof: `supabase/tests/common_account_lifecycle_run.sh` (disposable local PostgreSQL only)

## 1. Why

One Supabase Auth user (`auth.users.id`) is the person, shared by the Kabumori
app and the X autopost app. Today nothing records *which service a person
registered for*, and two independent routes can hard-delete the shared login:

- Kabumori `account-delete` deletes the Auth user without knowing about the X
  workspace, its posting authorization or admin membership.
- The X deletion decides its scope from "does a `profiles` row exist", and a
  `profiles` row is created by any Kabumori session.

The H1/C1 review accepted that a read-then-delete guard cannot fix this: a
workspace can be created between the read and the delete. Phase 1 therefore
adds an explicit lifecycle state with a real serialization point, as a shadow:
nothing reads it yet and every existing route behaves exactly as before.

## 2. What is added

| Object | Purpose | Client access |
| --- | --- | --- |
| `public.common_accounts` | one row per login: `active` / `deleting` / `locked`, `lifecycle_version` | own row, SELECT only |
| `public.service_entitlements` | registration per service (`kabumori`, `x_autopost`) | own rows, SELECT only (no `source` / `legacy_evidence`) |
| `private.account_lifecycle_operations` | durable deletion intent and saga checkpoints | none |
| `private.account_lifecycle_settings` | one row: Auth-delete guard mode (`shadow` / `enforce`) | none |
| `private.account_lifecycle_backfill_plan` (view) + `private.account_lifecycle_backfill(p_apply)` | shadow backfill candidate | none |

Not changed: `profiles` stays the Kabumori root, `brand_memberships` stays the X
workspace authorization, every existing table, policy, grant, trigger and
function. The runner proves this by comparing schema dumps (every prior line
still present after apply; byte-identical after rollback).

## 3. State machines

```text
common_accounts.status
  active ──begin_common_account_deletion──▶ deleting ──finalize──▶ (row and login removed)
     ▲                                          │
     └──────abort_common_account_deletion───────┘
  locked: reserved operator hold. No RPC sets it. Start and delete both fail closed.

service_entitlements.status
  (none) ──start──▶ active ──begin_service_deletion──▶ deleting ──finish──▶ ended ──start──▶ active
                       ▲                                   │
                       └──────abort_service_deletion───────┘
  provisioning / suspended: reserved. No RPC produces them; every gate treats
  them as "service still present".
```

## 4. Invariants

- **I1 — one serialization point.** Every lifecycle RPC first locks the person's
  `auth.users` row (`FOR KEY SHARE`; `finalize` takes `FOR UPDATE`) and then the
  `common_accounts` row `FOR UPDATE`, before it reads any state.
- **I2 — no start during deletion.** A service starts only while the account is
  `active`. From the commit of `begin_common_account_deletion`, every start
  returns `blocked / ACCOUNT_DELETION_IN_PROGRESS`.
- **I3 — service-only deletion is local.** Ending one entitlement never touches
  the login, the other entitlement or the other service's rows.
- **I4 — the login is removed only by `finalize`**, inside the transaction that
  holds the exclusive `auth.users` row lock and the `common_accounts` lock, and
  only when every entitlement is `ended`, no service row remains, the person is
  not an admin, holds no foreign workspace, and (if the person has an Apple
  identity) the Apple revoke checkpoint is recorded.
- **I5 — unknown fails closed.** Admin accounts, shared or internal workspaces,
  service data that no entitlement accounts for, and reserved entitlement states
  all block.
- **I6 — READ COMMITTED only.** A lifecycle RPC called at another isolation
  level raises, because the state read after a lock wait must be the committed one.

### Serialization guarantee up to the Auth hard delete

`finalize_common_account_deletion` is one transaction:

1. `auth.users` row `FOR UPDATE`, then `common_accounts` row `FOR UPDATE`.
2. Under those locks: operation is in progress, account is `deleting`, every
   entitlement is `ended`, blockers are empty, Apple checkpoint is satisfied.
3. Operation step → `auth_delete`; `delete from auth.users`; operation → `completed`.

Anything that creates service data for the person must insert a row that
references `auth.users` (profiles, brand membership, OAuth state, common account).
Such a creator either committed before step 1 — then step 2 sees its rows and
refuses — or needs the `auth.users` row while finalize holds it — then it waits
and fails on its own foreign key, rolling back its whole transaction (including a
workspace row inserted earlier in it). This holds for the **existing, unmodified**
creators too (`ensure_my_profile`, `begin_social_mobile_x_oauth_connection`); the
runner proves both commit orders with the real functions.

External steps (X revoke, Vault purge, Apple revoke) are saga steps. They run
outside any database transaction and are recorded as checkpoints; the database
never claims they were atomic with it.

### Lock order

`auth.users` row → `common_accounts` row → entitlement / operation rows → service
rows. This is the direction a login delete cascades in, so a lifecycle call and a
legacy hard delete of the same person queue behind each other (proved by race 8).
Rules for later phases:

- A creator that will call a lifecycle helper must do so **before** its first
  insert that references `auth.users`.
- `finalize` should be its own transaction. Calling it after another lifecycle
  RPC in the same transaction upgrades the `auth.users` lock and can deadlock
  with a concurrent call (PostgreSQL then aborts one; nothing is corrupted).

## 5. RPC contract

Client RPCs (role `authenticated`; the person is always `auth.uid()`; no argument):

| RPC | Result |
| --- | --- |
| `start_kabumori_service()` | `{status:'active', service, started}`; creates the account row if missing, the entitlement, and the `profiles` row, atomically. `blocked` with `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_SUSPENDED` or `SERVICE_NOT_READY`. |
| `start_x_autopost_service()` | Same, entitlement only. The workspace is still created by the existing connect RPC. |

Backend RPCs (role `service_role`; `p_user_id` is the id the caller verified from
the person's own token):

| RPC | Result |
| --- | --- |
| `common_account_deletion_eligibility(user)` | Read model: `account_status`, `lifecycle_version`, `services`, `blockers`, `apple_revoke_required`, `operation_id`. Takes no lock; advice only. |
| `begin_service_deletion(user, service)` | `started` / `in_progress` (+`operation_id`), `not_registered`, `already_ended`, `blocked`. |
| `finish_service_deletion(user, service, operation)` | `ended`, `not_ready / SERVICE_FOOTPRINT_REMAINS`, `aborted`, `not_found`, `blocked`. |
| `abort_service_deletion(user, service, operation)` | `aborted`; the entitlement returns to `active`. |
| `withdraw_kabumori_service(user)` | Begin + delete the `profiles` row (cascade) + finish, in one transaction. |
| `begin_common_account_deletion(user, expected_lifecycle_version)` | `started` (+`operation_id`, `services_to_end`, `apple_revoke_required`), `in_progress`, `lifecycle_changed`, `blocked` (+`reasons`). |
| `mark_common_account_apple_revoked(user, operation)` | `recorded`. |
| `abort_common_account_deletion(user, operation)` | `aborted`; the account returns to `active`. |
| `finalize_common_account_deletion(user, operation)` | `completed` (idempotent), `not_ready` (`SERVICES_REMAIN`, `APPLE_REVOCATION_REQUIRED`, `AUTH_DELETE_BLOCKED`, `ACCOUNT_DELETION_NOT_IN_PROGRESS`), `blocked` (+`reasons`), `not_found`. |

Blocker codes: `ADMIN_ACCOUNT`, `ACCOUNT_LOCKED`, `X_WORKSPACE_NOT_SELF_SERVICE`,
`UNREGISTERED_SERVICE_FOOTPRINT`, `SERVICE_NOT_DELETABLE`.

`lifecycle_version` increases on every account or entitlement change. The
backend passes the version the person saw on the confirmation screen; if a
service was started in between, `begin` answers `lifecycle_changed` instead of
deleting something the person did not confirm.

Retry and stale handling: every step is a state transition under the locks, so
repeating a call returns the current state (`in_progress`, `ended`,
`completed`). A deletion that will not complete is returned to `active` with
`abort_common_account_deletion`; services that already ended stay ended. There
is no lease at this level: external steps keep their own (the X saga's lease).

## 6. RLS and grants

- RLS is enabled on all four new tables. The two `public` tables have one
  policy each: `SELECT` for `authenticated` where `auth.uid() = user_id`.
- All table privileges are revoked from `PUBLIC`, `anon`, `authenticated` and
  `service_role` (this removes default `TRUNCATE` / `REFERENCES` / `TRIGGER`
  too). `authenticated` gets column-limited `SELECT` only. `service_role` gets no
  table privilege: the backend uses the RPCs.
- Every function is `SECURITY DEFINER` with `search_path = ''`. `EXECUTE` is
  revoked from `PUBLIC` and every role, then granted to exactly one role per
  RPC. Helpers in `private` are executable by nobody but their owner. Create
  and revoke happen in one transaction.
- Existing Kabumori / X policies are not changed. Entitlement checks in
  existing policies and producers are a later phase.

## 7. Auth-delete guard

A `BEFORE DELETE` trigger on `common_accounts` runs when the cascade from
`auth.users` reaches it.

- `shadow` (installed default): every delete is allowed. Legacy routes behave as
  before; lifecycle operations of the removed person are closed
  (`ACCOUNT_REMOVED_EXTERNALLY`) and their raw user id is cleared.
- `enforce`: a login delete is refused (`COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED`,
  SQLSTATE 23503) unless `finalize` authorized it in the same transaction. The
  existing X saga maps that to its own `operator_required / LOGIN_DELETE_BLOCKED`.
  A missing settings row is treated as `enforce`.

Switching to `enforce` is a separate reviewed step (section 11). It protects
only people who have a `common_accounts` row, so it comes after the backfill.

## 8. Shadow backfill candidate

`select private.account_lifecycle_backfill(false)` counts; `(true)` inserts the
missing rows. Not executed by the migration. Idempotent; never modifies an
existing entitlement; skips accounts that are not `active`.

| Rule | Evidence recorded |
| --- | --- |
| one `common_accounts` row per `auth.users` row | — |
| `kabumori`: a `profiles` row exists | `kabumori_activity` (any tracked stock, alert setting, category setting, notification, push token or report) or `kabumori_profile_only` |
| `x_autopost`: sole owner of the person's own `social_mobile_user_v1` workspace | `x_identity_verified` or `x_workspace_pending` |
| admin rights, internal or shared workspaces | no entitlement |
| login only | account row only |

E-mail is never read; two logins with the same address stay two accounts.
Against the production-shaped fixture (the Phase 0 population) the dry-run
reports 4 accounts, 2 Kabumori (1 with activity, 1 profile only), 1 X
(identity verified), 1 login only.

## 9. Deletion adapter contract (Phase 3, not implemented here)

The existing Kabumori `account-delete` is **not** made safe by this candidate.

- **Kabumori "delete account" in the app** becomes: verify the caller and a
  recent re-authentication → `withdraw_kabumori_service`. If the person has no
  other entitlement and asked for the whole account, continue with the
  whole-account flow; otherwise the login stays.
- **X deletion** keeps its saga (X revoke → fingerprint check → Vault purge).
  It is wrapped: `begin_service_deletion('x_autopost')` before `acquire`,
  `finish_service_deletion` after its purge. Its `profiles`-based scope rule and
  its own Auth delete are removed; it always behaves as service-only.
- **Whole-account deletion** is one orchestrator: eligibility → confirmation →
  `begin_common_account_deletion(expected version)` → end each service through
  its own adapter → Apple revoke + `mark_common_account_apple_revoked` when
  required → `finalize_common_account_deletion`.
- Until the X scope rule is replaced, the orchestrator must end X **before**
  Kabumori: while the profile exists the X saga stays `social_only`. The runner
  exercises this order end to end with the real X saga.
- X revoke, Vault purge and Apple revoke are not re-implemented here; the
  existing social-mobile implementation remains the only one.

## 10. Registration and login contract (later phases)

- New registration from an app = create or confirm the common account + start
  that app's entitlement. An existing person who opens the other app signs in
  and only that app's entitlement is created, by an explicit "start using" step.
- Before sign-in, an entered e-mail never reveals whether an account exists.
- Identities are linked only within one Auth user (`linkIdentity`). Two Auth
  users are never merged because their e-mail matches.
- An X login identity is not an X posting authorization; the entitlement and
  the workspace connection stay separate from the login method.
- A person who signs in with Apple cannot be fully deleted until the Apple
  grant is revoked (`APPLE_REVOCATION_REQUIRED`).

## 11. Rollout plan (not executed)

Each step is separately reviewed and authorized; stop on any mismatch.

1. Review this candidate (Auth / RLS / lifecycle). Re-run the read-only catalog
   checks the preflight depends on.
2. Apply the single file (not `db push`: migration history does not match the
   repository). The file is one transaction and refuses a second apply. Read
   back: tables, policies, grants, function ACLs, guard mode `shadow`.
3. Backfill dry-run; compare with the Phase 0 aggregates. Then apply the
   backfill and read back counts.
4. Phase 2 dual-write: the two existing creators also register the entitlement
   (section 13). Parity check: backfill dry-run stays at zero to create.
5. Phase 3: deletion routes move to the lifecycle (section 9).
6. Only then switch the guard to `enforce`.
7. Later: entitlement conditions in existing RLS and backend producers, behind a flag.

## 12. Rollback

`supabase/tests/common_account_lifecycle_rollback.sql` drops exactly what the
candidate created. It refuses while the guard is `enforce` or a deletion is in
flight. Before step 4 nothing depends on these objects, so rollback loses only
shadow rows. The runner proves the schema dump after rollback is identical to
the dump before apply, and that the candidate applies again afterwards.

## 13. Phase 2 integration points (exact list, nothing edited here)

Kabumori:
- `src/lib/auth.ts` (`ensureProfile` / `prepareSession`), `src/providers/auth-provider.tsx`,
  `src/app/_layout.tsx`: replace the implicit profile bootstrap with an explicit
  service start; gate the app on the entitlement.
- `public.ensure_my_profile()`: require an active `kabumori` entitlement (new migration).
- `src/app/settings.tsx`, `src/lib/account-deletion.ts`, `src/lib/account-deletion-client.ts`,
  `supabase/functions/account-delete/*`, `apps/kabumori-web/pages/account-deletion.html`:
  section 9.

X autopost (after PR #65 lands; its files are not touched here):
- `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`,
  `apps/social-mobile/src/data/onboarding-repository.ts`: explicit service start.
- `public.begin_social_mobile_x_oauth_connection`: lifecycle assertion as its
  first statement (new migration).
- `supabase/functions/social-mobile-account-delete/*` and
  `social_mobile_account_deletion_scope` / `_finalize`: section 9.

Backend producers that bypass RLS (entitlement condition, last phase):
`claim_pending_push_notifications`, `enqueue_important_news_notifications`,
`enqueue_personalized_report_notification`, `personalized_report_news_inputs`,
`important_news_app_copy_targets`, `supabase/functions/personalized-reports/index.ts`,
`supabase/functions/x-test-post/index.ts`.

## 14. Known limits of Phase 1

- Shadow only: the existing creators do not register entitlements yet, so
  service data can exist without one. The lifecycle treats that as
  `UNREGISTERED_SERVICE_FOOTPRINT` and refuses, rather than guessing.
- The existing Kabumori hard-delete route is unchanged and still unsafe for a
  person who uses both services.
- No server-side re-authentication rule is added; that belongs to the Edge
  Functions in Phase 3.
- A token issued before deletion stays valid until it expires. It cannot
  re-create anything: every creator fails on the missing `auth.users` row.

## 15. Running the proof

```bash
CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
  supabase/tests/common_account_lifecycle_run.sh
```

Local disposable cluster only (the runner refuses any host outside `/tmp`). It
applies the existing production-shaped fixture, the real onboarding RPC
migrations, the real social-mobile deletion candidate and this candidate, then
checks: preflight refusal, additive apply and refused re-apply, static source
rules, behavior (backfill, ACL/RLS, start, whole-account and service-only
deletion, fail-closed cases, Apple checkpoint, guard modes), eight two-session
races, isolation guard, no deadlock, and rollback.
