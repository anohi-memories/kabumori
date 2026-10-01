# Common account v1 — Phase 1: lifecycle foundation

Status: **source candidate**. Nothing here is applied, deployed or backfilled in
production. Production mutation by this work: **0**.

- Migration candidate: `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
- Rollback: `supabase/tests/common_account_lifecycle_rollback.sql`
- Proof: `supabase/tests/common_account_lifecycle_run.sh` and
  `supabase/tests/common_account_lifecycle_mutations.sh` (disposable local PostgreSQL only)

## 0. Scope of Phase 1, and what it is not

Phase 1 is a **database contract**: account state, service entitlements, the
serialization of "start a service" against "delete", a durable deletion intent
with saga checkpoints, a shadow backfill, and least-privilege access.

**Phase 1 never deletes a login.** No statement in the candidate removes or
changes a row of `auth.users`, Storage or Vault. Whole-account deletion stops at
the durable state `ready_for_managed_auth_delete`. The actual destruction — the
Auth Admin API delete, Storage cleanup through the Storage API, session
revocation, Apple and X grant revocation, and the read-back afterwards — belongs
to a later **common account deletion orchestrator** (section 9).

Consequences that must not be read into this candidate:

- "ready" is not "deleted", and there is no "completed" state for an account
  deletion in this schema at all.
- A recorded checkpoint is the orchestrator's attestation. The database did not
  verify it.
- The existing Kabumori `account-delete` route is unchanged and is **not** made
  safe by this candidate. In the installed `shadow` mode every existing deletion
  route behaves exactly as before.
- Local PostgreSQL proves the SQL contract only. It is not proof of GoTrue,
  PostgREST, Storage or role behaviour on real Supabase.

## 1. Why

One Supabase Auth user (`auth.users.id`) is the person, shared by the Kabumori
app and the X autopost app. Today nothing records which service a person
registered for, and two independent routes can hard-delete the shared login.
A read-then-delete guard cannot fix that: a workspace can be created between the
read and the delete. Phase 1 adds an explicit lifecycle state with a real
serialization point, as a shadow: nothing reads it yet.

## 2. What is added

| Object | Purpose | Client access |
| --- | --- | --- |
| `public.common_accounts` | one row per login: `active` / `deleting` / `locked`, `lifecycle_version` | own row, SELECT only |
| `public.service_entitlements` | registration per service (`kabumori`, `x_autopost`) | own rows, SELECT only (no `source` / `legacy_evidence`) |
| `private.account_lifecycle_operations` | durable deletion intent, step, saga checkpoints | none |
| `private.account_lifecycle_managed_checkpoints` | which managed-service cleanups a deletion must attest | none |
| `private.account_lifecycle_settings` | one row: guard mode (`shadow` / `enforce`), integration state | none |
| `private.account_lifecycle_backfill_plan` (view) + `private.account_lifecycle_backfill(p_apply)` | shadow backfill candidate | none |

Not changed: `profiles` stays the Kabumori root, `brand_memberships` stays the X
workspace authorization, every existing table, policy, grant, trigger and
function. The runner proves this by comparing schema dumps (every prior line
still present after apply; byte-identical after rollback).

## 3. State machines

```text
common_accounts.status
  active ──begin_common_account_deletion──▶ deleting
     ▲                                          │
     └──────abort_common_account_deletion───────┘
  locked: reserved operator hold. No RPC sets it. Start and delete both fail closed.

account deletion operation (status in_progress)
  cleanup ──prepare_common_account_auth_delete──▶ ready_for_managed_auth_delete
     ▲                                                     │
     └────── prepare again, state no longer clean ─────────┘
  terminal: aborted | login_removed.  Never "completed".

service_entitlements.status
  (none) ──start──▶ active ──begin_service_deletion──▶ deleting ──finish──▶ ended ──start──▶ active
                       ▲                                   │
                       └──────abort_service_deletion───────┘
  provisioning / suspended: reserved. No RPC produces them; every gate treats
  them as "service still present".
