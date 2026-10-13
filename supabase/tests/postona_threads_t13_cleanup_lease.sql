-- The Threads cleanup's live-lease authorization (F4, postona-f4-threads-cleanup-live-lease-security-fix-20261013)
-- on the REAL G5/F5 lifecycle, Phase 6 included (begin_service_deletion, claim_service_deletion,
-- release_service_deletion_claim, private.account_lifecycle_cleanup_authorized). Run by postona_threads_t13_run.sh
-- on a world with this branch's cleanup candidate (must pass) and on one with PR #169's (must FAIL: the shipped
-- predicate let a POSTONA-only deletion clean up with no lease). Each DO block is one transaction. Fake data only.
\set ON_ERROR_STOP 1
set timezone = 'UTC';

create temp table ids (k text primary key, v text);
create function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into ids values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.get(p_k text) returns text language sql as $$ select v from ids where k = p_k $$;
create function pg_temp.u(p_tag text) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000000' || p_tag)::uuid $$;
-- A person's whole Threads footprint: account | token secret | OAuth states | custody | publish permission.
create function pg_temp.footprint(p_user uuid) returns text language sql as $$
  with ws as (select public.social_mobile_account_deletion_workspace(p_user) as id)
  select concat_ws('|',
    (select count(*) from public.social_accounts a, ws where a.brand_id = ws.id and a.platform = 'threads'),
    (select count(*) from vault.secrets s join public.social_accounts a on a.vault_access_token_secret_id = s.id, ws
      where a.brand_id = ws.id and a.platform = 'threads'),
    (select count(*) from public.social_account_oauth_states s, ws where s.brand_id = ws.id),
    (select count(*) from public.threads_account_credential_custody c join public.social_accounts a on a.id = c.social_account_id, ws
      where a.brand_id = ws.id),
    (select count(*) from public.social_account_manual_publish_permissions p, ws where p.brand_id = ws.id)) $$;
create function pg_temp.cleanup(p_user uuid) returns jsonb language sql as $$
  select public.cleanup_threads_provider_footprint(p_user) $$;

-- Four people, each connected through PR #124's real flow (an OAuth state, a Vault token, custody) with publishing ON.
do $$
declare t text;
begin
  foreach t in array array['e1', 'e2', 'e3', 'e4'] loop
    perform t13.person(pg_temp.u(t), 'lease' || t);
    perform t13.check(pg_temp.footprint(pg_temp.u(t)) = '1|1|1|1|1', t || ' connected: ' || pg_temp.footprint(pg_temp.u(t)));
  end loop;
end $$;

-- 1. Ending POSTONA was BEGUN (G5's begin) but nobody claimed it: nothing is removed. (PR #169 removed here.)
do $$
declare s uuid := pg_temp.u('e1'); r jsonb;
begin
  r := public.begin_service_deletion(s, 'x_autopost');
  perform t13.check(r->>'status' = 'started', 'begin: ' || r::text);
  perform pg_temp.put('op_e1', r->>'operation_id');
  perform t13.check(not private.account_lifecycle_cleanup_authorized(s), 'G5 predicate: not authorized before the claim');
  r := pg_temp.cleanup(s);
  perform t13.check(r = '{"code": "DELETION_NOT_IN_PROGRESS", "outcome": "blocked"}', 'unclaimed POSTONA deletion: ' || r::text);
  perform t13.check(pg_temp.footprint(s) = '1|1|1|1|1', 'nothing removed before the claim: ' || pg_temp.footprint(s));
end $$;

-- 2. The owner CLAIMS it (F5's claim: a live lease): the cleanup removes this person's Threads footprint only.
do $$
declare s uuid := pg_temp.u('e1'); r jsonb;
begin
  r := public.claim_service_deletion(s, 'x_autopost', pg_temp.get('op_e1')::uuid);
  perform t13.check(r->>'status' = 'acquired' and r->'provider_results' ? 'threads', 'claim: ' || r::text);
  r := pg_temp.cleanup(s);
  perform t13.check(r = '{"code": "LOCAL_REMOVED", "outcome": "local_removed_remote_unverified"}', 'claimed: ' || r::text);
  perform t13.check(pg_temp.footprint(s) = '0|0|0|0|0', 'all of e1''s Threads footprint is gone: ' || pg_temp.footprint(s));
  perform t13.check(pg_temp.footprint(pg_temp.u('e2')) = '1|1|1|1|1' and pg_temp.footprint(pg_temp.u('e3')) = '1|1|1|1|1'
                    and pg_temp.footprint(pg_temp.u('e4')) = '1|1|1|1|1', 'the others are untouched');
end $$;

-- 3. A claimed lease that ENDED, one that was RELEASED, or another person's live lease: nothing is removed.
do $$
declare s uuid := pg_temp.u('e2'); o uuid := pg_temp.u('e4'); r jsonb; op uuid; lease uuid;
begin
  op := (public.begin_service_deletion(s, 'x_autopost') ->> 'operation_id')::uuid;
  r := public.claim_service_deletion(s, 'x_autopost', op);
  lease := (r->>'lease')::uuid;
  perform pg_temp.put('op_e2', op::text);
  -- The owner's lease runs out (wall clock).
  update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() - interval '1 second' where id = op;
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'outcome' = 'blocked', 'ended lease: ' || r::text);
  -- A live lease again, then the owner gives it back (F5's release).
  update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '5 minutes' where id = op;
  r := public.release_service_deletion_claim(s, 'x_autopost', op, lease);
  perform t13.check(r->>'status' = 'released', 'release: ' || r::text);
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'outcome' = 'blocked', 'released lease: ' || r::text);
  -- Someone else's claimed POSTONA deletion authorizes nothing for this person.
  r := public.claim_service_deletion(o, 'x_autopost', (public.begin_service_deletion(o, 'x_autopost') ->> 'operation_id')::uuid);
  perform t13.check(r->>'status' = 'acquired', 'other person claimed: ' || r::text);
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'outcome' = 'blocked', 'another person''s lease: ' || r::text);
  perform t13.check(pg_temp.footprint(s) = '1|1|1|1|1', 'nothing of e2 removed: ' || pg_temp.footprint(s));
