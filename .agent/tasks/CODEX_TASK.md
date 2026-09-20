# Codex Task

- task_id: important-news-phase1-shadow-observation-plus-source-rights-research-20260920
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
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
