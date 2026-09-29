# Claude Task 2 — CURRENT TASK

- task_id: kabumori-shared-analysis-content-guard-fix-20260929
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: highest
- recommended_model: Opus5.5（高）
- purpose: 2026-09-29大引けshared analysisがlocal check / Factで2回失敗した実例を再現し、1306の誤ラベルと根拠のない因果断定をsource側で最小修正する。transport retry・claim/idempotency・consumer gateは変えない。

## Accepted K2 finding

Previous task `kabumori-shared-analysis-prod-deploy-observe-20260928`:
- controlled deploy/read-back of PR #45 retry hardening: PASS.
- app_enabled=false / x_enabled=false preserved.
- transport retry diagnostics on 9/29 close: retries=0; transport layer was not the cause.
- 9/29 close:
  - attempt 1: `ANALYSIS_LOCAL_CHECK_FAILED`
    - generated text treated TOPIX-linked ETF 1306 as if it were TOPIX itself.
  - attempt 2: `ANALYSIS_FACT_FAILED`
    - headline/x_post asserted US-stock/semiconductor weakness as the cause of Tokyo decline although the input did not confirm that causal relationship.
- market_report_packet remained absent for the close cycle.
- consumer activation is NOT approved yet.

## Product/content contract

Fix the generator/validation contract; do not weaken validation just to make output pass.

Required semantics:
1. 1306 is a TOPIX-linked ETF/proxy, not the TOPIX index itself.
   - Generated content may say `TOPIX連動ETF（1306）`, `TOPIX連動型ETF`, or another accurate proxy wording.
   - It must not relabel 1306 as `TOPIX` or present its price/move as the index itself.
2. Causal claims must not exceed the evidence.
   - If input says the exact decline/rise reason is unconfirmed, generated headline/body/x_post must retain that uncertainty.
   - Do not convert correlation/timing into a confirmed cause.
   - Hedged language is allowed only when supported; do not invent a plausible cause merely by adding `可能性`.
3. Local/Fact checks remain meaningful and strict.
   - Do not disable, bypass, or broadly relax them.
4. Preserve the current one-shared-packet truth and fail-closed behavior while gates are OFF.

## Mandatory startup / isolation

1. Use the dedicated G2 worktree/checkout, independent from G1.
2. Fresh-fetch origin/main and record SHA.
3. Read PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, this TASK and prior Report.
4. Read current:
   - `supabase/functions/market-report-analysis/**`
   - relevant prompt/generation/regeneration/local-check/Fact flow
   - shared packet contract/tests
5. Confirm no newer main commit changed these files unexpectedly.
6. G1 owns `market-report-data-packet/**` production sync. Do not edit that directory in this task.
7. If ownership overlaps or fresh isolation is not safe, STOP.

## Reproduction first

Before editing, create a deterministic/sanitized replay fixture or equivalent test reproducing both 9/29 failures:
- 1306 proxy identity case
- unconfirmed-causality case

The test input must contain enough source semantics to prove the intended behavior without user/private portfolio content.

Document whether each failure originates in:
- initial generation instruction
- regeneration instruction
- normalization/post-processing
- local check
- Fact prompt/contract
- or a combination

Do not guess.

## Implementation requirements

Make the narrowest source change that reliably prevents both failure classes.

Preferred direction if confirmed by audit:
- strengthen generation/regeneration instructions to preserve instrument identity
- explicitly preserve qualifiers/uncertainty from source facts
- add deterministic guard(s) only where they can be precise without false positives
- ensure retry/regeneration cannot turn a qualified statement into a stronger causal assertion

Do not:
- add generic censorship that removes useful market explanation
- hard-code only the exact 9/29 sentence
- rename all ETF references blindly
- weaken Fact/local checks
- change transport retry behavior
- change model routing/call budgets unless proven necessary
- change claim/idempotency/fencing
- touch consumer gates

## Tests

At minimum:
- replay: 1306 cannot become TOPIX index
- replay: unconfirmed cause cannot become asserted cause in headline
- same for x_post
- qualified/uncertain wording remains qualified after regeneration
- a genuinely source-confirmed causal statement can still be expressed as confirmed
- no regression to existing local/Fact failure handling
- no transport retry triggered by Fact/local rejection
- shared packet/idempotency regression
- morning + close relevant suites
- existing market-report-analysis suite
- `deno check`
- `deno lint`
- `git diff --check`

Run the broadest relevant deterministic suite available.

## Delivery

This is source + tests only.

Create a focused PR. Do NOT self-merge.

Forbidden:
- production deploy
- app_enabled/x_enabled mutation
- cron mutation
- DB/schema/RPC/migration
- manual real cycle invocation
- X post
- G1 data-packet files

## Completion / K2

Report:
- task_id/result
- fresh main SHA/worktree/branch
- root cause for each 9/29 failure
- exact changed files
- replay tests before/after
- full test/check/lint results
- transport/idempotency preserved proof
- PR URL/head SHA
- production mutation = 0
- remaining issues
- recommendation for review/merge/deploy and later natural-cycle observation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

Codex review is deferred until ChatGPT K2 sees the final scope. Consumer activation/public-X boundary will require focused review.

---

## Archived predecessor state

# Claude Task 2 — CURRENT TASK

- task_id: kabumori-shared-analysis-prod-deploy-observe-20260928
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Sonnet5（高）
- purpose: PR #45でmerge済みのbounded transport retryを、consumer gate OFFのままproduction `market-report-analysis` のみにcontrolled deployし、deployed sourceをread-back照合したうえで、次の自然な朝刊・大引けcycleで共有packet完成率とretry diagnosticsを確認する。

## Accepted baseline

- shared unification proof merged in PR #43.
- retry hardening PR #45 merged -> main `6ea31efec1876596085e9b66727b2626ab0ba477`.
- `app_enabled=false`, `x_enabled=false`.
- no Codex review required before this gated-OFF deploy; focused review is deferred to the consumer activation/public-X release boundary.
- 2026-09-28 morning shared analysis failed with OpenAI 429; 2026-09-28 close shared analysis completed on retry schedule.

## Why Sonnet5（高）

This is a narrow production rollout/read-back/observation task with source already reviewed and merged. No new architecture or code design is expected. Escalate only if live behavior diverges from the reviewed source.

## Mandatory startup

1. Use dedicated G2 worktree/checkout.
2. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK and prior K2 report
3. Fresh fetch `origin/main`; require merge `6ea31efe`.
4. Confirm no newer commit changed `supabase/functions/market-report-analysis/**` after the reviewed merge without explicit review.
5. Read production:
   - current `market-report-analysis` version/source
   - verify_jwt
   - consumer settings
   - cron schedule
6. Confirm:
   - app_enabled=false
   - x_enabled=false
   - no active slot owns `market-report-analysis/**`

If any precondition differs unexpectedly: STOP.

## Resume after shared-checkout recovery

The accidental shared-checkout `supabase/config.toml` overwrite has been repaired by the operator.

Verified coordination state:
- shared checkout recovery changed only `supabase/config.toml`
- production mutation remained 0
- fresh main is `fc0afd32d6697940e96d3b9b52d91ef2c48a76ff`
- use **only** this new dedicated checkout for the remainder of this task:
  - `/Users/yuya/Developer/kabumori-g2-market-report-reliability`
- the older implementation branch/worktree `g2-shared-analysis-reliability-20260928` is historical PR #45 source and MUST NOT be used for deployment
- the shared checkout `/Users/yuya/Developer/kabumori` MUST NOT be used for deploy commands or config edits
- do not copy the shared local `supabase/config.toml` into the G2 checkout
- use explicit deploy arguments (`--project-ref wsmznyzcvmuitkglfeuj`, `--no-verify-jwt`, and the already-established API deploy mode where required) rather than creating/editing deploy config in the shared checkout

Before deploy, fail hard on directory mismatch. Use an equivalent guard to:
`cd /Users/yuya/Developer/kabumori-g2-market-report-reliability || exit 1`
and verify `git rev-parse HEAD` is fresh main and includes PR #45.

If the dedicated checkout is missing, dirty from another owner, or not on the expected fresh-main lineage: STOP. Do not fall back to the shared checkout.

## Deploy scope

Deploy only:

- `supabase/functions/market-report-analysis`

From exact merged main source containing PR #45.

Rules:
- preserve `verify_jwt=false`
- do not deploy any other Edge Function
- do not change DB/schema/RPC
- do not change cron
- do not change consumer settings
- do not invoke X
- do not modify legacy X morning/close/VOICE

