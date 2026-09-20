# Codex Task

- task_id: important-news-phase1-live-shadow-rollout-20260920
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: C1 PASS済みのPhase 1調査結果を受け、旧重要ニュース監視を一切止めずにlive shadowをproductionへ安全導入し、replacement経路の実first_seen/recall/latency/costを測定できる状態を作る。

## User approval

2026-09-20、前C1で「次は旧方式を残したままlive shadowを動かし、実際のfirst_seen時刻を集める。これは本番にshadow用Function/Cron/テーブルを追加するため明示承認が必要」と説明した上で、ユーザーが「すすめて」と明示。

よって本H1では **shadow専用production resourceの最小導入を承認済み** と扱う。

ただし承認範囲はshadowのみ。
旧production pipelineの削減/cutoverは未承認。

## Proven basis

前H1 C1 PASS:
- durable equivalent replay artifact:
  - branch: codex/important-news-phase1-replay-followup-20260919
  - commit: b7f14ef3455339b7857aa7f155aa591c494ad903
- 19件のequivalent cohortを再構築済み。
- historical replacement first_seenは19/19未証明。
- 全対象laneでlegacy paid fallback維持。
- Phase 0 usage meteringはproduction v58で自然実行確認済み。
- current important-news-fetch:
  - 9/19〜9/23: 12 fetch cycles/day = nominal 48 fixed searches/day
  - 9/24以降: 24 cycles/day = nominal 96 fixed searches/day
- natural cost sample:
  - 4 runs / 18 actual web_search calls
  - total $0.226884
  - mean $0.056721/fetch cycle
- MICはadditional trigger only。速報の必須dependencyにはしない。
- official-title/body-missing candidateは別branchにisolated/unintegrated:
  - codex/important-news-phase1-recall-safe-20260919 @ 8fd612471b04d09bd379a7ed74ed99e84647a72b

## Primary goal

live shadowで次を初めて実測可能にする:

1. free/official source側の実first_seen_at
2. old pipeline detected_atとの実時間差
3. important/most_important eventの取り逃し有無
4. source health / rate limit / stale状態
5. conditional Web Searchの発火回数と費用
6. lane別にlegacy paid fallbackを安全に外せるか

**旧pipelineは完全維持。投稿/X/Push/Appは旧pipelineだけ。**

## Non-negotiable safety

- old important-news-fetch/judgement/generation/publish-readyの挙動を変更しない。
- old fixed breaking searchesを減らさない。
- existing important_news_candidates / important_news_monitor_runs にshadow candidateを書かない。
- shadow dataは専用tableのみ。
- shadowからX/Push/App/publish RPCを呼ばない。
- shadow candidateをlive judgement/generation selectorがconsumeできない構造にする。
- OAuth/Vault/secrets/social-mobile/market-report/G1/G2/H2へ触れない。
- MICはread-only trigger参照のみ。MIC側変更禁止。
- blind supabase db push禁止。
- migration history repair/reconcile禁止。
- exact migrationのみ。
- 既存未commit変更は触らない。
- production write前にfresh origin/main + 他slot再確認。

## Mandatory startup

開始前に必ず:
1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. other 3 slot TASKs
6. fresh origin/main
7. production Cron inventory read-only
8. production important-news schema/function inventory read-only
9. current important-news-monitor version/source hash read-only
10. current Phase 0 ai_usage_events/news usage read-only
11. existing candidate branches/artifacts確認

同じDB migration / same Function / same Cron / important-news shadow objectsを他slotが変更中ならSTOP。

## Approved architecture

### A. Isolated tables

専用table候補:
- public.important_news_shadow_runs
- public.important_news_shadow_candidates

必要最小限のみ。
live tablesは流用しない。

最低記録項目:

shadow_runs:
- id
- started_at
- completed_at
- trigger
- source_health jsonb
- free_fetch_count
- conditional_search_count
- input_tokens/output_tokens/web_search_calls/cost_usd
- status/error_summary
- created_at

