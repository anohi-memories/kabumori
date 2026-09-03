create table if not exists public.us_premarkarket_report_settings (
  id boolean primary key default true check (id),
  is_active boolean not null default false,
  summer_window_start time not null default '21:50',
  summer_window_end time not null default '22:10',
  winter_window_start time not null default '22:50',
  winter_window_end time not null default '23:10',
  timezone text not null default 'Asia/Tokyo',
  collision_minutes integer not null default 20 check (collision_minutes between 0 and 120),
  max_resamples integer not null default 40 check (max_resamples between 1 and 100),
  updated_at timestamptz not null default now()
);
