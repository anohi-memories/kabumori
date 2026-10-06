-- Production preflight / read-back (read-only). How new public objects become reachable: API-role schema access,
-- the event triggers that run during the migration's DDL (PostgREST cache reload and any
-- Supabase hook that could grant or alter new objects), and the installed extensions
-- (pg_graphql also reflects tables the API roles can read).
select jsonb_build_object(
  'schema_usage', (
    select jsonb_object_agg(r || ':' || s, has_schema_privilege(r, s, 'USAGE'))
      from unnest(array['anon', 'authenticated', 'service_role']) r,
           unnest(array['public', 'private', 'graphql_public', 'storage', 'auth']) s
     where to_regnamespace(s) is not null),
  'event_triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', e.evtname, 'event', e.evtevent, 'enabled', e.evtenabled::text, 'tags', e.evttags,
             'owner', pg_get_userbyid(e.evtowner), 'function', e.evtfoid::regprocedure::text,
             'function_md5', md5(pg_get_functiondef(e.evtfoid)),
             'function_definition', pg_get_functiondef(e.evtfoid))
           order by e.evtname collate "C"), '[]'::jsonb)
      from pg_event_trigger e),
  'extensions', (
    select jsonb_agg(x.extname || ' ' || x.extversion || ' schema=' || n.nspname order by x.extname collate "C")
      from pg_extension x join pg_namespace n on n.oid = x.extnamespace),
  'publications', (
    select coalesce(jsonb_agg(p.pubname || ' all_tables=' || p.puballtables order by p.pubname collate "C"), '[]'::jsonb)
      from pg_publication p)
) as result;
