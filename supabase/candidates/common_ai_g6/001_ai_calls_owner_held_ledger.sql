-- G6-20 (2026-10-28) CANDIDATE, NOT a migration and NOT applied anywhere: the owner-held ledger for the common AI
-- gateway. It closes the busy-check ABA of G6-08 / G6-17 / G6-18 (C1 + C3 together, never one without the other).
-- Depends on 20261010050613 (ledger), 20261017120000 (call store), 20261017150000 (erasure) and 20261020154536
-- (ai_calls_claim_held + the READ COMMITTED guard), applied in that order. Run as the ai_calls owner.
--
-- What it adds (nothing existing is changed):
--   * ai_calls.attempt_owners: which claim token reserved each ledger reservation the gateway made through it.
--   * ai_calls.hold_reason(p): the owner-held rule of ai_calls_claim_held (original token + full identity + acquired,
--     never inserts), with the SAME locks in the SAME order, returning NULL when held or the reason. A helper for the
--     three RPCs below (invoker, owner-only); claim_held itself is untouched.
--   * public.ai_calls_reserve_held(p {held, ledger}): in ONE transaction, the owner-held check and then
--     ai_ledger_reserve(ledger). A process that no longer owns the row never reaches the ledger (C1 at reserve time),
--     so it can never pick up, release or burn the new owner's attempt (C3). A reservation reused by another claim
--     token is refused (ATTEMPT_OWNER_MISMATCH) and its id is not returned.
--   * public.ai_calls_mark_sent_held(p {held, reservation_id}): in ONE transaction, the owner-held check, the
--     reservation's owner, and then ai_ledger_mark_sent. The send permit is given only to the owner at that instant
--     (C1 at send time, atomic with the permit: no window between the check and mark_sent).
--   * public.ai_calls_release_held(p {held, reservation_id}): releases only a reservation this claim token made.
--   Settlement stays ai_ledger_settle (it only finalises a reservation the caller was permitted to send).
-- Locks: person (shared) -> call key -> the row FOR SHARE -> the ledger's own locks, the order every other G6 RPC
-- uses (erasure: person -> ledger; abandon: call key -> row; the ledger never takes a call-store lock).
-- Each RPC refuses any isolation but READ COMMITTED first (G6-12 / G6-13). EXECUTE for service_role only.
-- Fail closed: preconditions and postconditions below; any difference raises and the whole file rolls back. A second
-- run is refused (the objects exist). Nothing is repaired. See docs/ai-provider/G6_20_OWNER_HELD_LEDGER.md.

begin;

do $$
begin
  if (select r.oid from pg_roles r where r.rolname = current_user) is distinct from (select n.nspowner from pg_namespace n where n.nspname = 'ai_calls') then
    raise exception 'G6_OWNER_HELD_LEDGER_PRESTATE: run as the ai_calls owner' using errcode = 'P0001';
  end if;
  if to_regprocedure('public.ai_calls_claim_held(jsonb)') is null
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.ai_calls_claim_held(jsonb)')) <> '052ff25919d4afd77f409c202fd326c0' then
    raise exception 'G6_OWNER_HELD_LEDGER_PRESTATE: ai_calls_claim_held (20261020154536) must exist with its known body' using errcode = 'P0001';
  end if;
  if to_regprocedure('public.ai_ledger_reserve(jsonb)') is null or to_regprocedure('public.ai_ledger_mark_sent(jsonb)') is null
     or to_regprocedure('public.ai_ledger_release(jsonb)') is null then
    raise exception 'G6_OWNER_HELD_LEDGER_PRESTATE: the ledger RPCs (20261010050613) must exist' using errcode = 'P0001';
  end if;
  if to_regclass('ai_calls.attempt_owners') is not null or to_regprocedure('ai_calls.hold_reason(jsonb)') is not null
     or to_regprocedure('public.ai_calls_reserve_held(jsonb)') is not null or to_regprocedure('public.ai_calls_mark_sent_held(jsonb)') is not null
     or to_regprocedure('public.ai_calls_release_held(jsonb)') is not null then
    raise exception 'G6_OWNER_HELD_LEDGER_PRESTATE: already applied (a second run is refused)' using errcode = 'P0001';
  end if;