```

`login_removed` is written by the guard trigger when the login row disappears
while an operation is open. It is an observation, not a verified deletion: the
orchestrator's read-back and audit decide whether the account deletion is done.

## 4. Invariants

- **I1 — one serialization point.** Every lifecycle RPC first locks the person's
  `auth.users` row (`FOR KEY SHARE`; the readiness check takes `FOR UPDATE`) and
  then the `common_accounts` row `FOR UPDATE`, before it reads any state. The
  backfill takes the same locks, login by login.
- **I2 — no start during deletion.** A service starts only while the account is
  `active`. From the commit of `begin_common_account_deletion`, every start
  returns `blocked / ACCOUNT_DELETION_IN_PROGRESS`.
- **I3 — service-only deletion is local.** Ending one entitlement never touches
  the login, the other entitlement or the other service's rows.
- **I4 — readiness.** An account deletion becomes `ready_for_managed_auth_delete`
  only when, under the locks: every entitlement is `ended`; no service row,
  admin membership or foreign workspace remains; every required managed
  checkpoint is recorded; and no managed ownership is visible to the database.
  Calling `prepare` again re-evaluates and drops the operation back to `cleanup`
  if that is no longer true.
- **I5 — unknown fails closed.** Admin accounts, shared or internal workspaces,
  service data that no entitlement accounts for, reserved entitlement states,
  an unreadable Storage shape, a newly registered managed checkpoint, and a
  damaged checkpoint registry all block.
- **I6 — READ COMMITTED only.** A lifecycle RPC or the backfill called at another
  isolation level raises, because the state read after a lock wait must be the
  committed one.
- **I7 — the version follows the state.** `lifecycle_version` is moved by
  trigger on every account-state change and on every entitlement insert, update
  or delete, whatever wrote it (RPC, backfill, an operator's SQL). It can never
  decrease. Version `1` therefore means "a row that never had an entitlement or a
  state change". Version `0` means "no account row" and never matches a row.

### Confirmation binding

The backend passes the version the person saw on the confirmation screen.

- Preview of an absent account reports `0`. `begin(0)` is accepted only if there
  is still no row; the row it then creates must be exactly the fresh one
  (version 1, active, no entitlement), otherwise `lifecycle_changed`.
- Any path that introduces an entitlement invalidates earlier confirmations,
  including the backfill creating the account and the entitlement together.

### Lock order

`auth.users` row → `common_accounts` row → entitlement / operation rows → service
rows. This is the direction a login delete cascades in, so a lifecycle call and
a hard delete of the same person queue behind each other (race 8). Rules for
later phases:

- A creator that will call a lifecycle helper must do so **before** its first
  insert that references `auth.users`.
- `prepare` should be its own transaction. Calling it after another lifecycle
  RPC in the same transaction upgrades the `auth.users` lock and can deadlock
  with a concurrent call (PostgreSQL then aborts one; nothing is corrupted).

## 5. RPC contract

Client RPCs (role `authenticated`; the person is always `auth.uid()`; no argument):

| RPC | Result |
| --- | --- |
| `start_kabumori_service()` | `{status:'active', service, started}`; creates the account row if missing, the entitlement, and the `profiles` row, atomically. `blocked` with `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_SUSPENDED` or `SERVICE_NOT_READY`. |
| `start_x_autopost_service()` | Same, entitlement only. The workspace is still created by the existing connect RPC. |

Backend RPCs (role `service_role`; `p_user_id` is the id the caller verified from
the person's own token — an Edge Function obligation, not something SQL can check):

| RPC | Result |
| --- | --- |
| `common_account_deletion_eligibility(user)` | Read model: `account_status`, `lifecycle_version`, `services`, `blockers`, `required_checkpoints`, `managed_ownership`, `operation`. Takes no lock; advice only. |
| `begin_service_deletion(user, service)` | `started` / `in_progress` (+`operation_id`), `not_registered`, `already_ended`, `blocked`. |
| `finish_service_deletion(user, service, operation)` | `ended`, `not_ready / SERVICE_FOOTPRINT_REMAINS`, `aborted`, `not_found`, `blocked`. |
| `abort_service_deletion(user, service, operation)` | `aborted`; the entitlement returns to `active`. |
| `withdraw_kabumori_service(user)` | Begin + delete the `profiles` row (cascade) + finish, in one transaction. |
| `begin_common_account_deletion(user, expected_lifecycle_version)` | `started` (+`operation_id`, `services_to_end`, `required_checkpoints`), `in_progress`, `lifecycle_changed`, `blocked` (+`reasons`). |
| `record_common_account_deletion_checkpoint(user, operation, checkpoint)` | `recorded`. Raises for a checkpoint that is not in the registry. |
| `abort_common_account_deletion(user, operation)` | `aborted`; the account returns to `active`, from `cleanup` or from `ready`. |
| `prepare_common_account_auth_delete(user, operation)` | `ready_for_managed_auth_delete` (+`login_deleted:false`, `next_steps`); `not_ready` (`SERVICES_REMAIN`, `MANAGED_CHECKPOINTS_MISSING`, `MANAGED_OWNERSHIP_REMAINS`, `MANAGED_CHECKPOINT_REGISTRY_INVALID`, `ACCOUNT_DELETION_NOT_IN_PROGRESS`); `blocked` (+`reasons`); `not_found`. Each answer carries non-secret `next_steps`. |

Blocker codes: `ADMIN_ACCOUNT`, `ACCOUNT_LOCKED`, `X_WORKSPACE_NOT_SELF_SERVICE`,
`UNREGISTERED_SERVICE_FOOTPRINT`, `SERVICE_NOT_DELETABLE`.

Retry and stale handling: every step is a state transition under the locks, so
repeating a call returns the current state. A deletion that will not complete is
returned to `active` with `abort_common_account_deletion`; services that already
ended stay ended. There is no lease at this level: external steps keep their own
(the X saga's lease).

## 6. Managed ownership and checkpoints

Storage records an object's owner as plain text (`owner_id`, and the deprecated
uuid `owner`). It is **not** a foreign key to the login, so removing a login
neither blocks on nor cleans up that person's objects, and Storage objects may
only be removed through the Storage API.

What Phase 1 does about it:

- It does not delete from Storage and does not implement Storage cleanup.
- `storage_cleanup`, `session_revocation` and (for a person with an Apple
  identity) `apple_revocation` are **required checkpoints**. `prepare` refuses
  until the orchestrator has recorded each one.
- `prepare` and the guard also run a read-only probe of `storage.objects` and
  `storage.buckets`. If the database can still see ownership, the answer is
  `MANAGED_OWNERSHIP_REMAINS` even though the checkpoint was recorded. The probe
  is a reason to refuse, **never proof of absence**: an object can be uploaded
  right after it with a still-valid token.
- If the Storage tables or their `owner_id` column are not there in the expected
  shape, the probe answers `MANAGED_STORAGE_SHAPE_UNKNOWN` (fail closed).
- Extension point: a newly discovered kind of managed ownership is added as a
  row in `private.account_lifecycle_managed_checkpoints`. From then on every
  deletion fails closed until an orchestrator attests it. A registry that lost a
  built-in row makes every deletion not ready.

## 7. RLS and grants

- RLS is enabled on all five new tables. The two `public` tables have one
  policy each: `SELECT` for `authenticated` where `auth.uid() = user_id`.
- All table privileges are revoked from `PUBLIC`, `anon`, `authenticated` and
  `service_role` (this removes default `TRUNCATE` / `REFERENCES` / `TRIGGER`
  too). `authenticated` gets column-limited `SELECT` only. `service_role` gets no
  table privilege: the backend uses the RPCs.
- Every function is `SECURITY DEFINER` with `search_path = ''` and
  schema-qualified names. `EXECUTE` is revoked from `PUBLIC` and every role, then
  granted to exactly one role per RPC. Helpers in `private` are executable by
  nobody but their owner. Create and revoke happen in one transaction.
- Existing Kabumori / X policies are not changed.

## 8. Auth-delete guard

A `BEFORE DELETE` trigger on `common_accounts` runs when the cascade from
`auth.users` reaches it.

- `shadow` (installed default): every delete is allowed. Existing routes behave
  as before — **unchanged, not safe**. Open lifecycle operations of the removed
  person are closed (`login_removed`, `ACCOUNT_REMOVED_EXTERNALLY`) and their raw
  user id is cleared.
- `enforce`: a login delete is refused (`COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED`,
  SQLSTATE 23503) unless the account is `deleting`, a `ready` operation exists,
  every entitlement is `ended`, the blockers are empty and the managed-ownership
  probe is clean — all evaluated at that moment, inside the deleting transaction,
  which holds the `auth.users` row. A creator that needs that row waits and then
  fails on its own foreign key; one that committed earlier is seen and refuses
  the delete (races 11 and 12). The existing X saga maps the refusal to its own
  `operator_required / LOGIN_DELETE_BLOCKED`. A missing settings row is treated
  as `enforce`.

Limits, stated on purpose:

- `enforce` cannot be set while `integration_state` is `not_started` (a table
  constraint). It must not be enabled before the creators and deletion routes are
  wired to the lifecycle.
- The guard protects only people who have a `common_accounts` row.
- An allowed delete means the database-visible state was clean. It says nothing
  about Storage objects uploaded later or about provider grants.
- A table owner or superuser can disable triggers; this is not a control
  against privileged maintenance.

## 9. Prerequisites for the deletion orchestrator (not implemented here)

The orchestrator and the client integration own all of the following. None of
them is solved by Phase 1.

1. **Recent re-authentication** of the person, enforced server-side, before
   `begin`.
2. **Session revocation and a stale-token policy.** A token issued before the
   deletion stays valid until it expires; removing the login does not invalidate
   it. Revoke sessions, then record `session_revocation`.
3. **Each service's own cleanup**: Kabumori through `withdraw_kabumori_service`;
   X through its existing saga (X posting authorization revoke → fingerprint
   check → Vault purge), wrapped by `begin_service_deletion` /
   `finish_service_deletion`.
4. **Apple grant revocation** for a person with an Apple identity, then record
   `apple_revocation`.
5. **Storage cleanup through the Storage API**, re-listing until empty, then
   record `storage_cleanup`. Retried until it converges; idempotent.
6. `prepare_common_account_auth_delete` → `ready_for_managed_auth_delete`.
7. **Revalidation immediately before the delete**: call `prepare` again and
   re-list Storage. Anything found returns the flow to step 3 or 5.
8. **Managed Auth delete through the Auth Admin API** — never SQL against
   `auth.users`.
9. **Post-delete read-back and audit**: confirm the login, sessions, identities,
   Storage objects and service rows are gone; retry or raise an operator case
   otherwise. Only this step may call an account deletion complete, and it needs
   its own schema change to record that.

Also required before any production use: a proof on a disposable **real**
Supabase project of the Auth / Storage / session behaviour and of the role
boundaries (`supabase_auth_admin`, `postgres`, PostgREST).

## 10. Shadow backfill candidate

`select private.account_lifecycle_backfill(false)` counts from one unlocked
snapshot. `(true)` goes login by login in id order: it takes the lifecycle locks,
re-reads that login's plan row after the lock, and only then inserts what is
still missing. Not executed by the migration. Idempotent; never modifies an
existing entitlement; a login whose account is not `active` at that moment gains
nothing; every inserted entitlement moves `lifecycle_version`.

| Rule | Evidence recorded |
| --- | --- |
| one `common_accounts` row per `auth.users` row | — |
| `kabumori`: a `profiles` row exists | `kabumori_activity` (any tracked stock, alert setting, category setting, notification, push token or report) or `kabumori_profile_only` |
| `x_autopost`: sole owner of the person's own `social_mobile_user_v1` workspace, **and not an admin** | `x_identity_verified` or `x_workspace_pending` |
| admin (even when the same login owns a self-service workspace), internal or shared workspaces | no X entitlement. Kabumori follows its own rule. |
| login only | account row only |

E-mail is never read; two logins with the same address stay two accounts.
Against the production-shaped fixture (the Phase 0 population) the dry-run
reports 4 accounts, 2 Kabumori (1 with activity, 1 profile only), 1 X
(identity verified), 1 login only. That is a fixture result, not a production
dry-run.

The apply holds the locks of every login it has visited until it commits. With
the current population that is a few rows; for a large population it should be
run in a quiet window.

## 11. Preflight

The migration is one transaction and refuses unless the schema matches exactly:

- required schema, roles and tables (including `storage.objects` / `storage.buckets`);
- every column an invariant reads, with its exact type;
- every foreign key an invariant relies on, bound to its **exact referencing and
  referenced columns**, with equal column types, the expected delete action,
  validated, and not deferrable;
- no table hanging off `profiles` without `ON DELETE CASCADE`;
- the two reused helper functions with their exact signatures and return type;
- not already applied.

## 12. Deletion adapter contract (later phase, not implemented here)

- **Kabumori "delete account" in the app** becomes: verify the caller and a
  recent re-authentication → `withdraw_kabumori_service`. If the person has no
  other entitlement and asked for the whole account, continue with the
  orchestrator; otherwise the login stays.
- **X deletion** keeps its saga. It is wrapped by `begin_service_deletion` /
  `finish_service_deletion`. Its `profiles`-based scope rule and its own login
  delete are removed; it always behaves as service-only.
- Until the X scope rule is replaced, X must be ended **before** Kabumori: while
  the profile exists the X saga stays `social_only`. The runner exercises this
  order with the real X saga.

## 13. Registration and login contract (later phases)

- New registration from an app = create or confirm the common account + start
  that app's entitlement. An existing person who opens the other app signs in
  and only that app's entitlement is created, by an explicit "start using" step.
- Before sign-in, an entered e-mail never reveals whether an account exists.
- Identities are linked only within one Auth user. Two Auth users are never
  merged because their e-mail matches.
- An X login identity is not an X posting authorization.

## 14. Rollout plan (not executed)

Each step is separately reviewed and authorized; stop on any mismatch.

1. Review this candidate. Before any production apply: a separate pre-production
   review, and the real-Supabase proof of section 9.
2. Apply the single file (not `db push`: migration history does not match the
   repository). Read back: tables, policies, grants, function ACLs, guard
   `shadow`, integration `not_started`.
3. Backfill dry-run; compare with the Phase 0 aggregates. Then apply the
   backfill and read back counts.
4. Integration phase: the existing creators register entitlements and take the
   lifecycle lock first (section 16); set `integration_state = 'started'`.
5. Deletion routes move to the lifecycle; the orchestrator of section 9 exists.
6. Only then switch the guard to `enforce`.
7. Later: entitlement conditions in existing RLS and backend producers, behind a flag.

## 15. Rollback

`supabase/tests/common_account_lifecycle_rollback.sql` drops exactly what the
candidate created, and only from an **affirmed** shadow state:

- exactly one settings row, guard `shadow`, integration `not_started`
  (a missing row is refused: the guard treats it as enforcing);
- the built-in managed checkpoints all present;
- no operation in flight, no account that is not `active`;
- no self-registered entitlement (a client already uses the start RPCs);
- no dependent object: every `DROP` is without `CASCADE`.

It is a pre-integration rollback: from step 4 on it refuses. The runner proves
each refusal, that the schema dump after rollback is identical to the dump
before apply, and that the candidate applies again afterwards. Dependencies that
PostgreSQL does not track (dynamic SQL, client code) are not detected.

## 16. Integration points (exact list, nothing edited here)

Kabumori:
- `src/lib/auth.ts` (`ensureProfile` / `prepareSession`), `src/providers/auth-provider.tsx`,
  `src/app/_layout.tsx`: replace the implicit profile bootstrap with an explicit
  service start; gate the app on the entitlement.
- `public.ensure_my_profile()`: require an active `kabumori` entitlement (new migration).
- `src/app/settings.tsx`, `src/lib/account-deletion.ts`, `src/lib/account-deletion-client.ts`,
  `supabase/functions/account-delete/*`, `apps/kabumori-web/pages/account-deletion.html`.

X autopost (after PR #65 lands; its files are not touched here):
- `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`,
  `apps/social-mobile/src/data/onboarding-repository.ts`: explicit service start.
- `public.begin_social_mobile_x_oauth_connection`: lifecycle assertion as its
  first statement (new migration).
- `supabase/functions/social-mobile-account-delete/*` and
  `social_mobile_account_deletion_scope` / `_finalize`.

Backend producers that bypass RLS (entitlement condition, last phase):
`claim_pending_push_notifications`, `enqueue_important_news_notifications`,
`enqueue_personalized_report_notification`, `personalized_report_news_inputs`,
`important_news_app_copy_targets`, `supabase/functions/personalized-reports/index.ts`,
`supabase/functions/x-test-post/index.ts`.

## 17. Known limits of Phase 1

- Shadow only: the existing creators do not register entitlements and are not
  gated, so service data can appear without an entitlement, even after an
  operation became ready. The lifecycle treats that as
  `UNREGISTERED_SERVICE_FOOTPRINT` and refuses on the next `prepare` (race 3); in
  `shadow` mode nothing stops a login delete in that window.
- The existing Kabumori hard-delete route and the existing X scope rule are
  unchanged.
- No re-authentication rule, no session revocation, no provider revocation.
- Not exercised on real Supabase.

## 18. Running the proof

```bash
CAL_PGHOST=/private/tmp/<socket-dir> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> \
  supabase/tests/common_account_lifecycle_run.sh

CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... CAL_JOBS=4 \
  supabase/tests/common_account_lifecycle_mutations.sh
```

Local disposable cluster only (the runner refuses any host outside `/tmp`).

The runner applies the existing production-shaped fixture, the real onboarding
RPC migrations, the real social-mobile deletion candidate and this candidate,
then checks: exact preflight (eight ways the schema can be wrong), additive
apply and refused re-apply, static source rules (no write to `auth` / `storage`
/ `vault`, no e-mail, nothing existing altered), behavior, twelve two-session
races, isolation guard, no deadlock, and rollback (eight refusals, then an
exact restore).

The mutation suite breaks one safety property at a time in a copy of the
candidate or the rollback and requires the runner to fail at the check that
guards it.

In the tests, a plain `delete from auth.users` stands in for whoever removes a
login (a legacy route today, the orchestrator's managed API call later). The
candidate itself contains no such statement; the static check enforces that.
