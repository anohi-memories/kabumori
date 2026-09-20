# Codex Task

- task_id: important-news-phase1-shadow-observation-and-match-audit-20260920
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: 10分live shadow稼働後の実データをread-onlyで監査し、source health / first_seen / live match / conditional search / costを評価する。0 live matchの原因を切り分け、必要ならmatching改善案とローカルテストcandidateまで作る。production挙動は変更しない。

## Approved basis

前H1 C1 PASS:
- PR #1 merged manually
- merge commit: 4a28c168f4c7a3acfb31172a685e2a1de6b0542f
- important-news-shadow v6 ACTIVE
- shadow Cron job 38 = */10 * * * *
- dedicated X-Cron-Secret path active
- shadow tables isolated / RLS enabled
- two natural 30m canaries + one natural 10m run completed
- observed 24 free-source candidates, all with first_seen_at
- observed paid Web Search in reviewed runs = 0
- legacy important-news Cron jobs 2/3/4/8 unchanged
- important-news-monitor source hash unchanged
- X / Push / App writes = 0
- recall parity NOT proven because reviewed runs had 0 live matches

## User goal

次は待つだけではなく、shadow実データを使って以下を前に進める:

1. sourceごとの稼働安定性を把握
2. first_seenが正しく蓄積されているか確認
3. live側important/most_importantとのmatchが0件だった原因を切り分け
4. matcherが厳しすぎる/弱すぎる可能性をofflineで検証
5. conditional Web Searchが必要な時だけ発火する設計か監査
6. shadow追加コストを実測
7. legacy paid fallbackを将来lane単位で外せる証拠の作り方を固める

## Model policy

- **Lunaで開始・継続する。**
- このH1はread-only監査とローカル検証が中心なのでSol不要。
- production security discrepancy、unexpected DB mutation、secret/auth異常など明確な高リスクblockerが出た場合のみSTOPしてSol検討。
- 単に分析が複雑という理由ではSolへ上げない。

## Mandatory startup

開始前:
1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh origin/main
7. production shadow Cron/read-only
8. production important-news-shadow version/source hash/read-only
9. production legacy important-news Cron/function hashes/read-only
10. shadow tables read-only
11. live important_news_candidates read-only

