# Codex Phase 1 shadow redesign (2026-09-19)

This is a new Codex design based on the H1 task and read-only production evidence. It is not a reconstruction of Claude's reported local replay artifacts. The original PHASE1_SHADOW_DESIGN.md and replay/ directory were absent from fresh origin/main at c3bc1bb064a2927dee93d1a6a9ea3e10d530c0f7.

## 1. Correct cadence and measured economics

Production schedule in the H1 source of truth is 12 fetch cycles/day through 2026-09-23 and 24/day from 2026-09-24. The nominal four search slots per cycle therefore mean 48 and 96 search slots/day; this replaces the obsolete 288/day estimate.

Four natural Phase 0 cycles visible in ai_usage_events and run diagnostics cost $0.051510, $0.062484, $0.060745, and $0.052145, with 4, 5, 5, and 4 actual web_search calls. Total: $0.226884 across 18 actual calls; observed mean: $0.056721 per cycle and 4.5 calls/cycle. The 4-call reference cycle remains $0.051510. This is only a four-cycle sample and is not a stable unit-price guarantee.

| Baseline | Nominal slots/day | Cost at $0.051510/cycle | Cost at observed $0.056721/cycle |
| --- | ---: | ---: | ---: |
| 2026-09-19–23, 12 cycles/day | 48 | $0.618120/day; $18.54/30d | $0.680652/day; $20.42/30d |
| From 2026-09-24, 24 cycles/day | 96 | $1.236240/day; $37.09/30d | $1.361304/day; $40.84/30d |

The last column is a sensitivity estimate from four natural cycles. It must be refreshed after a larger sample. Do not multiply nominal slots by unit cost and call it metered spend; telemetry shows one selected query can produce an extra web_search call.

Conditional-search examples using observed mean cost/search ($0.0126047 from 18 calls) are illustrative, not recall evidence:

| Proposed paid-search policy | Current 12 cycles/day | From 24 cycles/day | Nominal reduction vs 48/96 |
| --- | ---: | ---: | ---: |
| Existing 4 slots per cycle | 48/day | 96/day | 0% |
| One rotating sweep query per existing cycle | 12/day; about $4.54/30d | 24/day; about $9.08/30d | 75% |
| One targeted search in 25% of cycles | 3/day; about $1.13/30d | 6/day; about $2.27/30d | 93.75% |

These savings scenarios are not acceptable as cutover targets by themselves. A 10-minute free/official polling model is 144 free polls/day, with paid search added only by a trigger or unhealthy-source fallback. Every additional actual search call is budgeted at about $0.012605 using the small sample above. A hard daily call cap must never suppress an emergency fallback; exceeding budget should alert and preserve the legacy coverage path.

## 2. Production read-only evidence and source health

- No Phase 1 production mutation, migration, function deploy, or Cron change was made.
- important-news-monitor was observed ACTIVE at v58, verify_jwt=false, source SHA ce7b4bf79da6fb35f8593c4a692ef125acdbdb0ed26c189a761f15eeb5a4070f.
- Cron inventory read-only showed important-news-fetch job 2 active at 0,20,40 * * * *, with command MD5 b9a98c88ada68d0552ac66c9e8e19983. The runtime gate makes only the scheduled 2-hour collection ticks fetch; a later :20 tick completed with zero collected rows. Related judgement/generation/publish Cron definitions were unchanged.
- Read-only diagnostics from the prior seven-day window contain repeated HTTP 429 failures in paid search. For high-frequency query keys, critical_market_events, disaster_infrastructure, and japan_security_emergency each had 57 failures among 255 recorded query entries (22.4%). shipping_chokepoints had 8/30 (26.7%); bank_china_stimulus 7/27 (25.9%). These denominators are diagnostics entries, not unique incidents. Current code reports 429 failures and no usable calls/results; the evidence does not establish a working retry/backoff path.
- market_macro feed diagnostics mostly reported provider success; the Federal Reserve source had 4 HTTP 404 failures among 255 entries. A successful HTTP fetch with zero relevant items is not proof of fresh coverage. Persist per-feed last-success, newest-published timestamp, candidate count, HTTP status, and stale-age so silent staleness is detectable.
- GDELT remains an additional source only; never make it a hard dependency. HTTP 429, timeout, and parse errors must be distinct health states. Use bounded exponential backoff with jitter for transient requests; do not retry inside a single poll without a budget.

