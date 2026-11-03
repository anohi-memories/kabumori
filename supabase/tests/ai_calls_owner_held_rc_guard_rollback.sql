-- LOCAL ISOLATED TEST DATABASES ONLY. Reverts 20261020154536_ai_calls_owner_held_rc_guard.sql: puts back the
-- original ai_calls_abandon / ai_calls_forget_user bodies (20261017120000) and drops ai_calls_claim_held.
-- Reverting RE-OPENS the R1 root and the REPEATABLE READ / SERIALIZABLE counterexample: never run it on a Supabase
-- project (production NO_GO). Used by supabase/tests/common_ai_gateway_owner_held_rc_guard_migration_pg_test.ts.
-- It refuses unless the database is exactly in the state that migration leaves (fail closed), keeps OIDs, owners and
-- grants of the replaced functions, and drops the new one without CASCADE (a dependent object makes it fail).

begin;

do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.ai_calls_abandon(jsonb)')) is distinct from '479cbc34c20225d4ea202be18ec9a294'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.ai_calls_forget_user(jsonb)')) is distinct from '3130d05268c8c7fd136b062bdfe051a1'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.ai_calls_claim_held(jsonb)')) is distinct from '052ff25919d4afd77f409c202fd326c0' then
    raise exception 'AI_CALLS_OWNER_HELD_ROLLBACK_PRESTATE: not the state 20261020154536 leaves' using errcode = 'P0001';
  end if;
end;
$$;

create temp table ai_calls_owner_held_rollback_prestate on commit drop as
  select p.oid, p.proowner, p.proacl::text as acl
    from pg_proc p where p.oid in (to_regprocedure('public.ai_calls_abandon(jsonb)'), to_regprocedure('public.ai_calls_forget_user(jsonb)'));

create or replace function public.ai_calls_abandon(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := ai_calls.input_text(p, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_age bigint := coalesce(ai_calls.input_int(p, 'older_than_seconds', false, 300, 2592000), 1800);
  v_audit jsonb := p -> 'audit';
  v_row ai_calls.consumer_calls;
  v_open bigint;
  v_sent bigint;
  v_cost numeric;
  v_upper boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:call:' || v_key, 0));
  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for update;
  if not found then
    return jsonb_build_object('abandoned', false, 'reason', 'NOT_FOUND');
  end if;
  if v_row.state <> 'acquired' then
    return jsonb_build_object('abandoned', false, 'reason', 'NOT_ACQUIRED', 'state', v_row.state);
  end if;
  if v_row.created_at > now() - make_interval(secs => v_age) then
    return jsonb_build_object('abandoned', false, 'reason', 'TOO_RECENT');
  end if;
  if not ai_calls.audit_ok(v_audit, v_row.call_key, v_row.tenant_tag, v_row.feature) then
    raise exception 'AI_CALLS_INVALID_INPUT: audit' using errcode = '22023';
  end if;

  select count(*) filter (where r.status in ('reserved', 'sent')),
         count(*) filter (where r.status in ('settled', 'unknown'))
    into v_open, v_sent
    from ai_ledger.reservations r
   where r.request_id = v_key;
  if v_open > 0 then
    return jsonb_build_object('abandoned', false, 'reason', 'LEDGER_NOT_FINAL', 'open_attempts', v_open);
  end if;
  select coalesce(sum(e.estimated_cost_usd), 0), coalesce(bool_or(e.cost_basis = 'upper_bound'), false)
    into v_cost, v_upper
    from ai_ledger.usage_events e
   where e.request_id = v_key;
  if (v_audit ->> 'attempts')::numeric <> v_sent
     or (v_sent = 0 and ((v_audit ->> 'costBasis') <> 'no_request' or (v_audit ->> 'estimatedCostUsd')::numeric <> 0))
     or (v_sent > 0 and (v_audit ->> 'costBasis') = 'no_request')
     or (v_upper and (v_audit ->> 'costBasis') <> 'includes_upper_bound')
     or (v_audit ->> 'estimatedCostUsd')::numeric < v_cost - 0.000001 then
    raise exception 'AI_CALLS_AUDIT_LEDGER_MISMATCH' using errcode = 'P0001';
  end if;

  update ai_calls.consumer_calls c
     set state = 'abandoned', result = ai_calls.tombstone(v_audit), audit = v_audit, abandoned_at = now()
   where c.call_key = v_key;
  return jsonb_build_object('abandoned', true);
end;
$$;

create or replace function public.ai_calls_forget_user(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := ai_calls.input_uuid(p, 'user_id', true);
  v_in_flight bigint;
  v_deleted integer;
  v_retained bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:user:' || v_user::text, 0));
  select count(*) into v_in_flight from ai_calls.consumer_calls c where c.user_id = v_user and c.state = 'acquired';
  if v_in_flight > 0 then
    return jsonb_build_object('forgotten', false, 'reason', 'CALLS_IN_FLIGHT', 'in_flight', v_in_flight);
  end if;
  delete from ai_calls.consumer_calls c where c.user_id = v_user;
  get diagnostics v_deleted = row_count;
  select count(*) into v_retained from ai_ledger.reservations r where r.user_id = v_user;
  return jsonb_build_object('forgotten', true, 'deleted', v_deleted, 'ledger_reservations_retained', v_retained);
end;
$$;

drop function public.ai_calls_claim_held(jsonb) restrict;

do $$
begin
  if exists (select 1 from ai_calls_owner_held_rollback_prestate s left join pg_proc p on p.oid = s.oid
              where p.oid is null or p.proowner <> s.proowner or p.proacl::text is distinct from s.acl)
     or (select md5(p.prosrc) from pg_proc p where p.oid = 'public.ai_calls_abandon(jsonb)'::regprocedure) <> 'f6a0c47dbe82ae0e4f1e7d8b9d94e0f6'
     or (select md5(p.prosrc) from pg_proc p where p.oid = 'public.ai_calls_forget_user(jsonb)'::regprocedure) <> '458d9d4de2204c84723e4449e06638ef'
     or to_regprocedure('public.ai_calls_claim_held(jsonb)') is not null then
    raise exception 'AI_CALLS_OWNER_HELD_ROLLBACK_POST: not back to the 20261017120000 state' using errcode = 'P0001';
  end if;
end;
$$;

commit;
