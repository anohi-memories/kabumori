# Codex Task

- task_id: important-news-phase1-shadow-observation-plus-source-rights-research-20260920
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: 10分shadowの自然観測を継続しつつ、無料sourceで埋まらなかったlaneについて利用条件・公式API・低コストのlicensed data候補を調査し、将来の安全なcoverage拡張案を作る。production挙動は変更しない。

## Approved basis

前H1 C1 PASS:
- coverage-gap researchは完了。
- 新規sourceはproduction採用なし。
- TDnet/Japan IR、North Korea/J-Alert、shipping/chokepoints、China/systemic、abrupt market movesは独立測定route未確立。
- 全laneでlegacy paid/live fallback維持。
- 10分shadowは継続稼働。
- recall parityは未証明。
- production mutationは0。

## User decision

2026-09-20、ユーザーは「じゃあそれ」と明示。
前C1後に提案した
- 自然shadow観測を継続
- 別角度でsource rights / licensed data / low-cost providerを調査
を本H1として進める。

## Model policy

- **Lunaで開始・継続。**
- 観測、調査、比較、費用整理、ドキュメントはLuna。
- Solへ上げるのはsecurity/auth/production-writeの具体的blockerが出た場合のみ。
- 本H1はproduction writeを行わない。

## Scope A — continued natural shadow observation

read-onlyで最新shadowデータを再集計。

最低:
- task開始時までの全自然run
- 直近6h / 12h / 24h
- completed / partial / failed
- source health
- unique candidates
- first_seen_at
- live matches
- important / most_importantとのsame-window比較
- conditional Web Search calls / tokens / cost
- duplicate/retry/auth failure兆候
- GDELT timeout/cooldown状況

人工invokeは禁止。

重要:
- 観測時間が短く、重要eventが無い場合は無理に結論を出さない。
- 0 matchを失敗扱いしない。
- recall parityはevent証拠が揃うまで未証明のまま。

## Scope B — source rights / machine-use terms

前H1でtechnical endpointは見つかっても権利・termsが曖昧だったsourceを重点確認。

対象:
- JPX / TDnet
- NHK RSS
- MOD
- UKMTO
- PBOC / MOFCOM / State Council
- market-data providers

調べる:
- commercial/business use
- automated polling
- storing headline/summary
- redistribution restrictions
- attribution requirements
- polling/rate-limit guidance
- API availability
- pricing
- trial/free tier
- historical archive access

不明なものは「allowed」と推定しない。

## Scope C — licensed / low-cost alternatives

無料sourceだけで埋まらないlaneについて候補を比較。

### Japan IR
- official TDnet API
- other licensed Japanese disclosure feeds
- price per month
- latency
- machine access
- historical availability

### Japan security / North Korea
- official alert-compatible services
- reputable licensed newswire/API
- missile/security alert latency
- Japanese market relevance

### Shipping / chokepoints
- maritime security/API providers
- UKMTO official access paths
- shipping incident services
- latency / terms / pricing

### China policy/systemic
- official licensed services or reputable APIs
- English translation latency
- PBOC/MOFCOM/State Council coverage

### Abrupt market moves
- delayed or realtime market data providers
- Nikkei/futures
- USDJPY
- Brent/WTI
- S&P/Nasdaq futures
- licensing and per-month/API cost

候補は「具体的に使えるもの」だけ記録。
広告/マーケティングページだけでAPI実体が確認できないものは除外。

## Scope D — economics

現行legacy Web Searchコストと比較する。

baseline:
- through Sep23: nominal 48 searches/day
- from Sep24: nominal 96 searches/day
- measured prior natural mean: $0.056721/fetch cycle (small sample)

licensed source候補について:
- monthly fixed cost
- usage-based cost
- minimum contract
- free tier/trial
- effective cost per lane
- legacy Web Search削減可能性

ただし:
- cost reductionだけで導入を推奨しない。
- recall/timelinessが最優先。

## Scope E — architecture options

最低3案を比較:

A. 現状維持
- free shadow + legacy paid fallback

B. selective licensed source
- 重要gap laneだけlicensed feed
- 他laneは現状維持

C. broader licensed news/data
- 複数laneを1 providerでカバー

比較:
- recall
- latency
- independence
- operational complexity
- monthly cost
- vendor lock-in
- legal/terms clarity

ranking/最終決定はしない。
事実比較と採用条件を示す。

## Scope F — exact next proposal

