-- AI ledger user erasure + call-store deletion helpers (common AI foundation, F6). Source candidate: NOT applied.
--
-- Account deletion must leave no user identifier in the AI ledger (20261010050613) or the call store
-- (20261017120000). The ledger is append-only and its reservation identity is immutable, so this migration adds the
-- ONE narrow exception the erasure needs and nothing else:
--   * public.ai_ledger_erase_user(p {user_id}) replaces every ledger reference to the user (reservations, usage
--     events, per-user budget buckets, user-scoped policies) by ONE fresh "erased subject" id. The user's own
--     policies are also disabled, renamed erased.<policy id> and lose their note (free text that may name the user
--     or a contact). Amounts, counts, statuses, timestamps and every other column stay exactly as they were, so
--     monthly totals and per-call audit are unchanged. The erased-subject id is random (not derived from the user id), is never
--     stored next to the user id, never returned, and has a reserved shape (00000000-0000-0000-....-............) that
--     no real (version 4) user id can take, so it cannot collide with a user and is recognisable as erased.
--     Refused while the user still has call-store rows (forget them first), an in-flight (reserved / sent) attempt
--     (recover it first), or a policy NOT scoped to the user whose key or note names the user id (an operator must
--     fix it; erasure never rewrites other policies). Idempotent: a second call finds nothing. READ COMMITTED only:
--     a REPEATABLE READ / SERIALIZABLE snapshot could miss a row committed before the locks were taken.
--   * the two ledger triggers that forbid the change (ai_ledger.reservation_transition, the usage_events append-only
--     trigger) admit exactly that change: only user_id, from that user to that erased id, only inside the erasure
--     function's transaction (transaction-local setting ai_ledger.erasure = '<user>><erased id>'). Every other update
--     or delete is refused with the same errors as before.
--   * public.ai_ledger_user_footprint(p {user_id, brand_ref?}): counts of rows still referencing the user (ledger +
--     call store), including policies whose key or note names the user id, for the deletion read-back. Counts only.
--   * public.ai_calls_forget_system_brand(p {brand_ref}): removes SYSTEM-subject call-store rows tagged with a
--     POSTONA user workspace slug (u_ + 24 hex), which forget_user (by user_id) cannot reach.
--   * public.ai_calls_recovery_candidates(p): old in-flight claims with their ledger summary (no user id, no brand),
--     so a recovery job can rebuild the abandon audit from the bridge registration and the ledger.
-- All four RPCs: SECURITY DEFINER, search_path '', EXECUTE for service_role only. Access is verified at the end,
-- as in the two migrations this one builds on; anything unexpected rolls the whole migration back.
--
-- What erasure does NOT remove (see docs/ai-provider/F6_POSTONA_LEDGER_USER_ERASURE_CANDIDATE.md): the rows of one
-- erased user stay linked to each other (same erased id, same budget buckets), request_id stays (a one-way hash that
-- includes the user id and the client operationId), provider_request_id stays (billing reconciliation). Whether this
-- pseudonymised residue may be kept, and for how long, is a retention / legal decision that is NOT made here.

begin;

-- Preconditions: the ledger and the call store exist and belong to the migrating role (the two ledger trigger
-- functions are replaced, which only their owner may do). Catalog lookups only.
do $$
declare
  v_ledger_owner oid;
  v_calls_owner oid;