shadow_candidates:
- id
- shadow_run_id
- event_key
- dedupe_key
- source_name
- source_url
- topic/category
- headline
- published_at
- first_seen_at
- trigger_reason
- free_source_health
- conditional_search_used
- query/topic if used
- estimated_cost
- matched_live_candidate_id nullable
- old_detected_at nullable
- old_importance nullable
- detection_delay_sec nullable
- evidence metadata
- created_at

必要なら命名/列はcurrent repo conventionに合わせて調整可。
RLS/grantsはshadow Functionのservice roleだけを第一候補。
anon/authenticatedから直接読書きできないこと。

### B. Shadow Function

新規 isolated Edge Function:
- important-news-shadow

役割:
- free/official source取得
- deterministic normalize/dedupe
- source health記録
- event/schedule/MIC/source-health trigger判断
- 条件を満たす場合だけ targeted Web Search
- live candidatesとのread-only比較
- shadow tablesへ記録
- X/Push/App/publish 0

既存 important-news-monitor を改造してshadow modeを混ぜるより、isolated Functionを優先。

### C. Sources

最低候補:
- GDELT
- BBC World
- Al Jazeera
- White House
- ECB
- SEC
- JMA/日本の公式防災ソース
- BOJ / Fed等current official feedで利用可能なもの

ただし:
- sourceが実際にfreshであることをpreflight確認。
- NHK RSSは前調査で停止疑い。freshness確認できない限り主要source扱いしない。
- 1 sourceに依存しない。
- source-specific rate limit遵守。
- GDELTはbounded backoff/cooldown。
- 取得0件とsource healthyを混同しない。

### D. MIC

read-onlyで:
- market_events
- market_state_current

material change/new eventがある場合に追加trigger候補。
MICが遅い/空/失敗でもshadowは続行。

### E. Conditional Web Search

固定4検索をshadowでも毎回再実行するのは禁止。

発火候補:
- 新規free/official event
- high-signal title/body不足
- scheduled event window
- MIC material change
- source lane unhealthy/stale時のfallback
- low-frequency rare-event sweep

静かなcycleは0 paid searchesを許容。

ただしsource failure時にrecallを守るfallbackを禁止しない。
費用だけを守るhard capで緊急fallbackを止めない。

### F. Matching old pipeline

event_key + normalized entities/topic + canonical URL/content hash等でlive candidateへmatch。

matchできた場合:
- matched_live_candidate_id
- old_detected_at
- old_importance
- delay sec
を記録。

match未成立はunknownとして残し、無理にsame event扱いしない。

## Rollout sequence — approved

以下の順序でのみproductionへ進める。

### Gate 1 — source/local implementation

- fresh mainからclean branch/worktree。
- shadow migration + Function + tests + docs。
- source health parser tests。
- dedupe/matching tests。
- conditional trigger tests。
- no-publish boundary tests。
- cost metering tests。
- git diff --check。
- Deno/type checks where applicable。

失敗時STOP。

### Gate 2 — exact migration apply

C1前でも、このH1ではユーザー承認済み範囲として **shadow専用migration 1本だけproduction apply可**。

条件:
- preflightでobject absent/compatible確認。
- exact SQLのみ。
- no db push / include-all。
- grants/RLS/indices read-back。
-既存important-news tables/functionsのhash/schema不変確認。
- migration apply後にFunction deploy前でもlive pipelineへ影響0であること。

### Gate 3 — shadow Function deploy

- important-news-shadowのみdeploy。
- existing important-news-monitor redeploy禁止。
- deploy後source hash/read-back。
- manual invokeは **dry_run/read-only source checkまたはshadow write smokeのみ** に限定。
- manual OpenAI Web Searchは原則避ける。trigger logicの人工paid callは禁止。
- smoke rowsを作る場合は明確にsynthetic=true相当識別、またはrollback/delete可能な専用test row。自然データと混ぜない。

### Gate 4 — Cron

新規shadow Cron 1本。
最終target cadence:
- every 10 minutes

ただし最初は safety canary:
- 30分間隔で最低2回自然実行確認
- source health / 0 publish / cost / errorを確認
- 問題なければ10分へ変更可

Cron変更はshadow Cronのみ。
old Cronは一切変更しない。

### Gate 5 — natural observation

