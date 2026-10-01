# Codex Task

- task_id: common-account-kabumori-delete-cross-service-safety-review-20261001
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: highest
- recommended_model: Sol（高）
- type: security review / bug fix / Auth deletion boundary
- target: fresh origin/main; existing production-deployed Kabumori account deletion source
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 0（G5）のread-only inventoryで確認された、既存Kabumori account deletionのcross-service lifecycle riskを独立レビューする。

現在のKabumori deletionは共有Supabase Auth userをhard deleteする一方、X自動投稿側のworkspace / posting authorization / Vault credential / admin ownershipを認識しない。現時点で両service利用者は0人だが、共通ID導入後にそのまま残すと一サービスの退会が他serviceへ影響する。

このTASKでは、まずsource/securityレビューを行い、**小さく安全で決定的な暫定fail-closed修正が可能なら source + tests まで実施してよい**。production deployはしない。

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 Final K5 + Reportを読む。
2. H1専用の独立worktree/checkoutを使用。
3. fresh origin/mainを取得。
4. G3はsocial-mobile account deletion UI、G4はX posting OAuth account-switchを扱っている。G3/G4のbranch/files/PRを変更・merge・rebase/resetしない。
5. pending PRのchanged filesを確認し、Kabumori account-delete scopeと競合があればSTOP。

## Facts from G5 to independently verify

- production Kabumori account-delete is ACTIVE and verify_jwt=true.
- source path hard-deletes the authenticated Supabase Auth user.
- shared Auth hard delete cascades at least to Kabumori profile data, admin membership, X membership/OAuth-state references, while X workspace/social account/Vault credential can remain because they are not directly Auth-owned.
- X authorization revoke is not performed by Kabumori deletion.
- X social-mobile deletion has stronger cross-service/admin guards and service-specific cleanup, but must not be copied blindly.
- current production population has no user simultaneously classified as Kabumori + user-facing X workspace owner, so this is a latent boundary defect rather than evidence of an already-corrupted shared user.

Treat these as G5 findings to verify, not assumptions to silently trust.

## Review questions

1. Is the Kabumori hard-delete path actually reachable from current client UI and production deployment?
2. Exactly which shared/cross-service rows cascade or remain orphaned if Auth user is deleted?
3. Can an admin account currently delete itself through the Kabumori path?
4. What is the smallest safe interim guard before common-account orchestrator exists?
5. Should the interim path fail closed when any of the following exist:
   - admin ownership
   - X/social-mobile user-facing membership/workspace ownership
   - active/pending posting OAuth state or other service footprint
   - any other shared-account evidence found in source/production metadata
6. Does the interim correction preserve legitimate Kabumori-only account deletion?
7. Is server-side reauthentication/session freshness already adequate, or is a separate issue required? Do not expand into a large auth redesign in this TASK.
8. What regression tests prove “Kabumori-only may delete” and “other-service/admin footprint cannot be hard-deleted here”?

## Fix authority

Allowed only if review shows a bounded source-only fix:

- modify Kabumori account-delete Edge Function and narrowly related tests/docs
- add a server-side fail-closed pre-delete ownership/other-service guard using existing schema
- preserve current JWT verification and Auth ownership
- return a truthful non-success error requiring common-account/service-specific lifecycle handling
- add regression tests

Do not introduce common_accounts/service_entitlements yet.
Do not create/apply migrations or RLS changes in this TASK.

If safe correction requires schema migration, new lifecycle orchestrator, provider revoke redesign, or broad cross-service semantics, **do not implement**; report CHANGES REQUIRED for G5 Phase 1.

## Forbidden

- production deploy
- production DB write
- migration apply
- Auth user create/update/delete
- identity link/unlink
- X OAuth authorize/revoke
- Vault secret read/write/delete
- account deletion execution
- real X operations
- feature flag / Cron / secret / provider setting changes
- G3/G4 source changes
- common-account Phase 1 schema implementation

Read-only production metadata checks are permitted only if already available through safe authorized tooling; never expose PII/secrets.

## Required verification

At minimum:

- inspect account-delete source and client entry path
- inspect current FK/cascade ownership relevant to cross-service deletion
- focused account-delete tests
- static/type/lint/diff checks appropriate to changed scope
- tests for Kabumori-only allowed path if behavior preserved
- tests for admin and X-service footprint blocked path if implemented
- confirm no X revoke/Vault mutation is introduced into Kabumori service-only path
- confirm production mutation = 0

