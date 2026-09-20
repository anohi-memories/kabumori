# Shadow Observation and Source-Rights Research — 2026-09-20

- Task: `important-news-phase1-shadow-observation-plus-source-rights-research-20260920`
- Research date: 2026-09-20 UTC
- Production changes: **0**
- This is an operational research note, not legal advice. “Not confirmed” means the public material reviewed does not settle Kabumori’s specific commercial use, polling, storage, or end-user display rights; it must not be treated as permission.

## 1. Natural shadow observation

Read-only Supabase project: `wsmznyzcvmuitkglfeuj`. All SQL was SELECT-only. No Function invocation or injected candidate was used.

| Window requested | Natural scheduled runs | Result |
| --- | ---: | --- |
| trailing 6h | 17 | 17 completed, 0 partial, 0 failed |
| trailing 12h | 17 | same rows |
| trailing 24h | 17 | same rows |

The shadow source had only been active from 2026-09-20 02:30 UTC at the start of this readback. The observed rows span 02:30–05:30 UTC (11:30–14:30 JST), roughly 3 hours. Therefore these are **not** complete 6h, 12h, and 24h samples; each requested window is left-censored at activation. No 6/12/24-hour trend or coverage conclusion is claimed.

Across those 17 natural rows:
- 187 free-source checks (11 per run) and 408 per-run candidate observations (24 per run).
- 0 live matches, 0 conditional searches, 0 Web Search calls, 0 input/output tokens, and $0 stored run-estimated cost.
- All 17 persisted `error_summary` arrays were empty; there were 17 distinct run slots and no duplicate slot rows.
- This does not rule out transient attempts not represented in persisted rows; platform logs were not inspected.

Source health (averages are the persisted per-source fetch latency, not publisher publication delay):

| Source | Health | Items returned | Avg latency |
| --- | --- | ---: | ---: |
| Al Jazeera | 17/17 healthy | 136 | 201 ms |
| BBC World | 17/17 healthy | 136 | 177 ms |
| JMA earthquake/volcano | 17/17 healthy | 136 | 99 ms |
| BOJ | 17/17 healthy | 0 | 227 ms |
| ECB | 17/17 healthy | 0 | 829 ms |
| EIA | 17/17 healthy | 0 | 353 ms |
| Fed | 17/17 healthy | 0 | 198 ms |
| SEC | 17/17 healthy | 0 | 216 ms |
| UN peace/security | 17/17 healthy | 0 | 367 ms |
| USTR | 17/17 healthy | 0 | 522 ms |
| GDELT | 0 healthy, 3 failed, 14 skipped by cooldown | 0 | 15,002 ms on each failure |

The three persisted GDELT failures were at 03:00, 04:00, and 05:00 UTC; each stopped at about 15 seconds. The other 14 slots observed the designed cooldown skip. This is a recurring source-health limitation, not a shadow-run failure: all 17 complete run rows were successful.

The deduplicated candidate table held 41 distinct event keys: Al Jazeera 16, BBC World 9, and JMA 16. Their first-seen timestamps fall within the observed window; last-seen reached the 05:30 run. These are not 408 unique articles: 408 is the sum of run-level candidate observations, and the table upserts by event key. No North Korea/J-Alert, Japan corporate IR, shipping/chokepoint, China-policy, or price-series event was represented in these three broad sources during this short window.

There were no live `important` or `most_important` candidates fetched during 02:30–05:30 UTC, so there was no same-window positive event to match. Zero matches is not a false-negative result. **Recall parity remains unproven**; keep all legacy paid/live fallback lanes enabled.

## 2. Rights and machine-use matrix

