-- Fake-only, applied by postona_social_accounts_multi_provider_run.sh on top of an existing fixture
-- and its real prerequisite migrations, right before the candidate
-- (20261007150000_postona_social_accounts_multi_provider.sql). The shared fixtures grant every app
-- role everything by default and leave RLS off; production does not. This gives public.social_accounts
-- the access shape the candidate requires and production is expected to have:
--   RLS on (not forced) with the member read policy of 20260918120000;
--   anon: nothing (20260918120000 revokes SELECT);
--   authenticated: SELECT, no INSERT / UPDATE / DELETE (production read-only S0, 2026-10-06), and
--     no TRUNCATE (not yet read from production; the candidate refuses if present);
--   service_role: as the fixture granted.
-- Apply to a disposable local database as the non-superuser table owner, never to production.
alter table public.social_accounts enable row level security;
revoke all on table public.social_accounts from anon;
revoke insert, update, delete, truncate on table public.social_accounts from authenticated;
grant select on table public.social_accounts to authenticated;
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
create schema postona_proof;
-- Fixed time zone: row timestamps are compared as text across sessions.
create function postona_proof.catalog() returns jsonb language sql stable set timezone = 'UTC' as $$
  select jsonb_build_object(
    'columns', (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull
                                  || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' order by a.attnum)
                from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.social_accounts'::regclass and a.attnum > 0 and not a.attisdropped),
    'table', (select coalesce(c.relacl::text, '') || '|' || c.relrowsecurity || '|' || c.relforcerowsecurity || '|' || c.relowner::regrole
              from pg_class c where c.oid = 'public.social_accounts'::regclass),
    'column_acl', (select coalesce(string_agg(a.attname || '=' || a.attacl::text, ',' order by a.attnum), '')
                   from pg_attribute a where a.attrelid = 'public.social_accounts'::regclass and a.attacl is not null),
    'policies', (select coalesce(string_agg(p.polname || ':' || p.polcmd::text || ':' || p.polroles::text || ':'
                                            || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ':'
                                            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), ',' order by p.polname), '')
                 from pg_policy p where p.polrelid = 'public.social_accounts'::regclass),
    'triggers', (select coalesce(string_agg(t.tgname || ':' || t.tgenabled::text, ',' order by t.tgname), '')
                 from pg_trigger t where t.tgrelid = 'public.social_accounts'::regclass and not t.tgisinternal),
    'indexes', (select coalesce(string_agg(pg_get_indexdef(i.indexrelid) || ':' || i.indisvalid, ',' order by pg_get_indexdef(i.indexrelid)), '')
                from pg_index i where i.indrelid = 'public.social_accounts'::regclass),
    'constraints', (select coalesce(string_agg(c.conname || '=' || pg_get_constraintdef(c.oid) || ':' || c.convalidated, ' | ' order by c.conname), '')
                    from pg_constraint c where c.conrelid = 'public.social_accounts'::regclass),
    'rows', (select md5(coalesce(string_agg(to_jsonb(sa)::text, ',' order by sa.id), '')) from public.social_accounts sa))
$$;
