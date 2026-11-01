-- TEST DOUBLES (G3-38) of G5's R1 / W1 for the X reservation runners ONLY (disposable PG17): NOT G5's code and no evidence about G5.
-- G5's real R1 / W1 read F5's lifecycle_version and the owner epoch of PR #285 / #303 / #457 (independent review still open); this
-- double keeps their signatures and the one rule the X candidates rely on:
--   owner epoch (per workspace)  moves on every insert / update / delete of an 'owner' brand_memberships row (A -> B -> A is a NEW epoch);
--                                a workspace never changed reads 1, its first change makes it 2
--   lifecycle version            a constant 1 here (G5's restart rule is not modelled: see G3's fuller double for Threads)
--   R1 public.common_account_authorization_verdict(app, feature, brand) -> allow + 'g5oe:<epoch>:1' exactly when the caller (auth.uid())
--      owns the workspace now; otherwise deny, no token
--   W1 private.account_lifecycle_worker_brand_verdict(brand, key, epoch, lifecycle) -> 'active' only for the current epoch and 1
-- Applied by the schema owner; fake data only.
create schema if not exists private;
create schema t_g5x;
create table t_g5x.owner_epoch (brand_id text primary key, v bigint not null check (v >= 1));
create function t_g5x.bump_owner_epoch() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_brand text := case when tg_op = 'DELETE' then old.brand_id else new.brand_id end;
begin
  if (tg_op <> 'INSERT' and old.role = 'owner') or (tg_op <> 'DELETE' and new.role = 'owner') then
    insert into t_g5x.owner_epoch (brand_id, v) values (v_brand, 2) on conflict (brand_id) do update set v = t_g5x.owner_epoch.v + 1;
  end if;
  return null;
end $$;
create trigger t_g5x_owner_epoch after insert or update or delete on public.brand_memberships for each row execute function t_g5x.bump_owner_epoch();
create function public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p_app = 'postona' and auth.uid() is not null
                   and exists (select 1 from public.brand_memberships m where m.brand_id = p_brand_id and m.user_id = auth.uid() and m.role = 'owner')
              then pg_catalog.jsonb_build_object('v', 1, 'decision', 'allow', 'owner_epoch',
                     'g5oe:' || coalesce((select e.v from t_g5x.owner_epoch e where e.brand_id = p_brand_id), 1) || ':1')
              else pg_catalog.jsonb_build_object('v', 1, 'decision', 'deny', 'owner_epoch', null) end $$;
create function private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_owner_epoch bigint, p_lifecycle_version bigint)
returns text language sql stable security definer set search_path = '' as $$
  select case when p_owner_epoch is distinct from coalesce((select e.v from t_g5x.owner_epoch e where e.brand_id = p_brand_id), 1) then 'OWNER_EPOCH_CHANGED'
              when p_lifecycle_version is distinct from 1 then 'SERVICE_GENERATION_CHANGED'
              else 'active' end $$;
revoke all on function public.common_account_authorization_verdict(text, text, text) from public, anon;
revoke all on function private.account_lifecycle_worker_brand_verdict(text, text, bigint, bigint) from public, anon;