| Source | Officially visible rights/access facts | What remains unconfirmed for Kabumori |
| --- | --- | --- |
| JPX / TDnet API | JPX says the API provides timely disclosures via internet and five years of history. The page explicitly permits third-party redistribution. Index records include security code, disclosure date/time and title. The official service guide says the Index API incurs no API information fee; the monthly basic fee is ¥70,000 before tax. The test server is dummy data; the server-based service is faster. | Confirm the corporate contract, permissible polling cadence/rate, retention/cache rules, attribution and use of title/index data in a customer-facing product. Public material supports redistribution in general but does not settle this exact product behavior or service-level expectations. |
| NHK News RSS | A general news RSS endpoint has been found in prior technical research, but no NHK terms authorizing this project’s automated commercial polling, retention, or display were confirmed here. NHK’s official API reviewed is NHK for School video metadata, not a news API; its service guide requires registration and its terms restrict copying/storing the supplied data except for stated cache allowances. | General NHK News RSS commercial/business use, rate limit, retention of headline/snippet, and redistribution must not be inferred from RSS availability. Seek written permission or exclude it from production collection. |
| MOD | MOD’s published copy policy says site content may be copied, publicly transmitted, translated/adapted and commercially used under PDL 1.0 unless another rights notice applies; attribution is required. Its RSS guidance says updates need not match publication time and feeds may pause for maintenance. | Confirm individual items with third-party rights labels, polling expectations, and whether the selected RSS provides timely security/alert events. RSS availability is not proof of an alert-grade feed. |
| UKMTO | Warnings cover attacks, boarding, hijacking and other maritime-security incidents in the VRA. Website terms state material is under the Open Government Licence unless otherwise indicated, encourage linking, and describe third-party feeds as edited/cached rather than UKMTO products. The terms page is dated 2016. Prior unauthenticated technical probe encountered 403; no authless API/feed was validated. | An OGL statement is not itself a machine API or permission to bypass a 403. Approved access route, polling/cadence, reliable timestamps, and exact re-display/retention rights remain to be confirmed with UKMTO. |
| PBOC | A PBOC procurement-subdomain legal notice says unmarked material belongs to PBOC, requires authorized media/sites to attribute it, and says commercial websites may not link without PBOC permission. This notice is on a procurement subdomain and is not treated as a universal PBOC-site term. | Main-site / press release API or RSS, commercial machine use, caching and display rights, language availability and polling policy remain unknown. Written authorization is the safe gate. |
| MOFCOM | Rights statements vary by official subsite/page. A MOFCOM page permits original works with source attribution but says reposted/translated/abstracted works retain their originating source and users bear responsibility. Another MOFCOM site statement prohibits commercial verbatim reprinting and requires contacting third-party providers for permission. | Do not generalize one subsite’s policy to all MOFCOM content. Check each source page and third-party provenance; no API/automated polling terms were confirmed. |
| State Council / gov.cn | The English State Council site’s copyright notice says content belongs to gov.cn and may not be republished or used in any form without written authorization. | No commercial feed/API license or permission for headline/summary storage or redistribution confirmed. |
| JPX market prices | JPX public fee examples for TSE third-party distribution list ¥380,000/month for 15-minute delayed trade prices and ¥1,140,000/month for realtime trade prices, plus usage-dependent conditions where applicable. JPX says actual fees vary by data and use. OSE derivatives fees depend on subscriber business type, delivery method and timing and require rate-table/contact confirmation. | Exact contract and cost for transformed alerts versus display, Nikkei futures/derivative feed, WTI/Brent, and other exchange data must be separately confirmed. Do not infer public redistribution permission from API access. |

