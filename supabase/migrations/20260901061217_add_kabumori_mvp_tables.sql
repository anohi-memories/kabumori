create table if not exists public.stocks_master (
  id uuid primary key default gen_random_uuid(),
  ticker_code text not null,
  company_name text not null,
  market text not null default 'TSE',
  sector text,
  is_listed boolean not null default true,
  listed_at date,
  delisted_at date,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stocks_master_ticker_code_nonempty check (length(trim(ticker_code)) > 0),
  constraint stocks_master_company_name_nonempty check (length(trim(company_name)) > 0),
  constraint stocks_master_listing_dates_valid check (delisted_at is null or listed_at is null or delisted_at >= listed_at),
  constraint stocks_master_ticker_market_unique unique (ticker_code, market)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tracked_stocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  stock_id uuid not null references public.stocks_master(id) on delete restrict,
  tracking_type text not null,
  quantity numeric,
  average_price numeric,
  position_type text,
  side text,
  target_buy_price numeric,
  target_sell_price numeric,
  memo text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracked_stocks_tracking_type_check check (tracking_type in ('holding','watch')),
  constraint tracked_stocks_quantity_check check (quantity is null or quantity > 0),
  constraint tracked_stocks_average_price_check check (average_price is null or average_price >= 0),
  constraint tracked_stocks_position_type_check check (position_type is null or position_type in ('cash','margin')),
  constraint tracked_stocks_side_check check (side is null or side in ('long','short')),
  constraint tracked_stocks_target_buy_price_check check (target_buy_price is null or target_buy_price >= 0),
  constraint tracked_stocks_target_sell_price_check check (target_sell_price is null or target_sell_price >= 0),
  constraint tracked_stocks_user_stock_unique unique (user_id, stock_id)
);

create table if not exists public.alert_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  important_news boolean not null default true,
  earnings boolean not null default true,
  tdnet boolean not null default true,
  large_shareholding boolean not null default true,
  price_move boolean not null default true,
  morning_report boolean not null default true,
  close_report boolean not null default true,
  push_enabled boolean not null default true,
  email_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  tracked_stock_id uuid references public.tracked_stocks(id) on delete set null,
  source_type text not null,
  source_id text not null,
  title text not null,
  summary text not null,
  importance text not null default 'normal',
  push_status text not null default 'pending',
  read_at timestamptz,
  created_at timestamptz not null default now(),
  constraint notifications_importance_check check (importance in ('normal','important','most_important')),
  constraint notifications_push_status_check check (push_status in ('pending','sent','failed','skipped')),
  constraint notifications_source_nonempty check (length(trim(source_type)) > 0 and length(trim(source_id)) > 0),
  constraint notifications_dedupe unique (user_id, tracked_stock_id, source_type, source_id)
);

create index if not exists idx_stocks_master_company_name on public.stocks_master(company_name);
create index if not exists idx_stocks_master_listed on public.stocks_master(is_listed);
create index if not exists idx_tracked_stocks_user_active on public.tracked_stocks(user_id, is_active);
create index if not exists idx_tracked_stocks_stock_id on public.tracked_stocks(stock_id);
create index if not exists idx_notifications_user_created_at on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_unread on public.notifications(user_id, read_at) where read_at is null;

create or replace function public.kabumori_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.kabumori_set_updated_at();

drop trigger if exists trg_tracked_stocks_updated_at on public.tracked_stocks;
create trigger trg_tracked_stocks_updated_at
before update on public.tracked_stocks
for each row execute function public.kabumori_set_updated_at();

drop trigger if exists trg_alert_settings_updated_at on public.alert_settings;
create trigger trg_alert_settings_updated_at
before update on public.alert_settings
for each row execute function public.kabumori_set_updated_at();

drop trigger if exists trg_stocks_master_updated_at on public.stocks_master;
create trigger trg_stocks_master_updated_at
before update on public.stocks_master
for each row execute function public.kabumori_set_updated_at();

alter table public.stocks_master enable row level security;
alter table public.profiles enable row level security;
alter table public.tracked_stocks enable row level security;
alter table public.alert_settings enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "stocks_master_authenticated_read" on public.stocks_master;
create policy "stocks_master_authenticated_read"
on public.stocks_master for select
to authenticated
using (true);

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
to authenticated
using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
on public.profiles for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "tracked_stocks_select_own" on public.tracked_stocks;
create policy "tracked_stocks_select_own"
on public.tracked_stocks for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "tracked_stocks_insert_own" on public.tracked_stocks;
create policy "tracked_stocks_insert_own"
on public.tracked_stocks for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "tracked_stocks_update_own" on public.tracked_stocks;
create policy "tracked_stocks_update_own"
on public.tracked_stocks for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "tracked_stocks_delete_own" on public.tracked_stocks;
create policy "tracked_stocks_delete_own"
on public.tracked_stocks for delete
to authenticated
using (auth.uid() = user_id);

drop policy if exists "alert_settings_select_own" on public.alert_settings;
create policy "alert_settings_select_own"
on public.alert_settings for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "alert_settings_insert_own" on public.alert_settings;
create policy "alert_settings_insert_own"
on public.alert_settings for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "alert_settings_update_own" on public.alert_settings;
create policy "alert_settings_update_own"
on public.alert_settings for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own"
on public.notifications for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own"
on public.notifications for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
