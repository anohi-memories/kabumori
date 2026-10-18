-- TEST-ONLY F5 STAND-IN. NEVER a candidate, NEVER applied outside a disposable local database. It stands in for the
-- workspace OWNER EPOCH that G4 asks F5 / G5 to own (J2 V2 R2 on PR #276; proposal in
-- docs/postona/x-identity-credential-m1-20261018.md section 7): a durable, monotonic per-workspace number that changes
-- on EVERY write touching an owner membership row (insert, update, delete), so an owner change A -> B -> A can never
-- be mistaken for "nothing changed". F4 / G4 does not own public.brand_memberships and adds nothing to it in any
-- candidate; this file exists only so G4's candidates can be proven against the proposed interface:
--   private.account_lifecycle_brand_owner_epoch(brand text) -> bigint   owner-only, STABLE, SECURITY DEFINER
create table private.account_lifecycle_workspace_owner_epochs (
  brand_id text primary key,
  epoch bigint not null check (epoch > 0)
);
revoke all on table private.account_lifecycle_workspace_owner_epochs from public, anon, authenticated, service_role;

create function private.account_lifecycle_owner_epoch_bump() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.role = 'owner' then
    insert into private.account_lifecycle_workspace_owner_epochs as e (brand_id, epoch) values (old.brand_id, 1)
    on conflict (brand_id) do update set epoch = e.epoch + 1;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.role = 'owner'
     and (tg_op = 'INSERT' or new.brand_id is distinct from old.brand_id or old.role is distinct from 'owner') then
    insert into private.account_lifecycle_workspace_owner_epochs as e (brand_id, epoch) values (new.brand_id, 1)
    on conflict (brand_id) do update set epoch = e.epoch + 1;
  end if;
  return null;
end $$;
create trigger account_lifecycle_owner_epoch after insert or update or delete on public.brand_memberships
  for each row execute function private.account_lifecycle_owner_epoch_bump();

create function private.account_lifecycle_brand_owner_epoch(p_brand_id text) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select e.epoch from private.account_lifecycle_workspace_owner_epochs e where e.brand_id = p_brand_id), 0)
$$;
revoke all on function private.account_lifecycle_owner_epoch_bump(), private.account_lifecycle_brand_owner_epoch(text)
  from public, anon, authenticated, service_role;
