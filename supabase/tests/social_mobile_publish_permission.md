# Publish-permission boundary (per-account automatic publishing ON/OFF)

Status: **source-only**. Nothing applied or deployed. Production mutation: 0. Production read: 0.
Corrective for PR #76 after the H1 review (`x-social-mobile-pr76-publish-toggle-review-20261002`, findings R1–R5 on head `a59a89e9`) and the final H2 rereview (`x-social-mobile-pr76-transactional-publish-toggle-rereview-20261005`, findings F1–F3 on head `7f75c07a`).

## 1. What changed, in one picture

```
app (owner/admin) ── social-mobile-publish-setting (Edge) ─────────────────────────────┐
   request shape, bearer token check (Auth), ONE call, caller's own JWT, no service key  │
                                                                                         ▼
        public.set_social_account_publish_enabled(account, desired, expected)   ← one transaction
          auth.uid()  →  LOCK social_accounts (ROW EXCLUSIVE)
                      →  brand row FOR SHARE  →  caller's membership row FOR SHARE
                      →  account row FOR UPDATE
                      →  owner/admin?  expected state?  (ON only: brand live + readiness)
                      →  UPDATE social_accounts SET publish_enabled   (the only write)

x-test-post (Vault-backed account path) ── VaultAccountXAuth.send()
          immediately before EVERY X write (first request and the single 401 retry):
        public.assert_x_publish_permission_for_legacy_post(post, account, brand)
          x_legacy_post_account(...)   (existing exact-account contract)
          + ONE statement / one snapshot: post running, brand active+live, account ON,
            verified (status, platform user id, verified_at), credential refs, no account
            deletion, refresh state not blocked, no recorded connection error
```

Files:

| file | role |
| --- | --- |
| `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql` | the two functions and their exact privileges; creates nothing else |
| `supabase/functions/social-mobile-publish-setting/{logic,http,index}.ts` | thin, unprivileged front for the switch |
| `supabase/functions/x-test-post/vault_account_auth.ts` | pre-send permission check on the Vault send path |
| `apps/social-mobile/src/{domain/publish-setting.ts,features/publish-setting/*}` | confirmation pinned to what was on screen |

## 2. Review findings → disposition

| finding | reviewed head | now |
| --- | --- | --- |
| **R1** membership is a stale snapshot | HTTP read of the role, later a service-role PATCH | The caller's membership row is locked `FOR SHARE` in the same transaction as the write. A removal or demotion either committed before (and is what the function reads) or waits for the commit. The Edge function has no service key and no write of its own. |
| **R2** brand active/live TOCTOU | separate brand GET; cached brand context at send time | (a) The brand row is locked `FOR SHARE` from the check to the commit, so ON cannot be written for a brand that is no longer active+live. (b) Every X write of a Vault-backed account is preceded by a fresh single-snapshot permission check; a brand/account context cached earlier cannot authorize a send. |
| **R3** zero-row reread leaks foreign state | service-role reread of the account by id | No reread exists. Every answer comes from the one transaction, after the account's current brand and the caller's current membership were proven under lock. A moved, deleted or foreign account is `not_found` (same shape as a missing id), with no state. |
| **R4** read-side and write-side readiness differ | truthy check vs `not.is.null` filter | One predicate, evaluated on the locked rows that are then written: `nullif(btrim(platform_user_id),'')`, `identity_verified`, `verified_at`, both references present, distinct and unshared (same rule as `x_legacy_post_account`), no connection error, refresh state not `uncertain`/`reauth_required`. |
| **R5** confirmation not pinned | request built from current props at submit | The action is pinned (account, expected state, signed-in user) when the person asks; it is dropped as soon as the screen no longer matches, and re-checked against the latest committed render at submit, so even a callback kept from an older render sends nothing. |
| **F1** pre-send readiness weaker than ON | the final check omitted `verified_at` and the recorded connection error | The final pre-send `SELECT` itself now refuses a missing `verified_at` (`X_ACCOUNT_NOT_VERIFIED`) and a non-blank `last_connection_error_code` (`X_ACCOUNT_CONNECTION_DEGRADED`); the helper is not relied on for either. Every ON refusal case of the behavior proof now names its runtime refusal and none is skipped: parity is tested case by case, for all 18 cases, plus the blank error code accepted by both. |
| **F2** unexpected EXECUTE survives | only known roles were revoked; no effective check | The file refuses unless it is created by the owner of `x_legacy_post_account` and that owner is not a superuser; it removes every other grantee the creator's default privileges put on the two functions; before `COMMIT` it proves the exact direct ACL and the effective privileges (inherited ones included). See section 3. |
| **F3** migration-first rollout not fail-closed | migration before the guarded runtime | The approved order is now runtime first, drained, then the migration, read-back, then the Edge function and the app control. Every forward and abort state is machine-checked. See section 6. |