競合時STOP:
- 他slotが important-news-shadow/**
- shadow schema/migration
- shadow Cron
を変更中なら、writeは行わずread-only auditだけに限定。

## Scope A — accumulated shadow audit

最新の十分なwindowをread-only集計する。
最低:
- since shadow 10m activation
- plus直近6h/12h/24h view where available

集計:
- natural shadow run count
- completed/partial/failed
- source別 healthy / failed / cooldown
- source別 candidate counts
- unique shadow candidates
- first_seen_at / last_seen_at
- GDELT timeout/rate-limit behavior
- conditional_search_count
- web_search_calls
- input/output tokens
- cost_usd
- ai_usage_events news_shadow_search rows
- duplicate_run_slot / retry storm有無
- secret/auth related 401/403/5xx loop有無

人工invokeは禁止。
自然データのみ。

## Scope B — live comparison

同じ観測windowでlive important_news_candidatesをread-only確認。

特に:
- important
- most_important
- breaking_market
- market_macro
- official/RSS由来でshadow sourceと重なるもの

各live eventについて:
- live id
- title
- source_url
- category/entity/topic
- published_at
- fetched_at
- importance
- shadow candidate match有無
- shadow first_seen_at
- detection delta

### 0-match investigation

0件が続く場合、最低限以下を分類:
1. そもそも同期間にlive重要ニュースが無い
2. source coverageが異なり同一eventを見ていない
3. canonical URL違い
4. title normalization/entity key差
5. category/topic差
6. matcher thresholdが厳しすぎる
7. dedupe key/event keyの設計問題
8. shadow candidate stale/non-material noise中心

「0 match = shadow失敗」と即断しない。

## Scope C — offline matcher evaluation

production write/deployなし。

current matcherを:
- recent live rows
- recent shadow rows
- replay artifact 19件
に対してofflineで評価。

出すもの:
- true-positive候補
- false-positive候補
- false-negative候補
- match理由
- threshold/normalization問題

必要なら:
- local matcher candidate修正
- unit tests
- fixture追加

まで可。

ただし:
- important-news-shadow production redeploy禁止
- Cron変更禁止
- schema変更禁止

matchingを緩める場合も、誤matchを増やさない証拠が必要。
URL exact/canonical matchを最優先にし、曖昧title similarityだけで強制matchしない。

## Scope D — source quality audit

各sourceについて:
- freshness
- item cadence
- timestamp quality
- body/summary availability
- duplicate noise
- stale feed risk
- HTTP/rate-limit behavior
- market relevance

source set:
- BOJ
- Fed
- JMA
- USTR
- UN peace/security
- EIA
- BBC World
- Al Jazeera
- ECB
- SEC
- GDELT

White Houseは現在excluded。再追加はこのH1ではしない。

評価区分:
- primary reliable
- useful secondary
- noisy/limited
- unhealthy
- insufficient evidence

## Scope E — cost / trigger audit

shadowのconditional search policyを実データで確認。

必須:
- quiet cycleで0 paid searchが維持されているか
- same topic cooldownが効いているか
- source degradationだけで過剰発火しないか
- 1 run最大1 search境界
- observed cost/day extrapolation
- worst-case設計上限（ただしemergency fallbackを止めるhard cap提案は禁止）

legacy baseline:
- through 9/23: 48 nominal searches/day
- from 9/24: 96 nominal searches/day

shadow costはlegacy削減効果と混同せず、追加費用として別表示。

## Scope F — recall evidence plan

14日観測を最終推奨のまま維持。

ただし今回のH1では、
- 何をもってlane-safeとするか
- minimum matched-event count
- important/most_important zero-miss判定
- delay <= +20m
- median/p95
- source unhealthy fallback
を具体化。

laneごと:
- war/geopolitics
- North Korea/J-Alert
- tariffs/trade/sanctions
- FX/central-bank
- disaster/infrastructure
- energy/oil
- shipping/chokepoints
- financial-system
- China
- semiconductor/AI/export controls
- overseas major earnings
- Japan corporate IR
- Japan/US market abrupt moves

証拠不足laneはlegacy fallback維持。

## Production mutation policy

このH1は原則 **production mutation 0**。

禁止:
- shadow Function deploy
- shadow Cron変更
- migration/schema/RPC変更
- secret/Vault変更
- old important-news pipeline変更
- legacy Web Search削減
- X/Push/App変更
- MIC変更
- market-report変更
- OAuth/social-mobile変更
- manual OpenAI replay

もしproduction bugを見つけても:
- exact bug
- impact
- local fix candidate
- tests
- rollout proposal
をReportしてSTOP。
別承認なしに本番へ出さない。

## Deliverables / C1

.agent/CODEX_REPORT.md に最低限:
1. observation window
2. natural run count/status
3. source health summary
4. unique candidates / first_seen proof
5. live important/most_important event count
6. match count + per-match delay
7. 0-match root-cause classification if applicable
8. matcher offline evaluation
9. source quality classification
10. conditional search count/cost
11. observed + projected shadow daily/monthly cost
12. legacy baselineとの比較（削減ではなく現時点は追加費用）
13. lane-by-lane evidence/fallback matrix
14. recall parity status
15. local code/test changes if any
16. explicit production mutation = 0
17. next recommendation

完了時:
- status -> review_required
- next_owner -> chatgpt
- C1待ちでSTOP

**推奨モデル：Luna。**


## C1 review — 2026-09-20

**PASS — read-only shadow observation/match audit completed as scoped.**

Accepted evidence:
- Production mutation = 0.
- 9/9 natural shadow runs completed in the reviewed window; no duplicate/retry storm observed.
- 31 unique shadow candidates were present and all 31/31 had collector `first_seen_at`.
- 10 non-GDELT sources were fetch/parse healthy in the reviewed sample; GDELT was correctly identified as insufficient/unhealthy evidence because both observed actual polls timed out.
- Legacy important-news Cron jobs 2/3/4/8 and `important-news-monitor` source hash remained unchanged.
- No X / Push / App action, manual Function invoke, OpenAI replay, secret/Vault mutation, Cron change, schema write, or live pipeline change occurred.
- Live comparison was appropriately interpreted: there were 0 important/most_important live events in the same 24h observation window, while the prior 48h high-importance set was dominated by TDNET and one BOJ item outside the shadow window.
- Current matcher reproduced 0 offline matches, but the report did not incorrectly label this as matcher failure; the primary explanation is temporal/source coverage mismatch.
- The 19-row replay remains explicitly unscorable for TP/FP/FN because replacement first_seen ground truth does not exist.
- Conditional paid search remained 0 calls / $0 in the reviewed quiet window, with the limitation clearly stated.
- All lanes remain NOT lane-safe; legacy paid fallback stays enabled everywhere.
- Recall parity remains NOT PROVEN.

C1 judgment:
- This audit task is complete and passes.
- Do **not** loosen matcher thresholds based on this sample.
- Do **not** reduce legacy Web Search or cut over the live pipeline.
- Continue natural 10-minute shadow observation until matched important/most_important events exist and the observation window is materially larger.
- Any future production change requires a new explicit task/approval.

Recommended model for the next observation/audit task: **Luna**.
