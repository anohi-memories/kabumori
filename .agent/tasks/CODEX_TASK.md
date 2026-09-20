# Codex Task

- task_id: important-news-phase1-shadow-coverage-gap-expansion-candidate-20260920
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: live shadow監査で判明したcoverage gapを埋めるため、TDNET/Japan IR・North Korea/J-Alert・shipping/chokepoints・China・abrupt market moves等の追加source候補をread-only調査し、production未変更のsource-expansion candidateとtestsまで作る。

## Approved basis

前H1 C1 PASS:
- 10-minute shadow稼働は安定。
- 9 natural runs / 31 unique candidates / 31 first_seen。
- same-window live important/most_important = 0。
- prior 48h high-importance 14件のうち13件がTDNET、1件がBOJ。
- shadowにはTDNET collectorが無く、現状はJapan corporate IR laneを比較できない。
- BBC / Al Jazeeraはuseful secondaryだがnoiseあり。
- JMAは取得できているがroutine ashfall forecast等のnoiseあり。
- GDELTは観測した実poll 2回とも15秒timeout。
- BOJ/Fed/USTR/UN/EIA/ECB/SECはfetch healthyだが観測windowでは0 items。
- recall parity NOT PROVEN。
- 全lane legacy paid fallback維持。
- matcher thresholdは今の証拠では緩めない。

## User goal

待ち時間を使って、shadowが重要ニュース比較に使えるcoverageへ近づける。

今回のゴール:
1. 現行shadowで欠けている重要laneをsource単位で明示。
2. 無料/公式/低コストで追加できる候補を実地確認。
3. historical/recent live important eventsへ届くsourceかをread-only評価。
4. source追加candidateをlocal-onlyで実装・test。
5. production導入する価値のあるsourceだけをC1へ提案。

## Model policy

- **Lunaで開始・継続。**
- 調査、source比較、parser実装、tests、docsはLuna。
- Solへ上げるのは、具体的なsecurity/auth/production-write blockerが出た場合のみ。
- 複雑という理由だけでSolに切り替えない。

## Mandatory startup

1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh origin/main
7. production shadow state read-only
8. production recent important/most_important rows read-only
9. current source list/parser/tests
10. replay artifact 19件

H2/G1/G2 objectsには触れない。

## Priority coverage gaps

優先順位:

### P0
- Japan corporate IR / TDNET
- North Korea / J-Alert / Japan security
- shipping / Hormuz / Red Sea / chokepoints
- China major policy / stimulus / financial-system

### P1
- Japan/US abrupt market moves
- overseas major earnings/guidance
- semiconductor / AI / export controls
- FX intervention / emergency central-bank action
- energy infrastructure / oil disruption

### P2
- broad war/geopolitics source quality改善
- disaster/infrastructure noise reduction

## Scope A — source discovery and validation

各laneで候補sourceを探す。

優先:
- official RSS/Atom/XML/JSON
- official press release/index endpoint
- reputable free news RSS
- static HTML page that can be safely polled
- low-rate public API where terms/limits are acceptable

評価:
- HTTPS
- no auth / no paid key preferred
- update cadence
- stable timestamp
- body/summary presence
- historical archive availability
- rate limit
- robots/terms constraints where obvious
- parser complexity
- expected relevance/noise
- duplicate risk

GDELT単独依存は禁止。

## Scope B — TDNET/Japan IR

最重要。

調べる:
- existing live pipelineがTDNETをどう取得しているか
- shadowへ同じlive candidateを単純コピーするのではなく、independent measurement sourceとして何が使えるか
- JPX/TDNET official disclosure feed/index/API/HTML等の独立取得可否
- source timestampとcollector first_seenを記録できるか
- current live TDNET important events 13件に対してhistorical source URL/timestampを紐づけ可能か

もし独立sourceが無理なら:
- 「Japan IR laneはshadow replacement測定不能」
を明記し、legacy fallback維持。

live tableのコピーをshadowのrecall proofとして数えるのは禁止。

## Scope C — North Korea / Japan security

候補:
- J-Alert/消防庁/内閣官房/防衛省/海保等のofficial feed/index
- 防衛省 missile-related press release/update
- credible regional secondary sources