end;
$$;

create table ai_calls.attempt_owners (
  reservation_id uuid primary key references ai_ledger.reservations (id) on delete restrict,
  call_key text not null check (call_key ~ '^h5m2_[0-9a-f]{64}$'),
  claim_token uuid not null,
  created_at timestamptz not null default now()
);
alter table ai_calls.attempt_owners enable row level security;
comment on table ai_calls.attempt_owners is
  'G6-20: the claim token that reserved each ledger reservation made through ai_calls_reserve_held. No personal data (call_key is the ledger request_id hash; the token is random).';

create function ai_calls.hold_reason(p jsonb)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_key text := ai_calls.input_text(p, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_tenant text := ai_calls.input_text(p, 'tenant_tag', true, '^[0-9a-f]{64}$');
  v_fingerprint text := ai_calls.input_text(p, 'fingerprint', true, '^[0-9a-f]{64}$');
  v_application text := ai_calls.input_text(p, 'application', true, '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$');
  v_feature text := ai_calls.input_text(p, 'feature', true, '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$');
  v_subject text := ai_calls.input_text(p, 'subject_kind', true, '^(system|user)$');
  v_user uuid := ai_calls.input_uuid(p, 'user_id', false);
  v_brand text := ai_calls.input_text(p, 'brand_ref', false, '^[a-z][a-z0-9_]{1,40}$');
  v_owner uuid := ai_calls.input_uuid(p, 'owner', true);
  v_row ai_calls.consumer_calls;
begin
  if (v_subject = 'system' and v_user is not null) or (v_subject = 'user' and v_user is null) then
    raise exception 'AI_CALLS_INVALID_INPUT: subject' using errcode = '22023';
  end if;
  -- ai_calls_claim_held's locks, in its order (held until the calling RPC's transaction ends).
  if v_subject = 'user' then
    perform pg_advisory_xact_lock_shared(hashtextextended('ai_calls:user:' || v_user::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:call:' || v_key, 0));
  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for share;
  if not found then
    return 'NOT_FOUND';
  end if;
  if (v_row.tenant_tag, v_row.fingerprint, v_row.application, v_row.feature, v_row.subject_kind, v_row.user_id, v_row.brand_ref)
     is distinct from (v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user, v_brand) then
    return 'IDENTITY_MISMATCH';
  end if;
  if v_row.state <> 'acquired' then
    return 'NOT_ACQUIRED';
  end if;
  if v_row.claim_token is distinct from v_owner then
    return 'OWNER_MISMATCH';
  end if;
  return null;
end;
$$;

create function public.ai_calls_reserve_held(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_held jsonb := p -> 'held';
  v_ledger jsonb := p -> 'ledger';
  v_key text;
  v_owner uuid;
  v_reason text;
  v_result jsonb;
  v_reservation uuid;
  v_token uuid;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_held) is distinct from 'object' or jsonb_typeof(v_ledger) is distinct from 'object' then
    raise exception 'AI_CALLS_INVALID_INPUT: held and ledger are required' using errcode = '22023';
  end if;
  v_key := ai_calls.input_text(v_held, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_owner := ai_calls.input_uuid(v_held, 'owner', true);
  if v_ledger ->> 'request_id' is distinct from v_key then
    raise exception 'AI_CALLS_INVALID_INPUT: the ledger request_id must be the call key' using errcode = '22023';
  end if;
  v_reason := ai_calls.hold_reason(v_held);
  if v_reason is not null then
    return jsonb_build_object('allowed', false, 'held', false, 'reason', v_reason);
  end if;
  v_result := public.ai_ledger_reserve(v_ledger);
  if (v_result ->> 'allowed')::boolean is not true then
    -- A refusal never hands out another claim's reservation id.
    return (v_result - 'reservation_id') || jsonb_build_object('held', true);
  end if;
  v_reservation := (v_result ->> 'reservation_id')::uuid;
  insert into ai_calls.attempt_owners (reservation_id, call_key, claim_token) values (v_reservation, v_key, v_owner)
    on conflict (reservation_id) do nothing;
  select o.claim_token into v_token from ai_calls.attempt_owners o where o.reservation_id = v_reservation;
  if v_token is distinct from v_owner then
    return jsonb_build_object('allowed', false, 'held', true, 'reason', 'ATTEMPT_OWNER_MISMATCH', 'reused', true);
  end if;
  return v_result || jsonb_build_object('held', true);
end;
$$;

create function public.ai_calls_mark_sent_held(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_held jsonb := p -> 'held';
  v_reservation uuid;
  v_key text;
  v_owner uuid;
  v_reason text;
  v_owned boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_held) is distinct from 'object' then
    raise exception 'AI_CALLS_INVALID_INPUT: held is required' using errcode = '22023';
  end if;
  v_reservation := ai_calls.input_uuid(p, 'reservation_id', true);
  v_key := ai_calls.input_text(v_held, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_owner := ai_calls.input_uuid(v_held, 'owner', true);
  v_reason := ai_calls.hold_reason(v_held);
  if v_reason is not null then
    return jsonb_build_object('may_send', false, 'held', false, 'reason', v_reason);
  end if;
  select (o.call_key = v_key and o.claim_token = v_owner) into v_owned from ai_calls.attempt_owners o where o.reservation_id = v_reservation;
  if v_owned is not true then
    return jsonb_build_object('may_send', false, 'held', true, 'reason', 'ATTEMPT_OWNER_MISMATCH');
  end if;
  return public.ai_ledger_mark_sent(jsonb_build_object('reservation_id', v_reservation)) || jsonb_build_object('held', true);
end;
$$;

create function public.ai_calls_release_held(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_held jsonb := p -> 'held';
  v_reservation uuid;
  v_key text;
  v_owner uuid;
  v_owned boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_held) is distinct from 'object' then
    raise exception 'AI_CALLS_INVALID_INPUT: held is required' using errcode = '22023';
  end if;
  v_reservation := ai_calls.input_uuid(p, 'reservation_id', true);
  v_key := ai_calls.input_text(v_held, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_owner := ai_calls.input_uuid(v_held, 'owner', true);
  -- Releasing one's OWN unsent reservation is always safe (even after losing the row); anything else is refused.
  select (o.call_key = v_key and o.claim_token = v_owner) into v_owned from ai_calls.attempt_owners o where o.reservation_id = v_reservation;
  if v_owned is not true then
    return jsonb_build_object('released', false, 'reason', 'ATTEMPT_OWNER_MISMATCH');
  end if;
  return public.ai_ledger_release(jsonb_build_object('reservation_id', v_reservation));
end;
$$;

revoke all on table ai_calls.attempt_owners from public, anon, authenticated, service_role;
revoke all on function ai_calls.hold_reason(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ai_calls_reserve_held(jsonb), public.ai_calls_mark_sent_held(jsonb), public.ai_calls_release_held(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_calls_reserve_held(jsonb), public.ai_calls_mark_sent_held(jsonb), public.ai_calls_release_held(jsonb)
  to service_role;

-- Postconditions: exact ACLs (owner + service_role EXECUTE on the three RPCs; nothing else for anyone), definer only
-- on the RPCs, empty search_path everywhere, RLS on with no policy, and the effective privileges of the API roles.
do $$
declare
  v_owner oid := (select n.nspowner from pg_namespace n where n.nspname = 'ai_calls');
  v_fn record;
  v_extra text;
  v_role text;
begin
  for v_fn in
    select p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, p.proacl from pg_proc p
     where p.oid in (to_regprocedure('ai_calls.hold_reason(jsonb)'), to_regprocedure('public.ai_calls_reserve_held(jsonb)'),
                     to_regprocedure('public.ai_calls_mark_sent_held(jsonb)'), to_regprocedure('public.ai_calls_release_held(jsonb)'))
  loop
    if v_fn.proowner <> v_owner or v_fn.proconfig is distinct from array['search_path=""']
       or v_fn.prosecdef is distinct from (v_fn.proname <> 'hold_reason') then
      raise exception 'G6_OWNER_HELD_LEDGER_POST: % owner / definer / search_path', v_fn.proname using errcode = 'P0001';
    end if;
    select string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type || case when a.is_grantable then '+grant' else '' end, ', ' order by coalesce(r.rolname, 'PUBLIC'), a.privilege_type) into v_extra
      from aclexplode(coalesce(v_fn.proacl, acldefault('f', v_fn.proowner))) a left join pg_roles r on r.oid = a.grantee
     where a.grantee <> v_fn.proowner
       and not (v_fn.proname <> 'hold_reason' and r.rolname = 'service_role' and a.privilege_type = 'EXECUTE' and not a.is_grantable);
    if v_extra is not null then
      raise exception 'G6_OWNER_HELD_LEDGER_POST: unexpected grant % %', v_fn.proname, v_extra using errcode = 'P0001';
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.oid in (to_regprocedure('ai_calls.hold_reason(jsonb)'), to_regprocedure('public.ai_calls_reserve_held(jsonb)'),
        to_regprocedure('public.ai_calls_mark_sent_held(jsonb)'), to_regprocedure('public.ai_calls_release_held(jsonb)'))) <> 4 then
    raise exception 'G6_OWNER_HELD_LEDGER_POST: a function is missing' using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_class c cross join lateral aclexplode(c.relacl) a where c.oid = 'ai_calls.attempt_owners'::regclass and a.grantee <> c.relowner)
     or exists (select 1 from pg_attribute a where a.attrelid = 'ai_calls.attempt_owners'::regclass and a.attnum > 0 and a.attacl is not null)
     or not (select c.relrowsecurity from pg_class c where c.oid = 'ai_calls.attempt_owners'::regclass)
     or exists (select 1 from pg_policy pol where pol.polrelid = 'ai_calls.attempt_owners'::regclass)
     or (select c.relowner from pg_class c where c.oid = 'ai_calls.attempt_owners'::regclass) <> v_owner then
    raise exception 'G6_OWNER_HELD_LEDGER_POST: attempt_owners ACL / RLS / owner' using errcode = 'P0001';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    continue when to_regrole(v_role) is null;
    if has_table_privilege(v_role, 'ai_calls.attempt_owners', 'SELECT') or has_table_privilege(v_role, 'ai_calls.attempt_owners', 'INSERT')
       or has_table_privilege(v_role, 'ai_calls.attempt_owners', 'UPDATE') or has_table_privilege(v_role, 'ai_calls.attempt_owners', 'DELETE')
       or has_function_privilege(v_role, 'ai_calls.hold_reason(jsonb)', 'EXECUTE')
       or (v_role <> 'service_role' and (has_function_privilege(v_role, 'public.ai_calls_reserve_held(jsonb)', 'EXECUTE')
            or has_function_privilege(v_role, 'public.ai_calls_mark_sent_held(jsonb)', 'EXECUTE')
            or has_function_privilege(v_role, 'public.ai_calls_release_held(jsonb)', 'EXECUTE')))
       or (v_role = 'service_role' and not (has_function_privilege(v_role, 'public.ai_calls_reserve_held(jsonb)', 'EXECUTE')
            and has_function_privilege(v_role, 'public.ai_calls_mark_sent_held(jsonb)', 'EXECUTE')
            and has_function_privilege(v_role, 'public.ai_calls_release_held(jsonb)', 'EXECUTE'))) then
      raise exception 'G6_OWNER_HELD_LEDGER_POST: effective privileges of %', v_role using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

commit;
