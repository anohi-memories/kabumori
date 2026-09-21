# Codex Task

- task_id: important-news-phase1-search-diagnostics-instrumentation-candidate-20260921
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: conditional-searchの実request数・web_search action内訳・失敗attemptをprivacy-minimalに記録できるlocal-only instrumentation candidateを作り、現在のコスト不確実性を解消できる状態にする。production deployはまだ行わない。

## Approved basis

前H1 C1 PASS:
- 149 natural runs中19 conditional-search events。
- 35 `web_search_call` output items。
- 16 eventsで2 items、3 eventsで1 item。
- raw action types/provider billingは未保存。
- `conditional_search_count=1` はbillable search countではない。
- `max_tool_calls=1` だけでは1 billable search/runを証明できない。
- failed targeted request後は `paidSearchUsed=false` のままで、同run中の後続candidateが再attempt可能。
- Production mutation = 0。

## User intent

2026-09-21「じゃあどうする？」に対し、次はprivacy-minimal diagnosticsを先に整える方針。

## Model policy

- **Lunaで開始・継続。**
- instrumentation design、local code、migration candidate、tests、docsはLuna。
- Solへ上げるのはproduction apply/security/privacy blockerが出た場合のみ。
- このH1ではproduction deploy/applyしない。

## Goal

次のproduction observation phaseで、以下を区別できるようにする:
1. targeted Responses POST attempt count
2. successful response count
3. failed response count
4. output `web_search_call` item count
5. action.type別 count
   - search
   - open_page
   - find_in_page
   - unknown
6. input/output tokens
7. estimated cost
8. provider response id / request id がprivacy-safeに保存可能ならhashまたはopaque id
9. raw prompt/headline/search query/raw responseは保存しない

## Mandatory startup

1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh origin/main
7. important-news-shadow/index.ts
8. shadow tables migration
9. ai_usage_events schema
10. current shadow tests

H2/G1/G2 objectsには触れない。

## Scope A — telemetry schema candidate

local migration candidateとして、既存run/usage schemaを最小拡張。

候補 fields:
- targeted_search_attempt_count
- targeted_search_success_count
- targeted_search_failure_count
- web_search_output_item_count
- web_search_action_search_count
- web_search_action_open_page_count
- web_search_action_find_in_page_count
- web_search_action_unknown_count
- optional provider_response_id_hash

要件:
- raw prompt/headline/query/raw response禁止
- secret/API key禁止
- tenant/user PII禁止
- existing rows backward-compatible
- nullable/default 0 preferred
- no client exposure
- RLS/grants unchanged
- service-role/internal only

既存 `web_search_calls` は互換維持。
意味変更ではなく、新しい明示的fieldを追加。

## Scope B — runtime instrumentation candidate

local-onlyで `important-news-shadow` を修正可。

必要:
- Responses POST attempt開始時にattempt count
- HTTP failure / thrown errorでfailure count
- successでsuccess count
- output arrayの `web_search_call` itemsをaction.typeまで分類
- unknown actionはunknownへ
- current `countWebSearchCalls` semanticsを明示
- current estimated cost logicは勝手に変更しない
- provider billing不明なのでbillable count fieldを新設しない
- no raw content logging

重要:
- instrumentation追加だけ。
- trigger条件、matcher、source、fallback、model、max_tool_calls、timeout、Cronは変更禁止。

## Scope C — failed-attempt semantics

現在の `paidSearchUsed` 挙動をtestで固定。

minimum tests:
- first eligible candidate success -> later candidates no second request
- first request fails -> current behavior allows later eligible candidate retry
- retry count is telemetryに反映
- output items 0/1/2
- action types search/open_page/find_in_page/unknown
- no raw content persisted

このH1ではretry policy自体は変更しない。
まず観測可能にする。

## Scope D — persistence mapping

確認:
- important_news_shadow_runs
- ai_usage_events
のどちらに何を保存するか。

推奨:
- run table: per-run summary
- ai_usage_events: per successful/attempt aggregate

二重計上を避ける。
既存cost aggregationとの互換性維持。

## Scope E — provider usage reconciliation plan

OpenAI organization usage/billing側と照合するためのread-only planを作る。

必要:
- date/time bucket
- model
- request count
- web-search usage unit
- tokens
- cost
- possible request/response id linkage

ただし:
- external provider settings変更なし
- API key追加なし
- billing mutationなし
- account permission変更なし

connector/toolでprovider usageが読めない場合は「future manual/read-only step」と記載。

## Scope F — privacy review

明示的に禁止:
- candidate headline
- candidate body
- search query
- raw tool output
- URL全文（source URLも不要なら保存しない）
- user/account identifiers
- secrets

保存するのはcount/status/action type/tokens/cost/time/id hashだけ。

## Scope G — local verification

最低:
- Deno/unit tests
- migration static review
- no-publish boundary
- grep/static check for raw prompt/response persistence
- git diff --check
- no unrelated files

branch/push可。
merge不可。

## Production mutation policy

**0。**

禁止:
- migration apply
- Function deploy
- Cron
- Vault/secret
- OpenAI manual replay
- search trigger変更
- fallback変更
- legacy pipeline
- X/Push/App
- MIC
- OAuth/social-mobile

## Deliverables / C1

.agent/CODEX_REPORT.md:
1. telemetry schema candidate
2. runtime instrumentation candidate
3. action-type classification
4. failed-attempt behavior test
5. privacy review
6. local tests
7. branch/commit/files
8. production mutation=0
9. exact proposed next production step

完了時:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1

**推奨モデル：Luna。**


## Codex H1 handoff — 2026-09-21

- Candidate branch: `codex/h1-search-diagnostics-instrumentation-20260921`
- Code candidate commit: `9394c27a90b590f95ff8253212cc72843212a90b`
- Local verification: Deno tests 17 passed; Deno type checks passed; `git diff --cached --check` passed.
- Production mutation: 0. No migration apply, Function deploy, Cron change, provider replay, or credential/settings change.
- Next step: C1 review. Any later migration apply and matching Function deploy require their own explicit production approval; then observe natural runs only.
