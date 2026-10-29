# POSTONA personal MVP auth: release preflight and the G1 → G6 → G5 chain (G5-50)

Status: **source-only.** Nothing is applied. No managed or production connection, including read-only. G1 (PR #576 `8d95307c`) and G6 (PR #566 `79300d05`) were used through read-only `git archive` copies only. PR #457 is untouched. Production is **NO_GO**.

TASK: `common-account-g5-postona-personal-mvp-auth-release-integration-g1-g6-source-batch-20261030` (Issue #320, task 50, K5).

## 1. The release bundle (G5-owned, `supabase/candidates/postona_personal_mvp_auth/`)

| Step | File | Effect | If it fails |
| --- | --- | --- | --- |
| 0 | `MVP_RELEASE_PREFLIGHT.sql` (**new**) | read-only; every finding at once; `PASS phase=absent` | fix the environment (§2), nothing was changed |
| 1 | `MVP_INSTALL.sql` | one transaction; every gate owner-only | refuses, nothing changed |
| 2 | `MVP_RELEASE_PREFLIGHT.sql` | `PASS phase=installed` | stop here |
| 3 | `MVP_R1_EXECUTE_GRANT.sql` | R1-MVP to `authenticated` only | refuses, nothing changed |
| 4 | `MVP_RELEASE_PREFLIGHT.sql` | `PASS phase=granted`; then wire G6 | `MVP_R1_EXECUTE_REVOKE.sql` |
| stop | `MVP_R1_EXECUTE_REVOKE.sql` | owner-only again (idempotent, G5-49) | — |
| back | `MVP_R1_EXECUTE_REVOKE.sql` → `MVP_ROLLBACK.sql` | the catalog as before step 1 (measured) | rollback refuses while a consumer uses a gate |

- Run every file as the lifecycle owner (never a superuser) with `psql -v ON_ERROR_STOP=1 -f <file>`.
- The preflight is also the **health check** of a running release. A widened gate (`FAIL PF_GATES`) or a widened R1-MVP ACL (`FAIL PF_PHASE … drifted`) means: run the stop now, then find the cause.
- G6 must pin the personal profile **before** step 3 (PR #556 / #566 already do).

## 2. What the preflight checks

`PASS` / `FAIL` / `WARN` per line, then `VERDICT PASS phase=… warnings=n` or `G5_MVP_PREFLIGHT_FAILED <codes>`.

| Code | FAIL when | Why it blocks the release |
| --- | --- | --- |
| `PF_OWNER` | the current role is a superuser | every G5 file refuses a superuser |
| `PF_P1` / `PF_TRIGGERS` | a P1 lifecycle function is missing; `session_replication_role` ≠ origin | GC false → every verdict `unknown` |
| `PF_P3` | an API role can write `brand_memberships` | S2-3 trusts membership facts |
| `PF_AUTH` | `auth.uid()` / `auth.users` / `auth.sessions` missing or of another shape; RLS hides auth rows from the owner; **`auth.uid()` does not read `request.jwt.claims`** | PostgREST v10+ sets only the JSON claims: every person would get `AUTH_REQUIRED` |
| `PF_ROLE_GRAPH` | anon / service_role is a member of authenticated; **an API role is a member of the lifecycle owner** | the grant would reach them; they could alter every gate |
| `PF_AUTHENTICATOR` | **authenticator cannot `SET ROLE authenticated`**, or **inherits it** | G6's calls never reach R1-MVP; the grant would reach the login role itself |
| `PF_DEFAULT_ACL` | **the owner's default privileges give functions to a role other than PUBLIC / anon / authenticated / service_role** | the install revokes those four by name, but any other default grant makes it refuse late (`S22_POSTCONDITION_SHAPE`, measured) |
| `PF_PHASE` | partial profile; not R1-MVP (full profile / other); body / owner / config drift; R1 ACL ≠ owner-only or owner + authenticated | |
| `PF_GATES` | an installed gate is not owner-only | |
| `PF_DATA` | the owner cannot read every brand / membership row | S2-3 would refuse to install |

`WARN` lines are counts only; no row is printed:
- `PF_SCHEMA_CREATE`: an API role may CREATE in `public` / `private`.
- `PF_DATA_PERSONAL_ID`: a personal brand whose id ≠ its owner's derived id.
- `PF_DATA_MULTI_MEMBERSHIP`: a person with more than one membership (see §3).
- `PF_DATA_SHARED_PERSONAL`: a personal workspace without exactly one membership.
- `PF_DATA_NO_WORKSPACE`: an active `x_autopost` person without a personal workspace.

Supabase's usual default privileges for `anon` / `authenticated` / `service_role` (the test world has them too) are **not** a finding. `PF_ROLES` fails when one of the four Supabase roles is missing.

## 3. The contract with G1 and G6 (read-only, measured on the same databases)

| Item | G1 #576 | G6 #566 / #556 | G5 | Match |
| --- | --- | --- | --- | --- |
| workspace id | `snapshot.workspace.id` = the first `brands` row among the person's `brand_memberships` (RLS self-read, **no ORDER BY**) | sends it as `brand_id` → `p_brand_id` | only `'u_' ‖ substr(md5(user), 1, 24)` with S2-3 `own` | **yes** for 1 person / 1 workspace (it is the only membership); **no** with a second membership (below) |
| id type | `String(brand.id)` | text | text | yes |
| token | `session.access_token` as Bearer | forwarded to G5 with the publishable key only | claims D1 strict | yes |
| RPC | — | `POST /rest/v1/rpc/common_account_authorization_verdict`, exactly `p_app, p_brand_id, p_feature`; verdict + recheck before the send | the one EXECUTE to authenticated | yes (measured: every call) |
| generation | — | `g5pv:<lifecycle_version>` pinned to the personal profile; moves → stop | `g5pv:<lifecycle_version>` | yes |
| refused (403 `NOT_ENTITLED` → `not_available`) | anonymous, B without POSTONA, another workspace (G1 does not even send it), ended session, ended / suspended service, before the grant, after the stop | | deny / unknown / permission denied | yes |
| the person re-authorizes | new session → candidates | | | yes |

**Gaps, each with an owner (not resolved by a fictitious allow):**

1. **G1: a person with a second membership** (a shared or legacy brand).
   - G1 shows whichever brand PostgREST returns first. Measured in both orders:
     - shared brand first → `not_available`, even though G5 allows the person;
     - personal id first → `candidates`.
   - G1's gate also blocks the derived id while it shows another brand.
   - Fix (G1, `apps/social-mobile/src/data/supabase-repository.ts`): pick the personal workspace explicitly — role `owner`, `code_profile_key = 'social_mobile_user_v1'`, id = the derived id — or order the read.
   - Fail-closed today. Multi-workspace is out of MVP scope (P-1).
2. **G4 / G1 product: no workspace before the first X connection.**
   - The personal brand is created by the X OAuth begin RPC (`20260919120000`).
   - Until then: G1 `no_workspace`, G5 refuses (preflight `PF_DATA_NO_WORKSPACE` counts them).
   - A product decision: create the workspace at sign-up, or show AI assist only after connecting X.
3. **G6: R1-MVP absent** (after `MVP_ROLLBACK.sql`, or before the install, when PostgREST answers 404 `PGRST202`).
   - The Edge answers 503 with `retry_same_key: true`, so G1 shows 「混み合っています」 and invites the same-key retry. Measured.
   - Nothing reaches the provider (safe), but the message is wrong.
   - Fix (G6): treat PGRST202 as not available, not as a retry.
4. **G6: re-pin to the fixed stop.** G6-25's runner pins G5 PR #563 (`9846c0f0`), whose stop has H1's P2 F1 / F2. The fixed stop is #569 `5c882f01` (this bundle's base).

## 4. Measured (disposable local PG17.11, socket only, fake data, without #457)

`supabase/tests/postona_personal_mvp_release_pg_run.sh`: **8 / 8, three runs in a row.**

1. **Preflight on the release world:** `PASS phase=absent warnings=0`, 9 PASS lines, catalog unchanged.
2. **Preflight refusals.** Each of the following refused with its code and changed nothing:
   - a superuser
   - authenticator without `SET`
   - authenticator `INHERIT`
   - anon in authenticated
   - authenticator in the owner
   - a default grant of functions to authenticator
   - `auth.uid()` reading only the legacy claim
   - an API write on memberships

   Five drifts at once gave `FAIL PF_AUTH PF_AUTHENTICATOR PF_DEFAULT_ACL PF_ROLE_GRAPH` in one run. With them in place `MVP_INSTALL.sql` itself refuses with `S22_POSTCONDITION_SHAPE`.
3. **Install:** `phase=installed`. G1 reads the derived id as its workspace; the draft is `not_available` (R1-MVP owner-only). After the grant: `phase=granted`.
4. **The chain**, through G1's real snapshot read, assist gate and client, G6's real Edge entry, G5, the real ledger SQL and a fake OpenAI:
   - The draft gives `candidates` (one provider call).
   - The same key again gives the stored candidates (no second call).
   - Refused: anonymous, B, another workspace (G1 sends nothing; skipping G1 → G5 refuses).
   - Every G5 call was `apikey=publishable` with exactly the 3 arguments.
5. **Session and service changes:**
   - session ended → `not_available`; new session → `candidates`;
   - service ended → `not_available`; restarted → `candidates` (a new generation);
   - suspended between G6's check and its recheck → `not_available`, nothing sent.
6. **Gap 1 measured in both orders** (§3).
7. **Stop:**
   - `phase=installed`; a stored key and a new key → `not_available`;
   - re-grant → the stored candidates;
   - a widened gate → `FAIL PF_GATES`; R1 granted to service_role → `FAIL PF_PHASE`; the stop → `phase=installed`.
8. **Rollback:** stop ×2 → rollback → `phase=absent`. The app does not get candidates (gap 3). The catalog is as before the release.

Other results:
- Preflight mutants: **13 / 13 detected**, each by the case that names it.
- `postona_personal_mvp_auth_pg_run.sh`: 15 / 15 (regression).
- Builder `--check`: 5 PASS (the preflight pins the same M20 body as the grant).

## 5. Not verified, and what each needs

- **Managed Supabase:**
  - the real role graph (authenticator membership options), default privileges, `auth.uid()`;
  - PostgREST claim setting and JWT verification;
  - GoTrue.

  The preflight is the read-only check for these. Running it there is a read-only managed connection and needs the owner's explicit approval.
- **G6:** the real Edge runtime / deploy / secrets, the real ledger on managed, the real OpenAI.
- **G1:** native app on Simulator / device with a real JWT.
- **Not covered:** Threads, Instagram, multiple owners, production.
- **Open decisions:** RESIDUAL A→B→A (service_role / owner); P-1 – P-5 (P-4 = sign-out vs pending jobs).
- **Review:** no new authorization boundary was added. The preflight reads only, and the bundle's grant / stop are unchanged from G5-48 / G5-49.
