#!/usr/bin/env python3
"""J1-b4: builds the PERFORMANCE candidate (review only, never applied).

Output = (1) `create or replace` of the feed-only base function with its same-event de-duplication rewritten from a pairwise
function call (`important_news_same_event`, evaluated for every pair, regex per pair) to a precomputed signature compared by
equality (hash anti-join), SAME SEMANTICS; (2) the PR #181 wrapper candidate with the same rewrite for its own market_unique
and a precomputed event key for domestic_unique. The shared function important_news_same_event itself is NOT touched (the Push
producers use it). The base function is used only by the wrapper (checked by the proof scripts).

Every edit must match exactly the expected number of times; otherwise the build fails (no silent no-op).
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parents[3]
BASE_MIGRATION = root / "supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql"
WRAPPER_CANDIDATE = root / "tools/jp-news-coverage/j1b/candidate/20261013_J1B2_news_feed_domestic_visibility_CANDIDATE.sql"

def extract_function(text: str, signature_re: str) -> str:
    m = re.search(signature_re, text)
    if not m:
        raise SystemExit(f"function not found: {signature_re}")
    return text[m.start(): text.index("\n$$;", m.start()) + len("\n$$;")]

def edit(text: str, old: str, new: str, expected: int = 1) -> str:
    found = text.count(old)
    if found != expected:
        raise SystemExit(f"edit expected {expected} match(es), found {found}: {old[:70]!r}")
    return text.replace(old, new)

SAME_EVENT_BASE = """        and public.important_news_same_event(other.category, other.title,
              coalesce(other.published_at, other.created_at), candidate.category, candidate.title,
              coalesce(candidate.published_at, candidate.created_at))"""
SAME_EVENT_WRAPPER = """        and public.important_news_same_event(
          other.category, other.title, coalesce(other.published_at, other.created_at),
          candidate.category, candidate.title, coalesce(candidate.published_at, candidate.created_at)
        )"""
EQUIVALENT = """        and other.category = candidate.category
        and other.event_sig is not null
        and other.event_sig = candidate.event_sig
        and abs(extract(epoch from (other.event_time - candidate.event_time))) <= 72 * 3600"""

# 1. base function
base = extract_function(BASE_MIGRATION.read_text(), r"create function public\.get_my_important_stock_news\(")
base = base.replace("create function public.get_my_important_stock_news(", "create or replace function public.get_my_important_stock_news_phase5_base(", 1)
base = edit(base, SAME_EVENT_BASE, EQUIVALENT)
base = edit(base, """      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as visible_app_title_ja,""",
"""      public.important_news_market_themes(news.category, news.title, news.affected_entities) as themes,
      public.important_news_number_signature(news.title) as event_sig,
      coalesce(news.published_at, news.created_at) as event_time,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,
      case when news.app_copy_fact_status = 'passed' then news.app_title_ja end as visible_app_title_ja,""")

# 2. wrapper candidate (PR #181) with the same rewrite
cand = WRAPPER_CANDIDATE.read_text()
head, wrapper = cand.split("create or replace function public.get_my_important_stock_news(p_limit integer default 50)", 1)
wrapper = "create or replace function public.get_my_important_stock_news(p_limit integer default 50)" + wrapper
# wrapper market_candidates (first occurrence, the one before market_unique)
wrapper = edit(wrapper, """      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,""",
"""      coalesce(news.coverage_severity, public.important_news_app_severity(
        news.importance, news.category, news.title, news.source_type, news.source_url,
        news.published_at, news.company_code, news.japan_market_relevance, news.fact_check_status
      )) as effective_severity,
      public.important_news_number_signature(news.title) as event_sig,
      coalesce(news.published_at, news.created_at) as event_time,
      case when news.generation_fact_status = 'passed' then news.generated_text end as verified_text,""", expected=2)
wrapper = edit(wrapper, SAME_EVENT_WRAPPER, EQUIVALENT)
# domestic: precomputed event key / time, equality join
wrapper = edit(wrapper, """    select
      candidate.*,
      public.important_news_feed_themes(candidate.category, candidate.title, candidate.affected_entities) as themes
    from market_candidates_all as candidate""",
"""    select
      candidate.*,
      public.important_news_feed_themes(candidate.category, candidate.title, candidate.affected_entities) as themes,
      public.important_news_feed_event_key(candidate.title) as event_key
    from market_candidates_all as candidate""")
wrapper = edit(wrapper, """        and public.important_news_feed_same_event(
          other.category, other.title, coalesce(other.published_at, other.created_at),
          candidate.category, candidate.title, coalesce(candidate.published_at, candidate.created_at)
        )
        and (coalesce(other.published_at, other.created_at), other.id)
          < (coalesce(candidate.published_at, candidate.created_at), candidate.id)""",
"""        and other.category = candidate.category
        and char_length(candidate.event_key) >= 8
        and other.event_key = candidate.event_key
        and abs(extract(epoch from (coalesce(other.published_at, other.created_at)
                                    - coalesce(candidate.published_at, candidate.created_at)))) <= 72 * 3600
        and (coalesce(other.published_at, other.created_at), other.id)
          < (coalesce(candidate.published_at, candidate.created_at), candidate.id)""")
wrapper = edit(wrapper, """        and public.important_news_feed_event_key(existing.title) = public.important_news_feed_event_key(candidate.title)
        and char_length(public.important_news_feed_event_key(candidate.title)) >= 8""",
"""        and public.important_news_feed_event_key(existing.title) = candidate.event_key
        and char_length(candidate.event_key) >= 8""")

out = ["-- J1-b4 PERFORMANCE CANDIDATE — REVIEW ONLY, never applied; generated by build_perf_candidate.py.",
       "-- Apply order: helpers (from the PR #181 candidate head) -> feed-only base -> wrapper.", head.rstrip().rsplit("begin;", 1)[0] if False else "",
       "begin;", ]
# keep the PR #181 helper functions (themes / sectors / event key / same event) and their revokes
helpers = head.split("begin;", 1)[1]
out.append(helpers.strip())
out.append(base)
out.append(wrapper.strip())
sys.stdout.write("\n\n".join(x for x in out if x) + "\n")
