-- G3 TASK 29 gate self-check (TEST-ONLY, throw-away local database; never a product candidate, never applied anywhere else).
-- A crude owner-epoch + X-identity binding in the shape Threads 007 uses (PR #360): every owner-row change of a brand bumps the
-- brand's epoch; a reservation remembers the epoch and the X platform_user_id it was made under; row_publishable also requires both
-- to be unchanged. Applied with EF_PATCH_SQL, the four PROPOSED gaps (E2 E3 E4 E8) must disappear and run.sh must fail with
-- "the PROPOSED gaps changed" -- proof that the gate notices when the gaps close. It is NOT the proposed design (G5's owner epoch,
-- PR #457, and G4's connection epoch decide that).
create schema t_selfcheck;
create table t_selfcheck.owner_epoch (brand_id text primary key, epoch bigint not null);
create table t_selfcheck.bound (reservation_id uuid primary key, owner_epoch bigint not null, platform_user_id text);

create function t_selfcheck.bump() returns trigger language plpgsql as $$
begin
  insert into t_selfcheck.owner_epoch as e (brand_id, epoch)
  values (coalesce(new.brand_id, old.brand_id), 1)
  on conflict (brand_id) do update set epoch = e.epoch + 1;
  if tg_op = 'UPDATE' and old.brand_id is distinct from new.brand_id then
    insert into t_selfcheck.owner_epoch as e (brand_id, epoch) values (old.brand_id, 1) on conflict (brand_id) do update set epoch = e.epoch + 1;
  end if;
  return null;
end $$;
create trigger t_selfcheck_bump after insert or update or delete on public.brand_memberships for each row execute function t_selfcheck.bump();

create function t_selfcheck.bind() returns trigger language plpgsql as $$
begin
  insert into t_selfcheck.bound values (new.id,
    coalesce((select epoch from t_selfcheck.owner_epoch where brand_id = new.brand_id), 0),
    (select platform_user_id from public.social_accounts where id = new.social_account_id));
  return null;
end $$;
create trigger t_selfcheck_bind after insert on postona_x_resv.reservations for each row execute function t_selfcheck.bind();

-- the 001 body (PR #392's head, 001:543-563) plus the two bound-value checks
create or replace function postona_x_resv.row_publishable(p_row postona_x_resv.reservations) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_row.origin <> 'user_authored' then
    return false;
  end if;
  if p_row.consent_state <> 'confirmed' or p_row.consent_sha256 is distinct from p_row.content_sha256
     or p_row.consent_scheduled_at is distinct from p_row.scheduled_at or p_row.consent_revision is distinct from p_row.revision then
    return false;
  end if;
  if not exists (select 1 from public.brand_memberships bm
                 where bm.brand_id = p_row.brand_id and bm.user_id = p_row.user_id and bm.role = 'owner') then
    return false;
  end if;
  if not exists (select 1 from public.social_accounts sa where sa.id = p_row.social_account_id and sa.brand_id = p_row.brand_id and sa.platform = 'x') then
    return false;
  end if;
  if not exists (select 1 from t_selfcheck.bound b
                 where b.reservation_id = p_row.id
                   and b.owner_epoch = coalesce((select e.epoch from t_selfcheck.owner_epoch e where e.brand_id = p_row.brand_id), 0)
                   and b.platform_user_id is not distinct from (select sa.platform_user_id from public.social_accounts sa where sa.id = p_row.social_account_id)) then
    return false;  -- unknown binding or a changed owner epoch / X identity -> refuse (fail closed)
  end if;
  return postona_x_resv.g5_x_autopost_allowed(p_row.user_id) is true
     and postona_x_resv.g4_x_account_verified(p_row.user_id, p_row.social_account_id) is true;
end $$;
