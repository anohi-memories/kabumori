create table if not exists public.tips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text,
  base_text text,
  image_url text,
  last_used_at timestamptz,
  use_count integer not null default 0 check (use_count >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.tips enable row level security;

grant select on table public.tips to service_role;

create or replace function public.mark_tip_used(p_tip_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.tips
  set last_used_at = now(), use_count = use_count + 1
  where id = p_tip_id;
$$;

revoke all on function public.mark_tip_used(uuid) from public;
grant execute on function public.mark_tip_used(uuid) to service_role;

insert into public.tips (title, category, base_text)
select seed.title, seed.category, seed.base_text
from (
  values
    ('PERって何？', '株の基礎', 'PERは株価を1株当たり利益（EPS）で割った指標。利益に対して株価が何倍まで買われているかを見る。業種や成長性と合わせて比較する。'),
    ('PBRって何？', '株の基礎', 'PBRは株価を1株当たり純資産（BPS）で割った指標。会社の純資産に対して株価が何倍かを見る。低さだけで判断しない。'),
    ('配当利回りって何？', '株の基礎', '配当利回りは1株当たり年間配当を株価で割った割合。高利回りでも減配や業績悪化の可能性があるため、配当方針や業績も確認する。')
) as seed(title, category, base_text)
where not exists (
  select 1 from public.tips existing where existing.title = seed.title
);
