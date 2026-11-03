-- Test-only helpers for the AI consumer call store proofs (disposable databases only; never a migration).
-- acs_test.rpc() calls a public.ai_calls_* RPC AS a given application role (default service_role) from a
-- superuser session, so the behaviour file can assert on the owner-only table in between calls. Ledger calls use
-- the ledger's own fixture (ail_test), which the runner loads first.
create schema acs_test;

create function acs_test.check(p_ok boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'ACS_TEST_FAIL: %', p_label;
  end if;
end;
$$;

create function acs_test.rpc(p_fn text, p jsonb, p_role text default 'service_role')
returns jsonb
language plpgsql
as $$
declare
  v jsonb;
begin
  execute format('set local role %I', p_role);
  execute format('select public.%I($1)', p_fn) into v using p;
  execute 'reset role';
  return v;
end;
$$;

-- The SQLSTATE and message of a failing RPC call, or null when it succeeded (the failed call is rolled back).
create function acs_test.rpc_error(p_fn text, p jsonb, p_role text default 'service_role')
returns text
language plpgsql
as $$
begin
  perform acs_test.rpc(p_fn, p, p_role);
  return null;
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- For parallel sessions: the RPC result as text, or 'ERR:' and the message (one line per session).
create function acs_test.try(p_fn text, p jsonb)
returns text
language plpgsql
as $$
begin
  return acs_test.rpc(p_fn, p)::text;
exception when others then
  return 'ERR:' || split_part(sqlerrm, ':', 1);
end;
$$;

create function acs_test.hex(p text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

-- Claim input shaped like the bridge's: tenant_tag = hash(tenant seed), call_key = 'h5m2_' + hash(tenant, feature,
-- operation), fingerprint = hash(content seed). Two users = two tenant seeds.
create function acs_test.claim_p(
  p_op text, p_tenant text, p_fp text, p_subject text default 'user',
  p_user uuid default '00000000-0000-4000-8000-0000000000a1', p_feature text default 'postona.consult',
  p_brand text default null, p_lifecycle bigint default null)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'call_key', 'h5m2_' || acs_test.hex(p_tenant || '|' || p_feature || '|' || p_op),
    'tenant_tag', acs_test.hex(p_tenant),
    'fingerprint', acs_test.hex(p_fp),
    'application', 'postona',
    'feature', p_feature,
    'subject_kind', p_subject,
    'user_id', case when p_subject = 'user' then p_user end,
    'brand_ref', p_brand,
    'lifecycle_version', p_lifecycle))
$$;

create function acs_test.claim(p_claim jsonb)
returns jsonb
language sql
as $$
  select acs_test.rpc('ai_calls_claim', p_claim)
$$;

create function acs_test.audit(p_claim jsonb, p_attempts integer, p_cost numeric, p_basis text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'callId', p_claim ->> 'call_key', 'tenantTag', p_claim ->> 'tenant_tag', 'feature', p_claim ->> 'feature',
    'role', 'postona.consult.reply', 'model', 'claude-haiku-5-5', 'policyVersion', 'h5m2-test-v1',
    'attempts', p_attempts, 'estimatedCostUsd', p_cost, 'costBasis', p_basis)
$$;

create function acs_test.ok_result(p_claim jsonb, p_data jsonb, p_attempts integer default 1,
                                   p_cost numeric default 0.0012, p_basis text default 'measured')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('ok', true, 'data', p_data, 'audit', acs_test.audit(p_claim, p_attempts, p_cost, p_basis))
$$;

create function acs_test.fail_result(p_claim jsonb, p_code text, p_attempts integer default 0,
                                     p_cost numeric default 0, p_basis text default 'no_request')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'audit', acs_test.audit(p_claim, p_attempts, p_cost, p_basis))
$$;

create function acs_test.complete_p(p_claim jsonb, p_owner text, p_result jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('call_key', p_claim ->> 'call_key', 'tenant_tag', p_claim ->> 'tenant_tag',
                            'fingerprint', p_claim ->> 'fingerprint', 'owner', p_owner, 'result', p_result)
$$;

create function acs_test.abandon_p(p_claim jsonb, p_audit jsonb, p_age integer default null)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object('call_key', p_claim ->> 'call_key', 'audit', p_audit,
                                              'older_than_seconds', p_age))
$$;

create function acs_test.call_row(p_claim jsonb)
returns ai_calls.consumer_calls
language sql
as $$
  select c.* from ai_calls.consumer_calls c where c.call_key = p_claim ->> 'call_key'
$$;

-- Moves a row's timestamps into the past (the transition trigger forbids it, so triggers are bypassed for this one
-- statement only and switched back on before returning).
create function acs_test.backdate(p_claim jsonb, p_by interval)
returns void
language plpgsql
as $$
begin
  perform set_config('session_replication_role', 'replica', true);
  update ai_calls.consumer_calls c
     set created_at = c.created_at - p_by, completed_at = c.completed_at - p_by, abandoned_at = c.abandoned_at - p_by
   where c.call_key = p_claim ->> 'call_key';
  perform set_config('session_replication_role', 'origin', true);
end;
$$;

-- Race helper for the runner's concurrency part: a BEFORE trigger (created and dropped by the runner) that sleeps
-- for knobs.delay_seconds inside the writing transaction. A table, not set_config: parallel sessions must see it.
create table acs_test.knobs (delay_seconds numeric not null);
insert into acs_test.knobs values (0);
create function acs_test.slow()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep((select k.delay_seconds from acs_test.knobs k));
  return new;
end;
$$;

-- A ledger reservation of the call's first attempt (request_id = call_key), via the ledger fixture.
create function acs_test.reserve(p_claim jsonb, p_attempt integer default 1, p_amount numeric default 0.0044)
returns jsonb
language sql
as $$
  select ail_test.reserve(p_claim ->> 'call_key', p_attempt, 'anthropic', 'claude-haiku-5-5', 'postona',
                          p_claim ->> 'feature', 'user', (p_claim ->> 'user_id')::uuid, null, p_amount)
$$;