最低限C1までに:
- 2回以上 natural shadow runs
- X/Push/App writes 0
- legacy Cron/hash unchanged
- source health rows
- first_seen_at rows or no-event healthy proof
- conditional Web Search count/cost
- error/backoff挙動
を確認。

自然eventが無ければ「recall proven」とはしない。

## Cost guard

Shadow期間は追加費用が発生する。

必須:
- Phase 0 ai_usage_events互換またはshadow専用usage記録。
- feature名はnews_shadow_*などliveと区別。
- actual web_search_calls / tokens / costをrun単位で記録。
- daily projected costをReport。

異常ループ防止:
- same event/topicのcooldown
- per-source retry backoff
- run idempotency/claim
- duplicate trigger suppression

ただしemergency fallbackを単純な日額hard capで無効化しない。

## Recall acceptance remains unchanged

今回shadowを入れた時点ではcutoverしない。

将来cutover検討条件:
- shadow最低14日推奨
- important / most_important missed = 0
- match可能eventのreplacement first_seenを実測
- positive delayは原則<=20分
- median/p95 old以下目標
- source-health degradation時のfallback動作確認
- lane単位で証拠が揃ったものだけlegacy search削減
- unproven laneはlegacy fallback維持
- 70% cost reductionはrecallより下位

## Official-body enrichment

前branch候補を参考にしてよいが、今回の主目的はshadow計測。

許可:
- shadow側で official title/body不足を検出し、official body取得/conditional search triggerとして記録。
- fixture/test追加。

禁止:
- live important-news-monitorへ統合/deploy。
- live judgement/no_post挙動変更。

## Production mutations allowed in this H1

承認済み:
1. shadow専用migration 1本
2. important-news-shadow Function deploy 1本
3. shadow専用Cron 1本のcreate/enable/cadence変更（canary→10min）

それ以外は禁止。

特に禁止:
- old important-news-fetch Cron変更
- old breaking_market query変更/削減
- important-news-monitor deploy
- judgement/generation/publish-ready変更
- live schema/RPC改変
- market-report/MIC source変更
- X/Push/App publication変更
- OAuth/Vault/secrets
- migration history repair

## Rollback

最優先rollback:
1. shadow Cron disable
2. shadow Functionを呼ばない状態へ
3. shadow dataは監査用に保持
4. old pipelineは最初から無変更なのでそのまま継続

schema dropは緊急rollbackに含めない。
削除が必要なら別migration/review。

## Deliverables / C1

.agent/CODEX_REPORT.md に最低限:

- task_id/result
- fresh main base
- changed files/commit/branch
- exact migration name/hash
- exact Function version/source hash
- shadow Cron jobid/name/schedule/active/command hash
- canary→10min変更の有無
- old important-news Cron/hash unchanged proof
- old important-news-monitor version/hash unchanged proof
- RLS/grants proof
- source list + health
- natural run count
- free candidates count
- matched live candidates count
- first_seen/delay evidence
- conditional paid search count/tokens/cost
- projected daily/monthly shadow cost
- X/Push/App writes = 0 proof
- MIC modifications = 0
- other slot objects untouched
- rollback proof
- remaining recall gaps
- exact next recommendation

完了時:
- this TASK -> review_required
- next_owner -> chatgpt
- .agent/CODEX_REPORT.md更新
- control metadataをmainへ同期
- C1待ちでSTOP

**このH1完了だけでlegacy search削減/cutoverへ進んではならない。**


## User-approved continuation — 2026-09-20

The H1 implementation reached a safe stop before creating the authenticated shadow Cron.

User-reported completed state before this approval:
- one shadow-only migration applied to production
- `important-news-shadow` v1 deployed
- RLS enabled; anon/authenticated access denied
- unauthenticated POST returns 401
- 12 tests + typecheck passed
- legacy important-news Function/Cron hashes unchanged
- X / Push / App writes = 0
- branch commit `69b66b8` pushed
- authenticated 30-minute Cron, natural 2-run observation, 10-minute cutover, and main synchronization were not completed
- direct push to origin/main was rejected by the safety review

### Explicitly approved exception

For this continuation only, the user explicitly approves the following additional production mutations:

