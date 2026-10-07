-- Fake-only, applied by postona_social_accounts_multi_provider_run.sh on top of an existing fixture
-- and its real prerequisite migrations, right before the candidate
-- (20261007150000_postona_social_accounts_multi_provider.sql). The shared fixtures grant every app
-- role everything by default and leave RLS off; production does not. This gives public.social_accounts
-- the access shape of the candidate's reviewed starting contract:
--   RLS on (not forced) with the member read policy of 20260918120000;
--   anon: nothing (20260918120000 revokes SELECT);
--   authenticated: SELECT only (production read-only S0, 2026-10-06: no INSERT / UPDATE / DELETE; the
--     rest of its production ACL is not yet read and the candidate refuses anything more);
--   service_role: the fixture's grants minus TRIGGER (the candidate refuses TRIGGER).
-- Apply to a disposable local database as the non-superuser table owner, never to production.
alter table public.social_accounts enable row level security;
revoke all on table public.social_accounts from anon, authenticated;
grant select on table public.social_accounts to authenticated;
revoke trigger on table public.social_accounts from service_role;
create policy social_mobile_member_select_social_accounts
  on public.social_accounts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.brand_memberships as bm
      where bm.brand_id = social_accounts.brand_id
        and bm.user_id = (select auth.uid())
    )
  );

-- Proof-only helper outside public: everything about public.social_accounts the candidate may or may
-- not change, as one comparable value. The runner compares it around every refused apply; the
-- behavior proof compares it around the applied one.
-- Fixed time zone: row timestamps are compared as text across sessions.
create schema postona_proof;
create function postona_proof.catalog() returns jsonb language sql stable set timezone = 'UTC' as $$
  select jsonb_build_object(
    'columns', (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
                                  || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attcollation, ',' order by a.attnum)
                from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.social_accounts'::regclass and a.attnum > 0 and not a.attisdropped),
    'table', (select coalesce(c.relacl::text, '') || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relowner::regrole
              from pg_class c where c.oid = 'public.social_accounts'::regclass),
    'column_acl', (select coalesce(string_agg(a.attname || '=' || a.attacl::text, ',' order by a.attnum), '')
                   from pg_attribute a where a.attrelid = 'public.social_accounts'::regclass and a.attacl is not null),
    'policies', (select coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polpermissive || ':' || p.polroles::text || ':'
                                            || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
                                            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), ',' order by p.polname), '')
                 from pg_policy p where p.polrelid = 'public.social_accounts'::regclass),
    'triggers', (select coalesce(string_agg(pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text || ':' || md5(p.prosrc)
                                            || ':' || p.prosecdef || ':' || coalesce(p.proconfig::text, ''), ',' order by t.tgname), '')
                 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                 where t.tgrelid = 'public.social_accounts'::regclass and not t.tgisinternal),
    'functions', (select coalesce(string_agg(p.oid::regprocedure::text || ':' || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text), '')
                  from pg_proc p where p.proname = 'social_accounts_provider_guard'),
    'indexes', (select coalesce(string_agg(pg_get_indexdef(i.indexrelid) || ':' || i.indisvalid || i.indisready || i.indislive,
                                           ',' order by pg_get_indexdef(i.indexrelid)), '')
                from pg_index i where i.indrelid = 'public.social_accounts'::regclass),
    'constraints', (select coalesce(string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated, ' | ' order by c.conname), '')
                    from pg_constraint c where c.conrelid = 'public.social_accounts'::regclass),
    'memberships', (select coalesce(string_agg(m.roleid::regrole || '>' || m.member::regrole || ':' || m.inherit_option || m.set_option,
                                               ',' order by m.roleid::regrole::text, m.member::regrole::text), '')
                    from pg_auth_members m
                    where m.member in ('anon'::regrole, 'authenticated'::regrole, 'service_role'::regrole)
                       or m.roleid = 'service_role'::regrole),
    'rows', (select md5(coalesce(string_agg(to_jsonb(sa)::text, ',' order by sa.id), '')) from public.social_accounts sa))
$$;