Lower-risk items (H1): duplicate raw JSON keys and escapes are rejected (not last-wins); the body is capped in **bytes while it is read** (512), not by a character count after buffering; OFF copy no longer says "anytime" and states that an in-flight send cannot be recalled; the five `require-await` lint findings are gone (tests rewritten).

## 3. Authorization, privileges, lock order, isolation

- Caller identity: `auth.uid()` from the caller's own JWT (role `authenticated`). The function has no user-id or brand-id argument.
- `SECURITY DEFINER` because `authenticated` has no `UPDATE` on `social_accounts` and must not get one. `search_path = ''`, every relation schema-qualified.
- **Creator / owner.** Both functions run as their creator. The file refuses (`PUBLISH_PERMISSION_PRECONDITION_OWNER`) unless the creating role is the owner of `public.x_legacy_post_account(uuid,text,text,boolean)` (the check calls it, and its `EXECUTE` is owner-only) and is not a superuser. `anon`, `authenticated` and `service_role` must exist (`PUBLISH_PERMISSION_PRECONDITION_ROLES`).
- **Exact privileges.** Known roles and `PUBLIC` are revoked; then every other grantee the creator's default privileges put on **these two functions** (any role, with or without grant option) is revoked from them. No `ALTER DEFAULT PRIVILEGES`, no role-membership change, no table grant. Then: the switch to `authenticated`, the check to `service_role`.
- **Postcondition** (raises `PUBLISH_PERMISSION_EFFECTIVE_ACL` and so aborts the whole file):
  - both functions owned by the helper's owner, `SECURITY DEFINER`, `search_path=""`;
  - direct ACL besides the owner: exactly one plain (not grantable) `EXECUTE` for `authenticated` on the switch and for `service_role` on the check; nothing for `PUBLIC`;
  - effective privileges, inherited ones included: `anon` neither, `authenticated` only the switch, `service_role` only the check;
  - every other role: may execute a function only by inheriting the owner, by inheriting that function's intended grantee (it then acts as that role), or as a superuser.
  Role graphs the file cannot repair without changing memberships (for example `authenticated` inheriting `service_role`, `anon` inheriting `authenticated`, an app role inheriting the owner) are refused, never "fixed".
- Lock order (same direction as the account-deletion functions: brand → memberships → accounts):
  1. `LOCK TABLE public.social_accounts IN ROW EXCLUSIVE MODE` — before any row lock. The refresh commit functions take `SHARE ROW EXCLUSIVE` on this table and then the account row; a bare `UPDATE` after a row lock would be the opposite order and could deadlock with a commit that has already rotated a single-use token.
  2. brand row `FOR SHARE`
  3. the caller's membership row `FOR SHARE`
  4. account row `FOR UPDATE`
- A caller who is not a member of the account's brand is answered `not_found` by an unlocked pre-check and never waits on, or takes, a lock on another tenant's rows. Nothing is decided by that pre-check; everything is re-read under the locks.
- A member without the right (member/viewer) takes no write lock.
- Waiting is bounded: `lock_timeout = 3s` on the function. A timeout, a deadlock and the account-deletion guard are answered `busy`; nothing is written.
- `READ COMMITTED` is required (the Data API default); any other isolation level is refused.