end $$;

-- 4. Taken over: a NEW owner claims the abandoned deletion (the fence grows); its cleanup is authorized.
do $$
declare s uuid := pg_temp.u('e2'); r jsonb;
begin
  r := public.claim_service_deletion(s, 'x_autopost', pg_temp.get('op_e2')::uuid);
  perform t13.check(r->>'status' = 'acquired' and (r->>'fence')::int >= 2, 'new owner: ' || r::text);
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'code' = 'LOCAL_REMOVED' and pg_temp.footprint(s) = '0|0|0|0|0', 'the current owner removes: ' || r::text);
end $$;

-- 5. A whole-account deletion still needs its cleanup step AND its owner's live lease.
do $$
declare s uuid := pg_temp.u('e3'); r jsonb; op uuid;
begin
  insert into private.account_lifecycle_operations (user_id, subject_sha256, operation_type)
  values (s, encode(sha256(convert_to(s::text, 'UTF8')), 'hex'), 'account_deletion') returning id into op;
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'outcome' = 'blocked', 'account deletion, unclaimed: ' || r::text);
  update private.account_lifecycle_operations set owner_lease = gen_random_uuid(), owner_lease_expires_at = clock_timestamp() - interval '1 second' where id = op;
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'outcome' = 'blocked', 'account deletion, ended lease: ' || r::text);
  perform t13.check(pg_temp.footprint(s) = '1|1|1|1|1', 'nothing of e3 removed');
  update private.account_lifecycle_operations set owner_lease_expires_at = clock_timestamp() + interval '5 minutes' where id = op;
  r := pg_temp.cleanup(s);
  perform t13.check(r->>'code' = 'LOCAL_REMOVED' and pg_temp.footprint(s) = '0|0|0|0|0', 'account deletion, live lease: ' || r::text);
end $$;

-- 6. Access stays as it was: the predicate, the wrapper and the removal are owner-only.
do $$
declare f text;
begin
  foreach f in array array['select private.account_lifecycle_cleanup_authorized(gen_random_uuid())',
                           'select public.threads_cleanup_authorized(gen_random_uuid())',
                           'select public.cleanup_threads_provider_footprint(gen_random_uuid())'] loop
    perform t13.check(t13.try_as('service_role', f) = '42501', 'service_role: ' || f);
    perform t13.check(t13.try_as('authenticated', f) = '42501', 'authenticated: ' || f);
    perform t13.check(t13.try_as('anon', f) = '42501', 'anon: ' || f);
  end loop;
  perform t13.check((select p.prosecdef and p.proconfig @> array['search_path=""'] and p.prorettype = 'boolean'::regtype
                     from pg_proc p where p.oid = 'public.threads_cleanup_authorized(uuid)'::regprocedure), 'definer, empty search_path, boolean');
end $$;

select 'T13_CLEANUP_LEASE_OK';
