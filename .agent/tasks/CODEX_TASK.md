# Codex Task

- task_id: important-news-phase1-conditional-search-call-accounting-audit-20260921
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: natural shadow runで1 conditional-search eventに対し2 web_search_call出力が記録された事象を監査し、Responses APIの実挙動・usage/cost accounting・max_tool_calls解釈を確認する。production挙動は変更しない。

## Approved basis

前H1 C1 PASS:
- 27/27 natural shadow runs completed over 4h40m.
- GDELTは5/5 actual pollsで約15秒timeout。
- 07:10 natural runでJMA high-signal/sparse triggerが発火。
- そのrunは conditional_search_count=1 だが web_search_calls=2、estimated cost=$0.02112360。
- request側は max_tool_calls=1。
- Production mutation = 0。
- legacy paid/live fallbacks remain enabled。

## User decision

2026-09-21「すすめて」。

## Model policy

- **Lunaで開始・継続する。**
- API response anatomy、usage accounting、logs/read-only evidence、local testsはLuna。
- Solへ上げるのはsecurity/auth/production-writeの具体的blockerが出た場合のみ。
- 本H1はproduction mutationを行わない。

## Mandatory startup

1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh origin/main
7. important-news-shadow/index.ts targetedSearch
8. countWebSearchCalls
9. estimateCostUsd
10. ai_usage_events schema/read-only
11. shadow run 07:10 UTC read-only
12. Responses API docs / SDK semantics as available

H2/G1/G2 objectsには触れない。

## Scope A — exact natural-run reconstruction

07:10 UTC natural runについて、read-onlyで以下を再構成:
- run id
- trigger_reason
- triggering candidate
- candidate headline/topic/category
- input_tokens
- output_tokens
- web_search_calls
- estimated cost
- ai_usage_events row
- conditional_search_count
- any TARGETED_SEARCH_FAILED errors
- surrounding 07:00 / 07:20 runs

manual replay禁止。

## Scope B — response anatomy

コード上の countWebSearchCalls は output array 内の type=web_search_call を数える。

確認:
- Responses APIで1 tool invocationが複数 web_search_call output itemsになる可能性
- max_tool_calls=1 の意味
- 1 Responses requestあたり何が「tool call」として制限されるのか
- search query / open page / follow-up fetch等が別output itemとして数えられる可能性
- usage/web_search billing unitsとの対応
- response outputとusageが一致するか

推測せず、可能なら公式OpenAI docsを確認。

## Scope C — cost accounting audit

current estimator:
- input $0.20 / 1M
- output $1.20 / 1M
- web search $0.01 / call

確認:
- persisted 07:10 costがこの式と一致するか
- web_search_calls=2なら$0.02が含まれているか
- conditional_search_count=1 と web_search_calls=2 を混同していないか
- historical shadow cost rowsに同様のmulti-call例があるか
- ai_usage_events aggregationが実call数を保持しているか
- previous worst-case $44.7552/30d calculationが1 call/run前提なら再計算が必要か

新しい外部課金単価が現行コード前提と違う可能性があれば明記。ただし本H1で単価変更しない。

## Scope D — bounded non-production reproduction

必要ならlocal/mock fixtureで:
- outputにweb_search_call 0/1/2件
- countWebSearchCallsが正しく数える
- cost estimatorが実call数を使う
- conditional event 1件でもweb_search_calls複数を保存できる

tests追加可。

実OpenAI APIをmanual invokeするのは禁止。
既存natural response/raw payloadが保存されていない場合は無理に再現しない。

## Scope E — semantic correction candidate

監査結果に応じてlocal-onlyで以下を提案/実装可:
- variable naming改善
- docsコメント
- tests
- worst-case cost formula修正
- conditional_search_countの意味を「Responses request count」と明示
- web_search_callsをactual output/tool call countとして別扱い

ただしproduction deploy禁止。

もし current code がactual callsを正しく数えており誤りがdocs/assumptionだけなら、runtime codeは変えない。

## Scope F — worst-case economics

現在:
- 10分Cron = 144 runs/day
- at most 1 targeted Responses request/run by paidSearchUsed gate

重要:
- 1 Responses request/run と 1 web_search_call/run は同義と仮定しない。

観測と公式仕様から:
- hard upper boundが証明できるか
- 証明できないなら「finite cap unknown」とする
- observed max calls/request
- safe cost-envelopeの表現
を整理。

緊急fallbackを止めるhard cap提案は禁止。

## Production mutation policy

**0。**

禁止:
- Function deploy
- Cron変更
- migration/schema/RPC
- secret/Vault
- OpenAI manual replay
- Web Search policy reduction
- legacy pipeline変更
- X/Push/App
- MIC
- OAuth/social-mobile

## Deliverables / C1

.agent/CODEX_REPORT.md:
1. 07:10 exact reconstruction
2. conditional_search_count vs web_search_calls semantics
3. official API semantics evidence
4. cost formula check
5. historical multi-call scan
6. worst-case cost correction if needed
7. local tests/code/docs changes if any
8. production mutation = 0
9. exact next proposal

local branchを作る場合:
- fresh main
- H1-owned files only
- push可
- merge不可
- status -> review_required
- next_owner -> chatgpt
- STOP for C1

**推奨モデル：Luna。**