## 4. ON / OFF semantics

**ON** = "permission enabled and structurally eligible", not "the next X request will succeed". No Vault material is read. Requires, atomically: current owner/admin membership of the account's current brand; `publish_enabled` = expected; platform `x`; brand `is_active` and `publish_mode = 'live'`; `connection_status = 'identity_verified'`; non-blank `platform_user_id`; `verified_at`; both credential references present, distinct, not shared with another account; no (non-blank) `last_connection_error_code`; refresh state not `uncertain`/`reauth_required` (`refreshing` → `busy`); no account deletion in progress.

**OFF** = fail-safe. Requires only: current owner/admin membership, exact account, expected state. Works with a failed connection, a missing `verified_at`, a recorded connection error, missing references, an inactive/disabled brand and a blocked refresh state. Changes nothing but `publish_enabled`: no revoke, no Vault, no posts, no logs, no history, no Auth. During an account deletion both directions answer `busy` (the deletion already requires that nothing is being posted, and its guard refuses every writer).

`updated_at` is deliberately not touched (it is the account-configuration stamp that refresh leases snapshot).

Known consequence, unchanged from the refresh core: `commit_x_account_refresh_*` treats `publish_enabled = false` as an account change. An OFF that lands in the ~1 s between a refresh `begin` and its `commit` leaves that account `uncertain` (blocked until re-connected). OFF is not made to wait for a refresh, because a stale lease would then block OFF.

## 5. Runtime pre-send check and in-flight semantics

- Path covered: every X write of a **Vault-backed exact-account** send (`VaultAccountXAuth.send`), which is the only account-scoped send path wired today (AI Lab `brand_post`), and the path any future Vault-backed account uses. The check is the statement directly before each `request()` call (source-pinned by a test).
- What it requires, in one snapshot: post running for this brand; brand active and `live`; account `publish_enabled`; `identity_verified`, non-blank `platform_user_id`, `verified_at`; both credential references present and distinct; no account deletion; refresh state not `uncertain`/`reauth_required`; no (non-blank) `last_connection_error_code`. Unshared references and the post/account binding come from `x_legacy_post_account`, called first. Every structural condition ON requires is required here too, on the state at send time.
- A send is **in flight** from the moment its permission check returns `authorized`. OFF or a brand disable **committed before** the check's snapshot stops the send; one committed after it does not recall a request already on its way to X. No later request of the same dispatch (the 401 retry, a second post) starts without a new check.
- Fail closed: a refusal keeps its fixed code; an unreachable check, a missing function (migration not applied: PostgREST answers 404 `PGRST202`) or any unexpected answer is `X_PUBLISH_PERMISSION_UNAVAILABLE` and nothing is sent.
- Refresh behavior kept as it was: `refreshing` is not a permission refusal; a proactive refresh refused before any token request (rollout off, pilot limits, another refresh in progress) keeps the current token; after a 401 the reactive refresh commits first (a committed refresh clears the recorded error) and the retry is then checked afresh.
- **Consequence of F1, stated:** once a connection error is recorded on an account (`X_ACCESS_TOKEN_UNAUTHORIZED` from a 401 that could not be refreshed, or a refresh the token endpoint refused, including `X_REFRESH_RATE_LIMITED`), its automatic posts stop **until the account is reconnected** (a completed reconnection clears the code). No refresh is attempted for it meanwhile, because the check refuses before the send that would trigger one. This is the same state ON already refuses ("reconnect recommended").

Not covered (stated, not claimed):

- **Kabumori legacy path** (env tokens / `oauth_token_store`, `postToX` without a Vault account) and `important-news-monitor`: not account-scoped; unchanged. The switch can turn the Kabumori-shaped account (no Vault references) OFF but cannot turn it back ON; on that path OFF is seen at the next dispatch's context load, not mid-dispatch, and `important-news-monitor` does not consult `publish_enabled` at all.
- **v2 dispatcher** (`v2_dispatcher.ts`, Phase1B–1I): unwired and its migrations are not applied; unchanged.
- PR #41 (generic Vault-backed `brand_post` path, open, not merged) has its own publish predicate; unchanged.

