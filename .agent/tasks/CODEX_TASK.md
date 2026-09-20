# Codex Task

- task_id: important-news-phase1-gdelt-timeout-diagnosis-and-fallback-candidate-20260920
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: 10分shadowで継続的に15秒timeoutしているGDELT経路を切り分け、GDELTを安定化できるか、または安全にsecondary扱いへ下げるべきかをproduction未変更で判断する。必要ならlocal-onlyのtimeout/query/fallback candidateとtestsを作る。

## Approved basis

前H1 final C1 PASS:
- shadow自然観測は17/17 completed、観測約3時間。
- GDELTは3回の実pollすべて約15秒timeout、14回は設計どおりcooldown skip。
- 他10 sourceは観測sampleでfetch/parse healthy。
- same-window important/most_important = 0、recall parity NOT PROVEN。
- shadow paid Web Search = 0 calls / $0 in quiet sample。
- 全legacy paid/live fallback維持。
- production mutation = 0。
- JPX TDnet Index APIはresearch-only。今回のH1では触れない。

## User intent

2026-09-20「おkすすめて」。

待ち観測だけでなく、現在明確に見えているsource-health blockerであるGDELT timeoutを先に詰める。

## Model policy

- **Lunaで開始・継続する。**
- HTTP/query diagnosis、fixture/replay、local code/tests、docsはLuna。
- Solへ上げるのはproduction security/auth mutationが必要になった場合のみ。
- このH1ではproduction mutationを行わない。

## Mandatory startup

1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh origin/main
7. current important-news-shadow GDELT source implementation
8. source tests/fixtures
9. production shadow read-only state
10. latest natural runs after prior C1

H2/G1/G2 files/settingsには触れない。

## Scope A — natural observation refresh

read-onlyで最新natural runsを確認。

最低:
- total natural runs since activation
- observation span
- completed/partial/failed
- GDELT actual poll count / timeout count / cooldown skips
- other source failures
- same-window important/most_important
- stored matches
- conditional Web Search calls/cost

6h windowが成立していれば6h集計を明記。
成立していなければleft-censoredと明記。

## Scope B — GDELT current request diagnosis

current codeを正確に追う:
- endpoint
- query parameters
- mode
- format
- maxrecords
- timespan
- sort
- timeout
- headers/user-agent
- response size assumptions
- parser behavior
- cooldown

次を切り分け:
1. DNS/TLS/connect latency
2. GDELT server response latency
3. query complexity
4. response size
5. rate limiting
6. endpoint instability
7. malformed/redirect response
8. parser/JSON time
9. timeout値が短すぎるだけか

boundedな外部probeは可。ただしproduction Function invokeは禁止。

## Scope C — query minimization experiments

GDELTへの負荷とlatencyを下げるlocal/read-only candidateを比較。

例:
- narrower timespan
- lower maxrecords
- simpler query
- separate lane queries vs broad OR query
- alternate supported GDELT endpoint/mode
- article listではなくlighter metadata path
- HTTP timeout strategy

各experiment:
- request URL/queryはsecretなし
- response time
- HTTP status
- bytes
- item count
- relevant-event yield
- repeatability

過剰probe禁止。短時間に大量リクエストしない。

## Scope D — value assessment

GDELTが現在shadowに何を追加しているか評価。

確認:
- existing BBC/Al Jazeera/official sourcesと重複度
- replay cohortでGDELTが必要とされたlane
- GDELTでしか拾えない代表eventが証明できるか
- historical first_seen proofの有無
- zero items / timeoutでもfallback triggerへ悪影響がないか

結論候補:
A. keep + local query optimization
B. keep but secondary/less frequent
C. disable candidate in future and rely on explicit fallback
D. replace with another free source candidate

このH1ではどれもproduction適用しない。

## Scope E — local-only implementation candidate

明確な改善が見つかった場合のみ、local branchで:
- shadow_sources.ts
- source-specific helper
- tests/fixtures
- docs

を変更可。

必須:
- source-specific timeout
- bounded response size/item count
- stale/future timestamp rejection
- fail-open to other sources (GDELT failure must not fail run)
- no arbitrary URL fetch / SSRF
- no secrets
- no Web Search policy change
- no matcher threshold change

改善証拠が弱ければcode変更しない。

## Scope F — fallback semantics

GDELT unavailable時に:
- paid fallbackが消えない
- source degradation数の扱いが過剰searchを誘発しない
- 2+ degraded source triggerとの関係
- one-source timeoutでWeb Search発火しない現行挙動

を再確認。

必要ならlocal tests追加可。ただしproduction変更なし。

## Scope G — exact next proposal

C1へ以下のどれか1つを出す:
1. local query optimizationをshadowへ次Phaseでdeploy候補
2. GDELT cadenceをさらに下げる次Phase候補
3. GDELTをsecondary/no-proof sourceとして現状維持
4. GDELT removal候補 + paid fallback維持
5. evidence不足で観測継続

## Production mutation policy

**0。**

禁止:
- important-news-shadow deploy
- Cron変更
- migration/schema/RPC
- Vault/secret
- legacy important-news変更
- Web Search削減
- X/Push/App
- MIC
- OAuth/social-mobile
- JPX問い合わせ/契約
- manual OpenAI replay

## Deliverables / C1

.agent/CODEX_REPORT.md:
1. refreshed observation window
2. GDELT poll/timeout/cooldown counts
3. current request anatomy
4. bounded probe results
5. root-cause confidence
6. overlap/value assessment
7. fallback semantics proof
8. local code/tests if any
9. production mutation = 0
10. exact next proposal

local branchを作る場合:
- fresh main
- H1-owned files only
- push可
- merge不可
- status review_required
- next_owner chatgpt
- STOP for C1

**推奨モデル：Luna。**


## H1 diagnosis completed — 2026-09-20

- Refreshed natural observation: 27/27 scheduled runs completed from 02:30–07:10 UTC (4h40m; requested 6h window remains left-censored). GDELT failed at five hourly polls (03:00–07:00 UTC) at the 15s timeout and was cooldown-skipped 22 times; other 10 sources were healthy across all 27 runs.
- GDELT's live source set returned no candidate. Current request omits `timespan`; external baseline and 1h/maxrecords=8 probes both received HTTP 429, so query optimization was not validated. Exact production root cause remains low confidence.
- Read-only run comparison confirmed the 07:00 single-source GDELT failure produced 0 conditional searches; the 07:10 JMA high-signal/sparse trigger independently produced 1 conditional search, 2 Web Search calls, estimated $0.02112360, while GDELT was skipped and no source was degraded.
- No code change, deploy, Cron/configuration change, or other production mutation. Keep the existing hourly GDELT cooldown and all legacy fallbacks; exact next proposal is evidence-limited natural observation only.
- status: review_required; next_owner: chatgpt. Stop for C1.