After deploy:
- read production function version
- download/read-back deployed source
- verify reviewed retry code matches merged main
- verify app_enabled=false / x_enabled=false
- verify cron unchanged

## No manual cycle forcing

Do NOT manually invoke `market-report-analysis` against a real current cycle merely to test retry.

Reason:
- claim/attempt counters are production state
- forcing a run can consume an attempt and distort natural validation

Use natural cron only.

Safe read-only queries/log inspection are allowed.

## Natural morning validation

On the next JPX trading morning, inspect the natural shared cycle.

Capture without sensitive content:

- cycle_status
- report_status
- report_attempt_count
- report_last_error
- current_data_packet_id
- current_report_packet_id
- analysis diagnostics:
  - transport_retries
  - transport_retry_wait_ms
  - transport_retry_reasons
  - transport_retry_exhausted
  - transport_success_after_retry
- packet creation count / duplicate check
- timestamps / duration

PASS conditions:
- if no upstream transient occurs: normal completion with retry count 0 is valid
- if a retryable transient occurs: bounded retry behavior matches policy and can recover
- no duplicate report packet
- no unexpected claim churn
- no consumer gate activation

If morning fails for a retryable condition despite reviewed retry, preserve evidence and continue only with read-only diagnosis; do not hot-patch blindly.

## Natural close validation

On the same next JPX trading day, inspect the natural close cycle.

Capture the same fields.

Also distinguish:
- transport failures
- existing `ANALYSIS_FACT_FAILED` content failure

Do not treat a Fact failure as a transport-retry bug.

PASS conditions:
- shared close ultimately completes safely under existing scheduled retry semantics
- no duplicate packet
- transport diagnostics are accurate
- no regression in cycle fencing

## Consumer safety check

Throughout:
- `app_enabled=false`
- `x_enabled=false`

The app/X continue legacy behavior for user-facing output while shared packet generation is observed in background.

Do not judge old X VOICE/close failures as blockers for this task; they are being replaced by the shared path.

## No source changes expected

This is deployment/observation only.

If a source bug is discovered:
- do not patch production ad hoc
- record exact repro/evidence
- status -> review_required
- next_owner -> chatgpt
- STOP for a new source TASK

## Completion conditions

PASS when:

1. exact PR #45 source is deployed to `market-report-analysis` only.
2. deployed source/read-back matches merged main.
3. verify_jwt and cron are unchanged.
4. app/x consumer gates remain false.
5. at least one natural morning and one natural close shared cycle after deploy are observed.
6. no duplicate packet/idempotency regression occurs.
7. retry diagnostics behave coherently.
8. any remaining failure is correctly classified as transport vs Fact/content vs data.

## Required Report

- task_id
- result
- fresh main SHA
- worktree/branch
- production version before/after
- deployed source identity/read-back
- verify_jwt before/after
- app_enabled/x_enabled before/after
- cron before/after
- morning cycle result + retry diagnostics
- close cycle result + retry diagnostics
- packet IDs / duplicate check
- production mutations
- rollback status
- remaining issues
- recommendation:
  - ready for consumer activation review
  - or further reliability work needed
- Codex review recommendation for activation boundary

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Report — kabumori-shared-analysis-prod-deploy-observe-20260928

- task_id：`kabumori-shared-analysis-prod-deploy-observe-20260928`
- result：**PARTIAL（deployはPASS、自然cycleの観察は完了。共有packetは2026-09-29の朝刊・大引けとも未完成）**。
  - transport retryの不具合ではない。朝刊は**data段階のblock**、大引けは**内容の検査（local check・Fact）による失敗**で、transport retryは発生していない（0回）。
  - 完了条件5（朝刊・大引けのcycleを各1回観察）は満たした。ただし朝刊はanalysisまで到達しておらず、retry層が朝刊の実runで動いたことは確認できていない。
- fresh main SHA：deploy時は `fc0afd32d6697940e96d3b9b52d91ef2c48a76ff`（PR #45のmerge `6ea31ef` を含む）。Report作成時は `907c67d`。
- worktree/branch：G2専用checkout `/Users/yuya/Developer/kabumori-g2-market-report-reliability`（detached、`fc0afd3`）。共有checkoutではdeployもconfigの編集もしていない（DBのread-onlyなSELECTだけ）。

#### production version before/after

- `market-report-analysis`：v11（`94aa3ea` 相当）→ **v12（PR #45）**。
  - deploy：2026-09-28 18:49:33 JST
  - `supabase functions list` の表示は `version:13` だが、`updated_at` は上記deploy時刻のまま。一覧の番号の数え方の違いで、追加のdeployはない。
- ほかのfunctionはdeployしていない。

#### deployed source identity/read-back

- deploy直後と2026-09-29 18:40 JST の2回、`supabase functions download --use-api` でbyte照合した。どちらも**8ファイルがすべて一致**。
  - `_shared/kabumori_voice.ts`
  - `_shared/market_report_packet.ts`
  - `market-report-analysis/{analysis_input,analysis_logic,handler,index,transport_retry}.ts`
  - `market-report-data-packet/session_logic.ts`

#### 設定の前後比較

- verify_jwt：false → false
- app_enabled / x_enabled：false / false → false / false（2026-09-29 18:40 JST にも確認）
- cron：変更なし。9/29の実行も、次のscheduleどおりにすべて `succeeded` だった。
  - data：`50 22 * * 0-4`、`15 7 * * 1-5`
  - analysis：`55 22 * * 0-4`、`5 23 * * 0-4`、`20 7 * * 1-5`、`35 7 * * 1-5`

#### morning cycle（2026-09-29）

- **data段階でblockされた**：
  - `cycle_status=blocked`、`last_error=DATA_QUALITY_BLOCKED`（07:50:03）
  - `required_missing=["nikkei225"]`、`gap_reason=expected_session_not_available`（Yahooが9/28の終値を返さなかった）
- analysis側：
  - `report_status=pending`、`report_attempt_count=0`、`report_last_error=null`
  - `current_data_packet_id=null`、`current_report_packet_id=null`
  - 07:55と08:05のcronは実行されたが、claimは起きていない（不要なclaimの繰り返しはない）。
  - transport diagnosticsは記録なし（runが始まっていないため）。
- **見つかったdeployの漏れ（要判断）**：
  - 9/28の大引けpacketには、日経平均が `session_date=2026-09-28` のfreshな値（65,877.62）として保存されている。
  - 同じsessionの値を再利用するfix `aecfa60`（2026-09-18、`session_reuse.ts`）はmainにある。**しかし本番の `market-report-data-packet` には入っていない**。
    - 本番の最終deployは2026-09-17 14:43 JST。
    - `--use-api` でdownloadしたsourceには `session_reuse.ts` がなく、handlerにも再利用のcodeがない。
  - 同じ原因のblockが09-18、09-25、09-29に起きている。このfixをdeployすれば、今回のblockは避けられた可能性が高い。
  - 本TASKの範囲外（data-packetのdeployは禁止）なので、何もしていない。

#### close cycle（2026-09-29）

- data段階：`completed`（16:15）、`dataQuality=partial`、`requiredMissing=[]`。data packetは `58f6f5ea…`。
- analysis：
  - attempt 1（16:20）：`ANALYSIS_LOCAL_CHECK_FAILED`。
    - 指摘は「TOPIX連動ETF（1306）をTOPIXと表記」で、内容の問題。
  - attempt 2（16:35:00〜16:35:25）：`ANALYSIS_FACT_FAILED`。
    - 指摘は、見出しと `x_post` の冒頭が、米株安・半導体株安を東京市場の下落の原因と断定していたこと。入力では、具体的な下落理由は確認できないとされていた。
    - 内容の問題。
  - 最終状態：
    - `report_status=failed`、`report_attempt_count=2`
    - `current_report_packet_id=null`
    - 3回目のclaim枠は、scheduleされたrunがないため未使用。
- attempt 2のdiagnostics：
  - `transport_retries=0`、`transport_retry_wait_ms=0`、`transport_retry_reasons=""`
  - `transport_retry_exhausted=false`、`transport_success_after_retry=false`
  - calls=3、cost約$0.0068、model `gpt-5.6-luna`
- 分類：**transportの失敗はない。2回とも内容（local check・Fact）の失敗**。
  - Factの拒否はretryの対象外という設計どおりに動いている。
  - 09-24、09-25、09-28は2回目で完了していたが、09-29は2回とも失敗した。

#### packet IDs / duplicate check