## 6. Rollout order (when separately authorized; not part of this task)

The switch is callable **directly** through the Data API with any signed-in user's JWT as soon as the migration is applied; hiding the app or not deploying the Edge function does not change that. So the migration may only be applied once no sender that skips the permission check can still be running. Order:

| step | what | state afterwards |
| --- | --- | --- |
| **S0** preflight | Read-only queries a–g below. Stop on any surprise. Pick a window in which no Vault-backed brand post is due (S1–S3 fail those closed). | production today |
| **S1** guarded runtime | Deploy `x-test-post` from the reviewed merge commit. From now until S3 every Vault-backed (AI Lab) send fails closed with `X_PUBLISH_PERMISSION_UNAVAILABLE`; nothing is sent. Kabumori posts are unaffected. | guarded runtime live, older invocations may still be finishing; no switch |
| **S2** read back and drain | Byte-verify the deployed source against the commit and note the version. Wait at least 15 minutes after the deploy completed (longer than any single invocation may run; confirm the current platform limit at run time) and run query h: it must return 0. No manual dispatch, no Cron change, no backlog or candidate injection. | only the guarded runtime can run |
| **S3** migration | Apply `20261003090000` alone (single transaction, not wrapped, not re-runnable). If it refuses, nothing was created: stop here (state S2, safe). | switch and check exist |
| **S4** read back | Queries i and j below must match exactly. | unchanged |
| **S5** Edge function | Deploy `social-mobile-publish-setting` with JWT verification ON (`SUPABASE_URL`, `SUPABASE_ANON_KEY` only). Read back. | Edge function live |
| **S6** app control | Ship / show the app control. | fully rolled out |

Abort points (each statement reviewed, one transaction, reversible by the matching `grant`):

- after S1 or S2 (no switch yet): redeploy the previous `x-test-post`; the guarded invocations finish. Safe throughout: the switch does not exist.
- after S3 or S4: first make the switch unusable — `revoke execute on function public.set_social_account_publish_enabled(text, boolean, boolean) from authenticated;` — and only then, if needed, redeploy the previous `x-test-post`. (Optionally also `revoke execute on function public.assert_x_publish_permission_for_legacy_post(uuid, text, text) from service_role;`, which makes the guarded runtime fail closed.) The old runtime is never live next to a usable switch.
- after S5 or S6: remove (or stop serving) `social-mobile-publish-setting` — the app control then fails closed with an error — then as after S3.

```rollout-plan
{
  "initial": { "runtime": ["old"], "toggle": "absent", "check": "absent", "edge": "absent", "app": "hidden" },
  "steps": [
    { "id": "S0", "action": "read-only preflight a-h", "set": {} },
    { "id": "S1", "action": "deploy the guarded x-test-post", "set": { "runtime": ["old", "guarded"] } },
    { "id": "S2", "action": "byte-verify the deploy; wait out older invocations; query h = 0", "set": { "runtime": ["guarded"] } },
    { "id": "S3", "action": "apply 20261003090000 alone", "set": { "toggle": "usable", "check": "present" } },
    { "id": "S4", "action": "read back definitions, direct ACL, effective privileges (i, j)", "set": {} },
    { "id": "S5", "action": "deploy social-mobile-publish-setting with JWT verification on", "set": { "edge": "deployed" } },
    { "id": "S6", "action": "ship / show the app control", "set": { "app": "shown" } }
  ],
  "aborts": [
    { "from": ["S1", "S2"], "steps": [
      { "id": "A1", "action": "redeploy the previous x-test-post", "set": { "runtime": ["old", "guarded"] } },
      { "id": "A2", "action": "wait out the guarded invocations", "set": { "runtime": ["old"] } }
    ] },
    { "from": ["S3", "S4"], "steps": [
      { "id": "B1", "action": "revoke the switch from authenticated", "set": { "toggle": "revoked" } },
      { "id": "B2", "action": "revoke the check from service_role (guarded runtime fails closed)", "set": { "check": "revoked" } },
      { "id": "B3", "action": "redeploy the previous x-test-post", "set": { "runtime": ["guarded", "old"] } },
      { "id": "B4", "action": "wait out the guarded invocations", "set": { "runtime": ["old"] } }
    ] },
    { "from": ["S5", "S6"], "steps": [
      { "id": "C1", "action": "remove social-mobile-publish-setting (the app control fails closed)", "set": { "edge": "absent" } },
      { "id": "C2", "action": "revoke the switch from authenticated", "set": { "toggle": "revoked" } },
      { "id": "C3", "action": "revoke the check from service_role (guarded runtime fails closed)", "set": { "check": "revoked" } },
      { "id": "C4", "action": "redeploy the previous x-test-post", "set": { "runtime": ["guarded", "old"] } },
      { "id": "C5", "action": "wait out the guarded invocations", "set": { "runtime": ["old"] } }
    ] }
  ]
}
```

