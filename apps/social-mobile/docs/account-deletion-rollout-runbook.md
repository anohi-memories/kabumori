# Social-mobile account deletion — production rollout runbook (preflight 2026-09-29)

Preflight result: **READY_FOR_ROLLOUT_WITH_OPERATOR_GATES**. Nothing was applied or deployed (`production_mutation=0`).

- Production was read only through catalog SELECTs, plus one aggregate count of Storage objects with an owner (0). No user rows, tokens or Vault plaintext were read.
- Every step below is **for a later, separately approved task**. Each step has a STOP condition: on any delta from the expected values, stop and report.

## 0. Identity

| item | value |
| --- | --- |
| migration | `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql` (only file of its kind) |
| sha256 | `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657` (= accepted PR #52 head `4bc8195`, squash `136dcd2`) |
| production history | version `20260928160000` **not applied** (`remote` empty); no object-name collision |
| later migrations | `20260929090000_news_discovery_observer.sql` does not touch any referenced object |
| Edge function | `supabase/functions/social-mobile-account-delete/` (`index.ts`, `http.ts`, `delete_logic.ts`, `apple_revoke.ts`); **not deployed**; the name is free |

## 1. Preflight outcome (sanitized)

- The live production schema, ownership, ACL, isolation, Auth, Vault and Storage assumptions required by the reviewed design were checked read-only. None of them hit a STOP condition.
- The only workspace-creation path is the reviewed onboarding RPC, byte-identical to the repository (md5 of begin/consume/complete = `7679362b…` / `9da3c2fd…` / `ca070453…`).
- Every target path runs READ COMMITTED.
- social-mobile has no Storage dependency.
- Sign in with Apple revocation is not configured, so Apple-login users are refused, never partially deleted.
- Unrelated pre-existing security/configuration findings were observed and are intentionally excluded from this repository. They need separate private operational follow-up before or alongside rollout, as appropriate.
- The detailed read-only evidence is held with the operator, not in the repository.

## 2. Pre-apply re-check (immediately before apply)

Re-run the three read-only catalog queries of this preflight: owners/privileges/guarded tables/collisions/triggers/FKs; isolation/workspace creators/policies/grants/Storage; and the auth.sessions cascade.

STOP if any of these changed:
- the migration sha256 above;
- the `remote` history entry for `20260928160000` is no longer empty;
- any collision;
- a new trigger on the 11 tables or on `auth.users` / `vault.secrets`;
- a new FK into these tables;
- a new workspace creator;
- any isolation override;
- a changed onboarding RPC md5;
- the migration role no longer having the capabilities recorded in the operator-held preflight evidence;
- a Storage object with an owner.

## 3. Apply (single file, atomic, never `db push`, never `migration repair`)

```bash
cd <fresh checkout of main>
test "$(shasum -a 256 supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql | cut -d' ' -f1)" = 7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657
F="$(mktemp /private/tmp/sm-deletion-apply.XXXXXX.sql)"
{ echo "begin;"; echo "set local lock_timeout = '5s';"; echo "set local statement_timeout = '60s';";
  cat supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql; echo "commit;"; } > "$F"
supabase db query --linked --file "$F"
```

- The creation of 11 triggers briefly takes SHARE ROW EXCLUSIVE locks. If `lock_timeout` hits (for example a long dispatcher transaction), the whole file rolls back; retry later.
- A second run refuses with `SOCIAL_MOBILE_DELETION_CANDIDATE_ALREADY_APPLIED`.
- The migration history table is not updated by this method; this is known drift, and no repair is done.

## 4. Read-back after apply (all must hold)

```sql
select jsonb_build_object(
 'fn', (select jsonb_object_agg(p.proname, md5(p.prosrc)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'social_mobile_account_deletion%'),
 'owners', (select jsonb_agg(distinct pg_get_userbyid(p.proowner)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'social_mobile_account_deletion%'),
 'bad_config', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'social_mobile_account_deletion%' and coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=""'),
 'client_exec', (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'social_mobile_account_deletion%'
                  and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
 'service_exec', (select jsonb_agg(p.proname order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'social_mobile_account_deletion%' and has_function_privilege('service_role', p.oid, 'EXECUTE')),
 'tables', (select jsonb_agg(jsonb_build_object('t', c.relname, 'rls', c.relrowsecurity,
              'any_grant', has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'))) from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relname in ('social_mobile_account_deletions', 'social_mobile_account_deletion_audit')),
 'triggers', (select jsonb_agg(t.tgrelid::regclass::text || ':' || t.tgenabled::text order by 1) from pg_trigger t where t.tgname = 'social_mobile_deletion_guard'),
 'rows', (select count(*) from public.social_mobile_account_deletions) + (select count(*) from public.social_mobile_account_deletion_audit)
) as readback;
```

Expected values:
- `owners = ["postgres"]`, `bad_config = 0`, `client_exec = 0`, `rows = 0`.
- `tables`: both with `rls = true` and `any_grant = false`.
- `service_exec`: exactly `acquire, credentials, finalize, mark_apple_revoked, mark_x_revoked, operator_resolve, preview, purge, record, release`.
- `triggers`: exactly the 11 tables with `O` (enabled): brands, brand_memberships, social_accounts, social_account_oauth_states, x_account_refresh_state_v2, x_account_refresh_rollout, scheduled_posts, publish_claims, published_content_fingerprints, post_execution_logs, posting_windows.
- `fn` (md5 of `prosrc`, computed from the same file on disposable PG):

| function | md5 |
| --- | --- |
| acquire | de7ee0de1b5be93bb5200ca6243320b0 |
| blocker | 57d7558c2c0d6eebdd04a276863cdba0 |
| credential_set | 6c26ae29e74a1a5de337db409ed53312 |
| credentials | df318fb9643c7932fc13e29b119c50fa |
| finalize | 96f9df63c3b977c82bb7c41f4d65a33e |
| fingerprint | ca85276c1c7a8de2e2a558d420518e28 |
| guard | dc37138099df32c24142addf012e9132 |
| hold | 53066dcd62d6342695003298bd139ebe |
| mark_apple_revoked | 381ce7aa886e04ccaf3882e6672774fc |
| mark_x_revoked | b64ed319688d044b8788cc44200e7852 |
| operator_resolve | 9e262379bb33cf8d6343937b24a4f6ce |
| ownership_problem | 7c957685d2c92bf68048c644882a79b6 |
| preview | 8d51137a5fef2eacd990e1e065410bfc |
| purge | 4443571cd5a127ed2811398916793cd5 |
| record | 1a41f22d3c47e16d864e519e00e91e08 |
| release | 7506e60cfb318de3b089eae5b56519b7 |
| scope | ad59a61b2f0ddf63fd59d820de4bb6e7 |
| subject | 53ce3e9fa590368de2bad7b29b6bc14d |
| to_operator | 7fbdd9c62095a16cac893d3e731879d7 |
| workspace | 239faf67572b47cc1871b6f42b53e47b |
| workspace_lock | 9aaf7e282ca396760573ba930e258c63 |

Also re-check that the existing onboarding RPC md5s are unchanged (the apply must not touch them).

## 5. Rollback / recovery

- **Apply fails part-way.** The file is one transaction, so nothing remains. Verify `collisions = []` again.
- **Read-back mismatch, or a rollback is needed later.** Only while no deletion is in progress. The audit table is kept as evidence, with no grants:

```sql
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.social_mobile_account_deletions) then
    raise exception 'ROLLBACK_REFUSED_DELETION_IN_PROGRESS';
  end if;
end $$;
drop trigger social_mobile_deletion_guard on public.brands;
drop trigger social_mobile_deletion_guard on public.brand_memberships;
drop trigger social_mobile_deletion_guard on public.social_accounts;
drop trigger social_mobile_deletion_guard on public.social_account_oauth_states;
drop trigger social_mobile_deletion_guard on public.x_account_refresh_state_v2;
drop trigger social_mobile_deletion_guard on public.x_account_refresh_rollout;
drop trigger social_mobile_deletion_guard on public.scheduled_posts;
drop trigger social_mobile_deletion_guard on public.publish_claims;
drop trigger social_mobile_deletion_guard on public.published_content_fingerprints;
drop trigger social_mobile_deletion_guard on public.post_execution_logs;
drop trigger social_mobile_deletion_guard on public.posting_windows;
drop function public.social_mobile_account_deletion_operator_resolve(uuid, text);
drop function public.social_mobile_account_deletion_finalize(uuid, uuid);
drop function public.social_mobile_account_deletion_purge(uuid, uuid);
drop function public.social_mobile_account_deletion_mark_apple_revoked(uuid, uuid);
drop function public.social_mobile_account_deletion_mark_x_revoked(uuid, uuid, jsonb);
drop function public.social_mobile_account_deletion_credentials(uuid, uuid);
drop function public.social_mobile_account_deletion_release(uuid, uuid);
drop function public.social_mobile_account_deletion_acquire(uuid, text, boolean, integer);
drop function public.social_mobile_account_deletion_preview(uuid);
drop function public.social_mobile_account_deletion_to_operator(uuid, text);
drop function public.social_mobile_account_deletion_hold(uuid, uuid);
drop function public.social_mobile_account_deletion_scope(uuid);
drop function public.social_mobile_account_deletion_blocker(uuid, text);
drop function public.social_mobile_account_deletion_ownership_problem(text);
drop function public.social_mobile_account_deletion_credential_set(text);
drop function public.social_mobile_account_deletion_fingerprint(uuid);
drop function public.social_mobile_account_deletion_guard();
drop function public.social_mobile_account_deletion_record(uuid, text, text);
drop function public.social_mobile_account_deletion_workspace_lock(text);
drop function public.social_mobile_account_deletion_workspace(uuid);
drop function public.social_mobile_account_deletion_subject(uuid);
drop table public.social_mobile_account_deletions;
commit;
```

- **Deletion in progress when a rollback is wanted.** Resolve each tombstone first with `operator_resolve`: `cancel` before purge, or complete via the Edge retry. Never drop the state while a workspace is half-deleted.
- **Edge.** Undeploy with `supabase functions delete social-mobile-account-delete`, or disable by keeping `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` unset. The app shows 準備中 whenever the flag is not `true`.

## 6. Edge deploy (after the DB read-back passes)

```bash
supabase functions deploy social-mobile-account-delete --project-ref <ref>
```

- Keep JWT verification **on**: do not pass `--no-verify-jwt`. `supabase functions list` must show `verify_jwt=true`. The function also re-verifies the caller through `/auth/v1/user`.
- **Configuration.** No new X configuration is needed (the function reuses the existing X client configuration). The Sign in with Apple revocation configuration (see `apple_revoke.ts`) is added only when Sign in with Apple is enabled.
- **Source identity.** Run `supabase functions download social-mobile-account-delete` into a scratch directory and `diff -r` it against `supabase/functions/social-mobile-account-delete/` (the four source files). Any difference is a STOP.
- **Smoke check (no deletion):**
  1. `OPTIONS` with `Origin` returns 204 and the CORS headers.
  2. `POST` without a token returns 401 (gateway).
  3. `POST {"action":"preview"}` with a **disposable test account's** token returns 200 with `scope` and `state=none`; it is read-only.
  4. `POST {"action":"drop"}` returns 400 `ACTION_REQUIRED`.

## 7. Real-device E2E (disposable accounts only; before enabling the flag)

| # | case | must observe |
| --- | --- | --- |
| 1 | never-connected user, e-mail login | preview `social_and_login`; the delete result has `login_deleted:true`; afterwards 0 rows for that workspace/membership/tombstone, the user is absent, and the app is signed out |
| 2 | user with a Kabumori `profiles` row | preview `social_only`; the UI shows the login and Kabumori data are kept; the profile and its dependents are intact; the login still works |
| 3 | X-connected test account (test X app user) | X revoke is 200; the tokens stop working at X (for example a failed `users/me` with the old token); the Vault secrets of that account are gone; no other account's secret count changes |
| 4 | Apple-login user on iOS (only after `APPLE_*` is configured) | the native re-auth code is exchanged and revoked; a retry after an injected downstream failure does not ask for Apple again |
| 5 | lost response / retry | kill the app after sending: a retry either completes (`social_only`) or gets `AUTH_REQUIRED` with the "may already be complete" message; no orphan rows |
| 6 | onboarding-vs-deletion race | only on a disposable (non-production) environment; already proven by `supabase/tests/social_mobile_account_deletion_run.sh`; production E2E does not force races |
| 7 | unrelated data | before and after counts of other workspaces' brands, accounts, secrets and posts are unchanged; existing live workspaces are untouched |

Enable `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true` (and the legal URLs) only after rows 1–3 and 5 pass, and row 7 shows no unrelated change. Row 4 is additionally required before Sign in with Apple is offered.

## 8. Legal / operator gates (inventory only; no text invented)

- Privacy policy, terms and support URL / e-mail for social-mobile: **not set**. The owner must provide the pages.
- Retention period of the pseudonymous deletion audit (`subject_sha256`): **undecided**.
- History retention: currently none; all social history is deleted. This needs an owner/legal decision.
- Wording that posts already published on X remain on X: implemented in the app. The owner should confirm it.
- Kabumori `account-delete` (already live) deletes the shared login without handling social data. Coordination is owned by G1/G2 (refuse users with `brand_memberships`, or call this flow first).

## 9. Observations outside this rollout

Some pre-existing, out-of-scope security and configuration observations were reported to the operator directly and are intentionally not recorded here. None of them blocks this rollout.
