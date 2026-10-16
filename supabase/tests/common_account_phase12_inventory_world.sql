-- F5 Phase 12: a FAKE world with planted values, for proving that the schema inventory emits structure and never a value.
-- Every string below that starts with SENTINEL_ (and the number 7351902) is fake and must NEVER appear in an inventory.
-- Never applied anywhere but a throw-away local database. Run as the (non-super) owner role, after the platform stand-ins.
create table public.p12_sentinel_rows (
  id bigint generated always as identity primary key,
  note text not null default 'SENTINEL_COLUMN_DEFAULT_b81e',
  secret_note text,
  constraint p12_note_check check (note <> 'SENTINEL_CHECK_LITERAL_55d1')
);
insert into public.p12_sentinel_rows (secret_note) values ('SENTINEL_ROW_VALUE_7f3a9c');
create index p12_sentinel_idx on public.p12_sentinel_rows (note) where note <> 'SENTINEL_INDEX_PREDICATE_c9a2';
alter table public.p12_sentinel_rows enable row level security;
create policy p12_sentinel_policy on public.p12_sentinel_rows for select to authenticated
  using (note <> 'SENTINEL_POLICY_LITERAL_0e44') ;
create view public.p12_sentinel_view as select id from public.p12_sentinel_rows where note <> 'SENTINEL_VIEW_LITERAL_a3d0';
create sequence public.p12_sentinel_seq;
select setval('public.p12_sentinel_seq', 7351902);
-- p12_sentinel_fn (a function SET to a custom setting) needs a superuser to create: see the _super file
create function public.p12_net_fn() returns void language plpgsql as $f$
begin
  perform net.http_post('https://sentinel-host.example.test/SENTINEL_URL_PATH_c7d4', '{}'::jsonb);
end $f$;
create function public.p12_trigger_fn() returns trigger language plpgsql as $f$ begin return new; end $f$;
create trigger p12_sentinel_trigger before insert on public.p12_sentinel_rows for each row
  when (new.note <> 'SENTINEL_TRIGGER_LITERAL_61fa') execute function public.p12_trigger_fn();
create type public.p12_status as enum ('draft', 'live');
create domain public.p12_code as text default 'SENTINEL_DOMAIN_DEFAULT_3c6e' check (value <> 'SENTINEL_DOMAIN_CHECK_a17b');
comment on table public.p12_sentinel_rows is 'SENTINEL_TABLE_COMMENT_0d51';
insert into cron.job (jobname, schedule, command) values ('p12', '* * * * *', 'select net.http_post(''SENTINEL_CRON_COMMAND_e4f2'')');
insert into vault.secrets (name, secret) values ('p12', 'SENTINEL_VAULT_SECRET_6a90');
create publication p12_pub for table public.p12_sentinel_rows;
alter default privileges in schema public grant select on tables to authenticated;