## Completion / C1

Append a new report to `.agent/CODEX_REPORT.md`.

Report:

- PASS / PASS-WITH-FIX / FAIL
- exact reviewed main/head and final head if source changed
- confirmed risk and affected boundaries
- findings by severity
- interim guard decision
- changed_files
- tests
- production mutation = 0
- whether source is safe to merge
- whether any production deploy is recommended/held
- what remains for G5 common-account Phase 1
- next recommendation

At completion: status -> review_required, next_owner -> chatgpt, STOP for C1.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: kabumori-pr67-shared-report-v2-hard-fact-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- target: PR #67 exact head `5877045f7554cd4e089fb3b79091bf8e2bb38456`

## Purpose

PR #67 の shared market report Presentation v2 を独立レビューする。X約500字・App長文・Hard Fact / Quality WARN境界を、1つのshared fact spineを壊さず安全に成立させることを確認する。

**source/test review only**。merge / deploy / gate ON / real X post / production mutationは禁止。

## Accepted G2 evidence

- PR #67: open / mergeable=true / 27 files / +4622 -146.
- main-side 10 commits after PR base have no overlap with PR #67 runtime files.
- reported: analysis 73/73, personalized 128/128, X shared 8/8, data-packet 42/42, _shared 329/329, historical Fact-passed packet replay 8件で新Hard誤検出0, check/lint/diff PASS.
- production mutation=0; app_enabled=false / x_enabled=false.

## Mandatory startup / isolation

1. PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, G2 Report, DESIGN §15 を読む。
2. H1独立worktree/checkoutを使う。G2/H2/G1/G3/G4と共有しない。
3. fresh origin/main と PR #67 exact head を取得し、headが変わっていたらSTOP。
4. H2はPR #66をreview中。H2のTASK/branch/filesを触らない。

## Review priorities

### A. Hard Fact guard — 最優先

`hard_fact_guards.ts` と `analysis_logic.ts` integrationを深く確認する。
- metric/value mismatch
- metric/session-date mismatch
- 2026-10-01 mixed-session exact regression
- reused metricが元session_dateを保持
- staleをfresh/currentとして出さない
- direction/polarity/sign/emoji inversion
- 1306をTOPIX indexと誤認しない
- unsupported causality
- fabricated metric/news/ref/entity
- broad false absence claim

False negativeだけでなくfalse positiveも見る。『理由不明』『材料が薄い』『文体弱い』は、正直に書ける限り配信停止要因にしない。

### B. Hard BLOCK vs Quality WARN / rewrite fallback

`localAnalysisCheck`, warning codes, `qualityRewriteHints`, generation flow, handler diagnostics, delivery-policy分類を確認。
最低限次をadversarial testする：
- safe original + WARN -> rewrite Hard
- safe original + WARN -> rewrite Fact fail
- gen1 Hard -> gen2 safe
- invalid output -> next generation safe
- persistent Hard
- transport 429 around quality rewrite
- sparse/no evidence

確認条件：WARNだけではcycleを落とさない。rewriteがHardなら元のsafe draftへ戻る。call loopは bounded。content regeneration / Fact-local rejection / transport retry / cron retryを混同しない。

### C. v1 backward compatibility

`_shared/market_report_packet.ts`, `market_report_story.ts` を確認。
- 保存済みv1 packetが読める
- v1 X formatterの既存挙動を壊さない
- v1 fallback storyが事実を捏造しない
- DBのschema_version checkを破らない
- migration不要という判断がJSON payload実装上正しい
- report_packet_id/content_hash semantics維持

### D. Public X contract / privacy

- rich v2 section order, exactly 3 points, optional context/news/watch
- length targetはWARNでありFact blockではない
- hard min/maxは投稿不能保護として妥当
- URL/hashtag/internal field/user portfolio漏洩なし
- X consumerが独立再分析しない
- warning telemetryがsafe postを誤blockしない
- ~500日本語文字の投稿権限/契約がsourceから証明できなければ activation prerequisite として記録する

### E. App story / personalization boundary