要件:
- missile/launch/airspace/maritime warningの速報timestampが取れること。
- routine PR noiseを分離できること。

## Scope D — shipping / chokepoints

候補:
- maritime authority / UKMTO / IMO / official advisories
- reputable shipping/security feeds
- energy/shipping secondary sources

対象:
- Hormuz
- Red Sea / Bab el-Mandeb
- Suez
- tanker attacks
- port closure
- major shipping disruption

sourceが商用/認証必須なら「無料shadow sourceとして不採用」。

## Scope E — China / financial-system / trade

候補:
- PBOC / State Council / MOFCOM / customs / CSRC等official
- English official releases preferred where parser安定
- trusted secondary source

対象:
- stimulus
- reserve requirement/rate
- capital controls
- sanctions/trade controls
- bank/systemic actions

## Scope F — abrupt market moves

今回production変更なし。

read-only設計:
- live market price/time-seriesをnews shadowへどう追加triggerとして読むか
- MICを必須dependencyにしない
- price triggerが無い場合のlegacy fallback
- Nikkei futures / USDJPY / oil / US index急変 laneのminimum source

MIC ingest/Cronは変更禁止。

## Scope G — recent-event backtest

最近の重要事例に対して候補sourceをread-onlyでbacktest。

最低:
- Sep18 BOJ
- recent TDNET important examples
- Sep12 North Korea missile
- Sep12 Saudi pipeline attack
- Hormuz / tanker-related examples
- replay cohortのwar/tariff/shipping/geopolitics representative cases

各case:
- old detected/fetched
- candidate source published timestamp
- candidate URL
- historical availability confidence
- proposed collector could have seen it? yes/no/unproven
- expected lane fallback

「published earlier = collector would definitely detect earlier」とはしない。

## Scope H — local-only implementation candidate

source validationで有望なものだけ:
- `supabase/functions/important-news-shadow/shadow_sources.ts`
- parser/helper
- tests
- docs

へlocal candidateとして追加可。

条件:
- production deploy 0
- Cron change 0
- schema 0
- secret/Vault 0
- no manual OpenAI
- source fetch testsはbounded
- fixture-based parser testsを優先
- source-specific timeout/cooldown明示
- malformed/stale/future timestamp fail-closed
- no arbitrary URL fetch/SSRF

candidate branchを作る場合:
- fresh main
- H1-owned files only
- push可
- merge不可
- C1待ち

## Noise controls

特に:
- JMA routine notices
- broad BBC/Al Jazeera sports/entertainment
- repeated geopolitical articles

について、source追加と同時にmateriality prefilter候補を設計してよい。

ただし:
- materiality filterで重要ニュースを落とす恐れがあるため、本番適用禁止。
- positive/negative fixturesを作る。
- hard keyword blacklistだけに依存しない。

## Acceptance for source candidate

C1へ「追加候補」として出せるsourceは:
- endpoint stable
- timestamp usable
- parser testable
- recent relevant exampleあり、またはofficial sourceとしてevent windowで有用
- rate/timeout strategyあり
- duplicate/noise behavior説明可能
- existing sourceと独立したcoverageを増やす

これを満たさないものはresearch-only。

## Production mutation policy

**0。**

禁止:
- important-news-shadow deploy
- Cron変更
- migration/schema/RPC
- Vault/secret
- legacy important-news pipeline
- Web Search削減
- X/Push/App
- MIC
- market-report
- OAuth/social-mobile
- manual OpenAI replay

productionで見つけたbugはReportしてSTOP。直さない。

## Deliverables / C1

最低限:
1. lane coverage gap matrix
2. candidate source inventory
3. accepted/rejected reasons
4. TDNET independent measurement conclusion
5. North Korea/J-Alert coverage conclusion
6. shipping/chokepoint coverage conclusion
7. China/systemic coverage conclusion
8. abrupt market move design
9. recent-event backtest table
10. source timestamp confidence
11. local candidate files/branch/commit if any
12. parser/tests results
13. noise/materiality risks
14. per-lane fallback requirement
15. explicit production mutation = 0
16. exact next production proposal, if any

完了時:
- status -> review_required
- next_owner -> chatgpt
- C1待ちでSTOP

**推奨モデル：Luna。**
