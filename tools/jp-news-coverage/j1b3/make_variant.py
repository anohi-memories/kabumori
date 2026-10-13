#!/usr/bin/env python3
"""Emits the candidate migration text for variant a / b / c (same edits as j1b/apply_variant.py, each must match once)."""
import sys, pathlib
src = pathlib.Path(__file__).resolve().parents[1] / "j1b" / "candidate" / "20261013_J1B2_news_feed_domestic_visibility_CANDIDATE.sql"
text = src.read_text()
variant = sys.argv[1]

def once(old: str, new: str) -> None:
    global text
    if text.count(old) != 1:
        raise SystemExit(f"edit must match exactly once, got {text.count(old)}: {old[:50]!r}")
    text = text.replace(old, new)

if variant in ("b",):
    once("""    where (
        ranked.id is not null
        or exists (""", """    where (
        ranked.id is not null
        or candidate.effective_severity in ('critical', 'high')
        or exists (""")
elif variant == "c":
    once("""  with base_feed as (
    select * from public.get_my_important_stock_news_phase5_base(50)
  ),""", """  with base_feed as (
    select base.* from public.get_my_important_stock_news_phase5_base(50) as base
    where not exists (
      select 1 from public.important_news_candidates as c
      where c.id = base.news_id and c.status = 'rejected' and c.company_code is null
        and c.source_type not in ('tdnet', 'company_ir')
        and base.severity <> 'emergency'
        and not (c.fact_check_status = 'passed' and c.source_name = 'jp_official'
                 and (base.severity in ('critical', 'high')
                      or c.category in ('administrative_action', 'misconduct', 'litigation', 'major_security_incident')))
    )
  ),""")
elif variant == "m1":
    # MUTATION (proof that real_checks.sh notices): a helper becomes executable by app roles
    text += "\ngrant execute on function public.important_news_feed_event_key(text) to authenticated;\n"
elif variant == "m2":
    # MUTATION: a shared function used by the Push producers is changed (every theme now reaches every sector)
    text += """
create or replace function public.important_news_theme_sectors(p_themes text[])
returns text[] language sql immutable parallel safe set search_path = '' as $$
  select case when cardinality(coalesce(p_themes, '{}'::text[])) > 0 then array['輸送用機器','銀行業','食料品'] else '{}'::text[] end $$;
"""
elif variant != "a":
    raise SystemExit("variant must be a, b, c, m1 or m2")
sys.stdout.write(text)