- App storyはshared evidenceだけで長文化
- market-wide storyは全ユーザー共通
- personalized layerはholdingsを足してもshared market facts/directionを書き換えない
- user/portfolio dataがshared packet/storyへ漏れない
- native UI未対応は別G1 taskとして残す

### F. News priority / absence claims

- broad > sector > company がdeterministic
- isolated company criticalが市場全体storyを機械的に占有しない
- company itemはkey_newsやMy Portfolioで扱える
- category/company-code scope inferenceに明白な誤分類がない
- scoped absence（例: この銘柄の個別ニュースは確認できない）を誤blockしない
- 旧経路で出たfalse absence文はblockする

## Required verification

- market-report-analysis full suite + presentation_v2
- hard fact/date/session regressions
- handler/regeneration diagnostics
- transport retry suite
- personalized-reports full suite + shared story + absence regressions
- X shared consumer full suite
- data-packet regression
- _shared relevant/full suite if feasible
- deno check / lint / git diff --check

見つけた穴にはfocused adversarial testを追加する。

## Fix authority

小さく決定的なP1/P2/P3なら failing test -> minimal fix -> rerun を許可。PR #67 scope内だけ。
architecture変更、DB/schema/migration、model-call architecture変更、product semantics大変更が必要なら修正せず CHANGES REQUIRED でG2へ返す。

## Forbidden

- production deploy / DB write / migration / cron / gate change
- real X post / manual production cycle
- legacy X/App generator fix
- G1 native UI implementation
- important-news/API最適化変更
- H2/PR #66変更

## Completion / C1

`.agent/CODEX_REPORT.md` に新しいH1 reportを追記し、過去履歴を消さない。
reportには verdict, original/final head, findings severity, Hard-vs-WARN, mixed-session, rewrite/fallback/call budget, v1 compatibility, X privacy/output, App shared/personalized boundary, news priority/absence, tests, changed_files, production mutation=0, merge recommendation, rollout prerequisites を含める。

完了時: status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (source/tests)**; STOP for C1, no merge/deploy/activation.
- original head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`.
- final source head, pushed to PR #67: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`.
- corrected deterministic guard holes and false positives, malformed nested-output handling, exhausted quality-rewrite request fallback, and actual model-input news ordering; added 13 executed adversarial tests.
- analysis 86/86 (presentation 22 + H1 adversarial 13 included); personalized 128/128; data-packet 42/42; X shared consumer 8/8; `_shared` 329/329 with --no-check. Target runtime check/lint/diff PASS.
- existing `_shared` whole-suite type errors are documented separately; not a claim of a repository-wide clean typecheck.
- production mutation=0. Actual v2 model output, ~500-Japanese-character X API posting entitlement/contract, and native story UI remain rollout prerequisites. Detailed findings and limits are appended to `.agent/CODEX_REPORT.md`.


## Final C1 — PR #67

- verdict: **PASS-WITH-FIX / accepted**
- original G2 head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`
- H1 reviewed/fixed final head: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`
- H1 fixed nine demonstrated P2-class issues, including:
  - safe-original loss on quality-rewrite request failure
  - malformed nested-output parser escape
  - metric value/change/date association holes
  - stale-as-current wording
  - mixed-direction emoji escape
  - historical assertions in watch/caution escaping factual guards
  - scoped absence false positive
  - negated direction false positive
  - model-input news ordering contradicting broad-first policy
- final verification accepted:
  - market-report-analysis 86/86
  - H1 adversarial 13/13
  - personalized-reports 128/128
  - market-report-data-packet 42/42
  - X shared consumer 8/8
  - _shared 329/329 with --no-check
  - target runtime check/lint/diff PASS
- production mutation from H1: 0
- fresh-main overlap check before merge: no runtime-file overlap with PR #67.
- PR #67 final head was mergeable and was merged by ChatGPT.
- merge/main SHA: `09975d02cc81b1614818951173a94aa8677291a0`
- consumer gates remain OFF; this C1 does not authorize app/X activation.
- rollout prerequisites still include:
  - actual live-model v2 generation observation
  - actual X long-post entitlement/provider acceptance before x_enabled
  - native App story UI integration before app consumer activation

---

# Previous completed H1 task — preserved history

# Codex Task

- task_id: x-social-mobile-pr65-ephemeral-x-auth-session-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Sol（高）
- target: PR #65 exact head `e8a7785d5635096aa428899d28e629a95b7e3f31`

