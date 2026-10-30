#!/usr/bin/env python3
"""Applies candidate fixes (text edits on the generated RPC SQL) for the OFFLINE comparison only. Each edit must match
exactly once, otherwise the script fails: a variant can never silently be a no-op."""
import sys, pathlib

path, names = pathlib.Path(sys.argv[1]), sys.argv[2].split(",")
text = path.read_text()

def once(old: str, new: str) -> None:
    global text
    if text.count(old) != 1:
        raise SystemExit(f"variant edit must match exactly once, got {text.count(old)}: {old[:60]!r}")
    text = text.replace(old, new)

for name in names:
    if name == "v1_domestic_high_for_all":
        # critical / high market-wide news with a passed Fact reaches every user, with or without a tracked sector.
        once("where candidate.effective_severity = 'emergency' or ranked.id is not null",
             "where candidate.effective_severity = 'emergency' or ranked.id is not null\n"
             "       or (candidate.effective_severity in ('critical', 'high')\n"
             "           and (candidate.status = 'published' or candidate.fact_check_status = 'passed'))")
    elif name == "v2_domestic_themes":
        once("""    (7, 'rates',""", """    (8, 'financial_regulation',
      t ~* '金融庁|行政処分|業務改善命令|課徴金|金融機関|銀行|証券会社|保険会社|金融システム'),
    (9, 'domestic_disaster',
      t ~* '地震|震度|津波|噴火|台風|豪雨|停電|大規模災害'),
    (10, 'cyber_outage',
      t ~* 'サイバー|システム障害|決済障害|情報漏えい|情報漏洩|不正アクセス'),
    (7, 'rates',""")
        once("""    ('rates', '銀行業'),""", """    ('financial_regulation', '銀行業'), ('financial_regulation', '保険業'),
    ('financial_regulation', '証券、商品先物取引業'), ('financial_regulation', 'その他金融業'),
    ('domestic_disaster', '建設業'), ('domestic_disaster', '電気・ガス業'), ('domestic_disaster', '保険業'),
    ('cyber_outage', '情報・通信業'), ('cyber_outage', '銀行業'), ('cyber_outage', 'その他金融業'),
    ('rates', '銀行業'),""")
    elif name == "v3_base_excludes_rejected":
        # make the base market feed treat rejected rows like the wrapper already does (tdnet / company_ir only).
        once("""    from candidates as news
    where (select auth.uid()) is not null
      and news.company_code is null
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')""",
             """    from candidates as news
    where (select auth.uid()) is not null
      and news.company_code is null
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir'))""")
    elif name == "v3b_base_excludes_rejected_except_emergency":
        # as v3, but a rejected EMERGENCY item (e.g. an earthquake judged no_post for X) stays visible.
        once("""    from candidates as news
    where (select auth.uid()) is not null
      and news.company_code is null
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')""",
             """    from candidates as news
    where (select auth.uid()) is not null
      and news.company_code is null
      and news.effective_severity in ('emergency', 'critical', 'high', 'medium')
      and (news.status <> 'rejected' or news.source_type in ('tdnet', 'company_ir') or news.effective_severity = 'emergency')""")
    elif name in ("j1b2_a", "j1b2_b", "j1b2_c"):
        candidate = (pathlib.Path(__file__).resolve().parent / "candidate" /
                     "20261013_J1B2_news_feed_domestic_visibility_CANDIDATE.sql").read_text()
        if name == "j1b2_b":
            old = """    where (
        ranked.id is not null
        or exists ("""
            new = """    where (
        ranked.id is not null
        or candidate.effective_severity in ('critical', 'high')
        or exists ("""
            if candidate.count(old) != 1:
                raise SystemExit("j1b2_b edit must match exactly once")
            candidate = candidate.replace(old, new)
        if name == "j1b2_c":
            # additionally hide base-feed rows that are rejected, non-emergency and outside the official allowance
            old = """  with base_feed as (
    select * from public.get_my_important_stock_news_phase5_base(50)
  ),"""
            new = """  with base_feed as (
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
  ),"""
            if candidate.count(old) != 1:
                raise SystemExit("j1b2_c edit must match exactly once")
            candidate = candidate.replace(old, new)
        text = text + "\n" + candidate
    else:
        raise SystemExit(f"unknown variant {name}")

path.write_text(text)
