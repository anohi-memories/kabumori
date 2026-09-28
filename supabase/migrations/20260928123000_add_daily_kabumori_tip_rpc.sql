-- Home "今日のトピック": a narrow, read-only RPC over the existing public.tips
-- table (unrelated to public.useful_tips / the X useful-tip scheduler). The
-- table itself stays closed to authenticated -- only this function is
-- grantable, and it returns just the columns the app needs.
--
-- Deterministic by design: the same (p_jst_date, p_level) pair always
-- returns the same row, so pull-to-refresh never changes today's topic and
-- nothing here calls an LLM or mutates use_count/last_used_at.
create or replace function public.get_daily_kabumori_tip(p_level text, p_jst_date date)
returns table (
  id uuid,
  title text,
  category text,
  base_text text,
  difficulty text
)
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select case p_level
      when 'beginner' then '初級'
      when 'intermediate' then '中級'
      when 'advanced' then '実践'
      -- Any other value fails closed: target.difficulty is null, so the join
      -- below matches nothing and the function returns zero rows.
      else null
    end as difficulty
  ),
  eligible as (
    select
      t.id, t.title, t.category, t.base_text, t.difficulty,
      row_number() over (order by t.id) as rn,
      count(*) over () as total
    from public.tips t, target
    where t.is_active and t.difficulty = target.difficulty
  )
  select id, title, category, base_text, difficulty
  from eligible
  where total > 0
    -- hashtext() returns a signed int4; abs(-2147483648::int4) overflows
    -- int4's range and raises "integer out of range". Casting to bigint
    -- first keeps the same deterministic value but makes abs() safe (bigint
    -- comfortably holds 2147483648).
    and rn = (abs(hashtext(p_jst_date::text || ':' || p_level)::bigint) % total) + 1
$$;

revoke all on function public.get_daily_kabumori_tip(text, date) from public, anon;
grant execute on function public.get_daily_kabumori_tip(text, date) to authenticated;
