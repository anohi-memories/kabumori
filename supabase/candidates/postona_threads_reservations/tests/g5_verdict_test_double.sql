-- TEST DOUBLE of G5's R1 / W1 (G5 PR #358, head 4f4ece89af51a345c0e71cb3876278789a4f3896) for the disposable-PG17 runs ONLY. NOT G5's code:
-- this baseline lacks F5 P1's lifecycle_version and PR #303's owner epoch, so the two monotonic counters are modelled here with the SAME
-- movement rules G5 documents, and the two functions keep G5's exact signatures, shape and decision order:
--   lifecycle_version (per user)  moves on every insert / update / delete of the user's service_entitlements and on every common_accounts
--                                 status change -- never back (an end + restart, even inside one transaction, is a NEW generation)
--   owner epoch (per workspace)   moves on every insert / update / delete of an 'owner' brand_memberships row (A -> B -> A is a NEW epoch)
--   R1 public.common_account_authorization_verdict(app, feature, brand) -> jsonb   allow + owner_epoch 'g5oe:<epoch>:<lifecycle_version>'
--      only when F5 P5's brand state is 'active' and the caller (auth.uid()) is the workspace's single owner; otherwise deny, no token
--   W1 private.account_lifecycle_worker_brand_verdict(brand, 'x_autopost', epoch, lifecycle_version) -> text   G5's body, counters from here
-- Applied as the schema owner BEFORE candidate 007 (its precondition requires R1 / W1). Fake data only.
create schema t_g5;
create table t_g5.lifecycle (user_id uuid primary key, v bigint not null check (v >= 1));
create table t_g5.owner_epoch (brand_id text primary key, v bigint not null check (v >= 1));

create function t_g5.bump_lifecycle() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
begin
  if tg_table_name = 'common_accounts' and tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;
  insert into t_g5.lifecycle (user_id, v) values (v_user, 1)
  on conflict (user_id) do update set v = t_g5.lifecycle.v + 1;
  return null;
end $$;
create trigger t_g5_lifecycle_entitlements after insert or update or delete on public.service_entitlements
  for each row execute function t_g5.bump_lifecycle();
create trigger t_g5_lifecycle_accounts after insert or update on public.common_accounts
  for each row execute function t_g5.bump_lifecycle();

create function t_g5.bump_epoch() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_brand text := case when tg_op = 'DELETE' then old.brand_id else new.brand_id end;
begin
  if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
    insert into t_g5.owner_epoch (brand_id, v) values (v_brand, 1)
    on conflict (brand_id) do update set v = t_g5.owner_epoch.v + 1;
  end if;
  return null;
end $$;
create trigger t_g5_epoch_memberships after insert or update or delete on public.brand_memberships
  for each row execute function t_g5.bump_epoch();
-- existing rows start at 1
insert into t_g5.lifecycle (user_id, v) select a.user_id, 1 from public.common_accounts a on conflict do nothing;
insert into t_g5.owner_epoch (brand_id, v) select distinct m.brand_id, 1 from public.brand_memberships m where m.role = 'owner' on conflict do nothing;

create function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- G5_R1_TEST_DOUBLE
declare v_user uuid := auth.uid(); v_state text; v_owner uuid; v_epoch bigint; v_lifecycle bigint;
        v_scope jsonb := pg_catalog.jsonb_build_object('app', p_app, 'feature', p_feature, 'brand_slug', p_brand_id);
begin
  if p_app is distinct from 'postona' or p_feature is null
     or p_feature not in ('read_workspace', 'x_connect', 'x_publish', 'threads_connect', 'threads_publish', 'consult', 'post_generation') then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'FEATURE_NOT_ENABLED', 'scope', v_scope, 'owner_epoch', null);
  end if;
  if v_user is null then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', 'AUTH_REQUIRED', 'scope', v_scope, 'owner_epoch', null);
  end if;
  select public.common_account_brand_service_state(p_brand_id, 'x_autopost'), private.account_lifecycle_brand_owner(p_brand_id),
         (select e.v from t_g5.owner_epoch e where e.brand_id = p_brand_id),
         (select l.v from t_g5.lifecycle l where l.user_id = v_user)
    into v_state, v_owner, v_epoch, v_lifecycle;
  if v_state is distinct from 'active' or v_owner is distinct from v_user then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'reason', coalesce(v_state, 'SERVICE_STATE_UNKNOWN'), 'scope', v_scope, 'owner_epoch', null);
  end if;
  if v_epoch is null or v_lifecycle is null then
    return pg_catalog.jsonb_build_object('v', 1, 'decision', 'unknown', 'reason', 'OWNER_EPOCH_UNAVAILABLE', 'scope', v_scope, 'owner_epoch', null);
  end if;
  return pg_catalog.jsonb_build_object('v', 1, 'decision', 'allow', 'reason', null, 'scope', v_scope,
    'owner_epoch', 'g5oe:' || v_epoch::text || ':' || v_lifecycle::text, 'entitlements', '["postona:x_autopost"]'::jsonb);
end $$;

create function private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)
returns text language plpgsql stable security definer set search_path = '' as $$
-- G5_W1_TEST_DOUBLE (G5 PR #358's body; the epoch and lifecycle_version come from this double's counters)
declare v_state text; v_epoch bigint; v_lifecycle bigint;
begin
  if p_service_key is distinct from 'x_autopost' then return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID'; end if;
  if p_expected_owner_epoch is null or p_expected_owner_epoch < 1 then return 'EXPECTED_OWNER_EPOCH_REQUIRED'; end if;
  if p_expected_lifecycle_version is null or p_expected_lifecycle_version < 1 then return 'EXPECTED_LIFECYCLE_VERSION_REQUIRED'; end if;
  select public.common_account_brand_service_state(p_brand_id, p_service_key),
         (select e.v from t_g5.owner_epoch e where e.brand_id = p_brand_id),
         (select l.v from t_g5.lifecycle l where l.user_id = private.account_lifecycle_brand_owner(p_brand_id))
    into v_state, v_epoch, v_lifecycle;
  if v_state is distinct from 'active' then
    return case when v_state in ('WORKSPACE_OWNER_UNKNOWN', 'ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND', 'ACCOUNT_DELETION_IN_PROGRESS', 'ACCOUNT_LOCKED',
                                 'SERVICE_NOT_REGISTERED', 'SERVICE_DELETION_IN_PROGRESS', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LIFECYCLE_SERVICE_INVALID')
                then v_state else 'SERVICE_STATE_UNKNOWN' end;
  end if;
  if v_epoch is null or v_epoch < 1 then return 'OWNER_EPOCH_UNAVAILABLE'; end if;
  if v_epoch <> p_expected_owner_epoch then return 'OWNER_EPOCH_CHANGED'; end if;
  if v_lifecycle is distinct from p_expected_lifecycle_version then return 'SERVICE_GENERATION_CHANGED'; end if;
  return 'active';
end $$;

revoke all on function public.common_account_authorization_verdict(text, text, text),
  private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint), t_g5.bump_lifecycle(), t_g5.bump_epoch()
  from public, anon, authenticated, service_role;
grant execute on function public.common_account_authorization_verdict(text, text, text) to authenticated;
revoke all on table t_g5.lifecycle, t_g5.owner_epoch from public, anon, authenticated, service_role;
