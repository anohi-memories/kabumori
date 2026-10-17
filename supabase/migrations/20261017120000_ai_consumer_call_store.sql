-- AI consumer call store (common AI foundation, F6). Source candidate: NOT applied anywhere.
--
-- The durable, multi-worker ConsumerCallStore that the H5 consumer bridge requires
-- (supabase/functions/_shared/ai_consumer_bridge/types.ts): one row per bridge call (callId), claimed once,
-- completed once by its claim owner, replayed afterwards, never taken over because time passed.
--
-- What it adds (nothing existing is changed):
--   * schema ai_calls (not exposed to the Data API, no grant to any application role) holding
--       consumer_calls   one row per bridge callId = ai_ledger.reservations.request_id of its provider attempts:
--                        acquired -> complete | abandoned. A complete row keeps the validated BridgeResult for
--                        replay; its model output is replaced by an UNKNOWN tombstone (same audit) by purge.
--   * five public RPCs (p jsonb -> jsonb), SECURITY DEFINER, search_path '', EXECUTE for service_role only:
--       ai_calls_claim, ai_calls_complete, ai_calls_abandon, ai_calls_purge_content, ai_calls_forget_user.
--
-- Why a schema of its own and not ai_ledger: the ledger keeps no prompt, output or other free text
-- (20261010050613 header, enforced by its behaviour suite). A stored BridgeResult carries model output for up to
-- the content retention, so it lives apart from the ledger, with its own retention and deletion. The ledger is
-- only READ here (abandon checks that the call's reservations are final; forget_user reports what the ledger
-- still holds). Nothing in ai_ledger is created, altered, granted or written.
--
-- Concurrency: claim and abandon take a transaction-scoped advisory lock per call_key, then the row FOR UPDATE.
-- complete locks the row. A user-subject claim also takes a SHARED per-user advisory lock and forget_user the
-- EXCLUSIVE one, so a forget never interleaves with a claim of the same user. Lock order is user -> key -> row
-- everywhere it applies.
--
-- No time-based takeover: an acquired row stays acquired (IN_PROGRESS for every duplicate) until its owner
-- completes it, or an operator / recovery job abandons it after it is old AND every ledger reservation of the call
-- is final; an abandoned row replays as UNKNOWN and its old owner is fenced. Nothing is ever resent.
--
-- Personal data: user_id (opaque uuid, no foreign key, like the ledger), a POSTONA brand slug kept for audit only,
-- hashes, audit counts, and the model output of a successful call until purge_content replaces it. Deletion:
-- forget_user removes every row of a user (refused while one of them is in flight). The ledger's own user_id rows
-- are NOT touched (its append-only triggers forbid it); see docs/ai-provider/F6_POSTONA_CONSUMER_CALLS_PG_CANDIDATE.md.
--
-- Access is verified, not assumed: after the objects and grants exist, the migration checks owners, memberships,
-- the exact direct ACLs and the EFFECTIVE privileges of anon / authenticated / service_role, and raises (rolling
-- the whole migration back) if anything is reachable that should not be. Nothing is repaired.

begin;

-- Preconditions: the ledger exists and the migrating role can read the two tables the RPCs consult.
-- (Catalog lookups only: to_regclass itself fails without USAGE on the schema.)
do $$
declare
  v_reservations oid;
  v_events oid;
begin
  select c.oid into v_reservations from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ai_ledger' and c.relname = 'reservations' and c.relkind = 'r';
  select c.oid into v_events from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'ai_ledger' and c.relname = 'usage_events' and c.relkind = 'r';
  if v_reservations is null or v_events is null then
    raise exception 'AI_CALLS_REQUIRES_LEDGER: apply 20261010050613_ai_provider_budget_ledger first' using errcode = 'P0001';
  end if;
  if not has_schema_privilege(current_user, 'ai_ledger', 'USAGE')
     or not has_table_privilege(current_user, v_reservations, 'SELECT')
     or not has_table_privilege(current_user, v_events, 'SELECT') then
    raise exception 'AI_CALLS_LEDGER_NOT_READABLE: % cannot read the ledger', current_user using errcode = 'P0001';
  end if;
end;
$$;

