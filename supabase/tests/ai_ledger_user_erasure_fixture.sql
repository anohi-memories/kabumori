-- Test-only helpers for the ledger user-erasure proofs (disposable databases only; never a migration). Loaded after
-- the ledger fixture (ail_test) and the call-store fixture (acs_test).
create schema aue_test;

create function aue_test.check(p_ok boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_ok is not true then
    raise exception 'AUE_TEST_FAIL: %', p_label;
  end if;
end;
$$;

create function aue_test.rpc(p_fn text, p jsonb, p_role text default 'service_role')
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

create function aue_test.rpc_error(p_fn text, p jsonb, p_role text default 'service_role')
returns text
language plpgsql
as $$
begin
  perform aue_test.rpc(p_fn, p, p_role);
  return null;
exception when others then
  return sqlstate || ':' || sqlerrm;
end;
$$;

-- For parallel sessions: the RPC result as text, or 'ERR:' and the error code word.
create function aue_test.try(p_fn text, p jsonb)
returns text
language plpgsql
as $$
begin
  return aue_test.rpc(p_fn, p)::text;
exception when others then
  return 'ERR:' || split_part(sqlerrm, ':', 1);
end;
$$;

create function aue_test.erase(p_user uuid)
returns jsonb
language sql
as $$
  select aue_test.rpc('ai_ledger_erase_user', jsonb_build_object('user_id', p_user))
$$;

create function aue_test.footprint(p_user uuid, p_brand text default null)
returns jsonb
language sql
as $$
  select aue_test.rpc('ai_ledger_user_footprint', jsonb_strip_nulls(jsonb_build_object('user_id', p_user, 'brand_ref', p_brand)))
$$;

create function aue_test.request(p_tag text)
returns text
language sql
immutable
as $$
  select 'h5m2_' || acs_test.hex(p_tag)
$$;

-- A user's ledger history: one measured call, one unknown (timeout) at its upper bound, one released hold, one
-- released hold that was settled late. Every row carries the user.
create function aue_test.seed_user(p_user uuid, p_tag text)
returns void
language plpgsql
as $$
declare
  r jsonb;
begin
  r := ail_test.reserve(aue_test.request(p_tag || '-1'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', p_user, null, 0.0044);
  perform aue_test.check(r ->> 'allowed' = 'true', 'seed reserve 1: ' || r::text);
  perform ail_test.mark_sent(r);
  perform ail_test.settle_measured(r, 0.0012, 1000, 200);
  r := ail_test.reserve(aue_test.request(p_tag || '-2'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', p_user, null, 0.0044);
  perform ail_test.mark_sent(r);
  perform ail_test.settle_unknown(r, 0.001);
  r := ail_test.reserve(aue_test.request(p_tag || '-3'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', p_user, null, 0.0044);
  perform ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', r ->> 'reservation_id'));
  r := ail_test.reserve(aue_test.request(p_tag || '-4'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', p_user, null, 0.0044);
  perform ail_test.rpc('ai_ledger_release', jsonb_build_object('reservation_id', r ->> 'reservation_id'));
  perform ail_test.settle_measured(r, 0.0009, 800, 100);
end;
$$;

-- Everything the bill and the budgets depend on, without any user column: usage by month / provider / model /
-- application / feature / outcome / basis, reservations by status, bucket counters by policy (id: erasure renames a
-- user's own policy) and period.
create function aue_test.totals()
returns text
language sql
as $$
  select concat_ws(E'\n',
    (select string_agg(x, ';' order by x) from (
       select concat_ws('|', billing_month, provider, model, application, feature, outcome, cost_basis, count(*),
                        sum(estimated_cost_usd), sum(reserved_usd), sum(input_tokens), sum(output_tokens)) as x
         from ai_ledger.usage_events group by billing_month, provider, model, application, feature, outcome, cost_basis) s),
    (select string_agg(x, ';' order by x) from (
       select concat_ws('|', status, count(*), sum(reserved_usd)) as x from ai_ledger.reservations group by status) s),
    (select string_agg(x, ';' order by x) from (
       select concat_ws('|', b.policy_id, b.period_start, count(*), sum(b.calls), sum(b.held_usd), sum(b.settled_usd)) as x
         from ai_ledger.budget_buckets b
        group by b.policy_id, b.period_start) s),
    (select count(*)::text from ai_ledger.usage_events),
    (select count(*)::text from ai_ledger.reservations))
$$;

-- Every ledger row of one subject, all columns except the subject columns (and, for a policy, what erasure rewrites:
-- enabled, policy_key, note).
create function aue_test.rows_sans_user(p_user uuid)
returns text
language sql
as $$
  select concat_ws(E'\n',
    (select string_agg((to_jsonb(r) - 'user_id')::text, '|' order by r.id) from ai_ledger.reservations r where r.user_id = p_user),
    (select string_agg((to_jsonb(e) - 'user_id')::text, '|' order by e.id) from ai_ledger.usage_events e where e.user_id = p_user),
    (select string_agg((to_jsonb(b) - 'user_id')::text, '|' order by b.id) from ai_ledger.budget_buckets b where b.user_id = p_user),
    (select string_agg((to_jsonb(pol) - 'scope_user_id' - 'enabled' - 'policy_key' - 'note')::text, '|' order by pol.id)
       from ai_ledger.budget_policies pol where pol.scope_user_id = p_user))
$$;

-- Every row (all columns) of one subject.
create function aue_test.rows_of(p_user uuid)
returns text
language sql
as $$
  select concat_ws(E'\n',
    (select string_agg(r::text, '|' order by r.id) from ai_ledger.reservations r where r.user_id = p_user),
    (select string_agg(e::text, '|' order by e.id) from ai_ledger.usage_events e where e.user_id = p_user),
    (select string_agg(b::text, '|' order by b.id) from ai_ledger.budget_buckets b where b.user_id = p_user),
    (select string_agg(pol::text, '|' order by pol.id) from ai_ledger.budget_policies pol where pol.scope_user_id = p_user),
    (select string_agg(c::text, '|' order by c.call_key) from ai_calls.consumer_calls c where c.user_id = p_user))
$$;

-- The subject id now carried by the reservations that had p_request_tag's request ids.
create function aue_test.subject_of(p_tag text)
returns uuid
language sql
as $$
  select distinct r.user_id from ai_ledger.reservations r where r.request_id = aue_test.request(p_tag || '-1')
$$;

-- How many rows of any table in ai_ledger / ai_calls contain the text (a user id must leave no trace).
create function aue_test.mentions(p_text text)
returns bigint
language plpgsql
as $$
declare
  t record;
  n bigint;
  total bigint := 0;
begin
  for t in select n2.nspname, c.relname from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
            where n2.nspname in ('ai_ledger', 'ai_calls') and c.relkind = 'r' loop
    execute format('select count(*) from %I.%I x where x::text like $1', t.nspname, t.relname) into n using '%' || p_text || '%';
    total := total + n;
  end loop;
  return total;
end;
$$;

-- Race helper for a statement that only READS: used as a test-only row-level-security policy (FORCE RLS on a
-- non-superuser owner), it sleeps knobs.delay_seconds once, in the first session that evaluates it, so that
-- statement's snapshot is old while another session commits. Other sessions (and later statements of the same
-- session) pass straight through. Very low cost, so the planner evaluates it before the query's own conditions.
-- Defined after the knobs table below.

-- Race helper (see the call-store fixture): a BEFORE trigger the runner creates that sleeps knobs.delay_seconds.
create table aue_test.knobs (delay_seconds numeric not null);
insert into aue_test.knobs values (0);
create function aue_test.slow()
returns trigger
language plpgsql
as $$
begin
  perform pg_sleep((select k.delay_seconds from aue_test.knobs k));
  return new;
end;
$$;

create function aue_test.slow_once()
returns boolean
language plpgsql
volatile
cost 0.0001
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('aue.slept', true), '') = '1' then
    return true;
  end if;
  if (select k.delay_seconds from aue_test.knobs k) > 0 and pg_try_advisory_lock(hashtext('aue_test.slow_once')) then
    perform set_config('aue.slept', '1', false);
    perform pg_sleep((select k.delay_seconds from aue_test.knobs k));
  end if;
  return true;
end;
$$;
