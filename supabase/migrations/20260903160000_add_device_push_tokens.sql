-- Push tokens live in their own table (not a column on profiles) so a user
-- can hold multiple tokens across devices/reinstalls without one overwriting another.
create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  expo_push_token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index device_push_tokens_user_id_idx on public.device_push_tokens (user_id);

alter table public.device_push_tokens enable row level security;

revoke all on public.device_push_tokens from anon;
grant select, insert, update, delete on public.device_push_tokens to authenticated;
grant select on public.device_push_tokens to service_role;

create policy "device_push_tokens_owner"
on public.device_push_tokens
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop trigger if exists trg_device_push_tokens_updated_at on public.device_push_tokens;
create trigger trg_device_push_tokens_updated_at
before update on public.device_push_tokens
for each row execute function public.kabumori_set_updated_at();
