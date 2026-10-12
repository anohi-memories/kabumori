# Common account — Phase 4: core integration (G5, source candidate)

Status: **source candidate, nothing applied, nothing deployed, no managed Supabase touched.** This is the
implementation round after the Phase 3b–3i investigations. It reuses Phase 1/2/3a (on main), the Phase 3b writer
guard (PR #121, stacked below this change) and adds what was still missing. Nothing here claims the common
account is production ready: the managed Auth delete stays behind the Phase 3a release gate (`blocked`) and
`IDP_PREPAUSE_BLOCKED` stays.

## 1. What exists, what this change adds, what is not done

| Layer | State | Where |
| --- | --- | --- |
| One common login + per-service entitlement, idempotent start, no implicit restart, isolation | **already implemented** (Phase 1/2); executable path recorded and re-proved end to end here | `start_kabumori_service()`, `start_x_autopost_service()`, `reactivate_*_service(bigint)` |
| Writer guard for a person's own reviewed writer (JWT + live session + state) | Phase 3b (PR #121, below this change) | `private.account_lifecycle_assert_active_service_write(uuid,text)` |
| **One state decision + generic row fence + closed Kabumori profile root + legacy `ensure_my_profile()`** | **new** | `supabase/migrations/20261012130000_common_account_core_service_fence.sql` |
| Whole-account deletion orchestrator against the real SQL state machine | implemented (Phase 3a); **now proven against the real SQL**, with the provider step | `supabase/functions/account-delete/` + `supabase/tests/common_account_phase4_e2e_test.ts` |
| **Provider cleanup port (T10), no adapter registered** | **new** | `supabase/functions/account-delete/provider_cleanup.ts` |
| Managed Auth delete, Storage consistency, Auth identity-link fence, managed permissions | **not done / not provable offline** | section 6 |

## 2. Entrypoints, statuses and idempotency (all exist; none new except `ensure_my_profile` semantics)

The person is `auth.uid()` in every call below; no argument names a user. "Idempotency" is state convergence
plus a compare-and-set on `lifecycle_version`; there is no client idempotency key because a replay converges.

| Operation | Entrypoint (caller) | Success | Refusals (fixed) | Replay |
| --- | --- | --- | --- | --- |
| Start Kabumori (creates the common account if missing) | `rpc start_kabumori_service()` (authenticated) | `{status:'active', service, started, shared_account}` | `{status:'blocked', reason: ACCOUNT_DELETION_IN_PROGRESS \| ACCOUNT_LOCKED \| SERVICE_DELETION_IN_PROGRESS \| SERVICE_SUSPENDED \| SERVICE_NOT_READY}`, `{status:'reenroll_required', lifecycle_version}`; SQLSTATE 42501 `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` / `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` | `started:false`, no new row, no version change |
| Start POSTONA (same login, only this entitlement is added) | `rpc start_x_autopost_service()` (authenticated) | same shape, `service:'x_autopost'`, `shared_account:true` when Kabumori is active | same | same |
| Explicit restart of an ended service | `rpc reactivate_kabumori_service(bigint)` / `reactivate_x_autopost_service(bigint)` | `{status:'active', started:true}` | `{status:'lifecycle_changed'}`, `{status:'not_registered'}`, blocked as above | CAS on the version the person confirmed; used once |
| Legacy Kabumori bootstrap (old builds) | `rpc ensure_my_profile()` (authenticated) | the person's uuid; enrolls account + entitlement + profile exactly like the start | 42501 `SERVICE_REENROLL_REQUIRED` (ended), `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_NOT_ACTIVE`, `AUTHENTICATION_REQUIRED` | idempotent |
| Preview / end Kabumori / delete the whole account | Edge `account-delete`, actions `preview`, `withdraw_kabumori`, `delete_common_account` (platform JWT ON) | see `phase3a-deletion-orchestrator.md` section 3 | + `PROVIDER_CLEANUP_BLOCKED`, `PROVIDER_REMOTE_UNVERIFIED` (new, 409, with `providers:[{provider,result}]`) | the open operation resumes; a version other than the one shown is refused |
| End POSTONA only | X-owned saga `social-mobile-account-delete` (not edited) | its own | its own | its own |

Entitlement escalation is closed structurally: the start functions take no user and no service argument (the
service is the function), the allowlist is `kabumori`/`x_autopost`, and `service_entitlements` has no INSERT/UPDATE
grant for any API role (proved: `common_account_core_fence_behavior.sql` V4).

## 3. The write boundary (B1 fence, B2 guard) and how an owner wires it

Both take the **I1 lock order** every lifecycle RPC takes (login `KEY SHARE` -> common account `FOR UPDATE` ->
service entitlement `FOR UPDATE`) and keep the locks to the end of the caller's transaction, so a freeze and a
write are totally ordered: a write that got the locks first commits before the freeze can see it; a freeze that
got them first makes the write wait, then refuses it. Same fixed codes in both (proved equal state by state).

| | B2 writer guard (Phase 3b) | B1 row fence (Phase 4) |
| --- | --- | --- |
| Call | first statement of an owner's reviewed `SECURITY DEFINER` writer: `perform private.account_lifecycle_assert_active_service_write((select auth.uid()), 'x_autopost')` | `create trigger ... before insert on <table> for each row execute function private.account_lifecycle_service_insert_fence('<user_column>', '<service_key>')` |
| Who it checks | the person's own session: `authenticated` JWT, subject = user, live `auth.sessions` row, then the state | the row's person: any creator (RPC, direct insert, service-role job); a person's JWT naming another id is refused **before any lock** |
| Covers | all statements of that writer | INSERT only (an UPDATE trigger fires after the row is locked and inverts the I1 order against a deletion cascade) |
| Wait | unbounded (Postgres default) | bounded: 3 s, then retryable `ACCOUNT_LIFECYCLE_BUSY` (SQLSTATE 55P03), nothing written |
| Missing/unknown | refuses; creates nothing | refuses; creates nothing |

Applied by G5 in this change: the fence on `public.profiles` (service `kabumori`). Whoever creates a profile
(`start_*`, `reactivate_*`, `ensure_my_profile()`, a direct insert, a service-role job) is subject to it.
`ensure_my_profile()` keeps its name, grant and `uuid` return for old builds, but is now a definer wrapper of the
Phase 2 start (**it enrolls**, and never silently restarts an ended service or re-creates a profile while a
deletion is open). An old build whose person ended Kabumori now gets `SERVICE_REENROLL_REQUIRED` instead of a
silent profile; that is intended.

Limits (stated, not hidden): it does not fence Supabase Auth (an identity link, a sign-in, a token refresh
happen in GoTrue); a token issued before the freeze is accepted by PostgREST/Storage until it expires, so only
writes that reach one of the two boundaries above are refused; Storage object writes are fenced only by the
cleanup read-back (the Storage policy state is unknown, outside the repository's migrations).

## 4. Provider cleanup port (T10)

`ProviderCleanupAdapter { provider, hasConnection(userId), cleanup(userId) }` in `provider_cleanup.ts`; outcomes
`confirmed_remote_revoked | local_removed_remote_unverified | reconciliation_required | blocked`. The orchestrator runs
every registered adapter after the X saga and **before** the POSTONA entitlement is ended (also when POSTONA was
never started or already ended, because a credential may remain). Decision: unreadable/throw/timeout/unknown ->
`RECONCILIATION_REQUIRED`; invalid, duplicate or reserved key (`x`, `x_autopost`, `kabumori`, `apple`, ...) ->
`PROVIDER_CLEANUP_BLOCKED`; `local_removed_remote_unverified` -> `PROVIDER_REMOTE_UNVERIFIED` unless
`deps.acceptRemoteUnverified === true` (a product decision, default off; then success carries
`remote_unverified:[provider]`). A stale owner never calls an adapter. **No adapter is registered by this change.**
Adapter obligations (G4): idempotent; report `hasConnection=true` while a remote grant is unverified if the product
requires a halt; never replay an unsettled provider call; return fixed codes only.

## 5. Owner wiring checklist (nothing below is done by this change; no owner file was touched)

- **G1/G2 (Kabumori):** ship the build that calls `start_kabumori_service()` (already in `src/lib/auth.ts`); old builds
  keep working through `ensure_my_profile()`. To fence Kabumori user tables against the freeze, attach the row fence
  (`'user_id'`, `'kabumori'`) to tables that create rows for a person; this is optional (FK to `profiles` already
  removes rows on withdrawal).
- **G3/G4 (POSTONA):** call the B2 guard first in every Threads/X connection writer (T13; their candidates already
  do); attach the row fence (`'<owner column>'`, `'x_autopost'`) to tables a stale token could still insert into;
  register a Threads `ProviderCleanupAdapter` and decide `acceptRemoteUnverified`; include the four G4 tables in
  `account_lifecycle_footprint`; treat an attempt left `publishing` as "may have posted" (no automatic repost).
- **G6 (common AI):** no entitlement is created for AI; usage rides the service that calls it. If AI storage keyed by a
  person is added, attach the row fence with that service's key.

Apply order (separate, individually approved steps; not executed): Phase 1 -> Phase 2 -> Phase 3a -> Phase 3b guard
(`20261010051938`) -> this file (`20261012130000`). Emergency rollback: `supabase/tests/common_account_core_fence_rollback.sql`
(restores the legacy `ensure_my_profile()`; any trigger that already calls the fence then fails closed).

## 6. Not proven, not done (named; none relabelled as PASS)

1. Managed Supabase behaviour: the guard's `auth.sessions` read, the owner role's privileges, PostgREST error
   mapping of `55P03`, the real Storage policy. **Local PostgreSQL 17 only.**
2. The Auth identity-link race (GoTrue inserts an identity after the managed-delete intent; nothing in SQL can
   fence it): `managed_auth_delete` stays `blocked`; the release gate is opened only by test-only DDL in the proof.
3. Provider remote revoke (Threads/Instagram): no API verified; no adapter exists.
4. Storage: no atomic DB + Storage snapshot is claimed; cleanup is list -> remove -> re-list with a read-back.
5. The X saga, Apple, Auth logout and Auth Admin delete are stand-ins in the end-to-end proof.
6. No app wiring (G1/G2/G3/G4), no EAS, no deploy, no merge; PR #121 is not changed.

## 7. Running the proofs (disposable local PostgreSQL only)

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> bash supabase/tests/common_account_core_fence_run.sh
CAL_PGHOST=... CAL_PGPORT=... CAL_PGSUPER=... python3 supabase/tests/common_account_core_fence_mutations.py
deno test --no-config --no-check --allow-read --allow-env supabase/functions/account-delete/
python3 supabase/tests/common_account_phase4_ts_mutations.py "$PWD"
```
