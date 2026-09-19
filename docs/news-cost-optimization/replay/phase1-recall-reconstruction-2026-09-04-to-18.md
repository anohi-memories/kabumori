# Phase 1 recall replay manifest (read-only reconstruction)

- Created: 2026-09-19 UTC
- Production project: `wsmznyzcvmuitkglfeuj`
- Baseline: explicit equivalent cohort, not asserted to be the missing original 19-row Web Search audit.
- Cohort selection: every `breaking_market` candidate with final `important`/`most_important` fetched from 2026-09-04 00:00 UTC through 2026-09-15 23:59:59 UTC: 19 rows. The schema does not attribute `source_type=breaking_market` rows to a specific discovery provider, so exact equivalence to the original Web Search-derived 19 cannot be proven.
- The Sep 18 BOJ event is listed as a supplemental row, outside the denominator.

## Result

- Historical legacy ground truth is reconstructed: 19 stable candidate UUIDs, entity keys, category/topic, importance, source URL, published time, and `fetched_at` are in the CSV.
- Legacy publication-to-fetch lags were independently calculated from those two production timestamps. These are not proposed-route delay metrics.
- Replacement-route `first_seen_at` is unavailable for all 19 cases. Current GDELT API retrieval was inaccessible in this environment; no historic collector logs or exact query→result timestamps were found. Search-engine visibility and source publication dates do not establish when a collector ingested the source.
- Therefore replacement recall/delay is **unproven for 19/19** in this reconstruction. No 12/19, 2 delayed, or 5 unknown split is independently revalidated. Keep legacy paid search fallback for every represented lane; no paid-search reduction/cutover is supported.
- Israel/Hezbollah (+45m): AP published at 06:35:26Z and legacy fetched at 07:00:23Z (24m57s legacy lag). The Al Jazeera page is date-only (Sep 5); no exact replacement-route first-seen exists. The inherited +45m cannot be independently computed.
- Mayun/Perim (+7h): AP published at 11:29:23Z and legacy fetched at 14:20:20Z (2h50m57s legacy lag). The Guardian article was first published 08:00 EDT / 12:00Z, 30m37s after AP publication and 2h20m20s before legacy fetch. That is source-publication evidence only, not GDELT/collector ingestion time; it does not prove a replacement-route detection delay. The inherited +7h cannot be independently computed.
- The 19-row manifest is a conservative evidence set, not a replay pass. The 70% search-reduction goal remains subordinate to recall.

## How to read the CSV

- `published_at_utc`: candidate's source publication timestamp recorded in production.
- `legacy_fetched_at_utc`: production `important_news_candidates.fetched_at`, not a separately instrumented detection timestamp.
- `legacy_fetch_lag`: independently calculated as fetched minus published; negative or cross-day cases retain the raw timestamps.
- `new_route_first_seen_at_utc`: blank means no historical ingestion timestamp was evidenced.
- `new_route_result=unproven`: absence of route evidence, not a claim that the route missed the event.
- `replay_aliases`: suggested entity/topic aliases for a future controlled replay only; not a record of executed searches.
- `fallback_required=yes`: retain the current legacy paid-search lane until deterministic historical replay or shadow evidence proves parity.

## Supplemental source evidence for the delayed cases

- AP Israel–Hezbollah source: https://apnews.com/article/6a083aa8bd1372c2ad25571e58d82a25 (source page timestamp 2026-09-05 06:35:26 UTC).
- Al Jazeera Ali al-Taher story (date-only evidence): https://www.aljazeera.com/amp/news/2026/9/5/israel-claims-control-of-lebanons-key-ali-al-taher-ridge-what-that-means.
- AP Mayun/Perim source: https://apnews.com/article/476237dd3bf568d946d2b16c7b45a687 (source page timestamp 2026-09-11 11:29:23 UTC).
- Guardian Mayun story: https://www.theguardian.com/world/2026/sep/11/iran-houthi-allies-capture-strategic-island-bab-al-mandab-strait (page says first published Fri Sep 11 08:00 EDT = 12:00 UTC).

## Production / scope

Read-only SELECTs only. No candidate insertion/update, replay invocation, OpenAI call, migration, function deploy, Cron mutation, X post, or other production mutation. Current read-back: `important-news-fetch` remains jobid 2, active, `0,20,40 * * * *`, command length 845 / MD5 `b9a98c88ada68d0552ac66c9e8e19983`; `important-news-monitor` remains ACTIVE v58, `verify_jwt=false`, SHA256 `ce7b4bf79da6fb35f8593c4a692ef125acdbdb0ed26c189a761f15eeb5a4070f`. See current task report for usage/monitor run read-back.
