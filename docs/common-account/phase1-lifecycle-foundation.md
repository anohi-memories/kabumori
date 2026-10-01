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
with saga checkpoints, a readiness authorization bound to what it was decided
against, a shadow backfill, and least-privilege access.

**Phase 1 never deletes a login.** No statement in the candidate writes to
`auth`, `storage` or `vault`. Whole-account deletion stops at the durable state
`ready_for_managed_auth_delete`. The actual destruction — the Auth Admin API
delete, Storage cleanup through the Storage API, session revocation, Apple and
X grant revocation, and the read-back afterwards — belongs to a later **common
account deletion orchestrator** (section 10).

Consequences that must not be read into this candidate:

- "ready" is not "deleted", and there is no "completed" state for an account
  deletion in this schema at all.
- A recorded checkpoint is the orchestrator's attestation. The database did not
  verify it.
- **There is no enforcing guard in Phase 1.** The guard trigger only observes.
  Nothing in this candidate authorizes, or prevents, a login delete by an
  existing route. The existing Kabumori `account-delete` route is unchanged and
  is **not** made safe.
- Local PostgreSQL proves the SQL contract only. It is not proof of GoTrue,
  PostgREST, Storage or role behaviour on real Supabase.

Supabase documentation consulted on 2026-10-02 (statements of the documentation,
not behaviour verified here):

- Auth: users are deleted with `auth.admin.deleteUser()`; an access token already
  issued stays valid until it expires, while refresh tokens stop working; a user
  who owns Storage objects cannot be deleted through that API; objects managed
  by Supabase in the `auth` schema may change at any time.
- Storage: ownership is the `owner_id` column, derived from the token's `sub`
  (`owner` is deprecated); ownership alone is no access control; every
  operation, deletion included, must go through the Storage API, because
  deleting metadata rows leaves the object in the storage provider.
- Changelog: no custom tables or functions in the `auth` / `storage` schemas
  (2025-03-18); new tables in `public` are no longer exposed to the Data API by
  default (2026-04-28, existing projects by 2026-10-30). The candidate grants
  explicitly and relies on no default exposure; whether the two client-readable
  tables are reachable must be confirmed at apply time.

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
| `private.account_lifecycle_operations` | durable deletion intent, step, saga checkpoints, readiness binding | none |
| `private.account_lifecycle_managed_checkpoints` | which managed-service cleanups a deletion must attest | none |
| `private.account_lifecycle_settings` | one row: guard mode (`shadow` only), integration state, `requirement_epoch` | none |
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
     └── any invalidator (section 6), or prepare finding ──┘
         the state no longer clean
  terminal: aborted | login_removed.  Never "completed".

service_entitlements.status
  (none) ──start──▶ active ──begin_service_deletion──▶ deleting ──finish──▶ ended ──start──▶ active
                       ▲                                   │
                       └──────abort_service_deletion───────┘
  provisioning / suspended: reserved. No RPC produces them; every gate treats
  them as "service still present".