## 3. Historical replay: what is and is not proven

The three Claude artifacts specified by the task were checked against fresh main: PHASE1_SHADOW_DESIGN.md and replay/ are absent; AUDIT_AND_PLAN.md exists but retains outdated older cadence assumptions. The task carries aggregate facts (12/19 timely-or-better, 2 delayed, 5 unverified), but the exact 5-case replay manifest, alternate query terms, and per-source detection timestamps are not present on main. Accordingly, this handoff does not claim to have independently replayed those exact five cases, nor to have verified 19/19.

The two named delayed cases were independently cross-checked against production candidate rows and AP timestamps:
- Israel–Hezbollah / Ali Taher hill: AP published 2026-09-05 06:35:26 UTC; the old pipeline candidate was fetched 07:00:23 UTC. The task's inherited replay says the proposed free-source path was about 45 minutes slower. AP primary article: https://apnews.com/article/6a083aa8bd1372c2ad25571e58d82a25.
- Houthi capture of Mayun (Perim) island: AP published 2026-09-11 11:29:23 UTC; old pipeline fetched 14:20:20 UTC. The task's inherited replay says the proposed free-source path was about 7 hours slower. AP article: https://apnews.com/article/476237dd3bf568d946d2b16c7b45a687.
These inherited relative delays could not be independently recomputed without Claude's replay file. They remain known cutover blockers until the manifest is recovered or rebuilt and the full 19-row matrix is rerun.

### Query wording and alias plan (proposed; not replayed against paid search)

Because the exact historical five-case manifest is absent, these are reproducible query families to use once each original event and UTC window is recovered; they are not represented as five completed replays. Keep the event/place plus spelling variants together and require a source timestamp.

| Topic | Query wording to test | Alias and primary-source lanes |
| --- | --- | --- |
| War case A | “new Iran US Kuwait Israel military attack airstrike missile drone strike escalation ceasefire September 2026 official update” | Iran / Islamic Republic / IRGC; United States / US; CENTCOM, White House, UN News, AP/BBC/Al Jazeera |
| War case B | “new Russia Ukraine Kyiv strike pause attack ceasefire missile drone September 2026 official update” | Kyiv / Kyiv City Military Administration; Russian Federation / Kremlin; Ukraine Air Force, UN, AP/BBC/Al Jazeera. Replace entities with the exact recovered historical event before replay. |
| Tariff | “Canada US counter tariff surtax Section 338 Section 232 effective September 8 2026 Canada Gazette CBSA” | counter-tariff / retaliatory tariff / surtax / customs duty; Canada.ca Finance, CBSA, Canada Gazette, USTR, Federal Register |
| Shipping | “new tanker merchant vessel attack seizure Strait of Hormuz Bab el-Mandeb Red Sea shipping disruption September 2026” | Hormuz; Bab al-Mandab / Bab el-Mandeb; Mayun / Mayyun / Perim; Mokha / Mocha; UKMTO, CENTCOM, IMO, AP/BBC/Al Jazeera |
| Geopolitics | “new Houthi Ansar Allah Saudi pipeline island capture Red Sea Bab el-Mandeb September 2026” | Houthi / Ansar Allah / Yemen; Saudi Aramco / East-West pipeline; Mayun / Mayyun / Perim / Hanish; UN News, UKMTO, AP/BBC/Al Jazeera |
| Delayed Israel–Hezbollah | “Israel Hezbollah Ali Taher hill southern Lebanon ceasefire clashes shelling airstrike drone September 5 2026” | Ali Taher / Ali al-Taher; IDF / Israeli forces; Hezbollah / Hizbullah; UNIFIL, UN News, AP/BBC/Al Jazeera |
| Delayed Houthi island | “Houthis seize capture Mayun Mayyun Perim island Bab el-Mandeb Red Sea September 11 2026” | Ansar Allah; Mokha/Mocha; UKMTO, UN News, AP/BBC/Al Jazeera |

