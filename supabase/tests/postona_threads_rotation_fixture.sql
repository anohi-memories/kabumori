-- Fake-only test support for supabase/tests/postona_threads_rotation_run.sh (F4,
-- postona-f4-threads-credential-rotate-cas-sql-contract-20261017). Applied on the REAL G5 world of
-- postona_threads_t13_fixture.sql (G5 T13 / Phase 4 / F5 / Phase 6 migrations, PR #124, the G4 publish stack, the
-- F4 guards, disconnect and cleanup), AFTER threads_credential_rotation_candidate.sql. Nothing here stands in for
-- the candidate; H5's Vault write is faked with the world's vault.update_secret stub. Every value is fake.
set timezone = 'UTC';

create schema rot;
create table rot.ids (k text primary key, v text not null);

-- Everything a refusal must leave unchanged, for EVERY account (a write to another account is a failure too).
create function rot.everything() returns text language sql volatile as $$
  select pg_catalog.concat_ws(' || ',
    (select string_agg(row(c.*)::text, ';' order by c.social_account_id) from public.threads_account_credential_custody c),
    (select string_agg(row(l.*)::text, ';' order by l.social_account_id) from public.threads_credential_refresh_leases l),
    (select string_agg(row(a.*)::text, ';' order by a.id) from public.social_accounts a),
    (select string_agg(row(s.*)::text, ';' order by s.id) from vault.secrets s),
    (select string_agg(row(t.*)::text, ';' order by t.id) from public.threads_manual_publish_attempts t),
    (select string_agg(row(m.*)::text, ';' order by m.brand_id, m.user_id) from public.brand_memberships m))
$$;

create function rot.claim(p_account text) returns jsonb language sql volatile as $$
  select public.claim_threads_credential_refresh(p_account)
$$;

-- The rotate a refresher would send for a claim; any argument can be overridden.
create function rot.rotate(p_account text, p_claim jsonb, p_new interval default interval '60 days', p_lease uuid default null,
                           p_secret uuid default null, p_recorded timestamptz default null) returns jsonb language sql volatile as $$
  select public.rotate_threads_credential_custody(
    p_account, coalesce(p_lease, (p_claim ->> 'lease')::uuid), coalesce(p_secret, (p_claim ->> 'vault_secret_id')::uuid),
    coalesce(p_recorded, (p_claim ->> 'custody_recorded_at')::timestamptz), pg_catalog.clock_timestamp() + p_new)
$$;

-- H5's second transaction, faked: the rotate, then (only when it rotated) the Vault replacement of THE SECRET THE
-- ROTATE NAMED, in the same transaction.
create function rot.h5_rotate(p_account text, p_claim jsonb, p_token text, p_new interval default interval '60 days') returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  v := rot.rotate(p_account, p_claim, p_new);
  if v ->> 'status' = 'rotated' then perform vault.update_secret((v ->> 'vault_secret_id')::uuid, p_token); end if;
  return v;
end $$;

-- A call (one jsonb) that must be refused with p_code and change nothing anywhere.
create function rot.refused(p_sql text, p_code text, p_label text) returns void language plpgsql as $$
declare v_before text := rot.everything(); v_out jsonb;
begin
  execute p_sql into v_out;
  if v_out ->> 'status' is distinct from 'refused' or v_out ->> 'code' is distinct from p_code then
    raise exception 'FAIL % : expected refused %, got %', p_label, p_code, v_out;
  end if;
  if rot.everything() is distinct from v_before then raise exception 'FAIL % : the refusal changed something', p_label; end if;
end $$;

-- One call with a person's JWT claims set (as H5's owner channel does for a person's own request).
create function rot.as_person(p_user uuid, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform t13.act(p_user);
  execute p_sql into v;
  perform t13.act(null);
  return v;
end $$;

-- H5's transaction fails after the rotate (e.g. the Vault write): everything rolls back together.
create function rot.rotate_then_vault_fails(p_account text, p_claim jsonb) returns text language plpgsql as $$
declare v_before text := rot.everything(); v jsonb;
begin
  begin
    v := rot.rotate(p_account, p_claim);
    if v ->> 'status' is distinct from 'rotated' then return 'NOT_ROTATED ' || v::text; end if;
    raise exception 'VAULT_UNAVAILABLE';
  exception when raise_exception then
    null;
  end;
  return case when rot.everything() = v_before then 'ROLLED_BACK' else 'CHANGED' end;
end $$;

-- For the two-session races: a person with a stored claim, and the stored rotate.
create function rot.setup(p_user uuid, p_tag text) returns text language plpgsql as $$
declare v_account text := t13.person(p_user, p_tag);
begin
  insert into rot.ids values ('acct', v_account), ('claim', rot.claim(v_account)::text);
  if (select v::jsonb ->> 'status' from rot.ids where k = 'claim') is distinct from 'claimed' then raise exception 'FIXTURE_CLAIM_FAILED'; end if;
  return v_account;
end $$;
create function rot.stored_rotate() returns jsonb language sql volatile as $$
  select rot.h5_rotate((select v from rot.ids where k = 'acct'), (select v::jsonb from rot.ids where k = 'claim'),
                       'fake_threads_race_ROTATED_0123456789')
$$;
-- A rotate naming a lease that does not exist, and whether it answered within a second: '<code> <fast>'.
create function rot.stray_rotate() returns text language plpgsql as $$
declare v_t0 timestamptz := clock_timestamp(); v_out jsonb;
begin
  v_out := rot.rotate((select i.v from rot.ids i where i.k = 'acct'), (select i.v::jsonb from rot.ids i where i.k = 'claim'), p_lease => gen_random_uuid());
  return coalesce(v_out ->> 'code', v_out ->> 'status') || ' ' || (clock_timestamp() - v_t0 < interval '1 second')::text;
end $$;
-- One call (one jsonb) and whether it had to wait: '<code or status> waited|fast' (half a second or more = waited).
create function rot.timed(p_sql text) returns text language plpgsql as $$
declare v_t0 timestamptz := clock_timestamp(); v_out jsonb;
begin
  execute p_sql into v_out;
  return coalesce(v_out ->> 'code', v_out ->> 'status') || ' '
         || case when clock_timestamp() - v_t0 >= interval '0.5 seconds' then 'waited' else 'fast' end;
end $$;
