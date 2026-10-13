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
    else:
        raise SystemExit(f"unknown variant {name}")

path.write_text(text)