## Purpose

Focused pre-merge OAuth/authentication-boundary review of the iOS X posting-account connection change that requests an ephemeral/private auth session so a previously logged-in X account is not silently reused.

This is a source/security review only. Provider-side live account switching remains an operator E2E check and must not be simulated with protected production accounts.

## Verify

### 1. Expo API / platform behavior
- installed `expo-web-browser 57.0.3` actually supports `AuthSessionOpenOptions.preferEphemeralSession`
- the option is valid for `openAuthSessionAsync` and is iOS-scoped as claimed
- implementation passes `{ preferEphemeralSession: true }` only on iOS
- Android/Web behavior is not unintentionally changed
- no native rebuild/config/plugin change is required beyond the existing expo-web-browser native module already in the development build; flag uncertainty if this cannot be proven from source/package state

### 2. OAuth security invariants
- authorization URL host/protocol validation remains unchanged
- state generation/verification remains unchanged
- PKCE verifier/challenge generation remains unchanged
- callback redirect validation remains unchanged
- callback request body and ownership binding remain unchanged
- no undocumented X parameters were added
- no global cookie/browser-data clearing was introduced
- duplicate-X-account server protection is untouched
- no token/Vault/DB/Auth/server-side write path was changed

### 3. Session/account-selection semantics
- ephemeral session is an appropriate way to avoid sharing normal Safari/browser cookies for this posting-account connect flow
- wording does not overpromise that an account chooser will always appear
- reconnect path uses the same behavior
- cancellation/dismiss/retry/error handling stays truthful
- assess the caveat that the browser/provider may ignore the request, and whether the current UX copy is sufficient

### 4. Tests
Review whether the new tests prove behavior rather than only source-string shape where possible.
Run/re-run relevant:
- focused X auth-session tests
- full social-mobile test suite
- typecheck
- lint
- any safe static/export checks useful for this boundary

If a test is brittle or gives false confidence, fix only narrowly within PR scope and report the new exact head.

### 5. Scope / safety
Confirm:
- PR changes only intended client files/tests
- no overlap with G3 E3 destructive verification
- no production mutation
- no real X login/post/revoke
- no DB/RLS/RPC/migration/Edge/Vault/Auth-provider mutation
- no secret leakage

## Provider-side E2E boundary

Do NOT attempt to type X credentials, use protected production X accounts, revoke any authorization, or post to X.

The operator must separately verify on a safe disposable account/device that the iOS auth sheet no longer silently reuses the previous X session and that a different X account can be authenticated.

Codex should state whether source is safe to merge **conditional on that provider-side E2E**.

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- exact reviewed head
- findings and any fixes
- OAuth/security invariant result
- platform behavior result
- test evidence
- remaining provider-side caveat
- production mutation = 0
- whether PR #65 is source-safe to merge after operator E2E passes
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (tests only)**; no client runtime/security defect found.
- original reviewed head: `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- final reviewed/pushed PR #65 head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`.
- H1 replaced weak source-string assertions with executed hook/SDK-bridge tests; client behavior is byte-unchanged from the original PR head.
- focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- source is safe to merge **after C1 and safe operator provider-side E2E pass**. Account switching on an actual device/browser remains unverified; keep merge hold.
- production_mutation=0; see `.agent/CODEX_REPORT.md` for evidence and caveats.


## Final C1

- verdict: **PASS**
- accepted PR: #65
- accepted exact head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`
- H1 disposition: PASS-WITH-FIX (tests only). Runtime/client behavior remained unchanged from original head `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- H1-only source delta from original reviewed head: exactly one test file, `apps/social-mobile/tests/x-connect-auth-session.test.mjs`.
- verification: focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- OAuth/security invariants accepted: PKCE/state/redirect/callback/host validation/server duplicate-account protection unchanged; no undocumented provider parameter; no cookie clearing; no DB/RLS/RPC/migration/Edge/Vault/Auth-provider change.
- production mutation: 0.
- merge decision: **HOLD** until safe operator provider-side E2E confirms a different X account can authenticate without silently reusing the prior normal-browser session, including cancel/retry/reconnect behavior.
- H1 is closed and free. G4 remains review_required for the operator E2E/merge gate.
