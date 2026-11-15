-- S1 last statement, still inside the outer transaction: anything unexpected rolls everything back.
-- (The hardening file already asserts ACL/policy/function/trigger post-conditions; S2 re-reads them.)
do $guard$
begin
  if (select count(*) from supabase_migrations.schema_migrations
      where version in ('20260922045046', '20261003120000')) <> 2 then
    raise exception 'ACTIVATION_GUARD_POST: expected exactly two history rows';
  end if;
  if (select c.relowner from pg_class c where c.oid = to_regclass('public.social_mobile_content_settings'))
       is distinct from (select r.oid from pg_roles r where r.rolname = current_user) then
    raise exception 'ACTIVATION_GUARD_POST: the table is not owned by the applying role';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.social_mobile_content_settings')) then
    raise exception 'ACTIVATION_GUARD_POST: row level security is off';
  end if;
end;
$guard$;
