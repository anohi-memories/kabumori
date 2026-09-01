do $$
declare constraint_row record;
begin
  for constraint_row in
    select conname
    from pg_constraint
    where conrelid = 'public.important_news_candidates'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) ilike '%source_type%'
        or pg_get_constraintdef(oid) ilike '%source_priority%case%'
      )
  loop
    execute format(
      'alter table public.important_news_candidates drop constraint %I',
      constraint_row.conname
    );
  end loop;
end $$;

update public.important_news_candidates
set source_type = case
  when source_name = 'tdnet' then 'tdnet'
  when source_name in ('corporate_ir', 'company_ir') then 'company_ir'
  else source_type
end
where source_type in ('primary', 'secondary');

alter table public.important_news_candidates
  add constraint important_news_candidates_source_type_check
  check (source_type in ('tdnet', 'company_ir', 'primary', 'secondary'));

alter table public.important_news_candidates
  add constraint important_news_candidates_source_priority_consistency_check
  check (source_priority = case when source_type = 'secondary' then 2 else 1 end);

alter table public.important_news_candidates
  add column if not exists company_name text;

create table if not exists public.important_news_company_ir_sources (
  id uuid primary key default gen_random_uuid(),
  company_code text not null,
  company_name text not null,
  entity_key text not null,
  feed_url text not null unique check (feed_url ~ '^https://'),
  feed_format text not null check (feed_format in ('rss', 'json')),
  is_active boolean not null default false,
  last_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists important_news_company_ir_sources_active_idx
  on public.important_news_company_ir_sources (company_code)
  where is_active;

drop trigger if exists important_news_company_ir_sources_updated_at
  on public.important_news_company_ir_sources;
create trigger important_news_company_ir_sources_updated_at
before update on public.important_news_company_ir_sources
for each row execute function public.set_important_news_updated_at();

alter table public.important_news_company_ir_sources enable row level security;
revoke all on public.important_news_company_ir_sources from anon, authenticated;
grant select, insert, update on public.important_news_company_ir_sources to service_role;

-- Acquisition and manual verification only. Cron and publication remain disabled.