create schema ai_calls;
comment on schema ai_calls is
  'Durable H5 consumer-bridge call store. Owner-only; reached only through the public.ai_calls_* RPCs.';
revoke all on schema ai_calls from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Helpers (owner-only, not SECURITY DEFINER)
-- ---------------------------------------------------------------------------------------------------------
-- A string field matching p_pattern; null when absent and not required; raises AI_CALLS_INVALID_INPUT otherwise.
create function ai_calls.input_text(p jsonb, p_key text, p_required boolean, p_pattern text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then
    if p_required then
      raise exception 'AI_CALLS_INVALID_INPUT: % is required', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'string' or (p ->> p_key) !~ p_pattern then
    raise exception 'AI_CALLS_INVALID_INPUT: %', p_key using errcode = '22023';
  end if;
  return p ->> p_key;
end;
$$;

-- An integral JSON number within [p_min, p_max]; null when absent and not required.
create function ai_calls.input_int(p jsonb, p_key text, p_required boolean, p_min bigint, p_max bigint)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? p_key) or jsonb_typeof(p -> p_key) = 'null' then
    if p_required then
      raise exception 'AI_CALLS_INVALID_INPUT: % is required', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(p -> p_key) <> 'number' then
    raise exception 'AI_CALLS_INVALID_INPUT: % must be a number', p_key using errcode = '22023';
  end if;
  v := (p ->> p_key)::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then
    raise exception 'AI_CALLS_INVALID_INPUT: % is out of range', p_key using errcode = '22023';
  end if;
  return v::bigint;
end;
$$;

