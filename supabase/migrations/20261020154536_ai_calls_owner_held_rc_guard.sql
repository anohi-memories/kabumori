-- AI call store: a NON-CREATING owner-held check and a READ COMMITTED guard (common AI foundation, G6-13).
-- Source candidate: NOT applied anywhere. Depends on 20261010050613 (ledger), 20261017120000 (call store) and
-- 20261017150000 (maintenance); the last two are themselves unapplied candidates. Apply them in that order.
--
-- Why (Issue #321 G6-07..G6-12, H2 #329, H3 #330): the gateway's pre-send check re-called ai_calls_claim and took
-- "busy" as proof that the asking process still owns the call. It is not: after recovery closes the row,
-- forget_user deletes it and another process re-claims the same key, a stalled process passes that check and sends.
-- And the argument that an open ledger reservation keeps recovery away holds only when ai_calls_abandon (and
-- forget_user) run READ COMMITTED: abandon counts the ledger with a plain SELECT, and reserving never touches the
-- call row, so a REPEATABLE READ / SERIALIZABLE transaction whose snapshot predates the reservation closes the call.
--
-- What it changes (nothing else):
--   * public.ai_calls_abandon(jsonb), public.ai_calls_forget_user(jsonb): CREATE OR REPLACE with the original body
--     (20261017120000) and ONE addition as the first statement: any transaction isolation but READ COMMITTED is
--     refused with P0001 AI_CALLS_REQUIRES_READ_COMMITTED, before any lock, read or write (as
--     ai_calls_forget_system_brand already does). Signature, OID, owner, ACL and every other line stay as they are.
--     A function cannot change its caller's isolation (a SET clause for it is refused at CREATE, SET LOCAL fails
--     once the transaction ran a query): it can only refuse.
--   * public.ai_calls_claim_held(p jsonb) -> {held: true} | {held: false, reason}: the pre-send check. held only for
--     the ORIGINAL claim token (the owner returned by the first ai_calls_claim) and the full call identity (key,
--     tenant, fingerprint, application, feature, subject kind, user, brand slug) of an ACQUIRED row; otherwise
--     NOT_FOUND | IDENTITY_MISMATCH | NOT_ACQUIRED | OWNER_MISMATCH. It never inserts or updates (a missing row stays
--     missing), never returns the token, takes the claim's locks in the claim's order (the person's advisory lock
--     shared, the call key's, the row FOR SHARE) and refuses any isolation but READ COMMITTED like the two above.
--     VOLATILE, SECURITY DEFINER, empty search_path, owned like the other ai_calls RPCs, EXECUTE for service_role
--     only (the PUBLIC / anon / authenticated grants a default privilege may add are revoked).
--   * Not changed: ai_calls_claim (still creates; the gateway calls it ONCE, for the first claim), ai_calls_complete
--     (the claim owner's finalizer: original token + identity + acquired; it does not consult the ledger, so the
--     protocol is that only the claim owner calls it, at the end of its own flow), ai_calls_purge_content,
--     ai_calls_forget_system_brand (keeps its own READ COMMITTED guard), the ledger and its erasure (keep theirs).
--     No table, column, trigger or helper is added or changed; no alias without the guard is left.
--
-- Contract the caller must keep (not enforced here): reserve the ledger attempt BEFORE asking ai_calls_claim_held,
-- send only after {held: true} and the authority recheck, and treat an error, a timeout or a lost answer as "not
-- held" (send nothing). With the attempt reserved and the call store's mutators at READ COMMITTED, the row cannot be
-- abandoned or forgotten until that attempt is finalised or released (and a released hold cannot be marked sent).
--
-- G6-14 (H4 #331 P2): it also refuses any direct privilege on the ai_calls / ai_ledger schemas, relations, columns,
-- helpers or default privileges for anyone but their owner, any effective privilege of anon / authenticated /
-- service_role there, and any path from those roles to the owner or a superuser, before AND after (no repair).
--
-- Fail closed: the migration checks first that the objects it replaces are exactly the known bodies (the original
-- ones, or this migration's on a re-run), owned by the migrating role, with the expected grants, and afterwards that
-- OIDs, owners, bodies, shapes, exact ACLs and the EFFECTIVE privileges of anon / authenticated / service_role are as
-- intended. Any difference raises and the whole migration rolls back. Nothing is repaired.
--
-- Reverting it re-opens the R1 root and the isolation counterexample; the local rollback used by the tests
-- (supabase/tests/ai_calls_owner_held_rc_guard_rollback.sql) is for isolated test databases only.
-- See docs/ai-provider/G6_OWNER_HELD_RC_GUARD_SQL.md.

begin;

-- ---------------------------------------------------------------------------------------------------------
-- G6-14 (H4 #331 P2): the access boundary of the call store and of the ledger it consults is their RPCs. A direct
-- privilege on the ai_calls / ai_ledger schemas, relations, columns or helpers for anyone but their owner (PUBLIC,
-- anon, authenticated, service_role, a role they inherit, a default privilege), or an application role that can
-- reach the owner or a superuser, makes "only the RPCs reach the rows" untrue, and with it the owner-held and
-- READ COMMITTED reasoning. This TEMPORARY function (pg_temp: gone at the end of the session, never in ai_calls)
-- checks it before anything changes and again at the end. A violation raises and the whole migration rolls back.
-- Nothing is granted or revoked to "repair" it. It cannot exclude what the owner or a superuser itself does.
-- ---------------------------------------------------------------------------------------------------------
create function pg_temp.ai_calls_owner_held_acl_check(p_stage text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_schemas constant text[] := array['ai_calls', 'ai_ledger'];
  v_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_table_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_set_check constant text := case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end;
  v_ns record;
  v_rel record;
  v_role text;
  v_priv text;
  v_extra text;
begin
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := array_append(v_table_privs, 'MAINTAIN');
  end if;
  if (select count(*) from pg_namespace n where n.nspname = any(v_schemas)) <> 2 then
    raise exception 'AI_CALLS_OWNER_HELD_%: the ai_calls and ai_ledger schemas must exist', p_stage using errcode = 'P0001';
  end if;
  for v_ns in select n.oid, n.nspname, n.nspowner, n.nspacl from pg_namespace n where n.nspname = any(v_schemas) order by n.nspname loop
    -- One owner for the schema and everything in it, and not an application role.
    if (select r.rolname from pg_roles r where r.oid = v_ns.nspowner) = any(v_roles)
       or exists (select 1 from pg_class c where c.relnamespace = v_ns.oid and c.relowner <> v_ns.nspowner)
       or exists (select 1 from pg_proc f where f.pronamespace = v_ns.oid and f.proowner <> v_ns.nspowner) then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % has an application-role or mixed owner', p_stage, v_ns.nspname using errcode = 'P0001';
    end if;
    -- Direct ACLs: nothing for anyone but the owner (PUBLIC and grant options included).
    select string_agg(format('%s:%s%s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type, case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
      from aclexplode(coalesce(v_ns.nspacl, acldefault('n', v_ns.nspowner))) a left join pg_roles r on r.oid = a.grantee
     where a.grantee <> v_ns.nspowner;
    if v_extra is not null then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: schema % grants %', p_stage, v_ns.nspname, v_extra using errcode = 'P0001';
    end if;
    select string_agg(format('%s %s:%s%s', c.relname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type, case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
      from pg_class c cross join lateral aclexplode(c.relacl) a left join pg_roles r on r.oid = a.grantee
     where c.relnamespace = v_ns.oid and a.grantee <> c.relowner;
    if v_extra is not null then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: relation grants %', p_stage, v_extra using errcode = 'P0001';
    end if;
    if exists (select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid
                where c.relnamespace = v_ns.oid and att.attnum > 0 and att.attacl is not null) then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: a column grant in %', p_stage, v_ns.nspname using errcode = 'P0001';
    end if;
    select string_agg(format('%s %s:%s%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type, case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
      from pg_proc f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a left join pg_roles r on r.oid = a.grantee
     where f.pronamespace = v_ns.oid and a.grantee <> f.proowner;
    if v_extra is not null then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: helper grants %', p_stage, v_extra using errcode = 'P0001';
    end if;
    if exists (select 1 from pg_proc f where f.pronamespace = v_ns.oid and f.prosecdef) then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: a SECURITY DEFINER helper in %', p_stage, v_ns.nspname using errcode = 'P0001';
    end if;
    if exists (select 1 from pg_default_acl d where d.defaclnamespace = v_ns.oid) then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: a default privilege in %', p_stage, v_ns.nspname using errcode = 'P0001';
    end if;
  end loop;
  -- Effective privileges (inheritance and PUBLIC included) of each application role, and whom it can reach.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    for v_ns in select n.oid, n.nspname from pg_namespace n where n.nspname = any(v_schemas) loop
      if has_schema_privilege(v_role, v_ns.oid, 'USAGE') or has_schema_privilege(v_role, v_ns.oid, 'CREATE') then
        raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % can use schema %', p_stage, v_role, v_ns.nspname using errcode = 'P0001';
      end if;
      for v_rel in select c.oid, c.relname, c.relkind from pg_class c where c.relnamespace = v_ns.oid and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f') loop
        if v_rel.relkind = 'S' then
          if has_sequence_privilege(v_role, v_rel.oid, 'USAGE') or has_sequence_privilege(v_role, v_rel.oid, 'SELECT')
             or has_sequence_privilege(v_role, v_rel.oid, 'UPDATE') then
            raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % can use sequence %', p_stage, v_role, v_rel.relname using errcode = 'P0001';
          end if;
          continue;
        end if;
        foreach v_priv in array v_table_privs loop
          if has_table_privilege(v_role, v_rel.oid, v_priv) then
            raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % holds % on %.%', p_stage, v_role, v_priv, v_ns.nspname, v_rel.relname using errcode = 'P0001';
          end if;
        end loop;
        foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
          if has_any_column_privilege(v_role, v_rel.oid, v_priv) then
            raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % has column % on %.%', p_stage, v_role, v_priv, v_ns.nspname, v_rel.relname using errcode = 'P0001';
          end if;
        end loop;
      end loop;
      select string_agg(f.proname, ', ') into v_extra from pg_proc f
       where f.pronamespace = v_ns.oid and has_function_privilege(v_role, f.oid, 'EXECUTE');
      if v_extra is not null then
        raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % can execute % helper %', p_stage, v_role, v_ns.nspname, v_extra using errcode = 'P0001';
      end if;
    end loop;
    select string_agg(r.rolname, ', ') into v_extra from pg_roles r
     where r.rolname <> v_role
       and (pg_has_role(v_role, r.oid, 'USAGE') or pg_has_role(v_role, r.oid, v_set_check))
       and (r.rolsuper
            or r.oid in (select n.nspowner from pg_namespace n where n.nspname = any(v_schemas))
            or (v_role <> 'service_role' and r.rolname = 'service_role'));
    if v_extra is not null then
      raise exception 'AI_CALLS_OWNER_HELD_%: ACL drift: % reaches %', p_stage, v_role, v_extra using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Preconditions (catalog only; nothing is changed yet).
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_schema oid;
  v_owner oid;
  v_fn record;
  v_md5 text;
  v_extra text;
begin
  -- Catalog only (no privilege needed), the owner first: anyone else stops here.
  select n.oid, n.nspowner into v_schema, v_owner from pg_namespace n where n.nspname = 'ai_calls';
  if v_schema is null
     or not exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relname = 'consumer_calls' and c.relkind = 'r')
     or not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ai_ledger' and c.relname = 'reservations' and c.relkind = 'r') then
    raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: the call store (20261017120000) and the ledger (20261010050613) must exist' using errcode = 'P0001';
  end if;
  if (select r.oid from pg_roles r where r.rolname = current_user) is distinct from v_owner then
    raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: run as the ai_calls owner %, not %', v_owner::regrole, current_user using errcode = 'P0001';
  end if;
  -- Exactly the known bodies: the originals, or this migration's own (a re-run). Anything else is drift.
  for v_fn in
    select * from (values
      ('public.ai_calls_abandon(jsonb)', array['f6a0c47dbe82ae0e4f1e7d8b9d94e0f6', '479cbc34c20225d4ea202be18ec9a294']),
      ('public.ai_calls_forget_user(jsonb)', array['458d9d4de2204c84723e4449e06638ef', '3130d05268c8c7fd136b062bdfe051a1']),
      ('public.ai_calls_forget_system_brand(jsonb)', array['f158ba6eb921ecbefaf4dadb99f31537']),
      ('public.ai_calls_claim(jsonb)', array['b1912b49262300ac8a83ab0f67cae46a']),
      ('public.ai_calls_complete(jsonb)', array['9c43a8cd1bedc673e62c51cd85f801a1']),
      ('ai_calls.call_transition()', array['5e7b4300ce1e8e8ec2bc61dc3fc20715'])
    ) v(sig, md5s)
  loop
    if to_regprocedure(v_fn.sig) is null then
      raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: % is missing', v_fn.sig using errcode = 'P0001';
    end if;
    select md5(p.prosrc) into v_md5 from pg_proc p where p.oid = to_regprocedure(v_fn.sig);
    if not v_md5 = any(v_fn.md5s) then
      raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: % is not a known body (drift)', v_fn.sig using errcode = 'P0001';
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.proname = 'ai_calls_claim_held' and p.oid is distinct from to_regprocedure('public.ai_calls_claim_held(jsonb)')) then
    raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: another ai_calls_claim_held overload exists' using errcode = 'P0001';
  end if;
  if to_regprocedure('public.ai_calls_claim_held(jsonb)') is not null
     and (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.ai_calls_claim_held(jsonb)')) <> '052ff25919d4afd77f409c202fd326c0' then
    raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: public.ai_calls_claim_held(jsonb) exists with an unknown body' using errcode = 'P0001';
  end if;
  -- The grants the replaced RPCs keep must already be exactly the call store's: EXECUTE for service_role only.
  select string_agg(format('%s %s:%s%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type, case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
    from pg_proc f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where f.oid in (to_regprocedure('public.ai_calls_abandon(jsonb)'), to_regprocedure('public.ai_calls_forget_user(jsonb)'))
     and a.grantee <> f.proowner
     and not (r.rolname is not distinct from 'service_role' and a.privilege_type = 'EXECUTE' and not a.is_grantable);
  if v_extra is not null then
    raise exception 'AI_CALLS_OWNER_HELD_PRESTATE: unexpected grant %', v_extra using errcode = 'P0001';
  end if;
end;
$$;

-- Direct and effective privileges of the call store and the ledger (G6-14), before anything changes.
do $$
begin
  perform pg_temp.ai_calls_owner_held_acl_check('PRESTATE');
end;
$$;

-- What the postconditions compare with (dropped at commit).
create temp table ai_calls_owner_held_prestate on commit drop as
  select p.oid, format('%s.%s(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) as sig, md5(p.prosrc) as body_md5, p.proowner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.pronamespace = 'ai_calls'::regnamespace
      or p.oid in (to_regprocedure('public.ai_calls_claim(jsonb)'), to_regprocedure('public.ai_calls_complete(jsonb)'),
                   to_regprocedure('public.ai_calls_abandon(jsonb)'), to_regprocedure('public.ai_calls_purge_content(jsonb)'),
                   to_regprocedure('public.ai_calls_forget_user(jsonb)'), to_regprocedure('public.ai_calls_forget_system_brand(jsonb)'),
                   to_regprocedure('public.ai_calls_recovery_candidates(jsonb)'));

-- ---------------------------------------------------------------------------------------------------------
-- RPC: abandon (unchanged except the READ COMMITTED guard; see 20261017120000 for its contract)
-- ---------------------------------------------------------------------------------------------------------
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
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
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

-- ---------------------------------------------------------------------------------------------------------
-- RPC: forget_user (unchanged except the READ COMMITTED guard; see 20261017120000 for its contract)
-- ---------------------------------------------------------------------------------------------------------
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
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
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

-- ---------------------------------------------------------------------------------------------------------
-- RPC: claim_held (the gateway's pre-send check)
--   p: call_key, tenant_tag, fingerprint, application, feature, subject_kind, user_id?, brand_ref?, owner
--   -> {held: true} | {held: false, reason: NOT_FOUND | IDENTITY_MISMATCH | NOT_ACQUIRED | OWNER_MISMATCH}
-- Invalid input raises AI_CALLS_INVALID_INPUT (22023), any isolation but READ COMMITTED P0001; nothing is written.
-- ---------------------------------------------------------------------------------------------------------
create or replace function public.ai_calls_claim_held(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
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
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  if (v_subject = 'system' and v_user is not null) or (v_subject = 'user' and v_user is null) then
    raise exception 'AI_CALLS_INVALID_INPUT: subject' using errcode = '22023';
  end if;
  -- The same locks, in the same order, as ai_calls_claim: the person's lock shared (forget_user takes it exclusive),
  -- then the call key's (ai_calls_claim and ai_calls_abandon take it), then the row FOR SHARE (ai_calls_complete
  -- takes it FOR UPDATE). Nothing is inserted or updated: a missing row stays missing.
  if v_subject = 'user' then
    perform pg_advisory_xact_lock_shared(hashtextextended('ai_calls:user:' || v_user::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:call:' || v_key, 0));
  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for share;
  if not found then
    return jsonb_build_object('held', false, 'reason', 'NOT_FOUND');
  end if;
  if (v_row.tenant_tag, v_row.fingerprint, v_row.application, v_row.feature, v_row.subject_kind, v_row.user_id, v_row.brand_ref)
     is distinct from (v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user, v_brand) then
    return jsonb_build_object('held', false, 'reason', 'IDENTITY_MISMATCH');
  end if;
  if v_row.state <> 'acquired' then
    return jsonb_build_object('held', false, 'reason', 'NOT_ACQUIRED');
  end if;
  if v_row.claim_token is distinct from v_owner then
    return jsonb_build_object('held', false, 'reason', 'OWNER_MISMATCH');
  end if;
  return jsonb_build_object('held', true);
end;
$$;

revoke all on function public.ai_calls_claim_held(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ai_calls_claim_held(jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Postconditions. Raises, rolling the whole migration back, unless everything is exactly as intended.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_schema constant regnamespace := 'ai_calls'::regnamespace;
  v_owner oid;
  v_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_rpcs constant regprocedure[] := array[
    'public.ai_calls_abandon(jsonb)'::regprocedure, 'public.ai_calls_forget_user(jsonb)'::regprocedure,
    'public.ai_calls_claim_held(jsonb)'::regprocedure];
  v_rpc regprocedure;
  v_role text;
  v_extra text;
  v_set_check text;
begin
  select n.nspowner into v_owner from pg_namespace n where n.oid = v_schema;
  -- 1. Same objects: every function recorded before is still there with the same OID and owner; the two
  --    replaced bodies are this migration's, every other body is unchanged; no new helper in ai_calls.
  select string_agg(s.sig, ', ') into v_extra from ai_calls_owner_held_prestate s
   where to_regprocedure(s.sig) is distinct from s.oid
      or (select p.proowner from pg_proc p where p.oid = s.oid) is distinct from s.proowner;
  if v_extra is not null then
    raise exception 'AI_CALLS_OWNER_HELD_POST: OID or owner changed: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(s.sig, ', ') into v_extra from ai_calls_owner_held_prestate s join pg_proc p on p.oid = s.oid
   where md5(p.prosrc) is distinct from case s.sig
           when 'public.ai_calls_abandon(jsonb)' then '479cbc34c20225d4ea202be18ec9a294'
           when 'public.ai_calls_forget_user(jsonb)' then '3130d05268c8c7fd136b062bdfe051a1'
           else s.body_md5 end;
  if v_extra is not null then
    raise exception 'AI_CALLS_OWNER_HELD_POST: unexpected body: %', v_extra using errcode = 'P0001';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = 'public.ai_calls_claim_held(jsonb)'::regprocedure) <> '052ff25919d4afd77f409c202fd326c0'
     or (select count(*) from pg_proc p where p.proname = 'ai_calls_claim_held') <> 1
     or exists (select 1 from pg_proc p where p.pronamespace = v_schema and p.oid not in (select s.oid from ai_calls_owner_held_prestate s))
     or exists (select 1 from pg_proc p where p.proname like 'ai_calls\_%' and p.proname like '%unguarded%') then
    raise exception 'AI_CALLS_OWNER_HELD_POST: unexpected function set' using errcode = 'P0001';
  end if;
  -- 2. Shape: owned like the call store, SECURITY DEFINER, empty search_path; claim_held VOLATILE.
  foreach v_rpc in array v_rpcs loop
    if not coalesce((select f.proowner = v_owner and f.prosecdef and f.proconfig = array['search_path=""'] from pg_proc f where f.oid = v_rpc), false) then
      raise exception 'AI_CALLS_OWNER_HELD_POST: % must be owned by % and SECURITY DEFINER with an empty search_path', v_rpc, v_owner::regrole using errcode = 'P0001';
    end if;
  end loop;
  if (select f.provolatile from pg_proc f where f.oid = 'public.ai_calls_claim_held(jsonb)'::regprocedure) <> 'v' then
    raise exception 'AI_CALLS_OWNER_HELD_POST: claim_held must be VOLATILE' using errcode = 'P0001';
  end if;
  -- 3. Exact direct ACL: EXECUTE for service_role without grant option, nothing for anyone else (PUBLIC included).
  select string_agg(format('%s %s:%s%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type, case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
    from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid
    cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where a.grantee <> f.proowner
     and not (r.rolname is not distinct from 'service_role' and a.privilege_type = 'EXECUTE' and not a.is_grantable);
  if v_extra is not null then
    raise exception 'AI_CALLS_OWNER_HELD_POST: unexpected grant %', v_extra using errcode = 'P0001';
  end if;
  -- 4. Effective privileges (inheritance, PUBLIC, grant option) of each application role.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    foreach v_rpc in array v_rpcs loop
      if has_function_privilege(v_role, v_rpc, 'EXECUTE') is distinct from (v_role = 'service_role')
         or has_function_privilege(v_role, v_rpc, 'EXECUTE WITH GRANT OPTION') then
        raise exception 'AI_CALLS_OWNER_HELD_POST: EXECUTE of % for % is wrong', v_rpc, v_role using errcode = 'P0001';
      end if;
    end loop;
  end loop;
  -- 5. anon / authenticated reach neither service_role, the owner nor a superuser (inheritance or SET ROLE).
  v_set_check := case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end;
  foreach v_role in array array['anon', 'authenticated'] loop
    continue when to_regrole(v_role) is null;
    select string_agg(r.rolname, ', ') into v_extra from pg_roles r
     where r.rolname <> v_role and (pg_has_role(v_role, r.oid, 'USAGE') or pg_has_role(v_role, r.oid, v_set_check))
       and (r.rolname = 'service_role' or r.oid = v_owner or r.rolsuper);
    if v_extra is not null then
      raise exception 'AI_CALLS_OWNER_HELD_POST: % reaches %', v_role, v_extra using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

-- The same privileges again, after everything changed (G6-14); then the temporary check goes away.
do $$
begin
  perform pg_temp.ai_calls_owner_held_acl_check('POST');
end;
$$;
drop function pg_temp.ai_calls_owner_held_acl_check(text);

commit;
