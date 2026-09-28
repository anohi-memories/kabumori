# Claude Task 2 — CURRENT TASK

- task_id: kabumori-shared-market-report-unification-20260928
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
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

Pending.

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