- 2026-09-29の `market_report_packets`：**0件**（朝刊・大引けとも）。重複はない。
- data packet：朝刊は1件（blocked）、大引けは1件（partial、`58f6f5ea`）。重複はない。
- cycleのfencingに異常はない。朝刊はclaimされず、大引けは2回のclaimで、それぞれ1回のfailを記録した。

#### production mutations

- 1件だけ：2026-09-28 18:49 JST の `market-report-analysis` のdeploy。
- それ以外（DB・cron・settings・ほかのfunction・手動のinvoke）は0件。観察はすべてread-onlyのSELECTと、source downloadだけで行った。

#### rollback status

- rollbackはしていない（不要と判断）。
  - retry層は発動しておらず、失敗の原因はv12の変更と関係がない。
- 戻す場合は、v11のsource（scratchpadのbackup、`94aa3ea` とbyte一致）を再deployするだけでよい。

#### remaining issues

1. **（data・deployの漏れ）** `market-report-data-packet` の本番に `aecfa60`（同じsessionの値の再利用）が入っていない。
   - Yahooが前日の日経平均の終値を返さない朝は、共有の朝刊がdata段階で止まる（09-18、09-25、09-29）。
   - 別gateでのdeploy（mainのdata-packetをbyte照合付きで）を推奨する。
2. **（内容）** 大引けのanalysisが内容の検査で落ちる。
   - 1306をTOPIXと表記する。
   - 理由が確認できないのに、因果を断定する。
   - 09-29は2回とも落ち、packetが未完成になった。promptとlocal check・Factの整合を扱う別のsource TASKが必要。
3. transport retryは、実運用ではまだ一度も発動していない。朝刊での実runの確認は、1が直ってからになる。
4. （既知）JGBとWTI・Brentがstale、先物・セクター・カレンダーはsourceがない。themesが空になりがち。
5. OpenAIの残高は手動チャージ。`insufficient_quota` の429は設計上retryしない。

#### recommendation

- **further reliability work needed**。consumerの有効化レビューはまだ早い。
  - 9/29は、共有packetの完成が朝刊・大引けとも0/2だった。
- 順序の提案：
  1. data-packetの本番を、main（`aecfa60` を含む）にそろえるdeployのTASK
  2. 大引けの内容失敗（1306の表記、因果の断定）を直すsourceのTASK
  3. 数営業日の自然cycleで完成率を再観察する
  4. そのあとで、consumerの有効化レビューに進む

#### Codex review recommendation for activation boundary

- 有効化（app_enabled、x_enabled）の前には、**focusedなCodex review**を推奨する。
  - 範囲：共有packetが欠けた場合のconsumerの挙動。現状、appはgateがONでpacketがないとrun全体をskipする。
  - 範囲：大引けの内容検査の修正。
- data-packetの再deploy自体は、mainにreview済みのcodeをそろえるだけなので、byte照合付きの軽い確認で十分と考える。

---

# Previous completed G2 task — reliability hardening

# Claude Task 2 — CURRENT TASK

- task_id: kabumori-shared-report-reliability-hardening-20260928
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- purpose: 共通 `market_report_packet` をX/アプリの正本として本番切替できるようにするため、`market-report-analysis` のOpenAI 429/一時障害耐性を最小変更で強化し、朝刊・大引けの共有packet完成率を上げる。旧X生成/VOICE経路は修正しない。

## Accepted K2 baseline

- PR #43 merged -> main `a0ac6484ecdc59670241c2ffb2e0340e93fd5994`.
- One shared packet identity feeding:
  - X simplified
  - App 市場全体
  - App マイポート
  is proven.