Read-only queries (aggregate/catalog only, no row data). a–g at S0, h at S2, i–j at S4:

```sql
-- a. what the migration builds on, and that it is not applied yet
select to_regclass('public.brand_memberships') is not null as memberships,
       to_regclass('public.social_mobile_account_deletions') is not null as deletions,
       to_regclass('public.x_account_refresh_state_v2') is not null as refresh_state,
       to_regprocedure('public.x_legacy_post_account(uuid,text,text,boolean)') is not null as exact_account_helper,
       to_regprocedure('public.set_social_account_publish_enabled(text,boolean,boolean)') is null as switch_absent,
       to_regprocedure('public.assert_x_publish_permission_for_legacy_post(uuid,text,text)') is null as check_absent;
-- b. every trigger on social_accounts (expected: the deletion guard, and the refresh reset on
--    UPDATE OF verified_at; a generic updated_at trigger would change the lease stamp on every toggle)
select t.tgname, pg_get_triggerdef(t.oid) from pg_trigger t
where t.tgrelid = 'public.social_accounts'::regclass and not t.tgisinternal order by 1;
-- c. authenticated must have no direct write on social_accounts
select privilege_type from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'social_accounts' and grantee = 'authenticated' order by 1;
-- d. how many accounts could be affected, by shape (no ids)
select (vault_access_token_secret_id is not null and vault_refresh_token_secret_id is not null) as vault_backed,
       publish_enabled, connection_status, count(*)
from public.social_accounts group by 1, 2, 3 order by 1, 2, 3;
-- e. Vault-backed accounts that are ON but will stop posting once the check is live (F1), by reason (no ids)
select (verified_at is null) as verified_at_missing,
       (nullif(btrim(last_connection_error_code), '') is not null) as connection_error_recorded, count(*)
from public.social_accounts
where publish_enabled and vault_access_token_secret_id is not null and vault_refresh_token_secret_id is not null
group by 1, 2 order by 1, 2;
-- f. the owner the functions will run as; the APPLYING session must be this role and it must not be a superuser
select r.rolname, r.rolsuper, current_user as applying_role
from pg_proc p join pg_roles r on r.oid = p.proowner
where p.oid = 'public.x_legacy_post_account(uuid,text,text,boolean)'::regprocedure;
-- g. role graph the postcondition refuses (every value must be false); default function ACLs of that owner (informational:
--    whatever they grant is removed from the two new functions)
with o as (select p.proowner from pg_proc p where p.oid = 'public.x_legacy_post_account(uuid,text,text,boolean)'::regprocedure)
select pg_has_role('authenticated', 'service_role', 'usage') as auth_inherits_service,
       pg_has_role('service_role', 'authenticated', 'usage') as service_inherits_auth,
       pg_has_role('anon', 'authenticated', 'usage') or pg_has_role('anon', 'service_role', 'usage') as anon_inherits_app_role,
       pg_has_role('anon', (select proowner from o), 'usage') or pg_has_role('authenticated', (select proowner from o), 'usage')
         or pg_has_role('service_role', (select proowner from o), 'usage') as app_role_inherits_owner;
select d.defaclnamespace::regnamespace, d.defaclacl from pg_default_acl d
where d.defaclrole = (select p.proowner from pg_proc p where p.oid = 'public.x_legacy_post_account(uuid,text,text,boolean)'::regprocedure)
  and d.defaclobjtype = 'f';
-- h. (S2) no post that an older runtime may still be sending: must be 0
select count(*) from public.scheduled_posts where status = 'running' and started_at < '<S1 deploy completed at>'::timestamptz;
-- i. (S4) definitions and direct ACL: owner = f.rolname, prosecdef, search_path="", lock_timeout=3s on the switch,
--    ACL exactly {owner, authenticated=X} and {owner, service_role=X}
select p.oid::regprocedure, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.proacl
from pg_proc p
where p.oid in ('public.set_social_account_publish_enabled(text,boolean,boolean)'::regprocedure,
                'public.assert_x_publish_permission_for_legacy_post(uuid,text,text)'::regprocedure);
-- j. (S4) effective privileges: anon f/f, authenticated t/f, service_role f/t
select r, has_function_privilege(r, 'public.set_social_account_publish_enabled(text,boolean,boolean)', 'execute') as switch,
          has_function_privilege(r, 'public.assert_x_publish_permission_for_legacy_post(uuid,text,text)', 'execute') as "check"
from unnest(array['anon', 'authenticated', 'service_role']) r;
```

