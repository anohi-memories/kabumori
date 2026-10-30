# POSTONA personal MVP: the first run of the personal workspace (W0) and the lifecycle owner on Supabase (G5-51)

Status: **source-only.** Nothing is applied. No managed or production connection, including read-only. Everything below was measured on a throw-away **local** Supabase (CLI 2.116.0 images) and on throw-away local PostgreSQL 17.11. G1 (PR #576 `8d95307c`) and G6 (PR #582 `1a567ea8`) were used through read-only `git archive` copies only. PR #457 is untouched. Production is **NO_GO**.

TASK: `common-account-g5-personal-signup-provisioning-auth-users-rls-real-runtime-source-20261030` (Issue #320, task 51, K5). It closes G6-26's G5 findings **F2** (auth tables and the lifecycle owner) and **F4** (no product path creates the personal workspace), and G5-50's gap 2.

## 1. F2: who can own the profile on Supabase

Measured on `public.ecr.aws/supabase/postgres:17.6.1.165`:

| Fact | Value |
| --- | --- |
| RLS on `auth.users`, `auth.sessions`, `auth.identities` | enabled, no policy, owner `supabase_auth_admin` |
| `postgres` | not a superuser; `BYPASSRLS`; `CREATEROLE`; ADMIN of `anon` / `authenticated` / `service_role` / `authenticator` |
| `postgres` on `auth.users` / `auth.sessions` | `SELECT` **with** grant option; `UPDATE` **without** grant option |
| `postgres` on schema `auth` | `USAGE` **without** grant option |

What the G5 lifecycle needs from its owner:
- **USAGE on `auth`.** Every gate reads the auth tables.
- **The `auth.users` row lock.** `private.account_lifecycle_lock` takes the row `FOR KEY SHARE` / `FOR UPDATE`, which needs `UPDATE` on a column. T13, every service start and end, and W0 go through it.
- **Every row visible.** This needs `BYPASSRLS` or the table owner.

**Cause of F2:** a dedicated owner made by `postgres` cannot get the schema USAGE or the row lock.
- `grant usage on schema auth` and `grant update (…) on auth.users` both answer *"no privileges were granted"*.
- A membership in `authenticated` gives USAGE but not the lock.
- The lock then fails with `permission denied for table users`, which is the error G6-26 met.

G6-26's test owner worked only because the local superuser `supabase_admin` granted it `ALL` on the auth tables. That role is not available on a managed project.

**Decision (G5): the lifecycle owner is `postgres`.** This is the role Supabase migrations already run as.
- No new grant, no new role, no new BYPASSRLS. Every G5 file already refuses a superuser, and `postgres` is not one.
- With owner `postgres`, the G5 world, `MVP_INSTALL.sql`, the R1 grant and W0 install and run on the real image **without any extra privilege**.
- The preflight passes: `PASS phase=granted`, `PF_W0 granted`, `PF_OWNER_AUTH PASS`.

Residual risk (stated, not changed here):
- Every G5 `SECURITY DEFINER` body runs with `postgres`'s rights, the same as any Supabase migration function.
- The bodies stay fixed by md5 pins, an empty `search_path`, owner-only gates and the preflight's drift checks.

New checks make a wrong owner visible before anything runs:
- Preflight `PF_OWNER_AUTH` reports FAIL when the owner has no USAGE on `auth`, or cannot lock `auth.users` rows. The USAGE check runs first and alone, because every auth name lookup needs it.
- `PF_PHASE` now reports a missing USAGE on `private` instead of crashing on it.
- `MVP_W0_INSTALL.sql` refuses with `W0_PRECONDITION_OWNER_AUTH schema|tables`.

## 2. F4: W0, the person's own first run of the personal workspace

`public.postona_ensure_my_personal_workspace()` returns `jsonb`. It takes **no argument**: the person is the request's JWT.

The app's first run:

```
sign-up / sign-in (GoTrue)  ->  rpc start_x_autopost_service()  ->  rpc postona_ensure_my_personal_workspace()  ->  read the snapshot (G1)  ->  AI assist
```

X is **not** needed. Any later sign-in may call W0 again; it is idempotent.

### What it does (one READ COMMITTED transaction)

1. **S2-2.** The JWT claims (D1 strict) and the live `auth.sessions` row. If this refuses, nothing is locked or written.
2. **T13.** `private.account_lifecycle_assert_active_service_write(person, 'x_autopost')`:
   - READ COMMITTED;
   - the I1 locks: the login `KEY SHARE`, then the common account `FOR UPDATE`, **held to commit**;
   - the account is active and POSTONA has been started and is active;
   - the session is still live after the waits.
3. **S2-3, under that lock:**
   - `own` → `ready`, created false.
   - `absent` → step 4, unless the person has **any other membership**: then `OTHER_WORKSPACE_MEMBERSHIP` (1 person / 1 workspace; shared and staff are P-1).
   - Anything else → that refusal, with nothing written and nothing repaired.
4. **The X OAuth begin RPC's two rows** (`20260919120000`):
   - `brands`: `u_<md5(user)[1..24]>`, `My Workspace`, inactive, publish `disabled`, `social_mobile_user_v1`;
   - `brand_memberships`: the person as `owner`.

   S2-3 then runs again. If the answer is not `own`, both inserts are undone (a subtransaction) and W0 returns `OWN_WORKSPACE_CONFLICT`.

W0 writes nothing else: no X account, no setting, no entitlement, no lifecycle version. R1-MVP's `g5pv:<lifecycle_version>` is unchanged.

### Answers (HTTP 200 unless stated) and what G1 does

| `status` | Meaning | G1 |
| --- | --- | --- |
| `ready` + `workspace_id` + `created` | the personal workspace (`created` true once) | read the snapshot again |
| `AUTH_REQUIRED`, `SESSION_REVOKED`, `SESSION_EXPIRED`, `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | no live, non-anonymous session | sign in again |
| `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`, `SERVICE_NOT_REGISTERED` | POSTONA not started | `start_x_autopost_service()`, then W0 |
| `SERVICE_NOT_ACTIVE` | POSTONA ended / suspended | the existing reactivate flow, or not available |
| `ACCOUNT_LOCKED`, `ACCOUNT_DELETION_IN_PROGRESS`, `SERVICE_DELETION_IN_PROGRESS` | not available | not available; no retry |
| `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE` | the server cannot check (configuration) | unavailable |
| `OWN_WORKSPACE_CONFLICT`, `WORKSPACE_OWNER_UNKNOWN`, `OTHER_WORKSPACE_MEMBERSHIP` | the data is not one personal workspace | not available (support) |
| HTTP 401 / 403 `42501` | no Bearer, or W0 not granted (stopped) | unavailable (401: sign in) |
| HTTP 404 (`PGRST202` / `42883`) | W0 not installed | the feature is off |

### Properties measured on the real stack

- **Idempotent.** A second call returns the same row with `created:false`.
- **Concurrent calls of one person.** 6 people each sent two calls at the same time. Each got one `created` and one `existing`, and exactly one brand and one membership exist.
- **Against G4's X begin RPC.**
  - W0 and the begin RPC at the same time: one workspace (4 people).
  - The begin RPC first: W0 adopts its workspace (`existing`).
  - G4's file was not changed.
- **No adoption, no repair.** Each of these returns a refusal and leaves the rows unchanged:
  - a foreign brand under the derived id;
  - another membership;
  - a derived brand owned by someone else.
- **Recovery safety.** A concurrent writer that adds a second member during W0 (a test-only trigger) ends in `OWN_WORKSPACE_CONFLICT`. Both of W0's inserts and the intruder's row are undone.
- **Nobody can be named.** `{p_user: …}` → `PGRST202`.

## 3. Release order (all as `postgres`, each with `ON_ERROR_STOP`)

`MVP_RELEASE_PREFLIGHT.sql` → `MVP_INSTALL.sql` → `MVP_W0_INSTALL.sql` → preflight → `MVP_R1_EXECUTE_GRANT.sql` → `MVP_W0_EXECUTE_GRANT.sql` → preflight (`phase=granted`, `PF_W0 granted`) → wire G1 / G6.

- **Stops** (independent, idempotent): `MVP_W0_EXECUTE_REVOKE.sql` and `MVP_R1_EXECUTE_REVOKE.sql`.
- **Withdraw:** W0 revoke → `MVP_W0_ROLLBACK.sql` → R1 revoke → `MVP_ROLLBACK.sql`. `MVP_ROLLBACK.sql` refuses while W0 exists, and `MVP_W0_ROLLBACK.sql` refuses while W0 is granted. Measured: the catalog is the same as before the release.
- **Data:** workspaces stay after a stop or a withdraw.
- `MVP_INSTALL.sql`, `MVP_R1_EXECUTE_GRANT.sql` and `MVP_R1_EXECUTE_REVOKE.sql` are **unchanged**: same blobs as #569, so G6's pins still hold.

## 4. The new authorization boundary (for the one bundled review before adoption)

- **New:** one `SECURITY DEFINER` writer reachable by `authenticated`. It inserts one brand and one membership for the caller.
- **New risks:**
  - a person creating a workspace for someone else;
  - creating while not entitled, logged out or anonymous;
  - a second workspace or a duplicate under concurrency;
  - adopting or repairing a foreign shape;
  - leaving a half-written shape;
  - reaching the gates it calls.
- **Why the existing tests were not enough:** H1 / H4 reviewed readers (S2-2, S2-3, R1-MVP) and T13 as a fence. None of them writes membership facts for a caller.
- **What the review covers:** W0's body (md5 `6ea93e3c13d28b8e7aa7520217642f1b`) and its grant / stop / rollback files. Everything else is unchanged and already reviewed.
- **Coverage so far:**
  - the real-stack suite (§5);
  - 6 / 6 body mutants detected: no T13, no S2-2, no other-membership refusal, no postcondition, `own` reported as created, the fence for another service;
  - dropping the early S2-3 refusal is equivalent by construction, because the postcondition re-runs S2-3 and undoes the inserts.

## 5. Measured

**`supabase/tests/postona_personal_workspace_local_run.sh`** (the real local Supabase: GoTrue ES256 JWTs, PostgREST v16.1, Kong 2.8.1 `verify_jwt`, Edge runtime v1.74.3, Postgres 17.6.1.165; owner `postgres`; G6's localtest twin of the real entry; G1's own snapshot read and assist client over supabase-js 2.115.0; a fake provider): **9 / 9, three runs in a row.**

1. **F2.** The image's grant options, measured. A dedicated owner gets `PF_OWNER_AUTH FAIL` (no USAGE; then, via `authenticated`, no lock), and W0 install refuses (`schema` / `tables`). Its `FOR KEY SHARE` fails with `permission denied for table users`.
2. **Release steps.**
   - preflight `absent`;
   - W0 install before the profile → `W0_PRECONDITION_GATE`, and the catalog is unchanged;
   - install → `installed`;
   - W0 before its grant → HTTP 403 `42501`, and the preflight counts one `PF_DATA_NO_WORKSPACE`;
   - W0 grant (idempotent) → `granted`.
3. **First run.**
   - A real ES256 token.
   - G1 before W0: `blocked`, nothing sent.
   - W0 before the start → `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`, nothing written.
   - Start → W0 `created` → `existing`, with the row shape exactly the begin RPC's and no X row.
   - G1's snapshot shows the derived id. AI draft through G6 → `candidates` (one provider call).
   - R1 `allow` with `g5pv:`.
   - The preflight's warning goes to 0.
4. **Refusals, nothing written:**
   - anonymous sign-in → `AUTH_REQUIRED`;
   - no Bearer → 401;
   - signed out (JWT still within `exp`) → `SESSION_REVOKED`;
   - `not_after` past → `SESSION_EXPIRED`, then a new sign-in → `created`;
   - another person's workspace: G1 sends nothing; skipping G1's gate → `not_available`.
5. **Concurrency** (§2).
6. **Lifecycle.**
   - Service ended → `SERVICE_NOT_ACTIVE` and G1 `not_available`.
   - Reactivated by the person → `existing`, with a **new** `g5pv` generation (A-B-A: the earlier check is not this generation) → `candidates`.
   - Account `locked` → `ACCOUNT_LOCKED`.
7. **Shapes** (§2).
8. **W0 mutants 6 / 6.** The reviewed body is restored by its pin.
9. **Stop / drift / withdraw.**
   - W0 revoke → 403; the rows stay; R1 still answers for the existing workspace.
   - W0 granted to `service_role` → `FAIL PF_W0`, and the grant refuses (`ACL`); the stop clears it.
   - Re-grant works.
   - `MVP_W0_ROLLBACK` refuses while granted; `MVP_ROLLBACK` refuses while W0 exists.
   - The full withdraw restores the catalog, and the workspace data stays.

**Regression** (throw-away local PG17.11):
- G5-50 `postona_personal_mvp_release_pg_run.sh` 8 / 8 ×3. Its expected preflight lines now include `PF_OWNER_AUTH` and `PF_W0`.
- `postona_personal_mvp_auth_pg_run.sh` 15 / 15.
- G5-50's 13 preflight mutants: 13 / 13.
- The builder `--check`: 6 PASS. `MVP_INSTALL` / `MVP_ROLLBACK` re-derive byte for byte; the preflight pins M20 and W0; the W0 grant pins W0.

**One run before these** (while the suite was being written) saw G1's first assist call answer `unavailable` instead of `candidates`. The Edge log of that run was not kept. Four later full runs did not repeat it. The cause is **not identified**: possibly G6-26's F5 first-request behaviour of the local gateway (NOT_VERIFIED).

## 6. Handoffs (G5 changed none of these)

- **G1 (#316):**
  - Call `start_x_autopost_service()` and then `postona_ensure_my_personal_workspace()` after sign-up and sign-in, before reading the snapshot. Map the answers by the table in §2.
  - Re-copy G6's reference client for the gateway 401 (G6-26 F1).
  - Gap 1 (a second membership) stays G1's; W0 itself refuses to create one.
- **G6 (#321):**
  - Pin the fixed stop (#569, G5-50 gap 4).
  - Treat `PGRST202` as not available (gap 3, measured again after the withdraw).
  - Your runner's owner: the preflight now fails a dedicated owner without the auth lock; `postgres` needs no extra grant.
- **G4 (#561):** the begin RPC (`20260919120000`) and W0 create the same rows and adopt each other's (measured both ways). Keep the begin RPC's row shape; any change to it must change W0 too.

## 7. Not verified

- **Managed Supabase:** whether `postgres` there has the same attributes and grant options (BYPASSRLS, `UPDATE` / `USAGE` without grant option), PostgREST claims and GoTrue. The preflight is the read-only check for these, and it needs explicit approval to run there.
- **G6:** hosted Edge, secrets and the real OpenAI.
- **G1:** native app and device.
- **Also not covered:** Threads, account deletion in progress (`ACCOUNT_DELETION_IN_PROGRESS` was not driven), multiple owners, production.
- **Open decisions:**
  - P-1 to P-5 (P-1: shared workspaces; P-4: sign-out vs pending jobs);
  - RESIDUAL A→B→A for service_role / owner;
  - the owner choice above, which needs the owner's approval for managed use.