Primary pages:
- [JPX TDnet API service, use cases, redistribution, and rates](https://www.jpx.co.jp/english/markets/paid-info-listing/tdnet/02.html)
- [JPX TDnet API overview and service comparison](https://www.jpx.co.jp/markets/paid-info-listing/tdnet/)
- [JPX TDnet API service guide (PDF; index API has no API information fee)](https://www.jpx.co.jp/english/markets/paid-info-listing/tdnet/p1j4l40000000q03-att/API_ServiceGuideE.pdf)
- [JPX J-Quants TDnet add-on: ¥11,000/month, individual-only; corporate/academic use prohibited](https://www.jpx.co.jp/corporate/news/news-releases/6020/20260518-01.html)
- [JPX DataCube / J-Quants / J-Quants Pro use comparison](https://www.jpx.co.jp/english/markets/paid-info-equities/historical/)
- [JPX TDnet on Snowflake pricing and external-distribution restriction](https://www.jpx.co.jp/corporate/news/news-releases/6020/20260420-01.html)
- [MOD copy/use policy](https://www.mod.go.jp/asdf/notice/) and [MOD RSS guidance](https://www.mod.go.jp/j/rss/index.html)
- [UKMTO warnings](https://www.ukmto.org/ukmto-products/warnings), [products](https://www.ukmto.org/ukmto-products), and [terms](https://www.ukmto.org/terms-and-conditions)
- [NHK for School API scope](https://school-api-portal.nhk.or.jp/service-guide) and [terms](https://school-api-portal.nhk.or.jp/terms); these do not grant NHK News RSS rights.
- [PBOC procurement-subdomain legal notice](https://jzcg.pbc.gov.cn/freecms/site/templet/flsm/index.html)
- [MOFCOM site copyright/notice example](https://chinawto.mofcom.gov.cn/bqsm.shtml) and [separate MOFCOM site statement](https://tradeinservices.mofcom.gov.cn/statement.shtml)
- [State Council English-site copyright notice](https://english.www.gov.cn/2021special/5ff50cdac6d0f7257694351a/5ff50cf6c6d0f7257694351e)
- [JPX TSE real-time market-data rate examples](https://www.jpx.co.jp/markets/paid-info-equities/realtime/01.html), [OSE derivatives fees](https://www.jpx.co.jp/english/markets/paid-info-derivatives/realtime/01.html)

## 3. Specific licensed-source candidates

| Candidate | Confirmed interface / public pricing | Coverage and constraints | Evaluation status |
| --- | --- | --- | --- |
| JPX TDnet API, Index API only | Direct internet API; timely data plus five-year history. Third-party redistribution is explicitly permitted. Fixed ¥70,000/month (tax excluded); Index API does not incur API information fees. | Strongly specific to the Japan IR gap. Public service page says server-type feed is faster. Production contract/cadence and cache/storage details still need confirmation. API test server contains dummy data, so it is not evidence of production delivery latency. | Best-defined lane-specific candidate; no account, API key, contract, trial, or adapter created. |
| JPX J-Quants TDnet add-on | ¥11,000/month, timely intraday + five-year history. | Officially individual-investor service; corporate/academic use prohibited, so not usable for Kabumori business use. | Excluded. |
| JPX TDnet on Snowflake Index | ¥100,000/month for single-corporation use; semireal-time and five-year index history. | JPX says external-user distribution is not allowed. | Not suitable for a public/customer-facing Kabumori feed. |
| JPX DataCube / J-Quants Pro | DataCube files priced per file, supports corporate use and redistribution; Pro is corporate with price by contact. | Historical data product is useful for replay/calibration but not a demonstrated low-latency alert feed. Individual J-Quants API is not for corporate use. | Possible later historical backtest source, not a replacement live route. |
| Associated Press Media API | Real API supports continuous news feeds and archive searches; API docs say 30 days of content and item/rendition pricing is contract-based. Feed docs describe real-time stream/long-poll behavior. | Potential trusted newswire for geopolitics/shipping/market events, but exact Japan/North Korea/chokepoint source availability, rights, price and SLA depend on contract. | No quote, account, trial, or content request. |
| Lloyd’s List Intelligence APIs | Published APIs include vessel tracking, maritime fundamentals, risk/compliance and trade-risk data; supports internal and customer-facing delivery methods. | Structured maritime data; it is not confirmed as an incident-news/attack warning feed. No public price; quote required. | Candidate for maritime context only; not validated as UKMTO warning replacement. |
| NewsAPI.org Business | $449/month, 250,000 requests/month, real-time availability and five-year search; extra requests $0.0018; no SLA on Business. | Developer/free tier is explicitly development/testing only, not staging or production. Broad API but source/domain coverage for target lanes not measured; no full article content returned. | Plausible broad news experiment only after separately approved paid evaluation; no signup or trial. |
| NewsData.io Basic | Vendor pricing page says $199.99/month, 20,000 credits, up to 50 articles/credit, realtime and six-month archive; vendor page claims 99.99% SLA. Free tier is 200 credits/day but delayed 12h. | Vendor FAQ states commercial publication is limited to title, short description, publisher, author, date/time; not images/full content. These are vendor statements, not independent confirmation of every publisher’s rights. No exact lane recall or source coverage measured; vendor states no free trial. | Lower-cost broad candidate, but not suitable for breaking alerts on free tier; paid rights/coverage still need contract review. No account created. |
| Twelve Data Business | Business pricing card lists Venture $499/month or $414/month billed annually, while page footer says “from $149/month”; exact plan/pricing therefore requires confirmation. Basic Business is free, 8 API credits/minute, 800/day, internal non-display, real-time US equities/forex/crypto. | Business terms say non-US price markets need additional approval; redistribution requires a separate agreement. Venture lists 70+ markets, real-time US/EU, delayed AU, EOD global equities/ETFs and commodities; market-specific rights and exact Nikkei/Brent/futures symbols are not confirmed. | Possible narrow internal USD/JPY trigger candidate: one 10-minute call would nominally be 144/day, below 800/day, but symbol access and non-US rights must be confirmed. No account or request made. Not a public price-display license. |

Provider pages:
- [AP Media API getting started](https://api.ap.org/media/v/docs/Getting_Started_API.htm), [Feed docs](https://api.ap.org/media/v/docs/Feed.htm), and [content-item pricing](https://api.ap.org/media/v/docs/Pricing.htm)
- [Lloyd’s List Intelligence API catalog](https://www.lloydslistintelligence.com/solutions/api)
- [NewsAPI pricing](https://newsapi.org/pricing) and [NewsAPI terms](https://newsapi.org/terms)
- [NewsData.io public pricing](https://newsdata.io/blog/pricing-plan-in-newsdata-io/) and [vendor use FAQ](https://newsdata.io/)
- [Twelve Data business pricing](https://twelvedata.com/pricing-business) and [commercial/personal use terms](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage)

## 4. Architecture A/B/C comparison

| Architecture | Recall / latency | Operational / rights | Monthly cost evidence |
| --- | --- | --- | --- |
| A. Current: free shadow + paid/live fallback | Preserves today’s fallback behavior, but the 3-hour shadow sample has no positive high-importance event and cannot establish recall parity. Current shadow observed cost is $0 in this quiet sample. | Lowest change and no vendor lock-in increase. Current free-source coverage is broad but misses the uncovered lanes and GDELT is degraded. | Prior small-sample observed mean was $0.056721 per fetch cycle. Through Sep 23, the cadence is 12 fetch cycles/day (48 nominal search slots/day at 4 slots/cycle), or about $0.680652/day and $20.42/30d. From Sep 24, it is 24 fetch cycles/day (96 nominal search slots/day), or about $1.361304/day and $40.84/30d. Search-slot counts are not multiplied by the per-cycle cost. These illustrative calculations are not invoices or a spend forecast. |
| B. Selectively license one lane | TDnet Index API is a concrete path for real-time index data and five-year history, but no local parity or production latency has been measured. It addresses Japan IR only. | Narrow integration; JPX publicly permits redistribution and index API has no usage fee, but corporate terms/rate/cache/UI rights should be confirmed in writing. Other lanes retain current fallback. | ¥70,000/month before tax for TDnet API base; no API information fee for Index API. |
| C. Broader licensed news/data provider | A broad aggregator/newswire may improve multi-lane discovery, but no same-window event recall, freshness distribution, Japan/NK/China/shipping source inclusion, or false-negative rate was measured. Market prices and official event sources remain separate. | Reduces number of integrations only if actual source coverage meets needs. Increases provider dependency; content republishing/retention rights vary by provider and underlying publisher. | Public entry prices seen: NewsData.io Basic $199.99/mo; NewsAPI Business $449/mo. AP and Lloyd’s quote-based. Twelve Data prices/permissions are inconsistent by plan page and exchange data. |

No architecture is ranked as the final decision. Cost alone is not sufficient to replace any lane. Any paid source must first demonstrate event-level recall/timeliness alongside unchanged fallback behavior.

## 5. Lane-by-lane fallback status

| Lane | Current shadow evidence / source rights | Fallback |
| --- | --- | --- |
| Japan corporate IR / TDnet | No TDnet shadow source; TDnet API Index is the most concrete potential route, subject to written contract/usage confirmation. | Keep legacy paid/live fallback. |
| Japan security / North Korea / J-Alert | No dedicated alert source validated. MOD terms are permissive with attribution, but RSS cadence is not publication-time accurate and not proven alert-grade; NHK News rights unresolved. | Keep fallback. |
| Shipping / chokepoints | No dedicated live shadow feed; UKMTO products exist but unauthenticated API was not validated. Lloyd’s APIs cover maritime movement/risk, not confirmed incident alerts. | Keep fallback. |
| China policy / systemic | No dedicated shadow feed; official terms differ by subsite and State Council English content requires written authorization. | Keep fallback. |
| Abrupt market moves | Shadow has no price series. Twelve Data Basic is possible for narrow internal USD/JPY only after exchange/symbol approval. Public Japanese exchange display data can be costly. | Keep fallback. |
| War / geopolitics, disaster, macro, energy, trade, financial system, earnings | Broad feeds/official endpoints are operationally healthy but this quiet observation does not establish high-impact event recall. | Keep fallback. |

## 6. One exact next proposal for C1

**Proposal category 3 — confirm official API contract/use costs.** Before any adapter or source change, request a written JPX confirmation for **TDnet API Index API only**, specifically:
1. Kabumori business/corporate eligibility and the ¥70,000/month (before tax) basic-fee quote;
2. index-only third-party redistribution and use of title/index fields in end-user alerts;
3. allowed automated polling cadence/rate, caching/storage/retention, attribution, and historical access;
4. expected production feed latency/support and the consequences of the test server returning dummy data.

No email/contact was sent in this task. No contract, account, API key, trial, billing, or code was created. Other lanes stay on their current fallback. Do not reduce legacy paid search based on this research.

## 7. Safety

- Production mutation: **0**.
- No Function deploy/invoke, Cron change, schema/migration/RPC, secret/Vault, API signup/contract/purchase/trial, source-polling setting, fallback reduction, X/Push/App/OAuth, or manual OpenAI replay.
- Candidate injection: 0.
- There are no runtime or test code changes in this work.
- Request C1 review before any next step. Merge of this documentation branch is not requested or authorized.