For each archived window, test at least one broad query and one precise alias query, compare official/primary and reputable wire results, and log first-published and first-seen UTC separately. Keep the topic's existing legacy query enabled unless every relevant archived case is proven recovered. The current paid query implementation makes one Responses request with max_tool_calls=1 and records HTTP 429 as failure; it does not retry that failed call. Proposed recovery is capped exponential backoff with jitter outside the same Cron invocation, plus a visible failed-source health flag and legacy topic fallback; retries must not multiply a single-run budget silently.

Representative official/alternate-source checks:
- Canada counter-tariff case: official Canada lists new U.S.-goods counter-tariffs effective 2026-09-08 and links applicable product details: https://www.canada.ca/en/department-finance/programs/international-trade-finance-policy/canadas-response-us-tariffs/complete-list-us-products-subject-to-counter-tariffs.html.
- BOJ 2026-09-18 publication index and decision PDFs are available from the official Bank of Japan page: https://www.boj.or.jp/mopo/mpmdeci/mpr_2026/index.htm.
These validate that strong primary pages exist, but do not prove a historical detector's first-seen timestamp. Do not count them as replay passes.

Ground-truth coverage from the production important/most_important candidate set (Sep 4–18) includes US-Iran fighting, Hormuz shipping, Israel-Hezbollah, a Kyiv strike pause, US strikes on Iranian oil tankers, Canada tariffs, Mayun/Bab-el-Mandeb, attacks on a Saudi pipeline, an Iranian vessel hit near Hormuz, Red Sea islands, FX, US payrolls, and BOJ. Because the exact five-case mapping is absent, no guess is assigned from this list. Keep the legacy paid fallback for war/geopolitics, tariffs/sanctions, maritime chokepoints, and any category with incomplete replay evidence.

## 4. Official-title/body-missing fix candidate

The confirmed root cause is in market_macro RSS normalization: RSS description/summary/content is read; an empty string becomes null; title and URL are still inserted as pending_judgement. The BOJ source rows fetched at 2026-09-18 03:00 UTC included the important “金融市場調節方針の変更について” PDF and had null body_summary. Official RSS successfully saw the item at 12:00 JST, but the source row itself did not contain enough decision text. The later breaking-market/AP candidate was fetched at 05:20 UTC (14:20 JST), matching the reported 2h20 recovery delay.

General candidate behavior:
1. Only market_macro/company_ir source types; high-signal normalized title; absent or <160-character body.
2. Exact HTTPS host allowlist, no credentials/non-default port/IP URL; redirect:error; do not follow redirects; HTML/XHTML only; PDFs stay on the existing TDNet/PDF path or an explicitly approved future PDF reader.
3. 15-second abort, 512 KiB streaming response ceiling, extracted text cap 6,000 chars, remove script/style/navigation boilerplate, require at least 160 readable characters.
4. If official body succeeds, attach it to the same candidate and only then pass it to the existing judgement pipeline.
5. On unsafe URL, fetch failure, HTTP error, non-HTML/PDF, empty, or oversized body: do not judge title-only. Run the existing targeted Web Search fallback using title + entities/aliases + country/region + event time. If fallback yields no corroborated evidence, do not insert the RSS item as pending_judgement; record a needs-review diagnostic and let later RSS polling retry. This avoids new status/schema values and does not create a stale pending row. No lowering of no_post thresholds.
6. Preserve original canonical source URL and candidate dedupe key; enrichment changes evidence only, not event identity or idempotency.
7. The isolated code candidate on this branch implements the fetch planner, bounded extractor, fail-closed disposition, and unit tests. It is intentionally not imported into index.ts and is not production-integrated.

SSRF and trust limits: allowlist validation is only on the source URL and redirects are rejected. A production-ready integration should also enforce the existing SOURCE_POLICY host check, set egress/DNS policy where available, avoid following page-provided links, and keep response text framed as untrusted evidence for judgement. More tests should use representative BOJ/Fed/JMA HTML fixtures and real documented source content before C1 approves integration.