1. Create a new dedicated secret named `important_news_shadow_cron_secret`.
2. Store the same new dedicated secret in:
   - the `important-news-shadow` Edge Function environment
   - Supabase Vault for Cron use
3. Modify/redeploy **only** `important-news-shadow` so authenticated Cron calls can be validated using this dedicated secret.
4. Create exactly one authenticated shadow-only Cron at 30-minute cadence.
5. After at least 2 successful natural 30-minute executions and safety verification, change **only that shadow Cron** to 10-minute cadence.
6. Create a PR from the H1 branch to main.
7. **Do not auto-merge the PR.** C1/explicit review is required before merge.

### Secret handling constraints

- Generate a new high-entropy random value; never reuse service-role keys, anon keys, existing webhook secrets, OAuth secrets, or existing application secrets.
- Do not place the secret in URL/query parameters.
- Send it only in a request header or equivalent secret header mechanism.
- Do not expose the secret value in Git, logs, Function responses, Cron command read-backs, Reports, screenshots, or assistant output.
- Cron command/hash evidence must redact the secret.
- Vault row/content may be checked structurally, but never print plaintext secret.
- Existing secrets must remain untouched.
- No service-role credential may be embedded in Cron.

### Auth design requirements

- Authentication applies only to `important-news-shadow`.
- Fail closed on missing/invalid secret.
- Use constant-time comparison where practical.
- No fallback to unauthenticated execution.
- Do not weaken `verify_jwt` / auth behavior of unrelated Functions.
- Keep all X/Push/App/publish surfaces absent from shadow.
- Preserve old important-news-monitor and old Cron byte-for-byte/hash-identical where practical.

### 30-minute canary acceptance

Before 10-minute cutover, verify at least 2 natural Cron executions:
- HTTP success / completed shadow run
- source health recorded
- no X/Push/App writes
- no legacy candidate mutation
- old important-news Cron/hash unchanged
- old important-news-monitor version/hash unchanged
- conditional Web Search count/cost recorded
- no retry storm / duplicate run
- secret not logged
- no unexpected 401/403/5xx loop

If any safety check fails:
- disable the shadow Cron immediately
- keep legacy pipeline untouched
- stop for C1 with evidence

### 10-minute cutover

Only after the 2-run canary passes:
- change the shadow Cron only to every 10 minutes
- verify active/schedule/command hash
- confirm legacy jobs unchanged again
- observe at least one natural 10-minute run if timing permits before C1
- do not interpret this as recall parity or cutover approval

### PR / main synchronization

Because direct main push was rejected:
- create a PR from the H1 branch to main
- include only H1-owned source/docs/migration/control-file changes
- no unrelated H2/G1/G2 changes
- no auto-merge
- record PR number/URL in CODEX_REPORT
- if branch is behind main, fresh-check and rebase/cherry-pick only H1-owned changes safely; do not overwrite concurrent work

### Updated production mutation scope

Allowed in this continuation:
- the already-applied shadow migration
- `important-news-shadow` redeploy only
- one new dedicated Vault secret entry
- one matching Function environment secret
- one shadow Cron create + its 30m -> 10m cadence update
- PR creation

Still prohibited:
- service-role Cron auth
- any existing secret mutation
- old important-news-fetch/judgement/generation/publish-ready changes
- `important-news-monitor` deploy
- fixed breaking search reduction
- live candidate/judgement behavior changes
- X/Push/App publication changes
- MIC source/Cron changes
- market-report changes
- OAuth/social-mobile changes
- migration history repair/reconcile
- blind db push
- auto-merge

### Completion / C1

Update CODEX_REPORT with:
- exact new Function version/source hash
- secret presence proof without value
- Vault presence proof without value
- Cron jobid/name/schedule/active/redacted command hash
- two 30-minute natural run timestamps/results
- 10-minute cutover proof if performed
- at least one 10-minute natural run if available
- source health/candidate/match/search/cost metrics
- old Function/Cron unchanged proof
- X/Push/App writes = 0
- rollback path
- PR number/URL
- production mutation inventory
- remaining recall gaps

Then set status=review_required, next_owner=chatgpt, sync control metadata through the PR/allowed safe route, and STOP for C1.

**Recommended model: Sol.**