- `app_enabled=false`, `x_enabled=false` remain the required production state for this task.
- 2026-09-28:
  - shared morning data completed but shared analysis failed: `ANALYSIS_OPENAI_GENERATE_FAILED:429`
  - shared close analysis ultimately completed on report attempt 2
  - old X close failed `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
  - App legacy close completed
- Therefore the architecture is accepted; the immediate blocker is shared-analysis reliability, not old X VOICE or old X close logic.

## Product decision for degradation

For the initial shared cutover, **do not fall back to a second independent legacy market analysis when the shared packet is unavailable**.

Reason:
- the user's priority is one market truth for X and App
- legacy fallback would reintroduce contradictory market narratives

Current fail-closed semantics stay in place during this task.

A future "portfolio-only degraded mode" that does not invent/recompute market direction may be designed separately if needed. Do not implement it here.

## Mandatory startup

1. Dedicated independent G2 worktree/checkout.
2. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - previous K2 report
   - `docs/market-report-shared-platform/DESIGN.md`
3. Fresh fetch `origin/main`; require main to contain merge `a0ac6484`.
4. Read current production versions/settings before mutation.
5. Confirm no active slot overlaps:
   - `supabase/functions/market-report-analysis/**`
   - relevant shared cycle scheduler/retry ownership
6. Preserve PR #41 / G3/G4 / important-news / MIC ownership boundaries.

## Primary investigation

Read-only first. Determine exactly why morning 2026-09-28 ended in 429 while close later completed.

Inspect:
- current `market-report-analysis` requester / handler
- existing report claim/retry semantics
- existing cron schedule and retry times
- whether 429 response carries `Retry-After`
- how many OpenAI calls can occur from:
  - first generation
  - regeneration after local/Fact failure
  - Fact call
  - scheduled retry
- current time budget / Edge execution limits
- idempotency / claim fencing when a retry occurs

Do not guess the retry model.

## Required implementation outcome

Implement the narrowest safe reliability improvement for transient upstream failures.

Preferred direction, if supported by the audit:
- retry only retryable transport/upstream conditions:
  - HTTP 429
  - HTTP 5xx
  - bounded network/timeout failures where safe
- honor `Retry-After` when present and sane
- otherwise use a short capped backoff
- strict maximum retry count
- no infinite loops
- no retry on:
  - local schema/validation failure
  - Fact rejection
  - non-retryable 4xx
  - malformed product input
- preserve current claim/idempotency model
- preserve one completed packet as the only truth
- keep cost bounded and observable

If the existing scheduled retry is already sufficient and the better fix is scheduling rather than in-function retry, document exact evidence and implement the safer minimal alternative. Do not add a new cron blindly.

## Call-budget safety

Explicitly calculate and test worst-case OpenAI call count.

The reliability layer must not accidentally multiply:
- generation regeneration
- Fact
- scheduled retry
into an unbounded or unexpectedly expensive sequence.

Report:
- max generation calls per run
- max Fact calls per run
- max transient retry calls per request/run
- max scheduled attempts per cycle
- worst-case bounded total

## Observability

Add only non-sensitive observability needed to distinguish:
- upstream 429
- 5xx/network retry
- retry exhausted
- success after retry

Do not log:
- prompts
- user portfolio data
- secrets
- raw credentials

Prefer existing diagnostics fields/log structure; no schema change unless absolutely necessary.

## Tests

At minimum:

- first generation gets 429 then succeeds
- repeated 429 exhausts bounded retry and fails cleanly
- 500 then success where retryable
- non-retryable 4xx does not retry
- Fact/local rejection does not trigger transport retry
- no duplicate `market_report_packet`
- claim/idempotency remains intact
- completed cycle remains immutable/current correctly
- morning and close both covered
- existing market-report-analysis suite
- market-report-data-packet related regression
- shared unification tests from PR #43
- X shared consumer
- personalized shared consumer
- `deno check`
- `deno lint`
- `git diff --check`

Use injected fake requester/fetch/timer where possible. Do not sleep real test time unnecessarily.

## Production / deploy constraint

This task is **source + deterministic validation only** unless ChatGPT explicitly extends it after K2.

Forbidden:
- `app_enabled=true`
- `x_enabled=true`
- real X post
- consumer-gate mutation
- production cron mutation
- migration apply
- unrelated Edge deploy
- legacy X morning/close VOICE patch

If a production deploy is necessary to prove the retry itself, STOP at source-ready and request the next gate.

## Scope boundaries

Allowed:
- `supabase/functions/market-report-analysis/**`
- narrowly related shared report tests/helpers/docs

Avoid unless truly required:
- `market-report-data-packet/**`
- `personalized-reports/**`
- X consumer code

Forbidden:
- `important-news-monitor/**`
- news API optimization/shadow files
- MIC implementation
- `x-test-post/index.ts`
- PR #41 Stage 3B files
- G3/G4 social-mobile
- Admin/Auth/OAuth/Vault
- unrelated migrations/RPCs

## Completion conditions

PASS only if:

1. 2026-09-28 429 failure mode is reproduced or mechanistically demonstrated.
2. Retryable upstream errors have a bounded, tested recovery path.
3. Non-retryable/content failures are not retried as transport failures.
4. Cost/call amplification is bounded and documented.
5. Claim/idempotency behavior remains safe.
6. Existing shared unification proof still passes.
7. No consumer gate or production publishing was activated.
8. Exact next cutover/deploy plan is written.

## Required Report

- task_id
- result
- fresh main SHA
- worktree/branch
- 2026-09-28 failure analysis
- existing retry/cron behavior
- implemented retry policy
- changed_files
- tests
- max/worst-case call budget
- diagnostics/observability changes
- commit_hash
- PR
- push
- deploy
- app_enabled/x_enabled before/after
- production mutations
- overlap checks
- remaining issues
- rollback plan
- exact next step toward shared production cutover
- Codex review recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Report — kabumori-shared-report-reliability-hardening-20260928

- task_id：`kabumori-shared-report-reliability-hardening-20260928`
- result：**source-readyのPASS候補**。`market-report-analysis` に、429・5xx・ネットワーク断に限った再試行（回数と待ち時間に上限あり）を実装した。deploy・gate変更・cron変更はしていない。
- fresh main SHA：`a5c5eaf8c1dee1237f73ef21b206ca26a37300c9`（着手時。merge `a0ac648` を含む）
- worktree/branch：G2専用worktree `scratchpad/kabumori-g2-rel`、branch `g2-shared-analysis-reliability-20260928`

#### 2026-09-28 failure analysis（production read-only）

- **朝刊のcycle**：
  - `report_attempt_count=2`、`report_status=failed`、`report_last_error=ANALYSIS_OPENAI_GENERATE_FAILED:429`
  - attempt 1が07:55、attempt 2が08:05 JST。最後の更新は08:05:02で、claimから約2秒後に失敗していた。
  - つまり、**両方の回とも最初のgeneration requestが429**だった。
- **仕組み**：
  - `openAiRequester` は、okでないresponseを受けた時点で即座にthrowする。
  - そのエラーがhandlerのcatchで `fail_market_report_analysis` になる。**run内の再試行はなかった**。
  - 同じ時間帯（08:20〜08:25）には、旧X朝刊のlaneも429を3回受けていた。持続的なrate limitの窓があったと判断した。
  - 429の `Retry-After` の有無は、pg_netの応答記録が保持期限切れで確認できなかった。そのため、実装側で両方のheader形式に対応した。
- **大引け**（参考）：09-24、09-25、09-28のいずれも、attempt 1（16:20）が失敗しattempt 2（16:35）で完了している。
  - 09-28のattempt 1の応答を確認すると `ANALYSIS_FACT_FAILED`（内容の問題）で、transportの問題ではない。本TASKの対象外。

#### existing retry / cron behavior

- claim：`claim_market_report_analysis(p_max_attempts=3, stale 600s)`。1つのcycleにつき最大3回claimでき、`already_completed`・`in_progress`・`attempts_exhausted` の場合は何もしない。
- cron：
  - 朝刊：data 22:50、analysis 22:55、retry 23:05（UTC）＝ 07:50 / 07:55 / 08:05 JST
  - 大引け：data 07:15、analysis 07:20、retry 07:35（UTC）＝ 16:15 / 16:20 / 16:35 JST
  - いずれも pg_net timeout 150,000ms。
- **scheduleされているのは2回だけ**（3回目のclaim枠は未使用）。
- run内の呼び出し：generationは最大2回（`MAX_GENERATIONS=2`）、Factは最大2回。成功したrunの所要時間は20〜37秒。

#### implemented retry policy

- 実装場所：`transport_retry.ts`（新規）を `openAiRequester` のfetch部分にだけ適用した。
- 再試行するもの：
  - HTTP 429（ただし `insufficient_quota` は除く）
  - 500 / 502 / 503 / 504
  - fetchのネットワークエラー（TypeError）
- 再試行しないもの：
  - それ以外の4xx
  - 自前の90秒timeoutによるabort
  - 空の出力、不正なJSON
  - localの検査やFactによる拒否（生成ロジックは無変更）
- 待ち時間：
  - `retry-after-ms`、`retry-after`（秒またはHTTP-date）を最大20秒まで尊重する。
  - 20秒を超える指定は待たず、scheduleされたretryに任せる。
  - 指定がなければ2秒、次に6秒待つ。
- 上限：
  - 1回の呼び出しにつき追加requestは最大2回
  - 1runの合計で追加requestは最大3回
  - 1runの待ち時間の合計は最大30秒
- 最終的にokでないresponseは、**既存のerror codeのまま**扱う（本番の監視やretryの分類に影響しない）。
- 変更していないもの：claimのfencing、complete/fail RPC、1cycleにpacket 1つ・不変であること、scheduleされたretry。

#### changed_files（PR #45）

- `supabase/functions/market-report-analysis/transport_retry.ts`（新規）
- `supabase/functions/market-report-analysis/handler.ts`（requesterへの配線、Depsに任意の `sleep` を追加、diagnosticsを追加）
- `supabase/functions/market-report-analysis/transport_retry_test.ts`（新規）

#### tests

- 新規 `transport_retry_test.ts`：**14/14**
  - 429のあと成功
  - Retry-Afterの尊重・上限・3形式のparse
  - 429の連続で上限に達する
  - 5xxとnetworkは再試行、timeoutは再試行しない
  - 4xxと `insufficient_quota` は再試行しない
  - run全体の上限
  - **handler統合テスト（朝刊・大引けとも）**：claim 1回・complete 1回・fail 0回、diagnosticsを記録、秘密情報なし
  - 429が続く場合は、本番と同じcode `ANALYSIS_OPENAI_GENERATE_FAILED:429` とfailを記録する（2026-09-28の再現）
  - Factの拒否はtransport再試行の対象外
  - 最悪ケースの上限
- 既存と関連：
  - market-report-analysis 35/35、market-report-data-packet 42/42
  - PR #43のunification 6/6、X shared consumer 6/6、personalized shared consumer 4/4
  - personalized-reports 125/125、関連スイート **338/338**
- deno check・deno lint（変更ファイル）・git diff --checkはPASS。
  - 既存の `handler_test.ts`・`analysis_test.ts` にある `require-await` のlint 2件は、main上にもともとあるもの。

#### max / worst-case call budget

- 1runあたり：
  - generationは最大2回、Factは最大2回（model呼び出しは最大4回で従来どおり）
  - transportの追加requestは最大3回
  - HTTP requestは最大7回
  - 追加の待ち時間は最大30秒
- 1cycleあたり：
  - claimは最大3run（cronは2run）
  - 最悪でHTTP requestは21回、課金されるmodel呼び出しは12回（従来と同じ上限。429の応答は出力を生まない）
- 所要時間：成功時の20〜37秒に、最大30秒の待ちと追加requestが加わる。pg_netの150秒以内に収まる設計。

#### diagnostics / observability

- 既存の `p_diagnostics`（complete・failとも）に次の項目を追加した：
  - `transport_retries`
  - `transport_retry_wait_ms`
  - `transport_retry_reasons`（例：`http_429,http_503`）
  - `transport_retry_exhausted`
  - `transport_success_after_retry`
- prompt・key・responseの本文は記録しない。schemaの変更もない。

#### commit / PR / push / deploy

- commit：`b37e1c921dff47430b8c1d70991bc8eadfc09190`
- PR：https://github.com/anohi-memories/kabumori/pull/45（open・未merge）
- push：branchへpushした
- deploy：**なし**

#### app_enabled / x_enabled

- 着手前：false / false。
- 本TASKでは変更しておらず、完了時もfalse / false（設定は触っていない）。

#### production mutations

- **0**（read-onlyのSELECTだけ）。

#### overlap checks

- `market-report-analysis/**` を扱う他slotや、open PRはない。
- `x-test-post/index.ts`（PR #41）・important-news・MIC・G3/G4の範囲には触れていない。

#### remaining issues

1. 持続的な429の窓（09-28は07:55〜08:25頃）には、run内の最大30秒の再試行だけでは足りない可能性がある。
   - claimの3回目の枠を使う**追加のscheduled retry（例：08:15 JST）**が有効。ただしcronの変更になるため、別途の承認が必要。
   - 共有packetを読むconsumer（X 08:20、アプリ 08:35）より前に終わる時刻にする必要がある。
2. 大引けのattempt 1が内容の問題（Fact）で毎回落ちている。attempt 2で完了しているので配信は間に合っているが、cost・時間とも倍かかる。promptとFactの整合は別TASKで扱うのが望ましい。
3. 429の根本原因（組織全体のrate・quotaの競合。同時刻の他のworkload）は未特定。

#### rollback plan

- `market-report-analysis` を直前の版（現行本番のv11のsource）へ戻すdeployだけで済む。DB・cron・settingsの変更はないので、戻す対象はコードだけ。
- 本PRはretry層を足しただけなので、無効化もrevert 1 commitで済む。

#### exact next step toward shared production cutover

1. K2の後、PR #45をmergeし、`market-report-analysis` **だけ**をdeployする（別gate）。
   - deploy後に `--use-api` でbyte照合する。
   - 自然cronの朝刊・大引けで、diagnosticsの `transport_*` と、packetが完成したかを確認する。
2. 必要なら、3回目のscheduled retryを追加する（別gate、cronの変更）。
3. 共有packetの完成率が安定したら（例：5営業日連続で朝刊・大引けとも完成）、**App gateのON**（`app_enabled=true`）を行う。
   - 最初の自然な朝刊・大引けで、保存された `body.market_section.report_packet_id` とcycleのpacket idが一致することを確認する。
4. その後、focusedなCodexレビューを経て **X gateのON**。
5. 旧経路の削除。

#### Codex review recommendation

- **本PR #45は、軽いreviewを推奨**。本番のcron経路の挙動（再試行の回数と待ち時間）を変えるため。
- 分類（何を再試行するか）と上限の確認が中心で、重いreviewは不要と判断している。


## Final K2 — shared analysis reliability hardening

Verdict: **PASS**.

Accepted:
- PR #45 head `b37e1c921dff47430b8c1d70991bc8eadfc09190`
- changed files limited to:
  - `market-report-analysis/handler.ts`
  - `market-report-analysis/transport_retry.ts`
  - `market-report-analysis/transport_retry_test.ts`
- bounded retry only for transient 429 / selected 5xx / network TypeError
- non-retryable 4xx, quota exhaustion, timeout abort, local validation and Fact rejection remain non-retry transport paths
- run budget: <=3 extra requests, <=30s wait; per-call <=2 retries
- existing claim/complete/fail fencing and packet idempotency untouched
- related suite 338/338 PASS; check/lint/diff PASS
- production gates remained app=false / x=false; source task production mutation=0
- no overlap with PR #41 / important-news / MIC / G3/G4

ChatGPT review decision:
- no separate Codex review required for this source PR before gated-OFF deployment.
- reason: the change is isolated to background shared-analysis transport reliability, consumers remain OFF, DB/cron/auth/public-X behavior is unchanged, and deterministic regression coverage is strong.
- Codex is reserved for the release boundary before consumer activation/public X use. H1 is currently occupied and H2 is preserved deferred; no slot is overwritten.

Merge:
- PR #45 merged by ChatGPT after diff/scope/mergeability review.
- merge/main SHA: `6ea31efec1876596085e9b66727b2626ab0ba477`.

Next:
- deploy only `market-report-analysis` from merged main with both consumer gates OFF.
- verify deployed source read-back.
- observe the next natural morning and close cycles; no manual cycle forcing.


---

# Previous completed G2 task — shared unification proof

# Claude Task 2 — CURRENT TASK

- task_id: kabumori-shared-market-report-unification-20260928
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- purpose: 朝刊・大引けの「市場全体分析」を `market_data_packet -> market_report_packet` に一本化し、Xはその簡易版、かぶモリアプリは市場全体の完全版＋マイポート完全版として同じ正本から生成できることを非破壊で実証する。旧X朝刊/大引けのVOICE NG個別修正は凍結し、共通化後に必要な問題だけ再評価する。

## User decision / product contract

2026-09-28 user decision:

- 先に旧X朝刊/大引けのVOICE問題を個別修正しない。共通化前の旧経路を直すと二重作業になる可能性が高いため。
- まずXとアプリの市場分析を共通化する。
- Xは「市場全体の簡易版」。
- かぶモリアプリは「完全版」。
- アプリ朝刊・大引けは将来、`市場全体 | マイポート` の2タブで表示する。
- 市場全体の事実・方向感・重要材料は1つの共通packetを正本にする。
- マイポートだけが、同じ市場packetに保有銘柄・個別ニュース・ユーザー固有分析を上乗せする。
- Xとアプリが同じ日の市場を別々に再分析して矛盾する構造を残さない。

Target architecture:

```text
market_data_packet
        ↓
market_report_packet  ← 市場全体の唯一の正本
        ├─ X morning/close       = 簡易版
        ├─ App 市場全体          = 完全版
        └─ App マイポート        = 共通市場分析 + 保有銘柄/個別材料
```

## Why Opus5.5（高）

This task crosses shared report contracts, X consumer behavior, personalized app reports, Fact boundaries and future production cutover. It requires architecture-level judgment and careful regression isolation. Do not spend Opus effort on unrelated cleanup.

## Mandatory startup / slot safety

Before any source edit:

1. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `docs/market-report-shared-platform/DESIGN.md`
   - latest G2 Report preserved below
2. Use a dedicated G2 independent worktree/checkout. Never reuse G1/G3/G4/H1/H2 worktrees.
3. Fresh fetch `origin/main`; record exact main SHA.
4. Inspect production read-only state for:
   - `market-report-data-packet`
   - `market-report-analysis`
   - `personalized-reports`
   - `x-test-post`
   - `market_report_consumer_settings.app_enabled`
   - `market_report_consumer_settings.x_enabled`
5. Inspect 2026-09-28 natural morning result read-only. If close 17:15 JST has already occurred, inspect that too; otherwise do not wait/idly block source work.
6. Confirm no active slot owns the same files/RPC/migration/Edge Function.

### Known overlap hazard — PR #41

Open PR #41 currently changes `supabase/functions/x-test-post/index.ts`.

- G2 MUST NOT edit `x-test-post/index.ts` while PR #41 remains open/unmerged unless ChatGPT explicitly reallocates/resolves that overlap.
- Existing shared-consumer behavior in `x-test-post` may be read/tested.
- If this task genuinely requires an `x-test-post/index.ts` source change before PR #41 is resolved, STOP and report `G2_X_TEST_POST_INDEX_CONFLICT_PR41`.
- Do not modify PR #41, Stage 3B OAuth/publish-authority files, or G3/G4 social-mobile work.

## Existing foundation to preserve

Current main already has:

- `market-report-data-packet`
- `market-report-analysis`
- `_shared/market_report_packet.ts`
- X shared market consumer
- `personalized-reports` shared market consumer
- `AppMarketDetail`
- common `report_packet_id / content_hash` contract
- consumer gates currently expected OFF unless production read-back proves otherwise

Do not redesign these from scratch. Audit first, then make the smallest changes needed.

## Scope A — audit the common packet against the real product goal

Determine whether the current common packet is rich enough for:

### Morning — App 市場全体 complete version

At minimum, use available verified inputs for:

- 前夜の米国市場
- 米国主要指数
- SOX / 半導体
- 前営業日の日本株
- 為替
- 金利
- 原油
- 重要ニュース
- strong/weak themes
- 今日の日本株で見る点
- risks
- next watch points
- data freshness / gaps

### Close — App 市場全体 complete version

At minimum:

- 今日の日本市場
- major moves
- verified reasons/materials
- important news
- strong/weak themes
- 朝刊で見ていたポイントとの比較
- risks
- next-session watch points
- data freshness / gaps

Do not invent unavailable data. If an item lacks a verified source, keep an explicit gap rather than filling it from model memory.

If information is insufficient because news acquisition itself needs expansion, do NOT modify the API-optimization/important-news workstream in this task. Record the missing contract/input and continue with the available shared inputs.

## Scope B — prove one shared source feeds all three consumers

Using the same completed common packet, non-destructively prove:

1. X簡易版
2. App 市場全体版
3. App マイポート版

Required invariants:

- same market direction
- same verified market numbers
- no contradictory key news
- no second independent market re-analysis by consumers
- X contains no user/portfolio data
- App 市場全体 contains no user-specific portfolio data
- App マイポート alone adds user-specific holdings/news/impact
- `report_packet_id` is traceable
- `report_content_hash` is traceable
- packet missing/not-ready => fail closed where the shared gate is enabled
- gate OFF => legacy behavior remains unchanged

Prefer deterministic fixture/integration tests and safe dry-runs. No real X post in this task.

## Scope C — App complete-version contract

Confirm/extend the app-side contract so that the future UI can render:

```text
[ 市場全体 ] [ マイポート ]
```

The UI itself is not the main goal of this task.

### 市場全体

Must be able to expose, from the shared layer:

- headline / summary
- metric groups
- overnight/today claims
- important news
- tailwind/headwind themes
- watch points
- risks
- data gaps
- morning reference on close where available

### マイポート

Must use the same shared market premise plus:

- holdings
- holding-specific news
- holding impacts/materials
- market/sector/theme relationships only where supported
- morning outlook vs close result where available
- risks/watch points specific to the user's portfolio

Do not make the personalized model independently decide a contradictory market direction.

## Scope D — X simplified-version contract

The X consumer should remain a short public summary derived from the shared packet.

Target:
- market-wide only
- short lead
- exactly three useful points where current contract requires it
- short closing/watch point
- no portfolio/user data
- no independent web search/Yahoo/OpenAI re-analysis after shared gate is ON

The existing old X VOICE failure is not a reason to patch the legacy path first.

## VOICE policy for this task

Freeze legacy X VOICE-specific fixes.

Evaluate the shared path on its own merits:

- common packet must remain Fact/local-check passed
- X shared format validation must remain strict
- do not weaken factual/safety checks
- if the shared X path intentionally does not run the old VOICE evaluator, prove why that is safe/intentional in tests and document it
- if a voice-quality layer is still needed after unification, leave it as a follow-up against the shared path, not the legacy generator

G2's existing app VOICE shadow telemetry remains historical evidence; do not proceed with old Phase 2 warn-deliver/rewrite work in this task unless the unified path specifically requires it.

## Allowed source area

Only as needed, and only after overlap check:

- `supabase/functions/market-report-data-packet/**`
- `supabase/functions/market-report-analysis/**`
- `supabase/functions/_shared/market_report_packet.ts`
- X shared market consumer files that do NOT conflict with PR #41
- `supabase/functions/personalized-reports/**`
- related focused tests/docs
- existing consumer-gate contract/tests

DB/migration changes are NOT assumed. If a migration/RPC change is actually required, stop before production apply and report the exact reason; it will receive a separate review gate.

## Explicitly out of scope / forbidden

Do not modify or activate:

- `important-news-monitor` cost/API optimization logic
- important-news shadow/breaking/trigger/judgement/usage work
- MIC independent workstream unless read-only compatibility inspection
- PR #41 / Stage 3B publish-authority/OAuth/Vault code
- G3/G4 `apps/social-mobile` work
- Admin/Auth
- unrelated native UI
- user auth/RLS/permissions
- production secrets
- migration history repair
- bulk DB changes

No:
- real X publish
- manual X post
- production consumer gate ON
- production app delivery activation
- production migration apply
- production cron changes
in this task before K2/review.

## Tests

Run all relevant tests for changed areas. At minimum where applicable:

- market-report-data-packet
- market-report-analysis
- `_shared/market_report_packet`
- X shared market consumer
- personalized-reports
- shared market consumer tests
- morning and close
- Fact/local validation
- `report_packet_id` propagation
- `report_content_hash` propagation
- privacy boundary: X/public market packet has zero portfolio data
- gate OFF legacy regression
- gate ON shared path
- packet missing/not-ready fail-closed behavior
- duplicate/idempotency behavior relevant to the shared cycle
- `deno check`
- `deno lint`
- `git diff --check`

If source changes touch broader shared modules, run the broader related suite too.

## Non-destructive integration proof

Before completion, produce at least one safe proof for morning and one for close if fixtures/current packets permit:

- one exact common packet identity
- X-rendered simplified output derived from it
- App market detail derived from it
- App personalized packet/report consuming the same shared identity
- no persistence / no notification / no real X post

Record IDs/hashes only if non-sensitive.

## Production cutover plan — prepare, do not execute yet

Prepare the exact safest next-step plan after this task passes:

1. reviewed shared packet source
2. reviewed consumers
3. controlled gate sequence
4. first natural morning/close observation
5. X post + App save identity comparison
6. rollback sequence

Do not turn `app_enabled` or `x_enabled` ON in this task.

Reason: the cutover crosses a public X publish boundary and production app delivery. It requires K2 and likely one focused Codex release-boundary review before live activation.

## Completion gate

PASS only if all are true:

- common market packet is confirmed as the single intended market truth source
- X simplified output can be generated from it
- App market-complete output can be generated from it
- App personalized output can consume the same identity and add only user-specific analysis
- morning and close contracts are covered
- no market-direction contradiction across consumers
- IDs/hashes remain traceable
- old X VOICE bug was not patched in isolation
- no prohibited production activation occurred
- rollback/cutover plan is written
- PR #41 overlap was not violated

## Required Report

Append under `## Report` for this current task:

- task_id
- result
- fresh main SHA
- worktree/branch
- production read-only preflight
- 2026-09-28 natural morning/close observations available at execution time
- current `app_enabled/x_enabled`
- common packet audit findings
- missing data/contract gaps
- changed_files
- tests
- commit_hash
- PR
- push
- deploy
- morning shared proof
- close shared proof
- X simplified proof
- App market-complete proof
- App personalized proof
- report_packet_id/content_hash propagation
- privacy boundary result
- legacy fallback behavior
- VOICE handling conclusion
- production mutations (expected 0)
- PR #41 overlap check
- remaining issues
- exact recommended production cutover sequence
- rollback plan
- whether focused Codex review is recommended

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Report — kabumori-shared-market-report-unification-20260928

- task_id：`kabumori-shared-market-report-unification-20260928`
- result：**PASS候補（source-onlyの非破壊証明）**。
  - 共通のmarket packetが、X簡易版・App市場全体・Appマイポートの唯一の正本として機能することを、本番の実packet（朝刊2026-09-24／大引け2026-09-25）で証明した。
  - 本番の切り替えはしていない。
  - 切り替え前に解消すべき信頼性の課題（OpenAIの429による共有分析の失敗）を特定した。
- fresh main SHA：`c171b34648097b4c17b0ca1163355b1b442a080c`（着手時。PRはその上にrebaseした）
- worktree/branch：G2専用worktree `scratchpad/kabumori-g2-unify`、branch `g2-shared-market-unification-20260928`

#### production read-only preflight

- 関数（verify_jwtはすべてfalse）：
  - `market-report-data-packet` v10（09-17）
  - `market-report-analysis` v11（09-18）
  - `personalized-reports` v33（09-25 22:11）
  - `x-test-post` v125（09-26）
- `app_enabled=false`、`x_enabled=false`（updated_at 2026-09-17）
- 共有cycle：
  - 09-24は朝刊・大引けともcompleted。
  - 09-25の朝刊はcycleが**blocked**、大引けはcompleted。
  - **09-28の朝刊はcycle completedだがreportがfailed（`ANALYSIS_OPENAI_GENERATE_FAILED:429`）**。

#### 2026-09-28の自然cronの観測（実行時点：14:3x JST。大引け17:15はまだ）

- X朝刊（旧経路）：08:20・08:22・08:25に `MORNING_REPORT_LANE_A_US_MARKET_FAILED:429` が3回、09:46に `MORNING_REPORT_FACT_CHECK_FAILED`。**投稿なし**。
- アプリ朝刊：cronは08:35に起動（succeeded）したが、行が作られたのは**09:46**（completed、legacy lane v1、delivery_policyはpass）。
- 09:46に、X朝刊とアプリ朝刊の両方がほぼ同時に再実行されている。起動元は未特定。
- 当日は全経路でOpenAIの429が集中していた。

#### common packetの監査結果

- **Morning（09-24）**：
  - freshな指標：日経平均、1306、NYダウ、S&P500、ナスダック、SOX、ドル円、米2年債・米10年債、WTI、ブレント（11指標）。
  - stale：JGB 2年・10年（08-31時点）。unavailable：日経先物。
  - news_refsは30件。
  - claimsはovernightが3件・todayが5件。next_watchが3件、risksが3件、data_gapsが5件。
  - x_postのpointsは3件。
- **Close（09-25）**：
  - 指標は同じ構成で、growth250もunavailable。news_refsは20件。
  - claimsにはnextもあり、data_gapsは6件。
- **満たせている項目**：前夜の米国市場、米国の主要指数、SOX、前営業日（または当日）の日本株、為替、米金利、原油、重要ニュース、今日・次に見る点、リスク、鮮度と欠損の明示。
- 大引けのmorning referenceは、アプリ側で同日の共有朝刊packetから付与する（朝刊packetがない日は欠落するだけ）。

#### missing data / contract gaps（捏造せず、gapのまま）

1. **共有分析の信頼性**：09-28の朝刊が429でfailed、09-25の朝刊がblocked。gateをONにすると、この日はX・アプリとも欠配する（fail-closed）。**切り替え前の最重要課題**。
2. JGBの利回りが8月末からstaleのまま（取得元側の問題）。
3. 日経先物・グロース250・業種別騰落・経済指標カレンダー：検証済みの取得元がない（`calendar_refs: unavailable`）。
4. strong/weak themesが空になりやすい（09-24は0/1、09-25は0/0）。テーマにはニュースの根拠が必須なため。アプリの「追い風・逆風」欄が薄くなる主因。
5. アプリはgate ON時に共有packetがないと、**マイポートも含めてrun全体をskipする**。DESIGN §7.4は、マイポートだけでも作る縮退を想定している。productの判断が必要。
6. ニュース取得の拡充（重要ニュースworkstream）は本TASKの対象外。入力は現行のnews_refsのまま。

#### changed_files（PR #43）

- `supabase/functions/personalized-reports/shared_gate.ts`（新規。index.tsのインライン処理を移動しただけ）
- `supabase/functions/personalized-reports/index.ts`（+11／−31。挙動は同一）
- `supabase/functions/personalized-reports/shared_unification_test.ts`（新規）
- `supabase/functions/market-report-analysis/fixtures/{morning_2026-09-24,close_2026-09-25}_{data_packet,generated_report}.json`（本番の実packet。市場データとニュースだけで、user情報は含まない）

#### tests

- shared_unification **6/6**
- personalized-reports **125/125**
- market-report-analysis 21/21、market-report-data-packet 42/42、X shared consumer 6/6
- 関連スイート **318/318**
- deno check・lint・git diff --checkはPASS

#### commit / PR / push / deploy

- commit：`4aa4251de07b446fedf9e6bec09f24f50dc7d810`
- PR：https://github.com/anohi-memories/kabumori/pull/43（open・未merge）
- push：branchへpushした
- deploy：**なし**

#### proofs（実packet、fake deps。保存・通知・X投稿はない）

- **morning shared proof（09-24、report `93ff6ee5…`、direction down）**：
  - X投稿文は、formatSharedXPostの結果に固定hashtagを付けたもので、sharedXPostIssuesは0件。
  - X runの記録：model_usedは `shared_market_report`、api_cost 0、web_search 0、sharedMarketReportにpacketとdataのid・hashがある。
  - アプリ：market_detail・market_sectionのreport_packet_idとhashが一致し、方向も一致。freshな指標はすべてdata packetの値。
- **close shared proof（09-25、report `3c5597ae…`、direction up）**：
  - 朝刊と同じ内容を確認した。
  - morning referenceは、同日の朝刊packetがblockedだったためnull。朝刊packetを与えればreferenceが付くことも確認した。
- **X simplified proof**：市場全体だけ。lead、ちょうど3つのpoints、closingで、ユーザー・ポートフォリオの情報は0件。
- **App market-complete proof**：headline・summary、指標のgroup、overnight・todayのclaims、key_news、themes、watch points、risks、data gaps、（大引けの）morning referenceをすべて共有層から出している。user情報は0件。
- **App personalized proof**：同じsharedInput（方向・claims・themes・cross-asset）の上に、保有銘柄・impactを追加する。指数の値も同じdata packetから取る。
- **report_packet_id / content_hashの伝播**：X runのmarket_data、アプリの `body.market_section`、`body.market_detail` で一致した。
- **privacy boundary**：X（投稿文とrun記録）、market_detail、market_sectionに、holdingのticker・会社名・user_idが出ないことをテストで確認した。holdingが出るのはpersonalized packetだけ。
- **legacy fallback**：gateがOFFのとき、personalized packetにshared_marketはなく、legacyの挙動は不変（既存テストもPASS）。

#### VOICE handling conclusion

- 旧X朝刊・大引けのVOICE問題は、**単独では修正していない**（凍結）。
- 共有のX経路にVOICE評価器がないのは設計どおりで、安全と判断した。理由は次のとおり。
  - x_postは共有分析のローカル検査とFact check（analysis全体を照合）を通過している。
  - 共有consumerは決定的なformatと厳格な形式検査（文字数、points=3、URL・hashtag・空行の禁止）だけを行い、model・web・Yahooを呼ばない。この点をテストで固定した。
- 共有経路の文体の品質が問題になれば、後続として共有経路側で扱う。

#### production mutations

- **0**（read-onlyのSELECTだけ）。

#### PR #41 overlap check

- `x-test-post/index.ts` は未変更。PR #41のファイルにも触れていない。
- X側は `shared_market_report_consumer.ts` をテストからread-onlyでimportしただけ。

#### remaining issues

- 上記gapの1〜5。特に1（429）と5（skipか縮退か）。
- 09-28の09:46の再実行の起動元は未特定。
- personalized-reportsのv33と、G2が最後にdeployしたv30（`0cba732`）の関係は未照合（次のdeploy前にbyte照合が必要）。

#### exact recommended production cutover sequence（本TASKでは実行しない）

1. **信頼性の先行対応（別TASK）**：`market-report-analysis` の429対策。
   - 例：run内での指数backoffによる再試行（1〜2回）と、既存のretry cron（+10分）の後に、さらに1回の救済runを置く。
   - 目的：朝刊packetの完成率を上げること。
   - あわせて、アプリをgate ONにしたときの縮退方針（skipか、マイポートだけにするか）を決める。
2. PR #43をmergeし、reviewedなconsumerを確定する（アプリ `personalized-reports` とX shared consumerは、現行mainのまま）。
3. **App gateを先にONにする**（`app_enabled=true`、`x_enabled=false` のまま）。
   - 最初の自然な朝刊と大引けで、次をread-onlyで確認する。
     - 保存された `body.market_section.report_packet_id` が、そのcycleの `current_report_packet_id` と一致すること
     - delivery_policy
     - 通知
4. 数営業日安定したら、**X gateをONにする**（`x_enabled=true`）。
   - 最初の自然な朝刊と大引けで、X runの `market_data.sharedMarketReport.reportPacketId` と、アプリの保存行のpacket idが**同じ日に同じ値**であることを照合する。
   - X投稿は公開境界を越えるため、直前に集中的なCodexレビューを行う。
5. 旧経路（web_search・Yahoo・旧VOICE）の削除は、安定を確認した後に別TASKで行う。

#### rollback plan

- **gateを戻す**：`market_report_consumer_settings` の `x_enabled` や `app_enabled` をfalseに戻すだけで、即座にlegacyの挙動へ戻る（コードのdeploy不要）。settings行の1回のUPDATEで済み、履歴はupdated_atに残る。
- **コードの問題**：`personalized-reports` はknown-goodのv29（`f34b8c4`）やv30（`0cba732`）の手順で、X consumerは既存のdeploy手順で、それぞれ戻す。
- 共有のpacketとcycleはinsert-onlyなので、戻しでDBを変更する必要はない。

#### focused Codex reviewは推奨か

- **本PR #43だけなら不要**：テストと、挙動が同一のrefactorだけで、低リスク。
- **X gateのON（手順4）の直前には推奨**：公開X投稿の境界を越えるため。App gateのON（手順3）も、最初の本番配信なので、軽いreviewがあると望ましい。


## Final K2 — shared market report unification proof

Verdict: **PASS for source/non-destructive unification proof; production cutover NOT yet approved**.

Accepted:
- PR #43 head `4aa4251de07b446fedf9e6bec09f24f50dc7d810`
- merged by ChatGPT after scope/mergeability review -> main `a0ac6484ecdc59670241c2ffb2e0340e93fd5994`
- changed source is a no-behavior-change extraction of the app shared gate plus tests/real market fixtures; `x-test-post/index.ts` was not touched
- shared_unification 6/6; personalized-reports 125/125; related 318/318; check/lint/diff PASS
- one `market_report_packet` identity can feed X simplified, App market-complete and App personalized output without a second market analysis
- report_packet_id/content_hash propagation and public/private data boundary PASS
- legacy X VOICE-only bug was not patched
- production mutation from G2 = 0; consumer gates remained OFF

Fresh K2 production read-only observation at 2026-09-28 17:5x JST:
- `x_enabled=false`, `app_enabled=false`
- shared morning cycle: data completed, analysis failed with `ANALYSIS_OPENAI_GENERATE_FAILED:429`; no report packet
- shared close cycle: completed; report completed on attempt 2 with current report packet `1a0cf2b9-8de9-4e10-a4ea-059428637b31`
- App legacy close: completed / Fact passed / notified, because app gate is still OFF
- old X close: failed with `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
- this strengthens the product case for shared cutover, but also proves shared-analysis 429 reliability must be hardened before enabling both consumers

Review decision:
- no Codex review required for PR #43 itself under reduced-review policy
- a focused Codex release-boundary review WILL be required after reliability hardening and before public X shared-gate activation

Next:
- G2 moves immediately to bounded shared-analysis reliability hardening.


---

# Previous completed G2 task — preserved history

The section below is historical and MUST NOT be treated as the current assignment.

# Claude Task 2

- task_id: kabumori-pr34-shadow-merge-deploy-20260925
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: medium
- recommended_model: Sonnet5（高）
- purpose: K2 PASS済みPR #34をfresh main確認後にmergeし、personalized-reportsへshadow telemetryのみcontrolled deployする。配信挙動は変えず、app_enabled=falseを維持する。

## Accepted K2 state

PR #34:
- reviewed head: `40828d31124a629e594c7ac2ac3af28e5325f6de`
- mergeable: true
- changed files:
  - `supabase/functions/personalized-reports/delivery_policy.ts`
  - `supabase/functions/personalized-reports/index.ts`
  - `supabase/functions/personalized-reports/delivery_policy_test.ts`

K2 accepted:
- shadow-only PASS/WARN/BLOCK/unavailable classification
- no prompt change
- no report_logic change
- no validator/parser/Fact semantic change
- no DB/migration/cron change
- no delivery/save/notify behavior change
- personalized-reports 119/119
- related 241/241
- check/lint/diff PASS
- production mutation 0

No new Codex review required under reduced-review policy.

## Mandatory startup

1. Independent worktree.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK.
3. Fresh fetch origin/main and PR #34.
4. Verify PR head exactly `40828d31124a629e594c7ac2ac3af28e5325f6de`.
5. Confirm no active personalized-reports overlap.
6. Read production version/settings before mutation.
7. If app_enabled != false, STOP.
8. If production personalized-reports changed unexpectedly since v29, STOP before overwrite.

## Merge

If head unchanged and conflict-free:
- merge PR #34
- fresh fetch main
- verify merged source byte/semantic identity with reviewed head
- record merge SHA

## Post-merge verification

Run:
- delivery_policy tests
- full personalized-reports
- PR #32 regression tests
- MIC context/integration
- related report/app suite
- deno check
- deno lint
- git diff --check

Confirm:
- report_logic unchanged from v29 baseline
- save/notify/dry_run guards unchanged
- no new delivery block path
- source_basis gets only `delivery_policy` telemetry addition
- app_enabled/x_enabled untouched

## Controlled deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- verify_jwt=false
- app_enabled=false throughout
- x_enabled=false unchanged
- no cron/settings/DB/Auth changes
- no other Edge deploy

After deploy:
- read back deployed version/source
- verify matches merged main
- verify app_enabled=false
- verify x_enabled=false
- cron unchanged

## Validation

No need for repeated LLM dry-runs in this task unless source mismatch or behavior concern appears.

Perform one non-persisting smoke/dry-run only if available and safe, to verify:
- response includes shadow telemetry
- reportId=null
- notification not_attempted
- behavior/outcome matches pre-shadow semantics

Do not turn app_enabled on.

## Natural cron

Monday natural morning/close read-only verification remains the meaningful live gate.
If shadow telemetry is deployed, capture:
- voice_status
- delivery_blocked_by
- warning_codes
without exposing user content.

## Forbidden

- app_enabled=true
- Phase 2 warn-deliver behavior
- rewrite/fallback
- prompt/Fact/validator changes
- DB migration
- X/admin/G1 changes

## Completion / K2

Report:
- fresh main
- PR head
- merge SHA
- tests
- deployed version/source read-back
- app_enabled/x_enabled before/after
- telemetry smoke result if executed
- production mutations
- rollback status
- next natural-cron gate

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-pr34-shadow-merge-deploy-20260925`
- result：PR #34をmergeし、`personalized-reports` を **v30**（shadow telemetryを含む）としてdeployした。smokeのdry_run 1回で、telemetryが出ていることと配信挙動が不変であることを確認した。`app_enabled=false`、`x_enabled=false` を維持している。
- changed_files：なし（PR #34のmergeのみ）
- tests（merge後の `0cba732` で実施）：
  - delivery_policy 8/8、PR #32の回帰7/7、morning_contract 8/8、MIC 14/14・6/6
  - personalized-reports **119/119**、関連スイート **241/241**
  - deno check・lint・diff checkはPASS
- commit_hash：merge `0cba73236f0e02dd3c88c78e9cb06434b593091f`（PR head `40828d31124a629e594c7ac2ac3af28e5325f6de`）
- push：mergeのみ
- deploy：`personalized-reports` v30（source `0cba732`、`--use-api --no-verify-jwt`）
- safety_checks：
  - smokeの前後で、`personalized_reports` の作成・更新は0件、通知は0件。
  - cronは不変。
  - 秘密情報・user_id・銘柄の詳細は本Reportに記載していない。

### 詳細

- **fresh main**：着手時は `1f98783`。PR head `40828d3` が一致し、conflictもなかった。v29以降、mainに関数の変更はない。`personalized-reports` を扱う他のopen PRもなかった。
- **deploy前のproduction**：v29（`--use-api` のdownloadで `f34b8c4` とbyte一致を確認）、`app_enabled=false`、`x_enabled=false`。
- **mergeとmerge後の確認**：
  - mergeされたsourceは、reviewed headと差分なし。
  - `report_logic.ts`・`mic_market_context.ts`・`market_detail.ts`・`_shared` は、v29（`f34b8c4`）と同一。
  - v29からの差分は、`delivery_policy.ts`（新規）、`delivery_policy_test.ts`（新規）、`index.ts` の3ファイルだけ。
  - `index.ts` の差分は、`withDeliveryPolicy(sourceBasis, outcome)` への置き換えと、log・responseへの項目追加だけ。保存・通知・dry_runのガードは不変。
- **deployed version / read-back**：**v30**、verify_jwt=false。`--use-api` でdownloadした6ファイルが、`0cba732` と**byte一致**。
  - 6ファイル：index / report_logic / market_detail / mic_market_context / delivery_policy / _shared/market_report_packet
- **app_enabled / x_enabled**：deploy前・deploy後ともfalse。
- **telemetryのsmoke**（大引けのdry_run 1回、Vault→`net.http_post`、`dry_run:true`）：
  - completed、LLM呼び出し2回、Fact passed、local issue 0件、impactは2/2。
  - `delivery_policy` = `{version: delivery_policy.v1_shadow, mode: shadow, voice_status: pass, warning_codes: [], block_codes: [], delivery_blocked_by: null, would_deliver_under_warn_policy: true, rewrite_attempted: false, rewrite_succeeded: false, fallback_original_used: false}`。
  - `reportId: null`、`notification: not_attempted`。所要時間は27秒以内。
  - 結果は、v29の大引けの結果（直近8回PASS）と同じ意味の挙動だった。
- **production mutations**：
  - Edge Functionのdeploy 1回（v30）
  - dry_runの呼び出し1回（保存・通知は0件）
  - GitHubでのPR #34のmerge
- **rollback**：不要のため実施していない。known-goodは、v29（`f34b8c4`）・v28（`47ea87d`）・v21（`4590ba6`）。

### 次の自然cronのgate

- **月曜9/28**の朝刊08:35、大引け17:15 JST。
- read-onlyで確認する項目：
  - `personalized_reports` のstatus・fact_status・error
  - `source_basis.delivery_policy` の `voice_status`・`delivery_blocked_by`・`warning_codes`
  - 通知のenqueue件数
- 本文やuser情報は出さずに集計する。
- 朝刊・大引けとも実際に完了して保存されれば、activationの判断（別TASK）に進める材料になる。


## Final K2 — PR #34 shadow deploy

Verdict: **PASS**.

Accepted:
- PR #34 head `40828d31124a629e594c7ac2ac3af28e5325f6de`
- merge SHA `0cba73236f0e02dd3c88c78e9cb06434b593091f`
- production personalized-reports v30
- deployed source read-back matches merged main
- app_enabled=false / x_enabled=false before and after
- personalized-reports 119/119; related 241/241; check/lint/diff PASS
- one dry-run smoke completed with Fact passed / local 0
- shadow telemetry present with voice_status=pass and delivery_blocked_by=null
- reportId=null / notification=not_attempted
- persistence=0 / notifications=0
- rollback not required

G2 is closed for now.
Next gate: Monday 2026-09-28 natural morning 08:35 JST and close 17:15 JST read-only validation. Phase 2 warn-deliver remains deferred until telemetry is observed.