## 5. Recall-safe shadow architecture

Prefer isolation over reusing important_news_candidates or important_news_monitor_runs for shadow candidates:
- Reusing the live candidate table risks old judgement/generation/publish-ready selectors consuming shadow rows. A boolean flag alone is unsafe unless every reader and writer is proven to filter it.
- Reusing production run diagnostics mixes shadow cost/failures with published-flow metrics and makes independent rollback harder.
- Proposed separate objects only after explicit approval: important_news_shadow_runs and important_news_shadow_candidates (or a private shadow schema), an isolated important-news-shadow function, and a disabled-by-default schedule. No X, notification, app-copy, generation, live candidate, OAuth, or Vault access from the shadow worker.
- Shadow free-source collection can run every 10 minutes. Query the current old-pipeline candidate/run tables read-only for ground truth. It must not rerun the old 4 paid search slots. Conditional shadow Web Search is permitted only on source-change/scheduled event/source-health triggers.
- Break ties with a stable event_key derived from normalized event/entity/time window plus canonical source URL/content hash; retain every source observation as evidence instead of overwriting first_seen_at.
- Compare shadow records to old candidates in a read-only comparator; send no user-facing writes.

Minimum shadow schema fields: event_key, source, category/topic, first_seen_at, old_pipeline_detected_at, new_pipeline_detected_at, old_detected, new_detected, importance, detection_delay_sec, trigger_reason, web_search_used, web_search_topic/query, estimated_cost, evidence/source URL, free-source health/status. Also keep source published_at, ingestion_at, query/HTTP diagnostics, retry count, dedupe key, and whether the evidence is primary/secondary.

Search/cost examples are in section 1. Trigger-only scenarios have theoretical savings, not safety evidence. Shadow should record a budget-overrun event instead of suppressing an urgent fallback. Set an explicit alert and operator decision path.

## 6. Acceptance gates, fallback, and rollback

No production cutover until all are met:
- Rebuild exact 19-case replay evidence: 100% important/most_important recovery, all 5 previously unverified resolved, both delay cases explained, each with source/query/timestamps.
- At least 14 consecutive days of shadow with zero missed important/most_important events against the old path; extend if there is no representative emergency sample.
- Per-domain/source freshness and error state visible; 429/down produces alert and immediately restores legacy query coverage in affected topics.
- Every positive delay difference explained; target +20 minutes or less per important event, with median/p95 no worse than old path.
- Observe actual paid calls and cost for at least 30 days; 70% is a target only after recall gates pass.
- Topic fallback remains enabled for war/geopolitics, Japan security/J-Alert/North Korea, tariffs/trade/sanctions, maritime chokepoints/oil, bank/financial system, central-bank action/FX, major disaster/infrastructure, semiconductor/AI/export controls, and any source-health outage.

Exact proposed production sequence for a future separately approved phase:
1. Review candidate/tests and replay manifest.
2. Apply one reviewed shadow-only schema migration for isolated tables/policies.
3. Deploy one isolated shadow function with no publication scopes and bounded network origins.
4. Create one disabled or initially manually-inactive shadow schedule, verify its disabled state and read-only behavior, then enable only under a separate approval.
5. Keep current important-news-monitor, paid-search cadence, and all publication paths untouched during the observation window.
6. Only after C1/user approval consider any replacement. No schema/function/cron change is authorized by this H1.

Rollback: disable the shadow schedule first; disable/remove the shadow function; retain or export its shadow tables for audit until explicit retention approval; do not touch old pipeline, X/Push/App state, or production tokens. Migration rollback is a separate reviewed operation; do not drop shadow tables automatically if they contain evidence.

## 7. Tests

Command: deno check and deno test on official_body_enrichment_candidate.ts and its test file. The 14 unit tests cover title/body gating, TDnet separation, allowlist and URL hardening, HTML/XHTML response rules, redirects, timeout, size/content limits, empty extraction, enriched judgement input, and no-title-only fallback disposition. These unit tests do not validate integration into the live Edge Function.