C1へ出す提案は以下のどれかに限定:
1. まだ観測継続のみ
2. 特定providerのtrial/read-only評価
3. 特定official APIの契約費用確認
4. local-only adapter candidate
5. no-go / fallback継続

production契約・課金・secret追加・deployは本H1で行わない。

## Production mutation policy

**0。**

禁止:
- Function deploy
- Cron変更
- migration/schema/RPC
- secret/Vault
- API契約/購入
- paid trial activation requiring billing
- legacy search削減
- X/Push/App
- MIC変更
- OAuth/social-mobile
- manual OpenAI replay

もしprovider trialが完全無料でも、account creationやexternal signupは行わず調査だけ。

## Deliverables / C1

.agent/CODEX_REPORT.mdへ:
1. observation window / natural run count
2. source health update
3. new live important/most_important events and matches
4. shadow paid-search cost
5. rights/terms matrix
6. licensed provider candidate matrix
7. price/latency/API/access evidence
8. architecture A/B/C comparison
9. lane-by-lane fallback status
10. exact next proposal
11. production mutation = 0
12. sources/URLs referenced in durable research doc if created

必要ならdocs/news-coverage/へdocumentation-only artifactを作成可。
branch/push可、merge不可。C1待ち。

完了時:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1

**推奨モデル：Luna。**


## C1 review — 2026-09-20

**NOT PASS — one material economics error must be corrected before this research task can close.**

The observation/source-rights work is otherwise acceptable:
- 17/17 natural shadow runs completed in the available ~3h sample.
- 6h/12h/24h windows were correctly identified as incomplete/left-censored.
- Same-window important/most_important = 0, so recall parity was correctly left unproven.
- GDELT degradation was reported honestly.
- Shadow paid-search usage remained 0 calls / $0 in the observed sample.
- Production mutation = 0.
- JPX TDnet Index API is a concrete research candidate, but no contract/contact/signup was performed.

### C1 blocker — baseline cost arithmetic

The Report and research document incorrectly multiply the prior mean **cost per fetch cycle** (`$0.056721/cycle`) by **nominal search slots/day** (`48` / `96`).

Those units are incompatible.

Correct baseline cadence already established in prior C1:
- through 2026-09-23: **12 fetch cycles/day**, nominally 4 search slots each = 48 search slots/day
- from 2026-09-24: **24 fetch cycles/day**, nominally 4 search slots each = 96 search slots/day

Therefore using the observed small-sample mean `$0.056721/fetch cycle`:
- 12 cycles/day = about **$0.680652/day = $20.42 / 30d**
- 24 cycles/day = about **$1.361304/day = $40.84 / 30d**

The current `$81.68 / $163.36 per 30d` figures are ~4x too high because they multiply a per-cycle cost by per-search-slot counts.

### Required continuation

1. Correct this arithmetic in:
   - `.agent/CODEX_REPORT.md`
   - `docs/news-coverage/SHADOW_RIGHTS_AND_LICENSED_OPTIONS_2026-09-20.md`
2. Preserve the distinction:
   - fetch cycles/day = 12 / 24
   - nominal search slots/day = 48 / 96
3. Keep the prior small-sample caveat.
4. Do not change the JPX facts or any production state unless another evidence issue is found.
5. Rebase/refresh the documentation branch onto current main if needed; H1-owned doc only.
6. Production mutation remains **0**.
7. Return to `review_required` and stop for C1 again.

**Recommended model: Luna.**


## C1 continuation completed — 2026-09-20

- Corrected the baseline arithmetic in the H1 report and research document using the prior small-sample mean of $0.056721 per fetch cycle.
- 12 cycles/day = 48 nominal search slots/day (4 per cycle) = $0.680652/day, about $20.42/30d. 24 cycles/day = 96 nominal search slots/day = $1.361304/day, about $40.84/30d. Search-slot counts are not multiplied by the per-cycle mean.
- Refreshed documentation-only artifact is on [codex/important-news-source-rights-research-20260920-c1fix](https://github.com/anohi-memories/kabumori/tree/codex/important-news-source-rights-research-20260920-c1fix) at ffb21da81a082288dacb652f82640f5165b965a5; it is based on the fresh main head 2fbb0a11480a79718d8cadfa5e6c65693cf0de33. No merge requested.
- Existing observations and source-rights findings are unchanged. Production mutation remains 0.
- status: review_required; next_owner: chatgpt. Stop for C1.