## 7. Proofs

All local, fake data, fake X. No production, no real X.

| proof | command | result |
| --- | --- | --- |
| SQL behavior + concurrency on a disposable PostgreSQL 17, stacked on the real onboarding / refresh core / rollout / deletion migrations | `PUB_PGHOST=… PUB_PGPORT=… PUB_PGSUPER=… supabase/tests/social_mobile_publish_permission_run.sh` | `APPLY / BEHAVIOR / RACE / CLEANUP PASS` |
| same, plus end to end: before the candidate the guarded runtime against a database without the migration (2 scenarios), after it the real Edge handler, real brand-context loader + cached guard, real Vault send adapter and real refresh SQL over HTTP (9 scenarios); only X is fake | `PUB_E2E=1 … social_mobile_publish_permission_run.sh` | `ROLLOUT_E2E_PASS`, `E2E_PASS` |
| adverse role graphs for the privileges (12 role situations, each on a fresh database, plus the re-apply check); **must run alone on its cluster** | `… social_mobile_publish_permission_acl.sh` | `ACL_PASS` |
| approved rollout order as a state machine (forward and every abort path) | `deno test supabase/tests/social_mobile_publish_permission_rollout_test.ts` | 5 tests |
| defect detection: single-property mutations of the candidate (34, parallel, through the runner), of the privilege section (6, serial, through the ACL runner) and of the rollout plan (5), each must fail at the named check | `… social_mobile_publish_permission_mutations.sh` | `45/45 DETECTED` |
| Edge function | `deno test supabase/functions/social-mobile-publish-setting` | logic, http, migration contract |
| send adapter | `deno test supabase/functions/x-test-post/vault_account_auth_test.ts` | fails when the checks are removed |
| client | `npm test` in `apps/social-mobile` | 145 (32 in `publish-setting.test.mjs`) |

Concurrency cases in the runner: membership removed / demoted before the write (ON and OFF); permission-changing writers blocked while the switch holds its decision (membership delete, demotion, brand disable, publish_mode change, account move); brand disabled before ON; the H1 R2 schedule with the pre-send check; account moved to a foreign brand and to another brand of the same caller; account deleted; duplicate ON and ON-vs-OFF; OFF vs an in-flight permission check; account deletion before and after the switch; lock order against a refresh-commit-shaped transaction; bounded waiting; a non-member never waits on another tenant's locks.

The runners require an English-speaking server (`lc_messages=C`).