begin
  select n.nspowner into v_ledger_owner from pg_catalog.pg_namespace n where n.nspname = 'ai_ledger';
  select n.nspowner into v_calls_owner from pg_catalog.pg_namespace n where n.nspname = 'ai_calls';
  if v_ledger_owner is null or v_calls_owner is null
     or not exists (select 1 from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid = f.pronamespace
                     where n.nspname = 'ai_ledger' and f.proname = 'reservation_transition')
     or not exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                     where n.nspname = 'ai_calls' and c.relname = 'consumer_calls') then
    raise exception 'AI_LEDGER_ERASURE_REQUIRES_LEDGER_AND_CALL_STORE: apply 20261010050613 and 20261017120000 first'
      using errcode = 'P0001';
  end if;
  if v_ledger_owner <> (select oid from pg_catalog.pg_roles where rolname = current_user)
     or v_calls_owner <> (select oid from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'AI_LEDGER_ERASURE_NOT_OWNER: % does not own ai_ledger and ai_calls', current_user using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Helpers (owner-only, not SECURITY DEFINER)
-- ---------------------------------------------------------------------------------------------------------
-- The reserved shape of an erased subject: version 0 with zero high bits. Real auth user ids are version 4.
create function ai_ledger.is_erased_subject(p uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null and p::text like '00000000-0000-0000-%'
$$;

-- A fresh erased-subject id: 62 random bits from gen_random_uuid(), not derived from anything; unused in the ledger.
create function ai_ledger.new_erased_subject()
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v uuid;
begin
  loop
    v := ('00000000-0000-0000-' || substr(gen_random_uuid()::text, 20))::uuid;
    exit when not exists (select 1 from ai_ledger.reservations r where r.user_id = v)
          and not exists (select 1 from ai_ledger.usage_events e where e.user_id = v)
          and not exists (select 1 from ai_ledger.budget_buckets b where b.user_id = v)
          and not exists (select 1 from ai_ledger.budget_policies pol where pol.scope_user_id = v);
  end loop;
  return v;
end;
$$;

-- True only inside ai_ledger_erase_user, for exactly the change it makes: p_old (a real user) -> p_new (that
-- erasure's erased subject), as announced in the transaction-local setting ai_ledger.erasure.
create function ai_ledger.erasure_allows(p_old uuid, p_new uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := current_setting('ai_ledger.erasure', true);
begin
  return v is not null and v <> '' and p_old is not null and p_new is not null
     and not ai_ledger.is_erased_subject(p_old) and ai_ledger.is_erased_subject(p_new)
     and v = p_old::text || '>' || p_new::text;
end;
$$;

-- True when free text names the user: the user id with or without dashes, in any letter case.
create function ai_ledger.mentions_user(p_text text, p_user uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text is not null and p_user is not null
     and position(replace(p_user::text, '-', '') in lower(replace(p_text, '-', ''))) > 0
$$;

-- ---------------------------------------------------------------------------------------------------------
-- The narrow immutability exception
-- ---------------------------------------------------------------------------------------------------------
-- Reservation identity is immutable and status only moves forward -- except the erasure of user_id alone.
create or replace function ai_ledger.reservation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.request_id, new.attempt, new.provider, new.model, new.application, new.feature, new.logical_role,
      new.subject_kind, new.user_id, new.brand_id, new.billing_month, new.usage_day, new.reserved_usd, new.bucket_ids,
      new.created_at, new.expires_at)
     is distinct from
     (old.id, old.request_id, old.attempt, old.provider, old.model, old.application, old.feature, old.logical_role,
      old.subject_kind, old.user_id, old.brand_id, old.billing_month, old.usage_day, old.reserved_usd, old.bucket_ids,
      old.created_at, old.expires_at) then
    -- Erasure: user_id from the announced user to its erased subject, every other column (status, timestamps)
    -- untouched. The generated attempt_id is derived from compared columns and left out of the comparison.
    if ai_ledger.erasure_allows(old.user_id, new.user_id)
       and (to_jsonb(new) - 'user_id' - 'attempt_id') = (to_jsonb(old) - 'user_id' - 'attempt_id') then
      return new;
    end if;
    raise exception 'AI_LEDGER_RESERVATION_IMMUTABLE' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'reserved' and new.status in ('sent', 'released', 'settled', 'unknown'))
    or (old.status = 'sent' and new.status in ('settled', 'unknown'))
    or (old.status = 'released' and new.status in ('settled', 'unknown'))
  ) then
    raise exception 'AI_LEDGER_RESERVATION_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Usage events stay append-only, except the erasure of user_id alone (deletes are always refused).
create function ai_ledger.usage_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and ai_ledger.erasure_allows(old.user_id, new.user_id)
     and (to_jsonb(new) - 'user_id') = (to_jsonb(old) - 'user_id') then
    return new;
  end if;
  raise exception 'AI_LEDGER_APPEND_ONLY: % on %', tg_op, tg_table_name using errcode = 'P0001';
end;
$$;

create or replace trigger usage_events_append_only before update or delete on ai_ledger.usage_events
  for each row execute function ai_ledger.usage_events_guard();

-- ---------------------------------------------------------------------------------------------------------
-- RPC: erase_user  p: {user_id}
--   -> {erased: true, reservations, usage_events, budget_buckets, budget_policies}
--    | {erased: false, reason: CALL_STORE_NOT_FORGOTTEN | LEDGER_IN_FLIGHT | POLICY_TEXT_MENTIONS_USER
--                              | POLICY_KEY_CONFLICT, ...}
-- Excludes concurrent call-store claims of the user (the call store's per-user lock) and every new ledger
-- reservation (the ledger's reservation lock) for its duration. The erased-subject id is not returned.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_erase_user(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := ai_ledger.input_uuid(p, 'user_id');
  v_erased uuid;
  v_calls bigint;
  v_in_flight bigint;
  v_mentions bigint;
  v_reservations integer;
  v_events integer;
  v_buckets integer;
  v_policies integer;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_LEDGER_ERASURE_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  if v_user is null then
    raise exception 'AI_LEDGER_INVALID_INPUT: user_id is required' using errcode = '22023';
  end if;
  if ai_ledger.is_erased_subject(v_user) then
    raise exception 'AI_LEDGER_INVALID_INPUT: user_id is an erased subject' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ai_calls:user:' || v_user::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('ai_ledger:reserve', 0));

  select count(*) into v_calls from ai_calls.consumer_calls c where c.user_id = v_user;
  if v_calls > 0 then
    return jsonb_build_object('erased', false, 'reason', 'CALL_STORE_NOT_FORGOTTEN', 'call_rows', v_calls);
  end if;
  select count(*) into v_in_flight from ai_ledger.reservations r
   where r.user_id = v_user and r.status in ('reserved', 'sent');
  if v_in_flight > 0 then
    return jsonb_build_object('erased', false, 'reason', 'LEDGER_IN_FLIGHT', 'in_flight', v_in_flight);
  end if;
  -- A policy NOT scoped to the user whose key or note names the user is not erasure's to rewrite: refuse, so the
  -- identifier can never be left behind silently (an operator corrects it, then the erasure is repeated).
  select count(*) into v_mentions from ai_ledger.budget_policies pol
   where pol.scope_user_id is distinct from v_user
     and (ai_ledger.mentions_user(pol.policy_key, v_user) or ai_ledger.mentions_user(pol.note, v_user));
  if v_mentions > 0 then
    return jsonb_build_object('erased', false, 'reason', 'POLICY_TEXT_MENTIONS_USER', 'policies', v_mentions);
  end if;
  -- The user's own policies are renamed erased.<policy id>: refuse rather than guess if another policy holds that key.
  if exists (select 1 from ai_ledger.budget_policies pol
               join ai_ledger.budget_policies other on other.policy_key = 'erased.' || pol.id::text and other.id <> pol.id
              where pol.scope_user_id = v_user) then
    return jsonb_build_object('erased', false, 'reason', 'POLICY_KEY_CONFLICT');
  end if;

  v_erased := ai_ledger.new_erased_subject();
  perform set_config('ai_ledger.erasure', v_user::text || '>' || v_erased::text, true);
  update ai_ledger.reservations r set user_id = v_erased where r.user_id = v_user;
  get diagnostics v_reservations = row_count;
  update ai_ledger.usage_events e set user_id = v_erased where e.user_id = v_user;
  get diagnostics v_events = row_count;
  -- Counters keep their values and updated_at (a fresh timestamp would date the erasure).
  update ai_ledger.budget_buckets b set user_id = v_erased where b.user_id = v_user;
  get diagnostics v_buckets = row_count;
  -- The user's own policies: subject replaced, disabled, key and note (free text) no longer naming anyone.
  -- created_at / updated_at stay as they were.
  update ai_ledger.budget_policies pol
     set scope_user_id = v_erased, enabled = false, policy_key = 'erased.' || pol.id::text, note = null
   where pol.scope_user_id = v_user;
  get diagnostics v_policies = row_count;
  perform set_config('ai_ledger.erasure', '', true);

  if exists (select 1 from ai_ledger.reservations r where r.user_id = v_user)
     or exists (select 1 from ai_ledger.usage_events e where e.user_id = v_user)
     or exists (select 1 from ai_ledger.budget_buckets b where b.user_id = v_user)
     or exists (select 1 from ai_ledger.budget_policies pol where pol.scope_user_id = v_user)
     or exists (select 1 from ai_ledger.budget_policies pol
                 where ai_ledger.mentions_user(pol.policy_key, v_user) or ai_ledger.mentions_user(pol.note, v_user))
     or exists (select 1 from ai_calls.consumer_calls c where c.user_id = v_user) then
    -- A reservation or claim of the user that slipped past the two locks: refuse the whole erasure.
    raise exception 'AI_LEDGER_ERASURE_INCOMPLETE' using errcode = 'P0001';
  end if;
  return jsonb_build_object('erased', true, 'reservations', v_reservations, 'usage_events', v_events,
                            'budget_buckets', v_buckets, 'budget_policies', v_policies);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: user_footprint  p: {user_id, brand_ref?}
--   -> {reservations, usage_events, budget_buckets, budget_policies, policy_mentions, call_rows, brand_call_rows?}
--      (counts only; policy_mentions = policies whose key or note names the user id, whoever they are scoped to)
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_ledger_user_footprint(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := ai_ledger.input_uuid(p, 'user_id');
  v_brand text;
  v jsonb;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_LEDGER_ERASURE_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  if v_user is null then
    raise exception 'AI_LEDGER_INVALID_INPUT: user_id is required' using errcode = '22023';
  end if;
  if p ? 'brand_ref' and jsonb_typeof(p -> 'brand_ref') <> 'null' then
    if jsonb_typeof(p -> 'brand_ref') <> 'string' or (p ->> 'brand_ref') !~ '^[a-z][a-z0-9_]{1,40}$' then
      raise exception 'AI_LEDGER_INVALID_INPUT: brand_ref' using errcode = '22023';
    end if;
    v_brand := p ->> 'brand_ref';
  end if;
  v := jsonb_build_object(
    'reservations', (select count(*) from ai_ledger.reservations r where r.user_id = v_user),
    'usage_events', (select count(*) from ai_ledger.usage_events e where e.user_id = v_user),
    'budget_buckets', (select count(*) from ai_ledger.budget_buckets b where b.user_id = v_user),
    'budget_policies', (select count(*) from ai_ledger.budget_policies pol where pol.scope_user_id = v_user),
    'policy_mentions', (select count(*) from ai_ledger.budget_policies pol
                         where ai_ledger.mentions_user(pol.policy_key, v_user) or ai_ledger.mentions_user(pol.note, v_user)),
    'call_rows', (select count(*) from ai_calls.consumer_calls c where c.user_id = v_user));
  if v_brand is not null then
    v := v || jsonb_build_object('brand_call_rows', (select count(*) from ai_calls.consumer_calls c where c.brand_ref = v_brand));
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: ai_calls_forget_system_brand  p: {brand_ref (u_ + 24 hex)}
--   -> {forgotten: true, deleted} | {forgotten: false, reason: 'CALLS_IN_FLIGHT', in_flight, deleted?}
-- A system-subject call tagged with a user's workspace slug is not reached by forget_user (no user_id). Only POSTONA
-- user workspace slugs are accepted, so an operator brand (whose replay protection the AI Lab needs) never is.
-- An acquired (in-flight) row is never deleted, even one whose claim commits between the check and the delete
-- (system claims do not take this function's lock); it is reported, and the caller repeats later.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_forget_system_brand(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand text := ai_calls.input_text(p, 'brand_ref', true, '^u_[0-9a-f]{24}$');
  v_in_flight bigint;
  v_deleted integer;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:system_brand:' || v_brand, 0));
  select count(*) into v_in_flight from ai_calls.consumer_calls c
   where c.subject_kind = 'system' and c.brand_ref = v_brand and c.state = 'acquired';
  if v_in_flight > 0 then
    return jsonb_build_object('forgotten', false, 'reason', 'CALLS_IN_FLIGHT', 'in_flight', v_in_flight);
  end if;
  delete from ai_calls.consumer_calls c
   where c.subject_kind = 'system' and c.brand_ref = v_brand and c.state <> 'acquired';
  get diagnostics v_deleted = row_count;
  select count(*) into v_in_flight from ai_calls.consumer_calls c
   where c.subject_kind = 'system' and c.brand_ref = v_brand and c.state = 'acquired';
  if v_in_flight > 0 then
    return jsonb_build_object('forgotten', false, 'reason', 'CALLS_IN_FLIGHT', 'in_flight', v_in_flight, 'deleted', v_deleted);
  end if;
  return jsonb_build_object('forgotten', true, 'deleted', v_deleted);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: ai_calls_recovery_candidates  p: {older_than_seconds? (300..2592000, default 1800), limit? (1..1000, default 100)}
--   -> [{call_key, tenant_tag, application, feature, subject_kind, created_at, open_attempts, sent_attempts,
--        estimated_cost_usd, includes_upper_bound, models, logical_roles}]
-- Old acquired claims and what the ledger knows of them: what a recovery job needs to decide (open attempts ->
-- run ai_ledger_recover_stale first) and to build the abandon audit with the bridge registration. No user id, brand
-- or result is returned.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_recovery_candidates(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_age bigint := coalesce(ai_calls.input_int(coalesce(p, '{}'::jsonb), 'older_than_seconds', false, 300, 2592000), 1800);
  v_limit bigint := coalesce(ai_calls.input_int(coalesce(p, '{}'::jsonb), 'limit', false, 1, 1000), 100);
  v jsonb;
begin
  select coalesce(jsonb_agg(row_to_json(s)::jsonb order by s.created_at, s.call_key), '[]'::jsonb) into v
    from (
      select c.call_key, c.tenant_tag, c.application, c.feature, c.subject_kind, c.created_at,
             (select count(*) from ai_ledger.reservations r where r.request_id = c.call_key and r.status in ('reserved', 'sent')) as open_attempts,
             (select count(*) from ai_ledger.reservations r where r.request_id = c.call_key and r.status in ('settled', 'unknown')) as sent_attempts,
             (select coalesce(sum(e.estimated_cost_usd), 0) from ai_ledger.usage_events e where e.request_id = c.call_key) as estimated_cost_usd,
             (select coalesce(bool_or(e.cost_basis = 'upper_bound'), false) from ai_ledger.usage_events e where e.request_id = c.call_key) as includes_upper_bound,
             (select coalesce(jsonb_agg(distinct r.model), '[]'::jsonb) from ai_ledger.reservations r where r.request_id = c.call_key) as models,
             (select coalesce(jsonb_agg(distinct r.logical_role), '[]'::jsonb) from ai_ledger.reservations r where r.request_id = c.call_key) as logical_roles
        from ai_calls.consumer_calls c
       where c.state = 'acquired' and c.created_at <= now() - make_interval(secs => v_age)
       order by c.created_at, c.call_key
       limit v_limit
    ) s;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Grants: the new helpers are owner-only; EXECUTE on the four RPCs for service_role only.
-- ---------------------------------------------------------------------------------------------------------
revoke all on function
  ai_ledger.is_erased_subject(uuid), ai_ledger.new_erased_subject(), ai_ledger.erasure_allows(uuid, uuid),
  ai_ledger.mentions_user(text, uuid),
  ai_ledger.usage_events_guard(), ai_ledger.reservation_transition()
  from public, anon, authenticated, service_role;
revoke all on function
  public.ai_ledger_erase_user(jsonb), public.ai_ledger_user_footprint(jsonb),
  public.ai_calls_forget_system_brand(jsonb), public.ai_calls_recovery_candidates(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.ai_ledger_erase_user(jsonb), public.ai_ledger_user_footprint(jsonb),
  public.ai_calls_forget_system_brand(jsonb), public.ai_calls_recovery_candidates(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Access verification over BOTH schemas (the same rules as 20261010050613 / 20261017120000) and the four new RPCs.
-- Raises, rolling the whole migration back, unless everything is reachable by exactly the intended roles.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_schemas constant regnamespace[] := array['ai_ledger'::regnamespace, 'ai_calls'::regnamespace];
  v_schema regnamespace;
  v_owner oid;
  v_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_table_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_rpcs constant regprocedure[] := array[
    'public.ai_ledger_erase_user(jsonb)'::regprocedure, 'public.ai_ledger_user_footprint(jsonb)'::regprocedure,
    'public.ai_calls_forget_system_brand(jsonb)'::regprocedure, 'public.ai_calls_recovery_candidates(jsonb)'::regprocedure];
  v_role text;
  v_priv text;
  v_rel record;
  v_rpc regprocedure;
  v_extra text;
  v_set_check text;
  v_reach record;
begin
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := array_append(v_table_privs, 'MAINTAIN');
  end if;
  v_set_check := case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end;
  select n.nspowner into v_owner from pg_namespace n where n.oid = 'ai_ledger'::regnamespace;

  -- 1. One owner for both schemas, everything in them and the new RPCs; not an application role.
  if pg_get_userbyid(v_owner) in ('anon', 'authenticated', 'service_role')
     or exists (select 1 from pg_namespace n where n.oid = any (v_schemas) and n.nspowner <> v_owner)
     or exists (select 1 from pg_class c where c.relnamespace = any (v_schemas) and c.relowner <> v_owner)
     or exists (select 1 from pg_proc f where f.pronamespace = any (v_schemas) and f.proowner <> v_owner)
     or exists (select 1 from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid where f.proowner <> v_owner) then
    raise exception 'AI_LEDGER_ERASURE_ACL_UNSAFE_OWNER' using errcode = 'P0001';
  end if;

  -- 2. No application role is a member of the owner or of a superuser.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    if pg_has_role(v_role, v_owner, 'MEMBER')
       or exists (select 1 from pg_roles super where super.rolsuper and pg_has_role(v_role, super.oid, 'MEMBER')) then
      raise exception 'AI_LEDGER_ERASURE_ACL_UNSAFE_MEMBERSHIP: %', v_role using errcode = 'P0001';
    end if;
  end loop;

  foreach v_schema in array v_schemas loop
    -- 3. Exact direct ACLs: nothing for anyone but the owner on the schema, its relations, columns and functions.
    select string_agg(format('%s %s:%s', v_schema, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
      from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      left join pg_roles r on r.oid = a.grantee
     where n.oid = v_schema and a.grantee <> n.nspowner;
    if v_extra is not null then
      raise exception 'AI_LEDGER_ERASURE_ACL_UNEXPECTED_SCHEMA_GRANT: %', v_extra using errcode = 'P0001';
    end if;
    select string_agg(format('%s %s:%s', c.relname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
      from pg_class c cross join lateral aclexplode(c.relacl) a
      left join pg_roles r on r.oid = a.grantee
     where c.relnamespace = v_schema and a.grantee <> c.relowner;
    if v_extra is not null then
      raise exception 'AI_LEDGER_ERASURE_ACL_UNEXPECTED_RELATION_GRANT: %', v_extra using errcode = 'P0001';
    end if;
    if exists (select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid
                where c.relnamespace = v_schema and att.attnum > 0 and att.attacl is not null) then
      raise exception 'AI_LEDGER_ERASURE_ACL_UNEXPECTED_COLUMN_GRANT: %', v_schema using errcode = 'P0001';
    end if;
    select string_agg(format('%s %s:%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
      from pg_proc f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
      left join pg_roles r on r.oid = a.grantee
     where f.pronamespace = v_schema and a.grantee <> f.proowner;
    if v_extra is not null then
      raise exception 'AI_LEDGER_ERASURE_ACL_UNEXPECTED_HELPER_GRANT: %', v_extra using errcode = 'P0001';
    end if;
    -- 4. Helpers and trigger functions are never SECURITY DEFINER; RLS is on everywhere, with no policy.
    if exists (select 1 from pg_proc f where f.pronamespace = v_schema and f.prosecdef) then
      raise exception 'AI_LEDGER_ERASURE_HELPER_SHAPE: % has a SECURITY DEFINER helper', v_schema using errcode = 'P0001';
    end if;
    if exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relkind = 'r' and not c.relrowsecurity)
       or exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relnamespace = v_schema) then
      raise exception 'AI_LEDGER_ERASURE_RLS: % must have RLS on and no policy', v_schema using errcode = 'P0001';
    end if;
  end loop;

  -- 3b / 4b. Each new RPC: EXECUTE for service_role (no grant option) only; SECURITY DEFINER, empty search_path.
  select string_agg(format('%s %s:%s%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type,
                           case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
    from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid
    cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where a.grantee <> f.proowner
     and not (r.rolname is not distinct from 'service_role' and a.privilege_type = 'EXECUTE' and not a.is_grantable);
  if v_extra is not null then
    raise exception 'AI_LEDGER_ERASURE_ACL_UNEXPECTED_RPC_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  foreach v_rpc in array v_rpcs loop
    if not coalesce((select f.prosecdef and f.proconfig = array['search_path=""'] from pg_proc f where f.oid = v_rpc), false) then
      raise exception 'AI_LEDGER_ERASURE_RPC_SHAPE: %', v_rpc using errcode = 'P0001';
    end if;
  end loop;

  -- 5. Effective privileges of each application role, and of every role it can reach by inheritance or SET ROLE.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    for v_reach in
      select r.oid, r.rolname, r.rolsuper, r.rolname = v_role as self
        from pg_roles r
       where r.rolname = v_role or pg_has_role(v_role, r.oid, 'USAGE') or pg_has_role(v_role, r.oid, v_set_check)
    loop
      if not v_reach.self and (v_reach.rolsuper or v_reach.oid = v_owner
                               or (v_role in ('anon', 'authenticated') and v_reach.rolname = 'service_role')) then
        raise exception 'AI_LEDGER_ERASURE_ACL_UNSAFE_ROLE_PATH: % reaches %', v_role, v_reach.rolname using errcode = 'P0001';
      end if;
      foreach v_schema in array v_schemas loop
        if has_schema_privilege(v_reach.oid, v_schema, 'USAGE') or has_schema_privilege(v_reach.oid, v_schema, 'CREATE') then
          raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: % (via %) can use %', v_role, v_reach.rolname, v_schema using errcode = 'P0001';
        end if;
        if exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relkind = 'S'
                    and (has_sequence_privilege(v_reach.oid, c.oid, 'USAGE') or has_sequence_privilege(v_reach.oid, c.oid, 'SELECT')
                         or has_sequence_privilege(v_reach.oid, c.oid, 'UPDATE'))) then
          raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: % (via %) can use a % sequence', v_role, v_reach.rolname, v_schema
            using errcode = 'P0001';
        end if;
        for v_rel in select c.oid, c.relname from pg_class c where c.relnamespace = v_schema and c.relkind in ('r', 'v', 'm') loop
          foreach v_priv in array v_table_privs loop
            if has_table_privilege(v_reach.oid, v_rel.oid, v_priv) then
              raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: % (via %) holds % on %', v_role, v_reach.rolname, v_priv, v_rel.relname
                using errcode = 'P0001';
            end if;
          end loop;
          if has_any_column_privilege(v_reach.oid, v_rel.oid, 'SELECT') or has_any_column_privilege(v_reach.oid, v_rel.oid, 'UPDATE') then
            raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: % (via %) has column access on %', v_role, v_reach.rolname, v_rel.relname
              using errcode = 'P0001';
          end if;
        end loop;
        if exists (select 1 from pg_proc f where f.pronamespace = v_schema and has_function_privilege(v_reach.oid, f.oid, 'EXECUTE')) then
          raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: % (via %) can execute a % helper', v_role, v_reach.rolname, v_schema
            using errcode = 'P0001';
        end if;
      end loop;
      foreach v_rpc in array v_rpcs loop
        if has_function_privilege(v_reach.oid, v_rpc, 'EXECUTE') is distinct from (v_reach.rolname = 'service_role') then
          raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: EXECUTE of % for % (via %) is wrong', v_rpc, v_role, v_reach.rolname
            using errcode = 'P0001';
        end if;
        if has_function_privilege(v_reach.oid, v_rpc, 'EXECUTE WITH GRANT OPTION') then
          raise exception 'AI_LEDGER_ERASURE_ACL_EFFECTIVE_PRIVILEGE: % (via %) may grant %', v_role, v_reach.rolname, v_rpc using errcode = 'P0001';
        end if;
      end loop;
    end loop;
  end loop;
end;
$$;

commit;
