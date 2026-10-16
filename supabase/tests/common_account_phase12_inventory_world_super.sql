-- F5 Phase 12: the part of the fake inventory world that needs a superuser (a role with a password, per-role / per-database
-- settings, a foreign server with option values and a user mapping). Fake values only; run on a throw-away local database.
-- psql variables: db (the database), owner (the owner role). Every SENTINEL_ value must never appear in an inventory.
create role kb_p12i_app login password 'SENTINEL_ROLE_PASSWORD_93cc' valid until '2099-01-01';
alter role kb_p12i_app set app.service_key = 'SENTINEL_ROLE_SETTING_88c3';
alter database :"db" set app.endpoint = 'SENTINEL_DATABASE_SETTING_2d9e';
create foreign data wrapper p12_fdw;
create server p12_server foreign data wrapper p12_fdw options (host 'SENTINEL_SERVER_HOST_5e1f', password 'SENTINEL_SERVER_PASSWORD_f0a1');
create user mapping for kb_p12i_app server p12_server options (user 'x', password 'SENTINEL_MAPPING_PASSWORD_77ab');
create foreign table public.p12_remote (a int) server p12_server options (table_name 'SENTINEL_FOREIGN_TABLE_OPTION_a1b2');
alter foreign table public.p12_remote owner to :"owner";
create function public.p12_sentinel_fn(p uuid) returns text language plpgsql security definer
  set search_path = public, pg_temp set app.p12_token = 'SENTINEL_FUNCTION_SETTING_4b12' as $f$
begin
  -- SENTINEL_FUNCTION_COMMENT_19ab
  return 'SENTINEL_FUNCTION_BODY_9d27';
end $f$;
alter function public.p12_sentinel_fn(uuid) owner to :"owner";
