-- S1 first statement, inside the same outer transaction as both migrations and the history rows.
-- Re-checks at apply time what S0 checked, so nothing changed between preflight and apply.
do $guard$
begin
  if to_regclass('public.social_mobile_content_settings') is not null then
    raise exception 'ACTIVATION_GUARD_PRE: public.social_mobile_content_settings already exists';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
             and p.proname like 'social\_mobile\_content\_settings\_%') then
    raise exception 'ACTIVATION_GUARD_PRE: social_mobile_content_settings_* functions already exist';
  end if;
  if exists (select 1 from supabase_migrations.schema_migrations
             where version in ('20260922045046', '20261003120000')) then
    raise exception 'ACTIVATION_GUARD_PRE: a target history row already exists';
  end if;
  if (select r.rolsuper from pg_roles r where r.rolname = current_user) is distinct from false then
    raise exception 'ACTIVATION_GUARD_PRE: the applying role must be a non-superuser';
  end if;
  if (select c.relowner from pg_class c where c.oid = to_regclass('public.brands'))
       is distinct from (select r.oid from pg_roles r where r.rolname = current_user) then
    raise exception 'ACTIVATION_GUARD_PRE: the applying role must own public.brands';
  end if;
end;
$guard$;