```

`login_removed` is written by the guard trigger when the login row disappears
while an operation is open. It is an observation, not a verified deletion.

## 4. Invariants

- **I1 — one serialization point.** Every lifecycle RPC first locks the person's
  `auth.users` row (`FOR KEY SHARE`; the readiness check takes `FOR UPDATE`) and
  then the `common_accounts` row `FOR UPDATE`, before it reads any state. The
  backfill takes the same locks, login by login.
- **I2 — no start during deletion.** A service starts only while the account is
  `active`.
- **I3 — service-only deletion is local.** Ending one entitlement never touches
  the login, the other entitlement or the other service's rows.
- **I4 — readiness.** An account deletion becomes `ready_for_managed_auth_delete`
  only when, under the locks: every entitlement is `ended`; no service row,
  admin membership or foreign workspace remains; every required managed
  checkpoint is recorded; and no managed ownership is visible to the database.
- **I5 — unknown fails closed.** Admin accounts, shared or internal workspaces,
  service data that no entitlement accounts for, reserved entitlement states,
  an unreadable Storage shape or probe, a registry that does not match the
  built-in contract, and missing settings all block.
- **I6 — READ COMMITTED only.**
- **I7 — the version follows the state.** `lifecycle_version` is moved by
  trigger on every account-state change and every entitlement insert, update or
  delete, whatever wrote it. It can never decrease. `0` means "no account row"
  and never matches a row. An entitlement can never be moved to another person
  or another service: a transfer would change two accounts and move one version.
- **I8 — readiness is a durable, bound authorization.** `prepare` records what
  it was decided against: the person's `lifecycle_version`, the
  `requirement_epoch`, and the exact set of required checkpoints. It is valid
  only while all three still match **and** a fresh evaluation still passes.
  Changes this candidate can see also drop the operation back to `cleanup` at
  once (section 6).
- **I9 — built-in checkpoints are a fixed contract.** `session_revocation` and
  `storage_cleanup` always; `apple_revocation` for a person with an Apple
  identity. Ordinary maintenance cannot change or remove them, and a registry
  that does not match them exactly makes nothing ready.

### Confirmation binding

The backend passes the version the person saw on the confirmation screen.
Preview of an absent account reports `0`; `begin(0)` is accepted only if there
is still no row, and the row it then creates must be exactly the fresh one.

### Lock order

`auth.users` row → `common_accounts` row → settings row (share, in `prepare`) →
entitlement / operation rows → service rows. This is the direction a login
delete cascades in, so a lifecycle call and a hard delete of the same person
queue behind each other (race 8). A requirement change takes the settings row
and then operation rows, in the same order (races 11 and 12).

## 5. Durable authorization

"Ready" is the authorization the orchestrator needs before it removes a login.

1. **How it is obtained.** Only `prepare_common_account_auth_delete`, under the
   exclusive `auth.users` row lock, the `common_accounts` lock and a share lock
   on the settings row, after: account `deleting`; every entitlement `ended`; no
   admin / foreign / shared / internal blocker; no unregistered service data;
   settings present; registry valid; every required checkpoint recorded; managed
   ownership probe clean.
2. **Where it lives.** On the operation row: `ready_at`,
   `ready_lifecycle_version`, `ready_requirement_epoch`,
   `ready_required_checkpoints`. That table has no foreign key to the login, so
   nothing a login delete cascades through can erase it.
3. **When it is valid.** `private.account_lifecycle_authorization_problems`
   returns no problem: the three bound values still match, and a fresh
   evaluation of everything in (1) still passes. The read model
   (`common_account_deletion_eligibility`) reports `authorization.state` as
   `none`, `valid` or `stale` with the reasons.
4. **Who validates it.** In Phase 1: `prepare` (obtain / refresh) and the read
   model. The orchestrator must call `prepare` immediately before the managed
   delete. **The guard trigger does not validate it and authorizes nothing**
   (section 9).

The three bound values are durable state, so a future enforcing guard can
compare them inside the deleting transaction without looking at any row a
cascade may already have removed. That is only correct once every producer in
section 6 moves `lifecycle_version` or `requirement_epoch`. Until then the
fresh evaluation — which must run **before** the delete starts — is what
catches the rest.

## 6. Readiness invalidation inventory

Every state transition that must invalidate a readiness, who can write it, and
whether Phase 1 sees it.

| # | Transition | Who can write it | Seen by Phase 1 | What invalidates the readiness |
| --- | --- | --- | --- | --- |
| 1 | Entitlement inserted, updated or deleted | lifecycle RPCs, backfill, operator SQL (no client or `service_role` table grant) | **Yes** — trigger on `service_entitlements` | `lifecycle_version` moves; operation back to `cleanup` (`LIFECYCLE_VERSION_CHANGED`) |
| 2 | Entitlement moved to another person or service | operator SQL | **Yes** — refused (`ACCOUNT_LIFECYCLE_ENTITLEMENT_OWNER_IMMUTABLE`) | cannot happen; end it here and start it there, which is (1) on both accounts |
| 3 | Account status or version changed | lifecycle RPCs, operator SQL | **Yes** — triggers on `common_accounts` | `lifecycle_version` moves; operation back to `cleanup` |
| 4 | Service start / provisioning | client start RPCs | **Yes** — refused while `deleting`; otherwise it is (1) | — |
| 5 | Backfill | operator (private function) | **Yes** — takes the lifecycle locks; grants nothing unless `active`; otherwise it is (1) | — |
| 6 | Checkpoint requirement added, changed or removed | operator SQL on the registry | **Yes** — statement trigger moves `requirement_epoch`; built-in rows are immutable | every ready operation back to `cleanup` (`REQUIREMENT_EPOCH_CHANGED`); binding no longer matches |
| 7 | Settings changed (integration state), row removed or re-created | operator, later migration | **Yes** — settings triggers | `requirement_epoch` moves (or restarts); every ready operation back to `cleanup` |
| 8 | A checkpoint withdrawn | orchestrator (`clear_common_account_deletion_checkpoint`) | **Yes** | operation back to `cleanup` (`MANAGED_CHECKPOINT_CLEARED`) |
| 9 | Admin membership added or removed (`admin_users`) | `service_role`, operator | **No** — existing table, not wired | evaluation only: `ADMIN_ACCOUNT` |
| 10 | X workspace membership added, changed or removed (`brand_memberships`: own, foreign, shared) | X onboarding RPC, `service_role`, operator | **No** — existing table, not wired | evaluation only: `X_WORKSPACE_NOT_SELF_SERVICE` / `UNREGISTERED_SERVICE_FOOTPRINT` |
| 11 | Workspace rows relevant to blockers (`brands.code_profile_key`, `social_accounts`, OAuth states, X deletion tombstone) | X connect RPCs, X deletion saga, operator | **No** | evaluation only |
| 12 | Kabumori profile created (`ensure_my_profile`) | any signed-in client | **No** — existing creator, not gated | evaluation only: `UNREGISTERED_SERVICE_FOOTPRINT` |
| 13 | Apple identity added or removed (`auth.identities`) | GoTrue (sign-in, `linkIdentity`) | **No** — managed schema | evaluation only: `REQUIRED_CHECKPOINTS_CHANGED`, `MANAGED_CHECKPOINTS_MISSING` |
| 14 | Storage object or bucket owned again | any client with a still-valid token, through the Storage API | **No** — managed schema, no foreign key | evaluation only: `MANAGED_OWNERSHIP_REMAINS` |
| 15 | Login row removed | existing deletion routes; later the orchestrator | observed by the guard trigger | operation closed as `login_removed` |

"Evaluation only" means: the stored step stays `ready` until someone evaluates;
`prepare` and the read model then report it and `prepare` withdraws it.

**Why there is no enforcing guard.** Rows 9–14 do not move `lifecycle_version`
or `requirement_epoch` in Phase 1, so the bound values cannot be trusted alone,
and the guard trigger runs after other cascades of the same delete may already
have removed the admin, membership and identity rows it would need to
re-evaluate. An enforcing mode is added only by the phase that wires rows 9–14
(triggers or lifecycle calls in the writers for 9–12; orchestrator and Auth-side
wiring plus a stale-token policy for 13–14) and sets `integration_state`.

Each "Yes" row and each "No" row has a regression in the behavior suite
(section 9 of `common_account_lifecycle_behavior.sql`); rows 6, 9 and the
absent-preview case also have two-session races.

## 7. RPC contract

Client RPCs (role `authenticated`; the person is always `auth.uid()`; no argument):

| RPC | Result |
| --- | --- |
| `start_kabumori_service()` | `{status:'active', service, started}`; creates the account row if missing, the entitlement, and the `profiles` row, atomically. `blocked` with `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_SUSPENDED` or `SERVICE_NOT_READY`. |
| `start_x_autopost_service()` | Same, entitlement only. The workspace is still created by the existing connect RPC. |

Backend RPCs (role `service_role`; `p_user_id` is the id the caller verified from
the person's own token — an Edge Function obligation, not something SQL can check):

| RPC | Result |
| --- | --- |
| `common_account_deletion_eligibility(user)` | Read model: `account_status`, `lifecycle_version`, `requirement_epoch`, `services`, `blockers`, `required_checkpoints`, `managed_ownership`, `operation`, `authorization` (`none` / `valid` / `stale` + problems). Takes no lock; advice only. |
| `begin_service_deletion(user, service)` | `started` / `in_progress` (+`operation_id`), `not_registered`, `already_ended`, `blocked`. |
| `finish_service_deletion(user, service, operation)` | `ended`, `not_ready / SERVICE_FOOTPRINT_REMAINS`, `aborted`, `not_found`, `blocked`. |
| `abort_service_deletion(user, service, operation)` | `aborted`; the entitlement returns to `active`. |
| `withdraw_kabumori_service(user)` | Begin + delete the `profiles` row (cascade) + finish, in one transaction. |
| `begin_common_account_deletion(user, expected_lifecycle_version)` | `started` (+`operation_id`, `services_to_end`, `required_checkpoints`), `in_progress`, `lifecycle_changed`, `blocked` (+`reasons`). |
| `record_common_account_deletion_checkpoint(user, operation, checkpoint)` | `recorded`. Raises for a checkpoint that is not in the registry. |
| `clear_common_account_deletion_checkpoint(user, operation, checkpoint)` | `cleared`; withdraws the readiness. |
| `abort_common_account_deletion(user, operation)` | `aborted`; the account returns to `active`. |
| `prepare_common_account_auth_delete(user, operation)` | `ready_for_managed_auth_delete` (+`login_deleted:false`, `authorization`, `next_steps`); `not_ready` (`SERVICES_REMAIN`, `LIFECYCLE_SETTINGS_INVALID`, `MANAGED_CHECKPOINT_REGISTRY_INVALID`, `MANAGED_CHECKPOINTS_MISSING`, `MANAGED_OWNERSHIP_REMAINS`, `ACCOUNT_DELETION_NOT_IN_PROGRESS`); `blocked` (+`reasons`); `not_found`. Each answer carries non-secret `next_steps`. |

Blocker codes: `ADMIN_ACCOUNT`, `ACCOUNT_LOCKED`, `X_WORKSPACE_NOT_SELF_SERVICE`,
`UNREGISTERED_SERVICE_FOOTPRINT`, `SERVICE_NOT_DELETABLE`.

## 8. Managed ownership and checkpoints

Storage records an object's owner as plain text. It is **not** a foreign key to
the login, so removing a login row neither blocks on nor cleans up that person's
objects, and Storage objects may only be removed through the Storage API.

- Phase 1 does not delete from Storage and does not implement Storage cleanup.
- **Built-in checkpoints (fixed contract, I9):** `session_revocation` — always;
  `storage_cleanup` — always; `apple_revocation` — for a person with an Apple
  identity. The contract is a function in the candidate; the registry rows must
  match it exactly. A trigger refuses to change, remove, rename or truncate a
  built-in row. If the registry nevertheless does not match (corruption, a
  bypassed trigger), nothing becomes ready
  (`MANAGED_CHECKPOINT_REGISTRY_INVALID`) and rollback refuses.
- **Extension rows:** a newly discovered kind of managed ownership is added as
  an extra row. That moves `requirement_epoch`, withdraws every existing
  readiness, and keeps every deletion not ready until an orchestrator attests it.
- `prepare` also runs a read-only probe of `storage.objects` and
  `storage.buckets`. Visible ownership answers `MANAGED_OWNERSHIP_REMAINS` even
  though the checkpoint was recorded. The probe is a reason to refuse, **never
  proof of absence**. An unexpected shape answers
  `MANAGED_STORAGE_SHAPE_UNKNOWN`; any failure to read answers
  `MANAGED_STORAGE_PROBE_FAILED`.

## 9. Auth-delete guard (Phase 1: observation only)

A `BEFORE DELETE` trigger on `common_accounts` runs when the cascade from
`auth.users` reaches it.

- `shadow` (the only mode): every delete is allowed. Existing routes behave as
  before — **unchanged, not safe**. Open lifecycle operations of the removed
  person are closed as `login_removed` (`ACCOUNT_REMOVED_EXTERNALLY`, or
  `LOGIN_REMOVED_WHILE_READY_UNVERIFIED` for a ready one) and their raw user id
  is cleared. The regression suite shows a login with a stale readiness and a
  late admin membership being deleted in this mode: Phase 1 records it, it does
  not prevent it.
- Settings missing or not `shadow`: every login delete is refused
  (`COMMON_ACCOUNT_DELETE_NOT_AUTHORIZED`, SQLSTATE 23503; the existing X saga
  maps that to its own `operator_required / LOGIN_DELETE_BLOCKED`).
- The guard looks at no admin, membership or identity row, so the order in
  which the delete's cascades run cannot change its answer (regression with
  both orders).
- The settings table accepts no value other than `shadow`. An enforcing mode
  does not exist in this candidate; the static check enforces that.
- The guard protects nobody. A table owner or superuser can disable triggers.

## 10. Prerequisites for the deletion orchestrator and for enforcement (not implemented here)

1. **Recent re-authentication**, enforced server-side, before `begin`.
2. **Session revocation and a stale-token policy.** A token issued before the
   deletion stays valid until it expires. Revoke sessions, then record
   `session_revocation`.
3. **Each service's own cleanup**: Kabumori through `withdraw_kabumori_service`;
   X through its existing saga (X posting authorization revoke → fingerprint
   check → Vault purge), wrapped by `begin_service_deletion` /
   `finish_service_deletion`.
4. **Apple grant revocation** for a person with an Apple identity, then record
   `apple_revocation`.
5. **Storage cleanup through the Storage API**, re-listing until empty, then
   record `storage_cleanup`. Retried until it converges; idempotent.
6. `prepare_common_account_auth_delete` → `ready_for_managed_auth_delete`.
7. **Revalidation immediately before the delete**: `prepare` again and re-list
   Storage. Anything found returns the flow to step 3 or 5.
8. **Managed Auth delete through the Auth Admin API** — never SQL against
   `auth.users`.
9. **Post-delete read-back and audit.** Only this step may call an account
   deletion complete, and it needs its own schema change to record that.

Before an enforcing guard may exist: every producer in rows 9–14 of section 6
wired, every existing creator and deletion route moved to the lifecycle, every
login enrolled in `common_accounts`, and a proof on a disposable **real**
Supabase project of the Auth / Storage / session behaviour and of the role
boundaries.

## 11. RLS and grants

- RLS is enabled on all five new tables. The two `public` tables have one
  policy each: `SELECT` for `authenticated` where `auth.uid() = user_id`.
- All table privileges are revoked from `PUBLIC`, `anon`, `authenticated` and
  `service_role`. `authenticated` gets column-limited `SELECT` only.
  `service_role` gets no table privilege: the backend uses the RPCs.
- All 33 functions are `SECURITY DEFINER` with `search_path = ''` and
  schema-qualified names. `EXECUTE` is revoked from `PUBLIC` and every role,
  then granted to exactly one role per RPC. Helpers in `private` are executable
  by nobody but their owner. Create and revoke happen in one transaction.
- Existing Kabumori / X policies are not changed.

## 12. Shadow backfill candidate

`select private.account_lifecycle_backfill(false)` counts from one unlocked
snapshot. `(true)` goes login by login in id order: it takes the lifecycle locks,
re-reads that login's plan row after the lock, and only then inserts what is
still missing. Not executed by the migration. Idempotent; never modifies an
existing entitlement; a login whose account is not `active` at that moment gains
nothing; every inserted entitlement moves `lifecycle_version`.

| Rule | Evidence recorded |
| --- | --- |
| one `common_accounts` row per `auth.users` row | — |
| `kabumori`: a `profiles` row exists | `kabumori_activity` or `kabumori_profile_only` |
| `x_autopost`: sole owner of the person's own `social_mobile_user_v1` workspace, **and not an admin** | `x_identity_verified` or `x_workspace_pending` |
| admin (even when the same login owns a self-service workspace), internal or shared workspaces | no X entitlement. Kabumori follows its own rule. |
| login only | account row only |

E-mail is never read. Against the production-shaped fixture the dry-run reports
4 accounts, 2 Kabumori (1 with activity, 1 profile only), 1 X, 1 login only.
That is a fixture result, not a production dry-run.

## 13. Preflight and postflight

The migration is one transaction and refuses unless the schema matches exactly:
required schema, roles and 17 tables; 26 columns with their exact types; 14
foreign keys bound to their exact referencing and referenced columns, with equal
column types, the expected delete action, validated and not deferrable; no table
hanging off `profiles` without `ON DELETE CASCADE`; the two reused helper
functions with their signatures; not already applied. Before it commits it
checks its own result: registry equal to the built-in contract, one settings
row at `shadow` / `not_started` / epoch 1, no account and no operation.

## 14. Deletion adapter and registration contracts (later phases)

- **Kabumori "delete account"** becomes: verify the caller and a recent
  re-authentication → `withdraw_kabumori_service`; the whole-account flow only
  if the person asked for it and has no other entitlement.
- **X deletion** keeps its saga, wrapped by `begin_service_deletion` /
  `finish_service_deletion`. Its `profiles`-based scope rule and its own login
  delete are removed. Until then X must be ended **before** Kabumori (the runner
  exercises this order with the real X saga).
- **Registration**: create or confirm the common account + start that app's
  entitlement by an explicit step. Before sign-in an entered e-mail never
  reveals whether an account exists. Two Auth users are never merged because
  their e-mail matches. An X login identity is not an X posting authorization.

## 15. Rollout plan (not executed)

1. Review this candidate. Before any production apply: a separate
   pre-production review and a read-only check that the production catalog
   passes the exact preflight.
2. Apply the single file (not `db push`). Read back: tables, policies, grants,
   function ACLs, settings.
3. Backfill dry-run; compare with the Phase 0 aggregates. Then apply the
   backfill and read back counts.
4. Integration phase: wire the creators and rows 9–14 of section 6; set
   `integration_state = 'started'`.
5. Deletion routes move to the lifecycle; the orchestrator of section 10 exists.
6. Only then add and switch on an enforcing guard, by a new reviewed migration.
7. Later: entitlement conditions in existing RLS and backend producers.

## 16. Rollback

`supabase/tests/common_account_lifecycle_rollback.sql` drops exactly what the
candidate created, in one transaction, and only from an **affirmed** shadow
state:

- exactly one settings row, guard `shadow`, integration `not_started`
  (a missing row is refused);
- the registry is exactly the built-in contract — each built-in row with its own
  meaning (spelled out in the rollback file itself), and no extension row;
- no lifecycle operation at all, open or finished (one means deletion intent or
  readiness was already used);
- no account that is not `active`;
- no self-registered entitlement;
- no dependent object: every `DROP` is without `CASCADE`.

Dependencies that PostgreSQL does not track (dynamic SQL, client code) are not
detected.

## 17. Integration points (exact list, nothing edited here)

Kabumori: `src/lib/auth.ts`, `src/providers/auth-provider.tsx`,
`src/app/_layout.tsx`, `public.ensure_my_profile()`, `src/app/settings.tsx`,
`src/lib/account-deletion.ts`, `src/lib/account-deletion-client.ts`,
`supabase/functions/account-delete/*`, `apps/kabumori-web/pages/account-deletion.html`.

X autopost: `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`,
`apps/social-mobile/src/data/onboarding-repository.ts`,
`public.begin_social_mobile_x_oauth_connection` (lifecycle assertion as its
first statement), `supabase/functions/social-mobile-account-delete/*`,
`social_mobile_account_deletion_scope` / `_finalize`.

Admin and membership writers (section 6, rows 9–11): `admin_users`,
`brand_memberships`, `brands`, `social_accounts`, `social_account_oauth_states`.

Backend producers that bypass RLS (entitlement condition, last phase):
`claim_pending_push_notifications`, `enqueue_important_news_notifications`,
`enqueue_personalized_report_notification`, `personalized_report_news_inputs`,
`important_news_app_copy_targets`, `supabase/functions/personalized-reports/index.ts`,
`supabase/functions/x-test-post/index.ts`.

## 18. Known limits of Phase 1

- Shadow only: existing creators are not gated and existing deletion routes are
  not prevented from anything.
- Rows 9–14 of section 6 are caught only by evaluation.
- No re-authentication rule, no session revocation, no provider revocation, no
  Storage cleanup, no login deletion.
- The apply of the backfill holds the locks of every login it has visited until
  it commits.
- Not exercised on real Supabase.

## 19. Running the proof

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
/ `vault`, no enforcing guard mode, no e-mail, nothing existing altered),
behavior (eleven sections), fourteen two-session races, isolation guard, no
deadlock, and rollback (ten refusals, then an exact restore).

The mutation suite breaks one safety property at a time in a copy of the
candidate or the rollback and requires the runner to fail at the named check
that guards it.

In the tests, a plain `delete from auth.users` stands in for whoever removes a
login. The candidate itself contains no such statement; the static check
enforces that.
