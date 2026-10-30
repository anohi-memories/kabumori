# public.brands tenant isolation (G5 source candidate, G5-02 task 3)

**Not applied anywhere. Production NO_GO.** Before any managed use, three things are needed:
- one Codex Sol (high) review of this candidate;
- the owner's approval;
- a read-only `MVP_RELEASE_PREFLIGHT.sql` run on that project (its state is [U]: never connected).

## Why

G5-02 task 2 measured this on the real local Supabase, with real JWTs through PostgREST:
- No migration enables row security on `public.brands`.
- The member read policy of `20260918120000` therefore does nothing.
- The image's default privileges let `anon` / `authenticated` write the table.

What that allowed:
- a person read every brand;
- a person set another person's workspace active / live;
- a person deleted another person's workspace (its membership went with it);
- a person and `anon` inserted brands.

G5 is the single owner of this fix (#299 comment 6520426514).

## Files

| file | what |
| --- | --- |
| `001_brands_tenant_isolation.sql` | One transaction as the owner of `brands` (not a superuser). It first checks the world (refusals below). It then records the API roles' privileges and the row security flag in `private.postona_brands_isolation_prestate` (owner-only; a re-run keeps the first record). It revokes all from PUBLIC / `anon` and every write of `authenticated` (INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER / MAINTAIN, table and column level), and enables row security (not forced). Finally it checks the result through every role `anon` / `authenticated` can reach. |
| `001_brands_tenant_isolation_rollback.sql` | Restores exactly the record (grants with their grant options, column grants, row security), checks it, and drops the record. **On the world as built this reopens the cross-tenant paths** (`PF_BRANDS FAIL` again). |

It creates no policy, function, role or grant, and changes no row. `authenticated` keeps `SELECT`: a person reads only the brands of their own memberships.

## Order (each as the owner of `brands`, with `ON_ERROR_STOP`)

1. `MVP_RELEASE_PREFLIGHT.sql` (read-only) shows `PF_BRANDS FAIL`.
2. Run `001_brands_tenant_isolation.sql`.
3. Run the preflight again: `PF_BRANDS PASS` and `PF_APP_READ PASS`.
4. Then the personal MVP order (`docs/common-account/g5-51-personal-workspace-provisioning.md` §3).

On the locks:
- The install takes ACCESS EXCLUSIVE on `brands`, then ACCESS SHARE on `brand_memberships`. This is the same order as every writer, so there is no lock cycle with W0, the X OAuth begin or the deletion.
- Its `lock_timeout` is 5 s. Measured: a transaction holding `brands` makes it stop with nothing changed.

## Consumers (fresh main `92884b33`, read-only)

| consumer | access | after the install |
| --- | --- | --- |
| app snapshot `apps/social-mobile/src/data/supabase-repository.ts:36` (G1 #592 adds `code_profile_key`) | person's JWT, `SELECT` of their memberships' brands | unchanged (member policy) |
| Edge `social-mobile-brand-dry-run/logic.ts:311`, `social-mobile-consult/logic.ts:257`, `social-mobile-history-learning/live_dependencies.ts:89` | person's JWT, `SELECT` of an owned brand | unchanged |
| Edge `_shared/brand/brand_context.ts:98` | `service_role` REST `SELECT` | unchanged (BYPASSRLS; grants untouched) |
| `begin_social_mobile_x_oauth_connection` (`20260919120000`, `20260922003101`) | SECURITY DEFINER, `authenticated` EXECUTE, inserts brands | unchanged (owner not filtered; checked at install) |
| POSTONA deletion functions (`20260928160000`: update `:389`, delete `:579`) | SECURITY DEFINER, `service_role` EXECUTE | unchanged (checked at install; not driven end to end) |
| G5 W0 `postona_ensure_my_personal_workspace()` | SECURITY DEFINER, owner `postgres` | unchanged (measured) |
| admin `apps/admin/src/lib/admin-brands.ts:3` | reads no brands table | n/a |

No client or Edge function writes `brands` through the Data API.

## Refusals (nothing is changed)

Install:

| code | the world it refuses |
| --- | --- |
| `BRANDS_ISOLATION_PREREQUISITE_MISSING` | the tables, the API roles or schema `private` are missing |
| `BRANDS_ISOLATION_SUPERUSER` | the caller is a superuser |
| `BRANDS_ISOLATION_NOT_OWNER` | the caller is not the owner of `brands` |
| `BRANDS_FORCE_ROW_SECURITY` | row security is forced: the definer writers would be filtered |
| `BRANDS_MEMBERSHIPS_NOT_ISOLATED` | `brand_memberships` row security is off, its self policy changed, or an API row write on it (table or column) |
| `BRANDS_MEMBER_POLICY` | the member read policy is missing or not `20260918120000`'s |
| `BRANDS_UNREVIEWED_POLICY` | another permissive policy on `brands` reaches PUBLIC / `anon` / `authenticated` |
| `BRANDS_VIEW_BYPASS` | a view or materialized view reads `brands` as its owner and an API role may select it |
| `BRANDS_INVOKER_WRITER` | an invoker function an API role may execute writes `brands` (it would break) |
| `BRANDS_DEFINER_FILTERED` | a definer function naming `brands` is owned by a role row security filters |
| `BRANDS_MEMBER_READ_MISSING` | `authenticated` cannot read the snapshot columns |
| `BRANDS_POSTCONDITION_*` | the result differs, e.g. a role `authenticated` reaches keeps a write (the owner's revoke cannot reach another grantor's grant either) |

Rollback:
- `BRANDS_ISOLATION_NOT_INSTALLED`: there is no record.
- `BRANDS_ROLLBACK_POSTCONDITION`: privileges were changed after the install.

## Not this candidate's

- G3 #370 owns TRUNCATE / REFERENCES / TRIGGER on `brand_memberships`.
- The install only checks that no API role can write membership rows.

## Evidence

The real local Supabase suite `supabase/tests/postona_personal_workspace_local_run.sh` installs this candidate on G5's world. Its brands tests:
- roll it back and re-detect the world as built;
- re-install it, with the same catalog and record;
- drive every refusal and the lock timeout;
- check the person / another person / `anon` / `service_role` paths through PostgREST.

The G5-50 release suite (`postona_personal_mvp_release_pg_run.sh`) installs it too.