create function ai_calls.input_uuid(p jsonb, p_key text, p_required boolean)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return ai_calls.input_text(p, p_key, p_required, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')::uuid;
end;
$$;

-- The bridge Audit of this call: exactly the nine keys of types.ts Audit, identity equal to the row, bounded
-- counts. The bridge re-validates every field (role / model / policyVersion against its registration) on replay.
create function ai_calls.audit_ok(p_audit jsonb, p_call_key text, p_tenant text, p_feature text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
  v numeric;
begin
  if p_audit is null or jsonb_typeof(p_audit) is distinct from 'object' then
    return false;
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_audit) k;
  if v_keys is distinct from array['attempts', 'callId', 'costBasis', 'estimatedCostUsd', 'feature', 'model',
                                   'policyVersion', 'role', 'tenantTag'] then
    return false;
  end if;
  if jsonb_typeof(p_audit -> 'callId') is distinct from 'string' or (p_audit ->> 'callId') is distinct from p_call_key
     or jsonb_typeof(p_audit -> 'tenantTag') is distinct from 'string' or (p_audit ->> 'tenantTag') is distinct from p_tenant
     or jsonb_typeof(p_audit -> 'feature') is distinct from 'string' or (p_audit ->> 'feature') is distinct from p_feature then
    return false;
  end if;
  if jsonb_typeof(p_audit -> 'role') is distinct from 'string' or jsonb_typeof(p_audit -> 'model') is distinct from 'string'
     or jsonb_typeof(p_audit -> 'policyVersion') is distinct from 'string'
     or jsonb_typeof(p_audit -> 'costBasis') is distinct from 'string'
     or jsonb_typeof(p_audit -> 'attempts') is distinct from 'number'
     or jsonb_typeof(p_audit -> 'estimatedCostUsd') is distinct from 'number' then
    return false;
  end if;
  if (p_audit ->> 'role') !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
     or (p_audit ->> 'model') !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
     or char_length(p_audit ->> 'policyVersion') not between 1 and 128
     or (p_audit ->> 'costBasis') not in ('measured', 'includes_upper_bound', 'no_request') then
    return false;
  end if;
  v := (p_audit ->> 'attempts')::numeric;
  if v <> trunc(v) or v < 0 or v > 10 then
    return false;
  end if;
  v := (p_audit ->> 'estimatedCostUsd')::numeric;
  -- A registered feature's maxTotalCostUsd is at most 1 USD (bridge registration limit).
  if v < 0 or v > 1 then
    return false;
  end if;
  return true;
end;
$$;

-- A final BridgeResult of this call: {ok: true, data, audit} or {ok: false, code, audit} with a code the bridge
-- completes with (never IN_PROGRESS / CONTENT_DRIFT / pre-claim codes).
create function ai_calls.result_ok(p_result jsonb, p_call_key text, p_tenant text, p_feature text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_keys text[];
begin
  if p_result is null or jsonb_typeof(p_result) is distinct from 'object' then
    return false;
  end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_result) k;
  if p_result -> 'ok' = 'true'::jsonb then
    if v_keys is distinct from array['audit', 'data', 'ok'] then
      return false;
    end if;
  elsif p_result -> 'ok' = 'false'::jsonb then
    if v_keys is distinct from array['audit', 'code', 'ok']
       or jsonb_typeof(p_result -> 'code') is distinct from 'string'
       or (p_result ->> 'code') not in ('POLICY_DENIED', 'COST_DENIED', 'BUDGET_DENIED', 'OUTPUT_REJECTED',
                                        'MODEL_UNAVAILABLE', 'PROVIDER_FAILED', 'UNKNOWN') then
      return false;
    end if;
  else
    return false;
  end if;
  return ai_calls.audit_ok(p_result -> 'audit', p_call_key, p_tenant, p_feature);
end;
$$;

-- The tombstone that replaces a result: no output, the original audit, replayed by the bridge as UNKNOWN.
create function ai_calls.tombstone(p_audit jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'code', 'UNKNOWN', 'audit', p_audit)
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------------------
create table ai_calls.consumer_calls (
  -- The bridge callId: 'h5m2_' + SHA-256(tenantTag, feature, operationId), lower-case hex (bridge.ts). The same
  -- value is the ai_ledger request_id of the call's provider attempts.
  call_key text primary key check (call_key ~ '^h5m2_[0-9a-f]{64}$'),
  tenant_tag text not null check (tenant_tag ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  application text not null check (application ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  feature text not null check (feature ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  subject_kind text not null check (subject_kind in ('system', 'user')),
  -- Only to find a user's rows on account deletion. No foreign key (as in the ledger).
  user_id uuid,
  -- POSTONA brand slug for audit display only; never an AI subject and never parsed into an identity.
  brand_ref text check (brand_ref ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- common_accounts.lifecycle_version seen by the authorizer at claim time (audit only).
  lifecycle_version bigint check (lifecycle_version >= 0),
  claim_token uuid not null unique,
  state text not null check (state in ('acquired', 'complete', 'abandoned')),
  result jsonb,
  audit jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  abandoned_at timestamptz,
  content_purged_at timestamptz,
  constraint consumer_calls_subject check (
    (subject_kind = 'system' and user_id is null and lifecycle_version is null)
    or (subject_kind = 'user' and user_id is not null)
  ),
  constraint consumer_calls_state check (
    (state = 'acquired' and result is null and audit is null and completed_at is null and abandoned_at is null)
    or (state = 'complete' and result is not null and audit is not null and completed_at is not null and abandoned_at is null)
    or (state = 'abandoned' and result is not null and audit is not null and completed_at is null and abandoned_at is not null)
  ),
  constraint consumer_calls_purged check (
    content_purged_at is null or (state = 'complete' and result = ai_calls.tombstone(audit))
  ),
  constraint consumer_calls_result_size check (result is null or octet_length(result::text) <= 131072)
);
comment on table ai_calls.consumer_calls is
  'One row per H5 bridge call. acquired = claimed, outcome pending (IN_PROGRESS for duplicates, never taken over); '
  'complete = final BridgeResult kept for replay (output purged to an UNKNOWN tombstone after retention); '
  'abandoned = closed by recovery as UNKNOWN after the ledger finalised every attempt; the old owner is fenced.';
create index consumer_calls_user_idx on ai_calls.consumer_calls (user_id) where user_id is not null;
create index consumer_calls_acquired_idx on ai_calls.consumer_calls (created_at) where state = 'acquired';
create index consumer_calls_purge_idx on ai_calls.consumer_calls (completed_at)
  where state = 'complete' and content_purged_at is null;

alter table ai_calls.consumer_calls enable row level security;

-- Identity is immutable and state only moves forward; a complete row changes only by the purge to its tombstone.
create function ai_calls.call_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.call_key, new.tenant_tag, new.fingerprint, new.application, new.feature, new.subject_kind, new.user_id,
      new.brand_ref, new.lifecycle_version, new.claim_token, new.created_at)
     is distinct from
     (old.call_key, old.tenant_tag, old.fingerprint, old.application, old.feature, old.subject_kind, old.user_id,
      old.brand_ref, old.lifecycle_version, old.claim_token, old.created_at) then
    raise exception 'AI_CALLS_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;
  if old.state = 'acquired' and new.state in ('complete', 'abandoned') then
    return new;
  end if;
  if old.state = 'complete' and new.state = 'complete' and old.content_purged_at is null
     and new.content_purged_at is not null and new.audit = old.audit and new.completed_at = old.completed_at
     and new.result = ai_calls.tombstone(old.audit) then
    return new;
  end if;
  raise exception 'AI_CALLS_TRANSITION: % -> %', old.state, new.state using errcode = 'P0001';
end;
$$;

create trigger consumer_calls_transition before update on ai_calls.consumer_calls
  for each row execute function ai_calls.call_transition();

-- ---------------------------------------------------------------------------------------------------------
-- RPC: claim
--   p: call_key, tenant_tag, fingerprint, application, feature, subject_kind ('system' | 'user'), user_id?,
--      brand_ref?, lifecycle_version?
--   -> {kind: 'acquired', owner} | {kind: 'busy'} | {kind: 'conflict'} | {kind: 'complete', fingerprint, result}
-- The CallClaim of types.ts. A new key is inserted as acquired with a fresh owner token. An existing key whose
-- identity (tenant, fingerprint, application, feature, subject) differs is a conflict (CONTENT_DRIFT); an acquired
-- one is busy however old it is; a complete or abandoned one returns its stored result for replay.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_claim(p jsonb)
returns jsonb
language plpgsql
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
  v_lifecycle bigint := ai_calls.input_int(p, 'lifecycle_version', false, 0, 9007199254740991);
  v_row ai_calls.consumer_calls;
  v_owner uuid;
begin
  if (v_subject = 'system' and (v_user is not null or v_lifecycle is not null))
     or (v_subject = 'user' and v_user is null) then
    raise exception 'AI_CALLS_INVALID_INPUT: subject' using errcode = '22023';
  end if;

  if v_subject = 'user' then
    perform pg_advisory_xact_lock_shared(hashtextextended('ai_calls:user:' || v_user::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:call:' || v_key, 0));

  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for update;
  if not found then
    v_owner := gen_random_uuid();
    insert into ai_calls.consumer_calls (call_key, tenant_tag, fingerprint, application, feature, subject_kind,
                                         user_id, brand_ref, lifecycle_version, claim_token, state)
    values (v_key, v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user, v_brand, v_lifecycle,
            v_owner, 'acquired');
    return jsonb_build_object('kind', 'acquired', 'owner', v_owner);
  end if;
  if (v_row.tenant_tag, v_row.fingerprint, v_row.application, v_row.feature, v_row.subject_kind, v_row.user_id)
     is distinct from (v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user) then
    return jsonb_build_object('kind', 'conflict');
  end if;
  if v_row.state = 'acquired' then
    return jsonb_build_object('kind', 'busy');
  end if;
  return jsonb_build_object('kind', 'complete', 'fingerprint', v_row.fingerprint, 'result', v_row.result);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: complete
--   p: call_key, tenant_tag, fingerprint, owner, result -> {state: 'complete', duplicate}
-- Records the final BridgeResult. Only the claim owner of an acquired row with the same identity may; the same
-- owner repeating the same result (its first response was lost) gets duplicate true. Everything else raises, which
-- the bridge turns into UNKNOWN without resending: unknown key, identity mismatch, another owner, an abandoned row
-- (AI_CALLS_FENCED), a different second result, an invalid or oversized result.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_complete(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := ai_calls.input_text(p, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_tenant text := ai_calls.input_text(p, 'tenant_tag', true, '^[0-9a-f]{64}$');
  v_fingerprint text := ai_calls.input_text(p, 'fingerprint', true, '^[0-9a-f]{64}$');
  v_owner uuid := ai_calls.input_uuid(p, 'owner', true);
  v_result jsonb := p -> 'result';
  v_row ai_calls.consumer_calls;
begin
  if v_result is null or octet_length(v_result::text) > 131072 then
    raise exception 'AI_CALLS_INVALID_INPUT: result is missing or too large' using errcode = '22023';
  end if;

  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for update;
  if not found then
    raise exception 'AI_CALLS_NOT_CLAIMED' using errcode = 'P0002';
  end if;
  if (v_row.tenant_tag, v_row.fingerprint) is distinct from (v_tenant, v_fingerprint) then
    raise exception 'AI_CALLS_IDENTITY_MISMATCH' using errcode = 'P0001';
  end if;
  if v_row.claim_token is distinct from v_owner or v_row.state = 'abandoned' then
    raise exception 'AI_CALLS_FENCED' using errcode = 'P0001';
  end if;
  if not ai_calls.result_ok(v_result, v_row.call_key, v_row.tenant_tag, v_row.feature) then
    raise exception 'AI_CALLS_INVALID_INPUT: result' using errcode = '22023';
  end if;
  if v_row.state = 'complete' then
    if v_row.result = v_result then
      return jsonb_build_object('state', 'complete', 'duplicate', true);
    end if;
    raise exception 'AI_CALLS_RESULT_CONFLICT' using errcode = 'P0001';
  end if;
  update ai_calls.consumer_calls c
     set state = 'complete', result = v_result, audit = v_result -> 'audit', completed_at = now()
   where c.call_key = v_key;
  return jsonb_build_object('state', 'complete', 'duplicate', false);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: abandon (recovery / operator)
--   p: call_key, audit, older_than_seconds? (300..2592000, default 1800)
--   -> {abandoned: true} | {abandoned: false, reason: NOT_FOUND | NOT_ACQUIRED | TOO_RECENT | LEDGER_NOT_FINAL}
-- Closes an acquired row whose owner never completed it (crash, lost response before the write) as an UNKNOWN
-- tombstone with the given audit. Only when the row is older than the threshold AND no ledger reservation of the
-- call is still reserved or sent (run ai_ledger_recover_stale first). The audit must agree with the ledger:
-- attempts = attempts that reached the provider, never less cost than the ledger charged, upper bound shown. The
-- abandoned row fences its old owner (complete raises) and replays as UNKNOWN; nothing is resent.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_abandon(p jsonb)
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

-- ---------------------------------------------------------------------------------------------------------
-- RPC: purge_content (retention job)
--   p: older_than_hours? (1..720, default 24), limit? (1..5000, default 1000) -> {purged}
-- Replaces the result of successful calls completed more than the given hours ago by the UNKNOWN tombstone of
-- the same audit: the model output is gone, replay stays an UNKNOWN that never resends.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_purge_content(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hours bigint := coalesce(ai_calls.input_int(coalesce(p, '{}'::jsonb), 'older_than_hours', false, 1, 720), 24);
  v_limit bigint := coalesce(ai_calls.input_int(coalesce(p, '{}'::jsonb), 'limit', false, 1, 5000), 1000);
  v_purged integer;
begin
  with picked as (
    select c.call_key from ai_calls.consumer_calls c
     where c.state = 'complete' and c.content_purged_at is null and c.result -> 'ok' = 'true'::jsonb
       and c.completed_at <= now() - make_interval(hours => v_hours::integer)
     order by c.completed_at
     limit v_limit
     for update skip locked
  )
  update ai_calls.consumer_calls c
     set result = ai_calls.tombstone(c.audit), content_purged_at = now()
    from picked
   where c.call_key = picked.call_key;
  get diagnostics v_purged = row_count;
  return jsonb_build_object('purged', v_purged);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- RPC: forget_user (account deletion)
--   p: user_id -> {forgotten: true, deleted, ledger_reservations_retained}
--               | {forgotten: false, reason: 'CALLS_IN_FLIGHT', in_flight}
-- Deletes every call row of the user. Refused while one of them is still acquired (abandon it first), and it
-- excludes concurrent claims of that user for its duration. Run it only once the user can no longer be
-- authorised (entitlement no longer active), or a later claim would create a new row. The ledger keeps its own
-- rows of the user: their count is reported, nothing there is changed.
-- ---------------------------------------------------------------------------------------------------------
create function public.ai_calls_forget_user(p jsonb)
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

-- ---------------------------------------------------------------------------------------------------------
-- Grants: nothing on the schema, table or helpers for any application role; EXECUTE on the five RPCs for
-- service_role only (a Supabase default EXECUTE grant to anon / authenticated must not survive).
-- ---------------------------------------------------------------------------------------------------------
revoke all on all tables in schema ai_calls from public, anon, authenticated, service_role;
revoke all on all sequences in schema ai_calls from public, anon, authenticated, service_role;
revoke all on all functions in schema ai_calls from public, anon, authenticated, service_role;
revoke all on function
  public.ai_calls_claim(jsonb), public.ai_calls_complete(jsonb), public.ai_calls_abandon(jsonb),
  public.ai_calls_purge_content(jsonb), public.ai_calls_forget_user(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.ai_calls_claim(jsonb), public.ai_calls_complete(jsonb), public.ai_calls_abandon(jsonb),
  public.ai_calls_purge_content(jsonb), public.ai_calls_forget_user(jsonb)
  to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- Access verification (same rules as the ledger migration). Raises, rolling the whole migration back, unless
-- every new object is reachable by exactly the intended roles. Nothing is repaired here.
-- ---------------------------------------------------------------------------------------------------------
do $$
declare
  v_schema constant regnamespace := 'ai_calls'::regnamespace;
  v_owner oid;
  v_owner_name name;
  v_roles constant text[] := array['anon', 'authenticated', 'service_role'];
  v_table_privs text[] := array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  v_rpcs constant regprocedure[] := array[
    'public.ai_calls_claim(jsonb)'::regprocedure, 'public.ai_calls_complete(jsonb)'::regprocedure,
    'public.ai_calls_abandon(jsonb)'::regprocedure, 'public.ai_calls_purge_content(jsonb)'::regprocedure,
    'public.ai_calls_forget_user(jsonb)'::regprocedure];
  v_role text;
  v_priv text;
  v_rel record;
  v_fn record;
  v_rpc regprocedure;
  v_extra text;
  v_set_check text;
  v_reach record;
begin
  if current_setting('server_version_num')::int >= 170000 then
    v_table_privs := array_append(v_table_privs, 'MAINTAIN');
  end if;

  select n.nspowner into v_owner from pg_namespace n where n.oid = v_schema;
  select r.rolname into v_owner_name from pg_roles r where r.oid = v_owner;

  -- 1. One owner for everything, and not an application role.
  if v_owner_name in ('anon', 'authenticated', 'service_role') then
    raise exception 'AI_CALLS_ACL_UNSAFE_OWNER: schema owner % is an application role', v_owner_name using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relowner <> v_owner)
     or exists (select 1 from pg_proc f where f.pronamespace = v_schema and f.proowner <> v_owner)
     or exists (select 1 from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid where f.proowner <> v_owner) then
    raise exception 'AI_CALLS_ACL_UNSAFE_OWNER: mixed owners' using errcode = 'P0001';
  end if;

  -- 2. No application role may be a member of the owner or of any superuser.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    if pg_has_role(v_role, v_owner, 'MEMBER') then
      raise exception 'AI_CALLS_ACL_UNSAFE_MEMBERSHIP: % is a member of the owner %', v_role, v_owner_name using errcode = 'P0001';
    end if;
    select string_agg(super.rolname, ', ' order by super.rolname) into v_extra
      from pg_roles super where super.rolsuper and pg_has_role(v_role, super.oid, 'MEMBER');
    if v_extra is not null then
      raise exception 'AI_CALLS_ACL_UNSAFE_MEMBERSHIP: % is or inherits superuser %', v_role, v_extra using errcode = 'P0001';
    end if;
  end loop;

  -- 3. Exact direct ACLs: schema, relations and helpers carry no grant to anyone but the owner; each RPC carries
  --    EXECUTE for service_role (without grant option) and nothing else.
  select string_agg(format('%s:%s', coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
    from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    left join pg_roles r on r.oid = a.grantee
   where n.oid = v_schema and a.grantee <> n.nspowner;
  if v_extra is not null then
    raise exception 'AI_CALLS_ACL_UNEXPECTED_SCHEMA_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(format('%s %s:%s', c.relname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
    from pg_class c cross join lateral aclexplode(c.relacl) a
    left join pg_roles r on r.oid = a.grantee
   where c.relnamespace = v_schema and a.grantee <> c.relowner;
  if v_extra is not null then
    raise exception 'AI_CALLS_ACL_UNEXPECTED_RELATION_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(format('%s %s:%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type), ', ') into v_extra
    from pg_proc f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where f.pronamespace = v_schema and a.grantee <> f.proowner;
  if v_extra is not null then
    raise exception 'AI_CALLS_ACL_UNEXPECTED_HELPER_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  select string_agg(format('%s %s:%s%s', f.proname, coalesce(r.rolname, 'PUBLIC'), a.privilege_type,
                           case when a.is_grantable then '+grant' else '' end), ', ') into v_extra
    from unnest(v_rpcs) x(oid) join pg_proc f on f.oid = x.oid
    cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
    left join pg_roles r on r.oid = a.grantee
   where a.grantee <> f.proowner
     and not (r.rolname is not distinct from 'service_role' and a.privilege_type = 'EXECUTE' and not a.is_grantable);
  if v_extra is not null then
    raise exception 'AI_CALLS_ACL_UNEXPECTED_RPC_GRANT: %', v_extra using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid
              where c.relnamespace = v_schema and att.attnum > 0 and att.attacl is not null) then
    raise exception 'AI_CALLS_ACL_UNEXPECTED_COLUMN_GRANT' using errcode = 'P0001';
  end if;

  -- 4. RPC shape: SECURITY DEFINER with an empty search_path. Helpers are not SECURITY DEFINER.
  foreach v_rpc in array v_rpcs loop
    if not coalesce((select f.prosecdef and f.proconfig = array['search_path=""'] from pg_proc f where f.oid = v_rpc), false) then
      raise exception 'AI_CALLS_RPC_SHAPE: % must be SECURITY DEFINER with an empty search_path', v_rpc using errcode = 'P0001';
    end if;
  end loop;
  if exists (select 1 from pg_proc f where f.pronamespace = v_schema and f.prosecdef) then
    raise exception 'AI_CALLS_HELPER_SHAPE: a helper is SECURITY DEFINER' using errcode = 'P0001';
  end if;

  -- 5. Effective privileges (inheritance, PUBLIC, grant options, column privileges) of each application role.
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    if has_schema_privilege(v_role, v_schema, 'USAGE') or has_schema_privilege(v_role, v_schema, 'CREATE') then
      raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: % can use the ai_calls schema', v_role using errcode = 'P0001';
    end if;
    for v_rel in select c.oid, c.relname, c.relkind from pg_class c where c.relnamespace = v_schema and c.relkind in ('r', 'S', 'v', 'm') loop
      if v_rel.relkind = 'S' then
        if has_sequence_privilege(v_role, v_rel.oid, 'USAGE') or has_sequence_privilege(v_role, v_rel.oid, 'SELECT')
           or has_sequence_privilege(v_role, v_rel.oid, 'UPDATE') then
          raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: % can use sequence %', v_role, v_rel.relname using errcode = 'P0001';
        end if;
        continue;
      end if;
      foreach v_priv in array v_table_privs loop
        if has_table_privilege(v_role, v_rel.oid, v_priv) then
          raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: % holds % on %', v_role, v_priv, v_rel.relname using errcode = 'P0001';
        end if;
      end loop;
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] loop
        if has_any_column_privilege(v_role, v_rel.oid, v_priv) then
          raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: % has column % on %', v_role, v_priv, v_rel.relname using errcode = 'P0001';
        end if;
      end loop;
    end loop;
    for v_fn in select f.oid, f.proname from pg_proc f where f.pronamespace = v_schema loop
      if has_function_privilege(v_role, v_fn.oid, 'EXECUTE') then
        raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: % can execute helper %', v_role, v_fn.proname using errcode = 'P0001';
      end if;
    end loop;
    foreach v_rpc in array v_rpcs loop
      if has_function_privilege(v_role, v_rpc, 'EXECUTE') is distinct from (v_role = 'service_role') then
        raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: EXECUTE of % for % is wrong', v_rpc, v_role using errcode = 'P0001';
      end if;
      if has_function_privilege(v_role, v_rpc, 'EXECUTE WITH GRANT OPTION') then
        raise exception 'AI_CALLS_ACL_EFFECTIVE_PRIVILEGE: % may grant %', v_role, v_rpc using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  -- 5b. Roles an application role can REACH by inheritance or SET ROLE (direct or chained) are held to the same
  --     rules: anon / authenticated must not reach service_role, the owner or a superuser; no application role may
  --     reach any role holding authority on the call store.
  v_set_check := case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end;
  foreach v_role in array v_roles loop
    continue when to_regrole(v_role) is null;
    for v_reach in
      select r.oid, r.rolname, r.rolsuper,
             case when pg_has_role(v_role, r.oid, 'USAGE') then 'inheritance' else 'SET ROLE' end as path
        from pg_roles r
       where r.rolname <> v_role
         and (pg_has_role(v_role, r.oid, 'USAGE') or pg_has_role(v_role, r.oid, v_set_check))
       order by r.rolname
    loop
      if v_reach.rolsuper or v_reach.oid = v_owner then
        raise exception 'AI_CALLS_ACL_UNSAFE_ROLE_PATH: % reaches % (owner or superuser) by %', v_role, v_reach.rolname, v_reach.path
          using errcode = 'P0001';
      end if;
      if v_role in ('anon', 'authenticated') and v_reach.rolname = 'service_role' then
        raise exception 'AI_CALLS_ACL_UNSAFE_ROLE_PATH: % reaches service_role by %', v_role, v_reach.path using errcode = 'P0001';
      end if;
      if has_schema_privilege(v_reach.oid, v_schema, 'USAGE') or has_schema_privilege(v_reach.oid, v_schema, 'CREATE') then
        raise exception 'AI_CALLS_ACL_UNSAFE_ROLE_PATH: % reaches % by %, which can use the ai_calls schema', v_role, v_reach.rolname, v_reach.path
          using errcode = 'P0001';
      end if;
      for v_rel in select c.oid, c.relname, c.relkind from pg_class c where c.relnamespace = v_schema and c.relkind in ('r', 'S', 'v', 'm') loop
        if (v_rel.relkind = 'S' and (has_sequence_privilege(v_reach.oid, v_rel.oid, 'USAGE') or has_sequence_privilege(v_reach.oid, v_rel.oid, 'SELECT')
                                     or has_sequence_privilege(v_reach.oid, v_rel.oid, 'UPDATE')))
           or (v_rel.relkind <> 'S' and (exists (select 1 from unnest(v_table_privs) x(p) where has_table_privilege(v_reach.oid, v_rel.oid, x.p))
                                          or exists (select 1 from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) y(p)
                                                      where has_any_column_privilege(v_reach.oid, v_rel.oid, y.p)))) then
          raise exception 'AI_CALLS_ACL_UNSAFE_ROLE_PATH: % reaches % by %, which holds privileges on %', v_role, v_reach.rolname, v_reach.path, v_rel.relname
            using errcode = 'P0001';
        end if;
      end loop;
      if exists (select 1 from pg_proc f where f.pronamespace = v_schema and has_function_privilege(v_reach.oid, f.oid, 'EXECUTE'))
         or exists (select 1 from unnest(v_rpcs) x(oid) where has_function_privilege(v_reach.oid, x.oid, 'EXECUTE')) then
        raise exception 'AI_CALLS_ACL_UNSAFE_ROLE_PATH: % reaches % by %, which can execute call-store functions', v_role, v_reach.rolname, v_reach.path
          using errcode = 'P0001';
      end if;
    end loop;
  end loop;

  -- 6. Row level security is on for every table (no policy: nobody but the owner sees a row).
  if exists (select 1 from pg_class c where c.relnamespace = v_schema and c.relkind = 'r' and not c.relrowsecurity) then
    raise exception 'AI_CALLS_RLS_DISABLED' using errcode = 'P0001';
  end if;
  if exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relnamespace = v_schema) then
    raise exception 'AI_CALLS_UNEXPECTED_POLICY' using errcode = 'P0001';
  end if;
end;
$$;

commit;
