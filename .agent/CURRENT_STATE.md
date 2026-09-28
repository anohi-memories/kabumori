# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-28 JST
- repo: kabumori
- branch: main

## User routing preference

- かぶモリアプリ実装は G1 / G2。
- X自動投稿・複数ブランドX実装は G3 / G4。
- 各ペア内のどちらへ入れるかは、空き状況・競合・依存関係を見てChatGPTが判断する。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーが個別TASKについて明示指定した場合はその指定を優先する。
- 同一ファイル / migration / RPC / Edge Function / workflow / production設定 / API境界 / 認証・権限ロジックの競合禁止は常に優先する。

## Model routing

- Claude（くろちゃん）: Sonnet5（中/高/極高） / Opus5.5（中/高/極高）。Sonnet5で安全な作業はSonnet5優先。
- Codex（こでさん）: Luna（中/高/極高） / Sol（中/高/極高）。利用枠節約のためLunaで安全なTASKはLuna優先。

## Review cadence policy — reduced

- User decision (2026-09-25): Codex review frequency is reduced substantially to preserve the 5-hour review budget.
- Default: low-risk/UI/copy/prompt/image/small bug/test-only/local logic changes proceed via Claude + ChatGPT confirmation without H1/H2.
- Repeated small fixes in the same feature are bundled; review once at a meaningful stabilization/release boundary instead of after every change.
- Keep Codex focused on DB/migration/RLS/auth/RPC/OAuth/Vault/secrets, real external writes, X publish paths, cross-tenant boundaries, concurrency/idempotency, destructive production risk, major multi-layer changes and release-critical gates.
- Review omission never means test/dry-run/Preview/read-back omission.
- Prefer Luna for lighter reviews; reserve Sol for high-risk boundaries.
- Existing incomplete review tasks must be preserved as deferred, not overwritten.
- Canonical details: `.agent/ORCHESTRATION.md#レビュー最適化方針（2026-09-25〜）`.

## Deployment policy — user approved

- X自動投稿・Web管理画面の開発中/PR/テスト用PreviewはNetlifyへ寄せる。
- レビュー完了後の最終production deployのみVercelを使う。
- Vercelのrate limitを通常のX/Web開発・レビュー工程のブロッカーにしない。
- PR #15のmerge / post-merge / production verificationはG4へ割当済み。Vercel Preview rate-limit failure単独はmerge前ブロッカーにしないが、production deploy結果は実確認必須。
- かぶモリExpo/native本体はVercel制限の主対象ではないため、Netlify Web Preview対応は現時点では進めない。
- かぶモリのiOS実機/TestFlight/native-only機能は従来どおりExpo/EAS/実機で確認する。

## Final K1 Home news-first UI

- verdict: **PASS**.
- PR #46 final head `f95f9c2` merged -> main `58b53777ce64c054f6c8859940914b71a89472d4`.
- approved Home order implemented: 今日のかぶモリレポート -> 重要ニュース -> 保有銘柄最新ニュース -> 今日のトピック -> AIに聞く.
- report hero uses today's stored report only; older/future reports cannot be mislabeled as today. Report fetch failure has explicit error/retry.
- report points are dynamic text with no per-point chevrons; one CTA opens report detail.
- one existing important-news feed is split into market/holding sections; home network calls 3 -> 2.
- topic and AI remain honest future-ready "準備中" shells because no production source/route exists yet.
- current news feed has no thumbnail URL field; UI uses deterministic fallback visuals only. Real thumbnail acquisition is a separate news lane.
- 22 Home tests + 38 focused regressions PASS; no new src TypeScript errors; Expo config/export/diff checks PASS.
- production mutation 0; no Codex review required.
- follow-ups: approved mini Yume+robot cutout assets, topic backend + level setting, AI route/service, final tab redesign, authenticated real-device Home visual QA.


## K1 Daily topic + knowledge level

- verdict: **PASS for source implementation**.
- PR #48 head `98732bf` is OPEN/mergeable; production mutation 0; migration not applied.
- prior K1 fixes verified: cross-level/date stale topic hidden via request key, JST date refreshed per load/focus/refresh, `hashtext` selector casts to bigint before `abs`.
- accepted architecture: existing `public.tips` reuse, local beginner/intermediate/advanced preference, authenticated read-only narrow RPC, no LLM/news/G2/X overlap.
- verification accepted: topic 21/21, focused regressions 71/71, migration dry-run 12/12, Expo/TypeScript/diff checks clean apart from known unrelated CSS module errors.
- merge/apply remains blocked on independent Codex DB/RPC review.
- H1 is currently occupied by X Auth final acceptance; H2 deferred incomplete review is protected. No H slot was overwritten.
- preferred next review when free: H1, recommended Sol（高）.


## Current slot snapshot

- H1: `review_required` — `x-social-mobile-multi-provider-auth-focused-review-20260928`; FAIL at unchanged PR #47 `7bda196`; seven executable Auth-boundary negative probes failed (linking URL, callback result/PKCE flow ID, signup enumeration, provider-token persistence, recovery-user binding, malformed callback). Existing mobile 32/32 + domain 14/14, typecheck/lint/web+iOS export PASS. No source fix/PR push/merge/deploy; production mutation 0. Awaiting C1; do not merge/activate providers before coordinated source correction; see latest `.agent/CODEX_REPORT.md` section.
- H2: `idle` — `kabumori-pr32-morning-fact-contract-final-review-20260925` (deferred by user; incomplete)
- G1: `review_required` — `kabumori-daily-topic-level-settings-20260928`; K1 source PASS at PR #48 `98732bf`; awaiting independent DB/RPC review before merge/apply. H1 occupied, H2 protected deferred; preferred next H1 Sol（高） when free.
- G2: `ready` — `kabumori-shared-analysis-prod-deploy-observe-20260928`; PR #45 merged; controlled deploy of market-report-analysis only with consumer gates OFF, then natural morning+close observation; recommended Sonnet5（高）
- G3: `ready` — `x-universal-oauth-refresh-productionization-20260925`; AI Lab 401 root fix + universal exact-account Vault-backed OAuth refresh; production activation deferred pending K3 + Codex; recommended Opus5.5（高）
- G4: `done` — `x-admin-pr15-merge-production-verify-20260925`; Final K4 PASS, PR #15 production live + authenticated brand-isolation QA PASS



## Final K2 shared market unification proof

- verdict: **PASS for source/non-destructive proof; production cutover still gated**.
- PR #43 head `4aa4251` merged by ChatGPT -> `a0ac6484ecdc59670241c2ffb2e0340e93fd5994`.
- 318/318 related tests PASS; same report_packet_id/content_hash proven across X simplified, App market-complete and App personalized surfaces.
- privacy boundary PASS; `x-test-post/index.ts` / PR #41 untouched; production mutation from G2=0.
- live read-only K2 at ~17:58 JST:
  - gates: app=false / x=false
  - shared morning 2026-09-28: analysis failed on OpenAI 429; no report packet
  - shared close 2026-09-28: completed on report attempt 2; packet `1a0cf2b9-8de9-4e10-a4ea-059428637b31`
  - App legacy close completed + Fact passed + notified
  - old X close failed `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
- implication: shared architecture is the correct path, but upstream-analysis reliability must be hardened before enabling both consumers.
- no Codex review required for PR #43 itself; focused release-boundary review is reserved for the later live shared-gate activation.

## Final K2 shared analysis reliability hardening

- verdict: **PASS**.
- PR #45 head `b37e1c9` merged by ChatGPT -> `6ea31efec1876596085e9b66727b2626ab0ba477`.
- retry scope is bounded to transient OpenAI transport failures; claim/idempotency/content-validation semantics unchanged.
- related suite 338/338 PASS; production mutation before merge=0; gates remain app=false / x=false.
- no separate Codex review before gated-OFF deployment under reduced-review policy; H1 is occupied and H2 is preserved deferred, so neither is overwritten.
- focused Codex review remains required/strongly preferred before consumer activation, especially `x_enabled=true`.

## G2 shared analysis production observation

- 2026-09-28 recovery note: accidental local shared-checkout `supabase/config.toml` overwrite was restored; production mutation=0. Continue deployment only from dedicated checkout `/Users/yuya/Developer/kabumori-g2-market-report-reliability` at fresh main `fc0afd32`. Historical branch `g2-shared-analysis-reliability-20260928` and shared checkout are not deployment workspaces.


- assigned: `kabumori-shared-analysis-prod-deploy-observe-20260928`.
- deploy only `market-report-analysis` from merged main; preserve verify_jwt=false and all cron/settings.
- no manual cycle forcing; observe the next natural morning and close cycle.
- app/x consumer gates remain false throughout.
- recommended Claude model: Sonnet5（高）.

## G2 shared analysis reliability hardening

- assigned: `kabumori-shared-report-reliability-hardening-20260928`.
- goal: bounded retry/backoff for retryable 429/5xx/network failures in `market-report-analysis`, with explicit worst-case call budget and no idempotency drift.
- product policy for initial cutover: keep shared consumer fail-closed; do not fall back to a separate legacy market analysis and reintroduce contradictory market truth.
- no production gate activation/deploy/cron mutation in this source task.
- legacy X VOICE-only fixes remain frozen.
- recommended Claude model: Opus5.5（高）.

## G2 shared morning/close unification

- assigned: `kabumori-shared-market-report-unification-20260928`.
- user priority: stop spending effort on legacy X morning/close VOICE-only fixes before unification; first make X and App consume the same market truth.
- target product split:
  - X = market-wide simplified morning/close.
  - App = complete report with `市場全体 | マイポート`; market tab uses shared packet, my-portfolio tab adds holdings/news/impacts.
- source of truth: `market_data_packet -> market_report_packet`.
- first gate is non-destructive proof for X simplified / App market-complete / App personalized using the same report_packet_id/content_hash.
- production `app_enabled/x_enabled` activation is NOT authorized in this source task; prepare cutover plan, then stop for K2 and focused review if needed.
- legacy X VOICE issue is frozen and will be re-evaluated only on the unified shared path.
- known conflict: open PR #41 changes `supabase/functions/x-test-post/index.ts`; G2 must not edit that file while PR #41 remains unresolved. If required, STOP and report conflict.
- G3/G4 current social-mobile tasks are separate worktrees/scopes and must not be touched.
- recommended Claude model: Opus5.5（高）.

## G1 Kabumori onboarding + icon integration

- assigned: `kabumori-onboarding-icon-integration-20260926`.
- user-approved assets are final; Claude must not regenerate or redesign them.
- new official icon source expected 1254x1254 RGB sha256 `6b083c5156332665a1354199f824bc7590a05d79ec2fe1608ae286425ffd7d4e`.
- onboarding 01/02/03 expected 1179x2556 RGB with sha256:
  - 01 `de0f57bd48fb15a3c3cbf11480fed2106677a6729930f57b734f881051a988fb`
  - 02 `2ac0fda449490867f6f0ced3f89b2023f43bdb424122c8aea8ce3aedb9b5e833`
  - 03 `6dbbf10caad1eb0c23a4604186ce2474fd8472649f952d4e4662411b1ec93dd6`
- onboarding shown once for version v1; native page dots; accessible page-3 CTA.
- page-2 progress is explanatory/indeterminate only, never real market-analysis progress.
- no Codex review expected if scope remains UI/asset/local-state only.
- real-iPhone/TestFlight visual acceptance remains a later gate.
- recommended model: Sonnet5（高）.

## G1 real-iPhone visual QA build

- assigned: `kabumori-ios-internal-visual-qa-build-20260926`.
- user authorized proceeding after Final K1.
- goal: install current merged main on a real iPhone using one safest nonproduction internal EAS build.
- preflight must verify EAS login/project, required public env presence, iOS signing and device registration before build.
- if operator interaction is required, stop with one exact next action.
- no source change expected; no Codex review expected.
- recommended model: Sonnet5（高）.

## PR #40 merged by ChatGPT

- Claude Code app-level safety blocked self-merge; project review policy did not require K1/Codex for this narrow asset-only change.
- ChatGPT verified PR #40 was mergeable, exactly 3 files, and green on Netlify/Vercel.
- merged head `e8c4524faa138bfd894b5b5623a73ef23c07ffa9` -> `d2747c75ecbbe48ffeab77cc3827787cac888468`.
- G1 resumes only for one new nonproduction iOS preview build and user icon re-check.

## G1 full-bleed official icon correction

- user real-device finding: the approved icon design looked too small because the source itself included a rounded-card/white outer frame.
- corrected full-bleed artwork is now the intended official master; user will overwrite the previous Desktop source without changing its filename.
- new source gate: 1254x1254, fully opaque RGBA, sha256 `8b821f60b8a4c162c6fda2eafe52245bf4f28aa734778b4db6791c29508e40ed`.
- repo master path stays `assets/branding/kabumori-icon-master-2026-09-26.png`; installed icon remains `assets/images/icon.png`, deterministically resized to 1024x1024 opaque RGB.
- after merge, make one new nonproduction iOS preview internal build and let the user visually confirm the home-screen mask.
- no Codex review expected if scope remains asset-only.
- recommended model: Sonnet5（中）.

## Final K1 onboarding + icon integration

- verdict: **PASS**.
- PR #39 head `a781240297e66b0ed98738920cacb22940088f7d` merged -> `08355579ef8fd89e12e6723aed4674905440016a`.
- exact user-approved icon/onboarding asset hashes and dimensions matched before ingress.
- official app icon now uses the 2026-09-26 master; native splash/AnimatedSplashOverlay continue to reference the installed official icon.
- onboarding v1: 3 horizontally paged approved images, native page dots, image-relative accessible page-3 CTA, versioned AsyncStorage completion key.
- local onboarding-flag read is accepted as a presentation gate only; auth/session initialization, recovery-link precedence and routing semantics remain independent.
- page-2 native progress animation was not implemented; static approved bar retained under the task's explicit safe fallback.
- 155/155 tests PASS; src TypeScript 0 errors; Expo config/prebuild/web export/diff PASS.
- production mutation 0; no EAS build/TestFlight/App Store/Supabase/Auth/X/admin mutation.
- no Codex review required under reduced-review policy.
- next gate: real-iPhone/TestFlight visual acceptance, especially CTA alignment and overall crop/safe-area appearance.

## H1 universal OAuth refresh final review

- Verdict: **PASS-WITH-FIX for source only**. PR #37 prevents automatic redirect-follow on Vault-backed X create requests; Kabumori legacy behavior is unchanged. C1 required before merge/activation.
- Stage 0 read-only production metadata: AI Lab has distinct access/refresh Vault refs, shared refs 0, required `social_accounts` shape/unique constraint and Vault function present; core/Phase1I are unapplied. `service_role` already has direct Vault read/update privilege, not widened by this candidate. Edge OAuth-client environment-variable presence remains unverified.
- Disposable core and stacked Phase1I behavior/race proofs PASS; X-related 642/642 tests PASS; targeted Deno check/lint PASS. `index.ts` retains six pre-existing type errors and three pre-existing lint findings, none on changed lines.
- Stage 1/2 production changes remain **not approved**. Reconnect-versus-commit deadlock is fail-closed but can require operator reconnection; review rollout safeguards in `.agent/CODEX_REPORT.md`.

## Final K1 branded launch screen

- verdict: **PASS**.
- PR #36 head `5b72e5784b07ebf7871879471f53fe06e6f072eb` merged -> `b869fb557f009ca5817b6d2a853d529bd29c20c2`.
- native splash and AnimatedSplashOverlay use the approved Kabumori icon on #eef3ed with matched 200x200 sizing.
- Expo blue/logo removed from normal launch.
- restrained 600ms fade/scale exit; Reduce Motion supported.
- 135/135 tests, src tsc 0, expo config/prebuild/web export/diff PASS.
- production mutation 0.
- no Codex review required.
- newer Yume-chan + robot visual concept remains a separate optional refinement, not part of this merged baseline.

## G1 Kabumori branded launch screen

- user decision: create a dedicated Kabumori launch screen now.
- first implementation uses the already approved icon/branding; no new generated artwork.
- replace Expo native splash and AnimatedSplashOverlay template visuals.
- final aesthetic acceptance will be on real iPhone/TestFlight and may be refined.
- no Codex review expected for this branding/UI task.
- recommended model: Sonnet5（高）.

## Final K1 release-readiness audit

- verdict: **PASS for audit/documentation**.
- PR #35 docs-only head `5b5acd69d20c622b73e3b6f73f510a2479b9d318` merged -> `26b0e8903b434a7a5222370c65aa4ed565af113e`.
- no source/code bug found.
- icon done; EAS source config/verifier ready.
- Kabumori public/legal Web source ready, but no separate Netlify site exists yet.
- Auth/SMTP live state could not be safely read from this environment.
- AnimatedSplashOverlay/native splash remain Expo template and should be replaced before first TestFlight.
- next blockers are operator/artwork gates, not another code review.
- no Codex review needed under reduced-review policy.

## G1 release-readiness gap closure

- assigned: `kabumori-release-readiness-gap-closure-20260925`.
- goal: while G2 waits for Monday natural-cron telemetry, advance native release readiness.
- covers EAS production env prerequisites, Kabumori Netlify public/legal pages, Supabase Auth Site URL/redirect requirements, custom SMTP readiness, App Store/TestFlight prerequisites, and remaining startup artwork.
- safe source/config/doc fixes allowed; production Auth/SMTP/credentials/DNS/TestFlight/App Store mutation forbidden.
- no overlap with G2 personalized-reports or X/admin scopes.
- recommended model: Opus5.5（高）.


## Final K3 universal OAuth refresh productionization

- verdict: **PASS for source implementation**.
- implementation commit: `acbac42`.
- AI Lab `allowRefresh:false` dead-end removed in source and replaced by the generic exact-account Vault-backed credential lifecycle for non-Kabumori accounts.
- Kabumori legacy token path unchanged.
- exact-account/ref ownership, one-refresh/one-safe-retry, uncertain/reauth_required health handling, concurrency lease model and future-account generic routing implemented.
- x-test-post 500/500; _shared 141/141; important-news-monitor 473/473; disposable core/race proofs PASS.
- production mutation=0; no migration/deploy/real refresh/Vault write/X call.
- G3 closed.
- H1 assigned focused final review before any production activation.
- recommended Codex model: Sol（高）.

## Final K4 PR #15 production verification

- verdict: **PASS**.
- PR #15 merged head `f04c44ac564aa775fc0d68106648a0d2e4fcd564` -> merge `f610503761729bdc09dfa483bd218a769350a2dc`.
- post-merge apps/admin 34/34; focused brand-boundary 27/27; tsc/lint/build/diff PASS.
- Vercel production confirmed serving PR #15 code.
- authenticated production QA PASS: login, Kabumori ⇄ AI Lab switching, brand isolation, Kabumori-only control suppression, invalid selector rejection.
- unauthenticated/tampered-session boundary fails closed; non-admin live account unavailable but existing admin_users source/test boundary intact.
- secret/service_role exposure not observed; DB/Auth/RLS/OAuth/Vault/X/business-data mutation 0.
- no additional Codex review needed; semantics unchanged from reviewed candidate.
- G4 closed and reusable after fresh allocation check.
- AI Lab X 401 incident is tracked separately in G3.

## AI Lab 401 / universal OAuth refresh

- incident confirmed: AI Lab last success 2026-09-24 07:33 JST; first continuous X_REQUEST_FAILED:401 at 09:51 JST.
- live AI Lab account has exact access/refresh Vault refs and remains publish_enabled=true, but current x-test-post deliberately sets allowRefresh=false for AI Lab.
- root issue: access-token 401 cannot invoke the configured refresh token; repeated failures remain opaque while connection_status still appears identity_verified.
- G3 assigned to productionize the already-reviewed Phase1I exact-account refresh architecture for AI Lab plus all future Vault-backed X social accounts.
- source-only implementation first; no real refresh/Vault write/X call/deploy until K3 + focused Codex review.
- recommended model: Opus5.5（高）.

## Final K3 PR #30 merge

- verdict: **PASS**.
- reviewed/fixed head `94000720e10649612e84cb3811327de1a63364e9` merged -> `a9b1ef4d359d5ef554284fc56427e0cafeaec648`.
- post-merge focused Phase1B–1I 124/124; x-test-post 477/477; greeting/publish_claim/tip 138/138; _shared 141/141; important-news-monitor 473/473; DB behavior/concurrency proof PASS; Deno check/lint/bashe/diff checks PASS.
- production migration/deploy/OAuth/Vault/X mutation = 0; Phase1I remains OFF/unwired.
- additional Codex review not required because the already H1-reviewed/fixed head was merged unchanged and verified post-merge.
- G3 closed and reusable after fresh allocation check.

## PR #15 merge continuation

- PR #15 head `f04c44ac564aa775fc0d68106648a0d2e4fcd564` merged by ChatGPT with expected-head protection.
- merge/main commit: `f610503761729bdc09dfa483bd218a769350a2dc`.
- G4 should resume Scope C/D only: post-merge tests, brand/auth boundary verification, actual Vercel production status, and authenticated production QA if deployment succeeded.
- no additional Codex review required unless semantic source drift is introduced.

## K1 PR #31 icon integration

- verdict: **PASS**.
- PR #31 head: `8939ce9f2f829cbfb042cadd92760f4e67ce8cc9`.
- exact user-approved source used: 1254x1254 RGB opaque, sha256 `31eda5379951b3d8f69676add4add33ecea6d799a48545ef076bd6235949a3f8`.
- derived native icon: 1024x1024 RGB opaque/no alpha.
- Expo config resolves both top-level icon and ios.icon to `./assets/images/icon.png`.
- real expo prebuild generated the new artwork in AppIcon.appiconset; template icon no longer used by app-icon config.
- 126/126 tests, src TypeScript 0, Expo web export 10 routes, diff check PASS.
- Splash config, AnimatedSplashOverlay and expo-logo unchanged.
- production mutation=0.
- Codex review skipped as low-risk asset/config-only change.
- next G1: fresh-main merge + post-merge verification. EAS/TestFlight requires separate authorization.
- recommended model: Sonnet5（中）.

## Final K2 PR #34 shadow deploy

- verdict: **PASS**.
- PR #34 reviewed head `40828d31124a629e594c7ac2ac3af28e5325f6de` merged -> `0cba73236f0e02dd3c88c78e9cb06434b593091f`.
- production personalized-reports v30; verify_jwt=false.
- app_enabled=false / x_enabled=false maintained.
- deployed source read-back matches merged main byte-for-byte.
- personalized-reports 119/119; related 241/241; check/lint/diff PASS.
- one non-persisting dry-run smoke: completed, Fact PASS, local 0, voice_status=pass, delivery_blocked_by=null.
- reportId=null, notification=not_attempted, persistence=0, notifications=0.
- rollback not required.
- next meaningful gate: Monday 2026-09-28 natural morning 08:35 JST + close 17:15 JST read-only telemetry/result validation.
- Phase 2 warn-deliver/rewrite remains deferred until shadow data is observed.

## Final K2 VOICE Phase 1 shadow source

- verdict: **PASS**.
- PR #34 head `40828d31124a629e594c7ac2ac3af28e5325f6de`.
- shadow-only PASS/WARN/BLOCK/unavailable classification implemented.
- telemetry stored under existing `source_basis.delivery_policy`; no migration.
- report_logic, prompts, Fact/local semantics, parser, MIC and delivery/save/notify behavior unchanged.
- new tests 8/8; personalized-reports 119/119; related 241/241; check/lint/diff PASS.
- production mutation=0; PR remains unmerged at K2.
- no new Codex review required under reduced-review policy.
- next G2: fresh-main merge + controlled shadow deploy with app_enabled=false.
- recommended model: Sonnet5（高）.

## Final K2 PR #32 stabilization

- verdict: **PASS for technical stabilization; activation still OFF**.
- PR #32 final head `8792622d440b008d04ca97fb780a6a765245542a`.
- merged -> `f34b8c48e0de35626a8c16cd6a8d6109285c2bde`.
- production personalized-reports v29, verify_jwt=false.
- app_enabled=false / x_enabled=false.
- tests: no_material 7/7, morning_contract 8/8, report_hardening 9/9, close_validator 23/23, personalized-reports 111/111, related 233/233, check/lint/diff PASS.
- dry-run: morning **3/3 PASS**, close **3/3 PASS**.
- all impacts complete, empty fact_ja 0, MISSING_HOLDING_IMPACTS 0.
- broad no-news / intraday / unsafe causal regressions not observed.
- all dry-runs reportId=null and notification=not_attempted; persistence=0.
- mixed-news live LLM case not naturally observed; deterministic regression test covers it.
- rollback not required.
- deferred independent review remains historical debt, not an activation requirement for this low-risk stabilization under the new review-cadence policy.
- activation remains OFF pending later natural-cron/read-only confirmation and explicit decision.
- next G2: VOICE PASS/WARN/BLOCK Phase 1 shadow classification + telemetry only.
- recommended model: Opus5.5（高）.

## K2 PR #32 safe-stop regression

- verdict: **SAFE STOP before merge**.
- current PR #32 head `722d191...` passes existing tests but has a deterministic no_clear_material regression not covered by them.
- cause: prompt permits empty `fact_ja`; parser drops empty-fact impacts; local validator then raises `MISSING_HOLDING_IMPACTS`, causing delivery failure.
- production remains v28; no merge/deploy/dry-run occurred in the stopped task; mutation=0.
- chosen fix: keep parser unchanged and generate a holding-scoped non-empty input-state fact for no-material holdings.
- per reduced-review policy, G2 will fix/test/update same PR/merge/redeploy/dry-run in one task; no new Codex review now.
- app_enabled=true remains forbidden.
- recommended model: Opus5.5（高）.

## PR #32 review deferred / continue validation

- User explicitly deferred H2 because Codex became unavailable mid-review.
- H2 has no final verdict and remains incomplete.
- During the partial review, Codex pushed `722d191dcbe4ba4ce5cf549659493df03d35a353`, tightening empty-news handling to packet-wide emptiness and adding mixed-news/adversarial tests.
- Current PR #32 head is `722d191...`.
- G2 will independently rerun full source verification, then may merge/deploy with app_enabled=false and perform morning>=3 / close>=3 dry-runs.
- app_enabled=true remains forbidden until later review/activation decision.
- recommended model: Opus5.5（高）.

## Final K2 PR #32 source contract fix

- verdict: **PASS for source implementation; H2 review required**.
- PR #32 head `749ce19f01ae191398a5b32420b657263c54dd57`.
- morning prompt no longer requests unsupported intraday-observation wording.
- empty-news language is constrained to packet/input-state claims.
- Fact checker gains one narrow empty-input meta-claim allowance; no existing rejection removed.
- 6/6 new tests; personalized-reports 102/102; related 220/220; check/lint/diff PASS.
- production remains v28; app_enabled=false; x_enabled=false; mutation=0.
- H2 assigned independent Fact/Safety boundary review.
- recommended model: Sol（高）.

## Final K1 PR #31 icon merge

- verdict: **PASS**.
- reviewed head `8939ce9f` merged -> `7aa394fc1dc73edd0c67b6529923ec4dc9616e7f`.
- approved master asset preserved exactly; installed icon asset is 1024x1024 RGB/no alpha.
- Expo config and real prebuild both resolve to the approved artwork.
- 126/126 tests; src TypeScript 0; Expo export 10 routes; diff PASS.
- Splash/AnimatedSplashOverlay/expo-logo unchanged.
- production mutation=0.
- G1 closed; real iPhone/TestFlight visual acceptance remains a separate authorized step.

## Final K2 PR #29 deploy/dry-run

- verdict: **partial PASS / activation NO**.
- PR #29 merged -> `47ea87d33734fbd9e8489f2112c732cb0b2ca11f`.
- production personalized-reports v28; verify_jwt=false; app_enabled=false; x_enabled=false.
- post-merge tests all PASS: personalized-reports 96/96, related 214/214.
- close dry-run: **5/5 PASS**; false INFERENCE_NOT_HEDGED and factual-lead regression resolved.
- morning dry-run: **0/2**, both Fact FAIL with local issues 0.
- current morning failure is a prompt↔Fact contract mismatch:
  - prompt encourages 寄り付き後/場中 wording although packet has no future intraday observation
  - empty-news wording can become an overly broad world-state claim
- no persistence, no notification, no malformed/truncated output.
- rollback not required; v28 improves close and does not newly cause the morning issue.
- activation remains NO.
- next G2: source-only morning prompt/Fact contract fix.
- recommended model: Sonnet5（極高）.

## H1 Phase1I exact-account refresh final review

- Verdict: **PASS-WITH-FIX for source only**, PR #30 at `94000720e10649612e84cb3811327de1a63364e9` awaiting C1. Production migration/deploy/real refresh: **NO**.
- P1 cross-account Vault write was reproduced with fake local secrets when a ref changed without `updated_at`; P2 stale attempt could commit after settlement. Commit now rechecks leased identity/refs and live attempt/post under locks, and serializes shared-ref ownership check with account DML. Regression tests and disposable Phase1D–1I proofs pass.
- Full x-test-post + _shared: 618/618; important-news-monitor: 473/473; focused Phase1I: 41/41. Targeted Deno check/lint pass. Broader Deno type-check still has 18 unrelated existing errors; broad tests passed with `--no-check`.
- `service_role` remains a trusted server boundary. Live owner/ACL/definition read-back and an authorized activation plan remain outstanding. See `.agent/CODEX_REPORT.md` for the full review.

## Final C1 Phase1I

- verdict: **PASS-WITH-FIX**.
- PR #30 reviewed/fixed head: `94000720e10649612e84cb3811327de1a63364e9`.
- P1 cross-account Vault ref-swap write and P2 settled-attempt stale commit were fixed.
- Phase1I 41/41; x-test-post + _shared 618/618; important-news-monitor 473/473; disposable Phase1D–1I proofs PASS.
- production mutation=0; activation remains NO.
- G3 assigned reviewed-head merge + post-merge verification.
- recommended model: Sonnet5（高）.

## Final C2 PR #15

- verdict: **PASS-WITH-FIX for source/Preview**.
- reviewed/fixed PR #15 head: `de354e7ff9f647435a3c42a87629be1e735794eb`.
- fixed independent admin gate and Kabumori-only mutation-context P1 issues.
- apps/admin 34/34; focused boundary 20/20; tsc/lint/build PASS.
- Netlify Preview SUCCESS; unauthenticated/tampered-session behavior fail-closed.
- production mutation=0.
- authenticated live selector/cross-brand QA remains required before merge.
- PR #15 remains unmerged.

## G4 Admin password recovery / invite flow

- assigned: `x-admin-password-recovery-invite-flow-20260925`.
- goal: add Web Admin `/forgot-password` + `/reset-password`, support invite/initial-password setup through the same safe receiver, preserve the existing mobile `kabumori://reset-password` redirect.
- current Supabase Auth Site URL is still `http://localhost:3000`; only redirect allowlist entry currently known is `kabumori://reset-password`.
- this task is source + Netlify Preview only; production Supabase Site URL/Redirect URL mutation is forbidden.
- password setup must never imply admin authorization; `admin_users` gate remains mandatory.
- Auth/security change requires independent Codex review before merge or production Auth URL configuration mutation.
- recommended model: Opus5.5（高）.

## Final K4 Admin password recovery / invite flow

- result: **PASS for source + Netlify Preview**.
- PR #33 head: `e2e1ff52a99e37d108a0f9a1f024dc507a7bedaf`; unmerged.
- implemented `/forgot-password`, `/auth/confirm`, `/reset-password`.
- account enumeration/open redirect/token logging protections PASS.
- password setup does not grant admin; `admin_users` gate remains mandatory.
- Netlify Preview SUCCESS; live unauth route QA PASS.
- tests 47/47; tsc/lint/build/diff PASS.
- production mutation=0; Supabase Site URL/Redirect URLs unchanged.
- Codex review intentionally deferred per user instruction.
- next operator gate: add exact Preview redirect URL, then perform one real recovery/invite E2E; keep Site URL unchanged for now.
- recommended model for later continuation: Opus5.5（高）.

## Approved app icon decision

- User selected the latest newspaper/chart/leaf/「かぶモリ」 image as the current official app-icon candidate.
- Source supplied in ChatGPT as `アイコン.png`, 1254x1254, opaque square.
- G1 should use that exact source, deterministically resize to required native asset sizes, and must not regenerate or redesign it.
- Splash and AnimatedSplashOverlay are not approved by this decision and must remain unchanged.
- Final icon acceptance is deferred until actual iPhone home-screen verification.
- If Claude cannot access the exact source asset, it must STOP with `USER_ASSET_REQUIRED` rather than substitute an approximation.
- recommended model: Sonnet5（高）.

## K2 VOICE gate audit result

- verdict: **PASS** for audit/design.
- source change=0, production mutation=0.
- Product direction accepted: Fact/Safety remain BLOCK; Voice quality becomes PASS/WARN/BLOCK, and Voice-only WARN must not suppress delivery.
- preferred future delivery policy: one rewrite for WARN, re-Fact rewritten text, fallback to original Fact-passed text if rewrite fails or remains stylistically weak.
- Voice evaluator infrastructure errors should become WARN/unavailable after retry, not automatic content failure.
- next implementation will start only after PR #29 report stabilization; first phase is shadow classification + telemetry with no delivery behavior change.
- recommended implementation model: Opus5.5（高）; review: Codex Sol（高）.

## VOICE gate product-policy audit

- User decision: routine paid-user delivery reliability should outrank minor style perfection.
- Target policy: separate Fact/Safety from Voice quality; evaluate PASS / WARN / BLOCK.
- WARN should not automatically suppress delivery.
- G2 assigned read-only audit/design only; no source/deploy.
- X-side implementation is out of scope for this room; G2 should produce a handoff for X担当ちゃ.
- recommended model: Opus5.5（中）.

## Final C2 PR #29 + v27 validator

- verdict: **PASS-WITH-FIX**.
- `510acf5` validator widening to 値下がり/値上がり independently reviewed PASS.
- PR #29 final reviewed head: `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`.
- H2 fixed one prompt coverage gap: morning neutral-wording instruction now explicitly includes `watch_notes[*].note_ja`.
- validator and Fact behavior remain unweakened/fail-closed.
- MIC compatibility PASS.
- focused 32/32; personalized-reports 96/96; deno check/lint/diff PASS.
- production mutation from H2=0.
- next G2: merge PR #29 -> controlled redeploy -> close 5x + morning 2x dry-run, app_enabled=false.
- recommended model: Opus5.5（高）.

## Final K2 PR #29 source hardening

- source implementation verdict: **PASS; review required before merge/deploy**.
- PR #29 head `bed5e79d0ab22e94be6a7c1ebd0f7c8f157ea0c0`.
- prompt-only hardening for close inference-field discipline and neutral morning wording.
- PR #29 does not weaken validator or Fact checker.
- tests: new 9/9; close-validator 23/23; personalized-reports 96/96; related 214/214; deno check/lint/diff PASS.
- separate concern: commit `510acf5` added 値下がり/値上がり directly to main and was deployed as v27 before independent review.
- H2 assigned combined review of 510acf5 + PR #29.
- production remains app_enabled=false.
- recommended model: Luna（極高）.

## Final K1 PR #24 result

- PASS.
- PR #24 reviewed head `46515c56f88bb8a9f55c9e235477d660e8b8bd04` merged -> main `ff4c43c08752276a17f4124dce33a09b92749ee9`.
- 122/122 scoped tests PASS; production web build PASS.
- Privacy now explicitly covers portfolio-level valuation / sector composition / TOPIX-relative comparison sent to OpenAI.
- personalized-reports and account-deletion remained untouched.
- production mutation=0 excluding normal GitHub merge.
- G1 is closed for now; next release task should wait for finalized artwork or operator/publication inputs.

## Final K1 PR #21 merge result

- PASS.
- PR #21 reviewed head `0a71f0882136aa8930cf0572033e1a0ba28c0760` merged -> main `0d4ebad98a5a25e300f766600231eb60b36e5c07`.
- merged content byte-identical to H2-reviewed head.
- 122/122 scoped tests PASS; src TypeScript 0; Expo web export 10 routes PASS.
- identity/linkage unchanged except installed app display name 「かぶモリ」.
- no artwork changed.
- production mutation=0 excluding normal GitHub merge.
- next G1: privacy/data-flow re-audit against current report implementation before Netlify publication.
- recommended model: Sonnet5（高）.

## C2 PR #21 result

- verdict: **PASS-WITH-FIX**.
- H2 fix/reviewed head: `0a71f0882136aa8930cf0572033e1a0ba28c0760`.
- publishable-key validation hardened; malformed/secret/service-role values rejected without value echo.
- App Store listing-name wording corrected; `expo.name` only covers installed app display name.
- AnimatedSplashOverlay wording corrected to normal-startup scope.
- 8/8 verifier tests + 116/116 scoped tests PASS; git diff --check PASS.
- production mutation=0.
- G1 assigned PR #21 fresh-main merge + post-merge verification.
- production build/release still blocked by official artwork, EAS production values and App Store Connect inputs.

## K1 PR #21 result

- G1 implementation PASS for PR #21 at head `db5143fe399df25902739f4c60a07af712c3743a`.
- display name -> 「かぶモリ」; slug/scheme/bundleIdentifier unchanged.
- production env preflight added; 114/114 tests PASS; src TypeScript 0; Expo export 10 routes PASS.
- A1/A1b confirmed: static icon/splash and launch-time AnimatedSplashOverlay still expose Expo branding.
- no official Kabumori artwork found; none generated.
- production mutation=0.
- H2 independent light review required before merge; recommended Luna（高）.

## K1 PR #18 merge result

- PASS.
- PR #18 merged at reviewed head `6f327763...` -> main `a41b306de1cdf6e9c7e91ad7e22403a031650883`.
- 108/108 tests PASS; src TypeScript 0 errors; Expo export 10 routes; public Web preview/production dry-run builds PASS.
- No G2/PR #19 files were touched.
- production mutation=0 excluding normal GitHub merge.
- G1 advanced to branding/EAS preflight.

## K1 release foundation result

- G1 implementation PASS for PR #18 at head `2b91cc4`.
- PR #18 remains open/unmerged.
- H1 review required for privacy/data-flow factual consistency and release-page accuracy.
- H1 recommended model: Luna（高）.

## C1 PR #18 result

- H1 review PASS after minimal privacy/data-flow fixes.
- reviewed PR #18 head: `6f3277639bc19fb1f420cd0e771c1d77f6d23519`
- 17/17 focused tests PASS; production mutation=0.
- Vercel rate-limit failure is not a Kabumori Web merge-quality blocker; Kabumori Web uses Netlify.
- G1 assigned fresh-main merge + post-merge verification.

## Kabumori release lanes

- G1: release-readiness implementation (App Store/EAS/public release Web/Auth release blockers).
- G2: app content/feature depth (currently morning/closing reports + portfolio impact).
- G1/G2 may run in parallel only when file/API/Auth/DB boundaries do not overlap.

## Parallel safety

- G1 owns App Store release foundation/public legal-support Web/native release links/EAS audit.
- G2 owns Kabumori app morning/closing report detail + portfolio-impact implementation.
- G3 Phase1D implementation + DB/RPC/concurrency review are complete; G3 now owns Phase1E exact-account credential resolver + one-request provider seam. Phase1D remains source-only and not production-authorized.
- G4 Netlify repository preparation is complete; live Netlify site connection/QA remains pending interactive authorization.
- H1 final Auth/security review of PR #17 is complete (C1 PASS).
- H2 now owns PR #19 LLM/privacy/user-boundary final review.
- push前にfresh `origin/main`確認。
- 各slotは独立worktree/checkoutを使用する。
- 既存未コミット変更は他workstream所有として触らない。

## Kabumori native PR merge policy

- Native Expo/React Native PRs do not require Vercel deployment checks to merge.
- Native verification uses code review, tests, Expo/EAS and real-device evidence as appropriate.
- Future Kabumori Web Preview/Production uses Netlify.
- G1/G2 are both normal Kabumori implementation slots; G2 is used when safe parallel work is available.

## C1 result

- PR #17 Auth/security review PASS.
- H1 fixed one P2 classifier issue and pushed reviewed head `b3798aa6be82b6a29d8d2dcf21ca27fb19ef5f50`.
- PR #17 is Auth/security-approved. It may be merged after fresh-main verification; Vercel is not a native merge gate.
- Current Vercel failure is rate-limit related and was not bypassed.

## Deferred work

- PR #15 final Vercel check -> merge -> post-merge read-back -> production Admin QA.
- Kabumori Expo Web Netlify Preview setup.
- Prior reviewed code/test evidence remains preserved in the old G4/G2 reports.
- Resume either deferred item only when needed or user explicitly asks.

## K2 v26 repeated dry-run result

- result: **safety containment PASS / rollout not accepted**.
- PR #26 merged at reviewed head -> `f7498cd3a3c8be36c5c56ba19a437ba300d6f93a`.
- production v26 had already been deployed by MIC report-context integration; G2 did not overwrite it.
- production v26 matched then-current main and kept verify_jwt=false / app_enabled=false.
- close dry-run: 3/5 PASS.
- remaining false rejects:
  - `値下がりの要因は特定できません。`
  - factual lead clause + bounded unknown-cause sentence
- morning dry-run: Fact FAIL with local validator 0; likely advisory-sounding neutral wording false positive.
- no unsafe causal assertion, truncation, persistence, or notification observed.
- no G2 deploy/rollback performed; production v26 retained per user decision.
- activation remains NO.
- next G2: source-only vocabulary + prompt hardening; deploy forbidden until review.
- recommended model: Sonnet5（極高）.

## C2 PR #26 result

- verdict: **PASS**.
- reviewed head: `2b40a617e34c73c301e40a17692883ac70fd3e0a`.
- no over-permission or new causal/free-text bypass found.
- whole-string anchors, CAUSAL_ASSERTION-first ordering, and sentence splitting remain intact.
- focused 20/20; personalized-reports 64/64; deno check/lint/diff PASS.
- production mutation=0.
- G2 assigned fresh-main merge + redeploy + close dry-run 3〜5回 + morning 1回 with app_enabled=false.
- recommended model: Opus5.5（高）.

## Final K2 PR #26 source-fix result

- PASS.
- PR #26 head `2b40a617e34c73c301e40a17692883ac70fd3e0a`.
- narrow movement-prefix support added for legitimate unknown-cause wording.
- exact production false-reject sentences are now regression-tested.
- close-validator 20/20; personalized-reports 64/64; related suite 182/182 PASS.
- deno check/lint/diff PASS.
- production remains v25 = known-good v21 source `4590ba6`; app_enabled=false.
- production mutation=0.
- H2 assigned independent regex/over-permission review.
- recommended model: Luna（高）.

## K2 PR #23 redeploy result

- result: **safety containment PASS / rollout not accepted**.
- PR #23 merged -> main `5df9512b43c885fff28b625d089eda249320b3c3`.
- v24 deployed with app_enabled=false.
- close dry-run: 1/3 PASS, 2/3 false-rejected legitimate unknown-cause wording.
- morning dry-run PASS.
- IMPACT_TOO_LONG fixed; remaining blocker is narrow unknown-cause prefix parsing.
- no persistence / notification; rollback triggered as designed.
- production now v25 = known-good v21 source `4590ba6`; app_enabled=false.
- activation remains NO.
- G2 assigned a source-only minimal validator fix; no deploy in that task.
- recommended model: Sonnet5（極高）.

## C2 PR #23 result

- verdict: **PASS-WITH-FIX**.
- reviewed/fixed head: `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`.
- H2 fixed one adversarial same-sentence hedge-laundering bypass.
- morning brief=120 / close brief=160; prompt and local validator agree.
- close-validator 14/14 PASS; personalized-reports 58/58 PASS; deno check/lint/diff PASS.
- production mutation=0.
- G2 assigned fresh-main merge + redeploy with app_enabled=false + close dry-run 3回以上.
- recommended model: Opus5.5（高）.

## Final K2 production rollback result

- PASS for safety containment.
- v22 exposed close-report regression in controlled dry-run; no saved reports or notifications.
- production rolled back to known-good v21 source, deployed as v23.
- correct rollback source commit: `4590ba6`.
- rollback read-back byte-identical; verify_jwt=false.
- app_enabled=false remained unchanged.
- PR #23 head `5c22c71961496fc63e698e42e7c18cacc7f7cff3` contains source validator fix only.
- tests 167/167 PASS; deno check/lint/diff PASS.
- H2 independent validator review assigned before merge/redeploy.
- recommended model: Luna（極高）.

## G2 production rollout stage 1

- assigned: `kabumori-personalized-reports-prod-deploy-dryrun-20260924`
- authorized: deploy `personalized-reports` to production + controlled dry-run/read-only validation.
- mandatory: `app_enabled` remains false for the entire task.
- no cron/schema/Auth/X/cohort changes.
- goal: observe real LLM/Fact behavior, latency/output/cost, and push safety before any gate activation.
- recommended model: Opus5.5（高）.

## Final K2 PR #19 result

- PASS.
- PR #19 merged at head `2b743f3a9799f35409ab1e61652b9e76b04977c5` -> main `518542702f820e490d0c02050b0ef470f023ce5a`.
- post-merge 154/154 tests PASS; deno check/lint PASS; no new src TypeScript errors; Expo export 10 routes PASS.
- X/shared-fact paths unchanged; H2 missing-value fix confirmed on main.
- no Edge deploy, no app_enabled flip, no cron/DB/Auth/X mutation.
- production mutation=0 excluding normal GitHub merge.
- next rollout is a separate G2 task after explicit approval: Edge deploy -> dry-run validation -> app_enabled decision -> real-device QA.

## K2 result

- G2 implementation PASS for PR #19 at head `acbc1b6`.
- PR #19 remains open/unmerged.
- 151/0 tests; deno check/lint PASS; no new src TypeScript errors; production mutation=0.
- Codex review required before merge due LLM validation, user-bound morning lookup, and portfolio privacy boundaries.
- H2 has now been assigned the PR #19 review after C2 closed the Phase1D review.

## PR #19 merge handoff

- PR #19 merged successfully after fresh head/mergeability verification.
- merged head: `2b743f3a9799f35409ab1e61652b9e76b04977c5`
- merge/main SHA: `518542702f820e490d0c02050b0ef470f023ce5a`
- G2 now needs post-merge verification only.
- production mutation remains 0 except normal GitHub merge.

## C2 PR #19 result

- verdict: **PASS-WITH-FIX**.
- reviewed PR #19 head: `7dcf41c5714d620c41b3077376b9f5febbd129b2`.
- H2 fixed missing-value/change display; 49/49 focused tests PASS.
- privacy/user-boundary and morning-to-close isolation PASS.
- scheduled cohort remains users with active tracked_stocks; zero-tracked users are outside this task. Watch-only users cover the no-holdings market-only case.
- semantic evidence relevance remains future hardening, not a merge blocker.
- G2 assigned fresh-main integration + merge/post-merge verification.
- production mutation=0.

## C2 Phase1D result

- H2 verdict: **PASS-WITH-FIX for source-only candidate**.
- P1 fix 1: bound INSERT now requires v2 domain and valid pending initial state.
- P1 fix 2: bound routing identity (brand/date/post_type/slot) is immutable.
- fix commit: `4468a060d368d6d94c205eba1a86ff58195740e4`.
- fixed behavior/concurrency proof PASS; Phase1D static 7/7; full x-test-post 416/416.
- production mutation=0.
- Production activation remains **NO** until live-definition diff, atomic migration proof, Phase1C prerequisites and staged rollback plan pass.

## K3 result

- Phase1D source-only candidate IMPLEMENTATION PASS.
- Implementation commit: `238247a57287c3bb835b6e2a0ca8ee4a2d910fdf`.
- Disposable PostgreSQL/concurrency proof PASS; focused tests 13/13; x-test-post 416/416.
- Production mutation/deploy/X API calls = 0.
- Final DB/RPC/permission/concurrency acceptance is delegated to H2 using Sol（高）.
- No production activation until C2 review and later live-definition/prerequisite gates pass.

## Phase1E next step

- G3 assigned: `x-autopost-phase1e-exact-account-credential-resolver-20260924`.
- Goal: make `claim.social_account_id` the sole credential-routing authority for future v2 dispatch.
- No brand-only / first-row / hardcoded-account / legacy-token fallback.
- Add a one-request provider seam so a durable provider-start boundary cannot hide a second X create request.
- Source-only; production mutation/X API calls = 0.
- Recommended model: Opus5.5（高）.

## K3 Phase1E result

- Phase1E exact-account credential resolver IMPLEMENTATION PASS.
- implementation commit: `1868cc0e418ebda15ecfdfc88c55c9dd25a471f7`.
- claim.social_account_id is the sole v2 credential-routing authority.
- no brand/first-row/legacy/env/hardcoded-account fallback.
- one-request provider seam prevents hidden second X create after provider-start.
- x-test-post 422/422, _shared 114/114, important-news-monitor 431/431 PASS.
- production mutation/deploy/token refresh/X API calls=0.
- Independent Codex review is assigned to H1 using Sol（高） before Phase1E can be accepted beyond source-candidate status.
- H1/H2 app-owned task records were not overwritten by this X-owner workflow.

## C1 Phase1E result

- H1 verdict: **PASS-WITH-FIX for source-only candidate**.
- reviewed implementation: `1868cc0e418ebda15ecfdfc88c55c9dd25a471f7`.
- H1 fix: `7406c1c60506323400247b6c24162a5da4097419` on PR #22.
- Fixed P1: redirect-follow replay risk after provider-start.
- Fixed P1: Vault-origin P0001 secret/reference leakage.
- Fixed P2: default PUBLIC EXECUTE window during token RPC creation.
- Phase1E 31/31; x-test-post 422/422; _shared 116/116; important-news-monitor 431/431; disposable PostgreSQL PASS.
- production activation remains NO.
- G3 now owns PR #22 fresh-main merge/post-merge verification.
- recommended model: Sonnet5（高）.

## Final K3 PR #22 result

- PASS.
- PR #22 reviewed head `7406c1c60506323400247b6c24162a5da4097419` merged without semantic drift.
- merge commit: `bb297ff5b76ec8d218365d0db6e837bc4357df66`.
- post-merge Phase1B/1D/1E focused/static 44/44 PASS.
- x-test-post 422/422; _shared 116/116; important-news-monitor 431/431; disposable Phase1E PASS.
- live dispatcher and legacy credential paths unchanged.
- production mutation=0 excluding normal GitHub merge.
- Phase1E remains source-only; production activation is not authorized.
- G3 advanced to Phase1F atomic completion/provider outcome model.
- recommended model: Opus5.5（高）.

## K3 Phase1F result

- Phase1F IMPLEMENTATION PASS.
- implementation commit: `0b752925b28b1b922b94a4cb7629ee942f82120f`.
- durable x_rejected terminal outcome added.
- atomic typed completions implemented for interaction/useful_tip/morning_report/close_report/us_premarket_report.
- tip/morning_greeting/brand_post remain v2-disabled.
- provider-step ledger foundation and execution-log observability added.
- focused 55/55; x-test-post 429/429; _shared 120/120; important-news-monitor 431/431 PASS.
- disposable PostgreSQL behavior/race PASS.
- production mutation/X API calls=0.
- H1 final review assigned with Sol（高）.
- production activation remains NO.

## H1 Phase1F final review

- Source-only verdict: **PASS-WITH-FIX**, pending C1 review of PR #25 (`b3740cc7c39010f02ad3505721a5b37d2e707dba`).
- Fixed direct API-role `scheduled_posts` DML bypass, invalid provider-step kind/first-step sequencing, and late unfinished-step mutation after terminal attempt.
- Focused 55/55 and related Deno 980/980; disposable PostgreSQL Phase1D/1E/1F behavior and race proofs PASS.
- No production apply/deploy, token, Cron, or X API mutation. Production activation remains **NO**; live ACL/definition preflight and ordered rollout require separate authorization.

## C1 Phase1F result

- H1 verdict: **PASS-WITH-FIX for source-only candidate**.
- reviewed implementation: `0b752925b28b1b922b94a4cb7629ee942f82120f`.
- H1 fix/reviewed head: `b3740cc7c39010f02ad3505721a5b37d2e707dba` on PR #25.
- Fixed P1 direct scheduled_posts API-role DML bypass.
- Fixed P2 provider-step first-kind/order/reply-parent integrity.
- Fixed P2 late unfinished-step mutation after terminal attempt.
- focused 55/55; x-test-post/_shared/important-news-monitor 980/980; disposable Phase1D/E/F proofs PASS.
- production activation remains NO.
- G3 now owns PR #25 fresh-main merge/post-merge verification.
- recommended model: Sonnet5（高）.

## Final K3 PR #25 result

- PASS.
- PR #25 reviewed head `b3740cc7c39010f02ad3505721a5b37d2e707dba` merged without semantic drift.
- merge commit: `b2fdc1f58114eac55b3f31a1f781e3c555558cf4`.
- focused Phase1B/1D/1E/1F 55/55 PASS.
- x-test-post 429/429; _shared 120/120; important-news-monitor 431/431 PASS.
- disposable Phase1D/E/F behavior/race PASS.
- live dispatcher/producers remain unwired.
- production mutation=0 excluding normal GitHub merge.
- G3 advanced to Phase1G tip-thread + morning_greeting multi-step completion.
- recommended model: Opus5.5（高）.

## K3 Phase1G result

- Phase1G IMPLEMENTATION PASS.
- implementation commit: `e0f7785`.
- tip thread and morning_greeting now have source-ready multistep completion contracts.
- tip preserves all thread part X ids and enforces reply chaining/part count.
- greeting enforces media_upload -> create_post and attempt-bound publish_claim lifecycle.
- brand_post remains disabled.
- focused 72/72; x-test-post 437/437; _shared 129/129; important-news-monitor 431/431; greeting/tip-specific 138/138 PASS.
- disposable PostgreSQL behavior/race PASS.
- production mutation/X API/media calls=0.
- H1 final review assigned with Sol（高）.
- production activation remains NO.

## H1 Phase1G final review

- Source-only verdict: **PASS-WITH-FIX**, pending C1 review of PR #27 (`5a62af547dbc840c1f7b140d6d51d8876c1a7223`).
- Fixed stale prior-day morning-greeting claim/provider-step authorization using the execution day's JST date. The failure was reproduced first in a disposable database; Phase1F already guards non-reply parent IDs by CHECK constraint.
- Focused 72/72; related Deno 997/997; greeting/tip 138/138; disposable PostgreSQL Phase1D/1E/1F/1G behavior/race proofs PASS.
- Production migration, deploy, token/Cron, X API/media calls: **0**. Production activation remains **NO**; live schema/grant/read-back and ordered rollout need separate review/approval.

## C1 Phase1G result

- H1 verdict: **PASS-WITH-FIX for source-only candidate**.
- reviewed implementation: `e0f7785`.
- H1 fix/reviewed head: `5a62af547dbc840c1f7b140d6d51d8876c1a7223` on PR #27.
- Fixed P1 stale prior-day morning_greeting claim/provider-step authorization via current-JST checks.
- Fixed P3 duplicate confirmed thread IDs in the next-action helper.
- focused 72/72; x-test-post/_shared/important-news-monitor 997/997; greeting/tip 138/138; disposable Phase1D/E/F/G proofs PASS.
- production activation remains NO.
- G3 now owns PR #27 fresh-main merge/post-merge verification.
- recommended model: Sonnet5（高）.

## Final K3 PR #27 result

- PASS.
- PR #27 reviewed head `5a62af547dbc840c1f7b140d6d51d8876c1a7223` merged without semantic drift.
- merge commit: `3b33321d474946d1da117c647cdc3691e5618a3d`.
- focused Phase1B/1D/1E/1F/1G 72/72 PASS.
- x-test-post 437/437; _shared 129/129; important-news-monitor 431/431; greeting/tip 138/138 PASS.
- disposable Phase1D/E/F/G behavior/race PASS.
- live dispatcher, greeting publisher and producers remain unwired.
- production mutation=0 excluding normal GitHub merge.
- G3 advanced to Phase1H gated-OFF v2 dispatcher source candidate.
- recommended model: Opus5.5（高）.

## K3 Phase1H result

- Phase1H IMPLEMENTATION PASS.
- implementation commit: `59bd54412eae989400b6ce7e9ecb56dc943db94f`.
- hard OFF server gate added; live legacy dispatcher remains untouched.
- source-only v2 dispatcher composes Phase1D claim, Phase1E exact-account credential/provider, and Phase1F/1G ledger/completions.
- restart-safe tip/greeting and confirmed-incomplete resume paths implemented.
- interaction remains disabled pending poll-capable seam; brand_post remains disabled.
- focused Phase1B–1H 99/99; x-test-post 464/464; _shared 129/129; important-news-monitor 431/431; greeting/tip 138/138 PASS.
- disposable Phase1H behavior PASS.
- production mutation/X API calls=0.
- H1 final review assigned with Sol（高）.
- production activation remains NO.

## K4 Netlify result

- Final K4 PASS for repository-side Netlify Deploy Preview preparation.
- implementation commit: `12b994e00a4f7ae83076e6c9c44a09d339cebb9d`.
- dedicated remote branch: `admin-netlify-deploy-preview-phase2-20260924`.
- apps/admin source semantics unchanged; config/docs only.
- Vercel/production/DB/DNS mutation=0.
- Live Netlify site creation and `proxy.ts` runtime QA are still pending interactive account authorization.

## C1 Phase1H result

- H1 verdict: **PASS-WITH-FIX for source-only candidate**.
- reviewed implementation: `59bd54412eae989400b6ce7e9ecb56dc943db94f`.
- H1 fix/reviewed head: `ce60d7a29022956d049521ffaeb533a749152a60` on PR #28.
- Fixed P2 pre-X result/ledger divergence at attempt cap.
- Settle write failure/malformed RPC response now blocks for manual reconciliation instead of reporting false durable state.
- focused Phase1B–1H 102/102; x-test-post 467/467; _shared 129/129; important-news-monitor 431/431; greeting/tip 138/138 PASS.
- production activation remains NO.
- G3 now owns PR #28 fresh-main merge/post-merge verification.
- recommended model: Sonnet5（高）.

## Final K3 PR #28 result

- PASS.
- PR #28 reviewed head `ce60d7a29022956d049521ffaeb533a749152a60` merged without semantic drift.
- merge commit: `d1fa8a3bbc8ba7c8bab3725573e0cd6a5a3890f3`.
- focused Phase1B–1H 102/102 PASS.
- x-test-post 467/467; _shared 129/129; important-news-monitor 450/450; greeting/tip 138/138 PASS.
- disposable Phase1H behavior PASS.
- live legacy dispatcher remains unchanged; v2 gate remains unwired/OFF.
- production mutation=0 excluding normal GitHub merge.
- G3 advanced to Phase1I exact-account pre-X refresh writer.
- recommended model: Opus5.5（高）.

## G4 Netlify live preview continuation

- assigned: `x-admin-netlify-live-site-preview-qa-20260925`.
- goal: connect/create the real Netlify admin site and validate first Deploy Preview.
- preferred QA target: PR #15, without merge.
- primary unresolved technical gate: Next.js 16 `src/proxy.ts` session refresh behavior on Netlify runtime.
- Netlify development/preview configuration is allowed; Vercel production, DNS cutover, production DB/Auth/X mutation remain forbidden.
- if interactive Netlify authorization is required, G4 must stop and report the exact one-time user action.
- recommended model: Sonnet5（高）.

## Final K4 Netlify live-site result

- SAFE STOP / USER ACTION REQUIRED.
- no authorized Netlify session/integration was available.
- Netlify site creation requires one-time human account/repository authorization.
- main apps/admin local regression 12/12 PASS.
- PR #15 scoped regression 31/31 PASS.
- TypeScript/lint/build/diff/secret scan PASS.
- PR #15 remains unmerged at `b04442561d9e9c6d01b4a9fcf640c2cf731cd923`.
- production mutation=0; Netlify mutation=0.
- required user step: create/connect the Netlify site for `anohi-memories/kabumori`, base `apps/admin`, and set only the two public Supabase env vars.
- after that, G4 can resume with live Deploy Preview + proxy/auth/PR#15 QA.
- recommended continuation model: Sonnet5（高）.

## G4 Netlify blocker resolved

- user completed Netlify account/site connection for `anohi-memories/kabumori`.
- site UI showed `shiny-kheer-77a154`.
- base directory `apps/admin`, public Supabase env names configured.
- initial deploy detected Next.js 16.3.4 but Runtime was unset and produced 0 functions, causing valid dynamic routes to 404.
- user set Netlify Runtime = Next.js and redeployed without cache.
- live `/login` now renders Kabumori Admin successfully.
- prior interactive authorization/runtime blocker is resolved.
- G4 now owns PR #15 real Deploy Preview + proxy/auth/selector boundary QA.
- PR #15 merge and Vercel production remain forbidden.
- recommended model: Sonnet5（高）.

## Final K4 PR #15 Netlify QA result

- classification: **SAFE_STOP_OPERATOR_ACTION**.
- PR #15 remains open/unmerged at `b04442561d9e9c6d01b4a9fcf640c2cf731cd923`.
- main apps/admin tests 12/12 PASS; PR #15 tests 31/31 PASS.
- TypeScript/lint/build PASS; secret scan clean.
- live QA blocked by Netlify Team protection in Claude session.
- PR #15 has no Deploy Preview because it predates the Netlify site.
- source-neutral freshen merge was proven conflict-free locally but not pushed.
- no Netlify preview mutation; production mutation=0.
- next user actions: remove/adjust Netlify Team protection for QA and retrigger/update PR #15 so Netlify creates a Deploy Preview.
- after that, resume G4 live proxy/auth/selector QA.
- recommended continuation model: Sonnet5（高）.

## Final K3 Phase1I result

- result: **PASS for source-only implementation**.
- implementation: `12e9fd1`.
- exact-account pre-X refresh writer completed with no fallback to brand-first/first-row/env/legacy token paths.
- one-request OAuth refresh seam, Vault-bound exact-account write model, uncertain-result fail-closed behavior, and concurrency lease model implemented.
- focused Phase1B–1I 124/124; x-test-post 477/477; _shared 141/141; important-news-monitor 451/451; greeting/tip 138/138 PASS.
- disposable PostgreSQL Phase1I behavior/race and prior-phase proofs PASS.
- production migration/apply/deploy/token refresh/Vault mutation/X API calls = 0.
- production activation remains NO.
- H1 assigned final OAuth/Vault/concurrency/ACL review.
- recommended model: Sol（高）.

## Final K4 PR #15 live Preview result

- result: **PASS / PREVIEW_QA_PASS_AUTH_BLOCKED**.
- PR #15 head `a8f98444425c25796e9fef611445b0f574120669` is tree-identical to prior semantic head.
- Netlify Deploy Preview SUCCESS on the exact head.
- /login renders; unauthenticated /, /posts and /important-news redirect once to /login.
- tampered session cookie also fails closed.
- no redirect loop, 404 or 5xx; Next.js Runtime active.
- PR #15 source regression 31/31; tsc/lint/build PASS.
- production mutation=0; PR #15 remains unmerged.
- authenticated selector/session QA remains unavailable due lack of authorized session.
- H2 assigned independent auth/authorization/cross-brand final review before merge.
- recommended model: Sol（高）.

## Known issues / observations

- Phase1B account-bound queue foundationはC2 PASS済み。
- Phase1B migration単独適用禁止。
- old dispatcherのまま `claim_due_post_v2` 有効化禁止。
- legacy pending rowsの暗黙account backfill禁止。
- Phase1Cは安全停止C2 PASS。Phase1DはG3。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASK/Reportが正本。索引やCURRENT_STATEと矛盾する場合はTASK/Reportを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。

## G4 PR #33 continuation — Admin password recovery/invite

- assigned: `x-admin-pr33-rebase-stabilize-auth-review-prep-20260925`.
- PR #33 is open at head `dd66921a1578d6b54e707e5dce81eaa6ab1701af`, 5 commits / 11 files, currently `mergeable=false` / `dirty` against fresh main.
- goal: resolve main drift/conflicts while preserving PR #15 multibrand/Admin behavior and all password-recovery security invariants, rerun full Admin/Auth tests, and obtain an updated Netlify Preview candidate.
- this task does not merge PR #33 and does not mutate production Supabase Auth config/users, DB/RLS/RPC, Vercel production, OAuth/Vault/X.
- Auth/security-sensitive; focused Codex review expected after K4.
- recommended Claude model: Opus5.5（高）.

## Final C1 universal OAuth refresh review

- verdict: **PASS-WITH-FIX accepted for source candidate**.
- H1 reviewed G3 implementation `acbac42`; fixed head `7309805953b4e4ec9763377a0a02093065da8c82` in PR #37.
- H1 fixed one P2: Vault-backed X create requests now use manual redirect handling so 307/308 cannot silently replay a POST.
- exact-account/Vault, one-refresh/one-safe-retry, fail-closed uncertainty/reauth semantics and core/Phase1I concurrency proofs accepted.
- production activation remains NO; Stage 0 is partial and Stage 1/2 need separate production approval and read-back gates.
- G3 assigned PR #37 fresh-main merge + post-merge source verification only.
- recommended Claude model: Sonnet5（高）.

## Final K4 PR #33 stabilization

- verdict: **PASS**.
- PR #33 final candidate `e6b93be` is MERGEABLE after fresh-main integration.
- only conflict was Netlify comment-only overlap; main runtime config preserved.
- Admin/Auth tests 73/73 PASS; tsc/lint/build/diff/secret scan PASS; PR #15 multibrand/Admin regression PASS.
- Netlify Deploy Preview PASS.
- production mutation=0.
- H1 assigned focused final Auth/security review before merge.
- recommended Codex model: Sol（高）.

## Final K3 PR #37 merge/post-verify

- verdict: **PASS**.
- reviewed head `7309805953b4e4ec9763377a0a02093065da8c82` merged -> `777997a13c39c12ba409a0c6dc95cad18360038a` with no semantic drift.
- x-test-post 501/501; _shared 141/141; disposable core/Phase1I behavior-race-cleanup proofs PASS.
- Kabumori legacy token path unchanged.
- production mutation=0.
- G3 closed. Stage 0/1/2 production rollout remains separately gated and requires explicit approval/new TASK.

## G3 universal OAuth refresh production Stage 0–2

- user authorized proceeding on 2026-09-26 JST.
- assigned: `x-universal-oauth-refresh-production-stage0-2-20260926`.
- scope: Stage 0 read-only preflight -> Stage 1 reviewed core migration + reviewed x-test-post deploy with gate OFF -> Stage 2 one controlled AI Lab recovery.
- generic Stage 3/4 enablement, bulk replay, Kabumori credential migration, Admin PR #33, and important-news/common-search are excluded.
- any invalid-grant, uncertainty, deadlock, lease/account mismatch, persistence failure, second 401, duplicate provider request, or cross-account effect requires gate OFF and immediate stop.
- recommended Claude model: Opus5.5（高）.

## C1 PR #33 Auth review FAIL

- verdict: **FAIL accepted** at PR #33 head `e6b93beccfb9209dbe640fb9ea1464f2568f3c74`.
- blocker 1: generic `otp` / `magiclink` AMR was incorrectly accepted as reset authority.
- blocker 2: 15-minute freshness was checked only at render, not immediately before password update.
- blocker 3: signOut failure could still be reported as successful reset/logout.
- PR #33 must not merge at this head.
- G4 assigned narrow fixes for all three findings.
- after fixes, one bounded real recovery + invite E2E is required before merge to verify actual AMR/session/logout behavior.
- recommended Claude model: Opus5.5（高）.

## Final K4 PR #33 auth fix round2

- verdict: **PASS**.
- PR #33 head `2528b5686bcbb3630fb636cec12162803f921f8f`.
- generic otp/magiclink denied; submit-time recovery freshness reverified server-side; signOut failures no longer reported as completed logout.
- apps/admin tests 83/83 PASS; tsc/lint/build/diff/secret scan PASS; PR #15 Admin/multibrand regression PASS.
- Netlify Preview PASS; production mutation=0.
- H1 assigned focused re-review before bounded real recovery/invite E2E.
- recommended Codex model: Sol（高）.

## Final C1 PR #33 round2 source review

- verdict: **PASS for source readiness to bounded real E2E**.
- reviewed PR #33 head `2528b5686bcbb3630fb636cec12162803f921f8f`.
- all three prior findings fixed: generic otp/magiclink denied, submit-time freshness revalidated server-side, signOut failure no longer reported as confirmed logout.
- tests 83/83 PASS; tsc/lint/build/diff/secret scan PASS; Admin/multibrand regression PASS.
- production mutation=0.
- PR #33 remains unmerged.
- merge remains blocked on one bounded real recovery flow + one invite flow and operator verification of Redirect URL/template/SMTP/session behavior.
- real E2E/Auth config mutation requires separate user authorization.

## G4 PR #33 bounded real Auth E2E

- user explicitly authorized proceeding after C1 source PASS.
- assigned: `x-admin-pr33-bounded-real-auth-e2e-20260926`.
- scope: exact Preview callback allowlist if needed, one disposable recovery flow, one disposable invite flow, actual AMR/session/logout/non-admin denial verification, cleanup/restore afterward.
- no real operator/Admin account changes, no admin_users grant, no wildcard redirect, no shared Reset Password template change, no PR merge or Vercel production deploy.
- if safe disposable/test accounts or email access require user interaction, G4 must stop and request only that exact action.
- recommended Claude model: Opus5.5（高）.

## Final K4 PR #33 bounded real Auth E2E

- verdict: **SAFE STOP / OPERATOR GATE**.
- PR #33 head `2528b5686bcbb3630fb636cec12162803f921f8f` remains source-reviewed and mergeable, but not merge-approved.
- one real recovery request reached Supabase Auth (HTTP 200 generic response), but email was not delivered because custom SMTP is not configured; project still uses Supabase default mail delivery.
- invite E2E is blocked by the same mail/template limitation.
- actual recovery/invite AMR, password update, logout/relogin and non-admin denial remain unverified in real E2E.
- production/config mutation by Claude=0; operator created one test-only Auth user, not in admin_users.
- Preview callback URL already existed; no wildcard added; mobile redirect and Reset Password template unchanged.
- next prerequisite: custom SMTP setup in a separate task, then resume bounded recovery+invite E2E.

## G4 PR #33 Auth E2E resume after SMTP

- user saved temporary Gmail Custom SMTP in Supabase on 2026-09-26 JST.
- G4 assigned to resume the previously blocked bounded real recovery + invite E2E only.
- PR #33 remains unmerged; merge waits for K4 E2E result.
- no real Admin account, admin_users grant, wildcard redirect, shared Reset Password template change, or Vercel production deploy is authorized.
- recommended Claude model: Opus5.5（高）.

## G4 PR #33 invite OTP purpose binding

- bounded real E2E observed Supabase invite token_hash flow establishing `amr.method=otp`.
- recovery E2E passed; invite setup correctly failed closed under the current recovery/invite-only AMR gate.
- generic otp must remain denied.
- G4 assigned to implement a short-lived signed httpOnly invite-purpose binding issued only after successful server-side `verifyOtp(type=invite)`, bound to the same authenticated user and existing 15-minute window.
- successful password setup must clear the marker; forged/expired/mismatched markers fail closed.
- PR #33 remains unmerged pending source fix, focused H1 review, and one more bounded invite E2E.
- recommended Claude model: Opus5.5（高）.

## Final K4 PR #33 invite purpose binding

- verdict: **PASS for source/tests; OPERATOR GATE before invite E2E**.
- PR #33 head `0cc48fe3ac1c376d747a74b6b31ea34990615805` is OPEN/MERGEABLE.
- secure signed httpOnly invite-purpose binding implemented for real invite `amr=otp`; generic OTP/magiclink remain denied.
- tests 103/103 PASS; tsc/lint/build/diff/secret scan PASS; Netlify Preview build SUCCESS.
- no intermediate Codex review will be scheduled; reduced-review policy/user direction is to complete real invite E2E first and bundle final review at the release boundary if needed.
- operator action required: set server-only Netlify Deploy Preview env `ADMIN_INVITE_BINDING_SECRET` to a random >=32-byte value, Functions scope, then rebuild Preview.
- after that, G4 should resume one bounded invite E2E; PR remains unmerged.

## Final K3 universal OAuth refresh production rollout

- verdict: **PASS-WITH-DEVIATION**.
- Stage 0/1/2 all passed; x-test-post v121 live, core refresh migration applied, AI Lab refresh path proven in production.
- AI Lab scheduled posts 08:27 / 09:09 / 11:29 JST all succeeded; refresh gen 0→1 then 1→2, with no uncertain/reauth/second-401/deadlock/lease/commit failures.
- Kabumori legacy token path and other account credentials remained unchanged.
- accepted deviation: monitoring parser failure delayed gate-OFF, so 09:09 also ran with gate ON; no extra refresh/replay/duplicate/cross-account effect occurred.
- user explicitly turned gate ON again for continued operation; current gate remains ON and AI Lab is recovered.
- generic Stage 3/4 rollout remains unapproved.
- migration-history debt remains: core SQL is live but not recorded in `supabase_migrations.schema_migrations`; no blind push/repair.

## G3 Universal OAuth Refresh Stage 3A

- assigned: `x-universal-oauth-refresh-stage3a-rollout-foundation-20260926`.
- purpose: promote the AI Lab-proven universal OAuth refresh into an account-scoped rollout foundation suitable for future all-user operation.
- Stage 3A is source-first: explicit OFF/PILOT/ENABLED account authority, centralized eligibility contract, reauth state, non-secret observability, stuck-refresh detection, and a migration-history-safe deployment plan.
- the current global gate alone must not authorize newly eligible accounts.
- no additional production X account activation, production migration apply, production Edge deploy, bulk Vault migration, or Kabumori credential migration is authorized in Stage 3A.
- existing core migration-history debt must be inspected but not blindly repaired/pushed.
- after K3, expected next phases are Stage 3B controlled second-account pilot -> Stage 3C multi-account pilot -> Stage 4 general rollout.
- recommended Claude model: Opus5.5（高）.

## Final K3 Stage 3A rollout foundation

- verdict: **PASS for source-first implementation**.
- PR #38 head `050d62f` adds exact-account OFF/PILOT/ENABLED rollout authority, pre-Vault eligibility gating, exact-account reauth semantics, non-secret health observability, and migration-history-safe deployment planning.
- production mutation=0; Kabumori legacy path unchanged.
- migration-history debt remains isolated; no blind db push/repair.
- because Stage 3A introduces rollout authority + SECURITY DEFINER/RPC ACLs + grandfathering + a production migration path, H1 receives one final release-boundary review before production apply. No intermediate review loop is planned.
- recommended Codex model: Sol（高）.

## Final C1 Stage 3A rollout review

- verdict: **PASS-WITH-FIX**.
- reviewed PR #38 `050d62f`; fixed head `748deb13a934129e5696ab5552401f547204b32c` pushed.
- P2 fixed: unexpected proactive refresh-start failures can no longer fall through to X create with a still-valid token; only expected rollout refusal / in-progress outcomes may continue.
- rollout modes, pre-Vault exact-account authority, service_role-only mutation ACLs, grandfathering, reauth, stuck-lease behavior, non-secret health observability and migration-history safeguards accepted.
- disposable DB tests + 655 Deno tests PASS; production mutation=0.
- next: separate explicit authorization for Stage 3A production apply. Apply only migration `20260926032054`, recheck exact grandfather set immediately before apply, read back all ACL/function/table/rollout state, and stop on any unexpected delta. Edge deploy/refresh observation remains a later gated step.

## G3 Stage 3A production apply

- user approved assigning the narrow production-apply step on 2026-09-26 JST.
- assigned: `x-universal-oauth-refresh-stage3a-production-apply-20260926`.
- reviewed/fixed PR #38 head: `748deb13a934129e5696ab5552401f547204b32c`.
- scope is limited to read-only preflight -> apply only migration `20260926032054_x_account_refresh_rollout_authority.sql` -> full ACL/function/rollout/grandfather read-back.
- exact grandfather set must be rechecked immediately before apply and equal one proven AI Lab account; any discrepancy is a hard stop.
- no Edge deploy, env change, token refresh, X post, second-account rollout, migration repair, db push, historical batch apply, or Kabumori credential migration is authorized.
- recommended Claude model: Opus5.5（高）.

## Final K3 Stage 3A production apply

- verdict: **PASS**.
- production applied only migration `20260926032054_x_account_refresh_rollout_authority.sql` from reviewed PR #38 fixed head `748deb1`.
- grandfather candidate preflight was exactly one proven AI Lab account; post-apply rollout table contains exactly that account as `enabled` and no other pilot/enabled rows.
- RLS/ACL/owner/search_path/SECURITY DEFINER/function-definition read-back PASS; no anon/authenticated privilege expansion.
- Kabumori remains on legacy non-Vault path; other account states unchanged.
- advisor delta attributable to Stage 3A = 0.
- Edge deploy/env/token refresh/X post = 0; migration repair/db push = 0.
- migration history debt remains unnormalized by design.
- next: merge reviewed PR #38, deploy Stage 3A x-test-post source, then observe one natural AI Lab token-expiry cycle. No extra Codex review unless new semantic changes appear.

## G3 Stage 3A merge + Edge + natural observation

- user approved proceeding on 2026-09-26 JST.
- assigned: `x-universal-oauth-refresh-stage3a-merge-edge-observe-20260926`.
- scope: verify and merge PR #38 fixed head `748deb1` -> deploy only `x-test-post` from merged main -> verify deployed source -> observe one natural AI Lab token-expiry/refresh cycle.
- Stage 3A DB authority layer is already live and must not be reapplied; migration repair/db push remain forbidden.
- no manual refresh/X post, no rollout-row changes, no second account pilot, no Kabumori credential migration.
- if a natural expiry cycle cannot be observed safely in the available window, stop with OBSERVATION_PENDING rather than forcing it.
- no additional Codex review unless new semantic changes appear.
- recommended Claude model: Opus5.5（高）.


## Final K3 Stage 3A fully live

- verdict: **PASS**.
- PR #38 merged -> `6717b1fe451db83f80e837bf8104268a2b00423d`.
- production x-test-post v125 deployed from merged main; source byte-identical, verify_jwt=false preserved.
- rollout rows remain AI Lab only enabled.
- natural AI Lab scheduled post at 2026-09-27 07:49 JST triggered proactive refresh: generation 6->7, refresh once, post succeeded, no duplicate/second401/uncertain/reauth/stuck state.
- cross-account check PASS; Kabumori legacy path unchanged.
- Stage 3A is fully proven in production across DB authority, Edge runtime and one natural token-expiry cycle.
- next phase: Stage 3B controlled second-account pilot; migration-history normalization remains separate.


## Future backlog — user ideas (not assigned)

User requested these ideas be remembered for later implementation; **do not start yet**.

- ニュース内容の充実
- かぶモリXで投稿しているような話題を扱う「トピック」コーナーの新設
- アプリ内の設定画面から通知内容・通知カテゴリを変更できるようにする
- ニュース一覧／記事にサムネイル画像を付ける

Status: backlog only / no G1-G2 task assigned.

## G3 Stage 3B second-account pilot prep

- assigned: `x-universal-oauth-refresh-stage3b-second-account-pilot-prep-20260927`.
- Stage 3A is fully live and proven; next work prepares a controlled second-account pilot.
- scope is source/plan-first: identify one exact candidate, generalize/prove account-bound publish/content routing, test pilot mode isolation, and produce exact activation/observation/rollback procedure.
- no second account production activation, rollout-row mutation, publish_enabled change, Edge deploy, production migration apply, manual refresh/X post, migration repair or db push is authorized.
- if no unambiguous second account exists, candidate selection remains an operator gate rather than being guessed.
- recommended Claude model: Opus5.5（高）.


## Final K3 Stage 3B pilot prep

- verdict: **PASS for source/plan preparation; production activation remains gated**.
- PR #41 head `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`.
- exact second-account candidate identified read-only: `sa_bfdab0e0696ec8e56ed2dd83` / `yumeyoasobi`; rollout remains off, publish disabled, no production mutation.
- new generic account-bound brand_post path reuses existing VaultAccountXAuth and Stage 3A authority; AI Lab and Kabumori behavior unchanged.
- new service_role-only SECURITY DEFINER completion RPC added; disposable DB/race/isolation tests PASS.
- candidate remains owner/product-gated: explicit owner consent and content-settings contract are prerequisites before activation.
- one final H1 review assigned because the change crosses multi-account publish isolation + SECURITY DEFINER/RPC boundary.
- recommended Codex model: Sol（高）.


## G4 PR #33 invite E2E after binding secret

- user configured sensitive Netlify env `ADMIN_INVITE_BINDING_SECRET` and retried Deploy Preview #33 on 2026-09-27 JST.
- assigned: `x-admin-pr33-bounded-invite-e2e-after-binding-secret-20260927`.
- scope: verify rebuilt PR #33 Preview -> one disposable invite -> confirm real AMR=otp + same-user/session signed purpose binding -> password setup -> cookie clear -> logout/relogin -> non-admin denial -> cleanup.
- cookie/secret/token/password values must never be logged or reported.
- temporary Invite User template adjustment is allowed only if needed and must be restored; Reset Password template/mobile redirect/admin_users remain untouched.
- PR merge and Vercel production deploy are not authorized in this task.
- recommended Claude model: Opus5.5（高）.


## Final C1 Stage 3B review

- verdict: **FAIL**.
- PR #41 reviewed head `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`.
- P1 design blocker: Stage 3A rollout controls refresh, not publish. A valid token could still post after pilot expiry/off/refresh ceiling. Stage 3B requires a separate exact-account publish authority/timebox checked at publish boundary, with fail-closed expiry/revocation.
- P2 blocker: generic completion RPC accepts AI Lab's own matching row/account and must explicitly exclude AI Lab.
- exact-account/ACL/refresh-race boundaries otherwise acceptable; production mutation=0.
- G3 reassigned source-only correction; no production pilot/merge until fixed and re-reviewed.
- recommended Claude model: Opus5.5（高）.


## Final K3 Stage 3B publish authority fix

- verdict: **PASS for source correction**.
- PR #41 fixed head `6b25305e57bb1d6ad119c06c779042daba210547`.
- explicit exact-account publish authority/timebox added separately from refresh rollout.
- valid-token posts are blocked by missing/off/revoked/not-started/expired publish authority and by consent/admin/account gates; authority is checked again immediately before X create.
- rollback publish-authority `revoked` alone is sufficient to stop subsequent new X creates.
- AI Lab/Kabumori are explicitly excluded from generic setter/check/dispatcher/completion path; matching AI Lab regression now fails closed with no side effects.
- Stage 3A refresh and AI Lab/Kabumori specialized paths remain unchanged; production mutation=0.
- one focused H1 re-review assigned for prior P1/P2 + atomicity only.
- recommended Codex model: Sol（高）.


## Final K4 PR #33 product scope correction

- technical invite E2E: PASS at PR #33 `0cc48fe`.
- product correction: this Admin is an internal operator site for one owner/two accounts; there is no intended invited-user workflow, and non-admin invitees cannot access Admin because `admin_users` remains authoritative.
- actual requirement is owner password recovery only.
- do not configure production invite secret/template/redirects for this Admin.
- before merge, PR #33 should be treated as recovery-only; invite-specific code is unnecessary complexity and should be removed or intentionally left disabled only if removal cost is judged higher.
- Preview-only `ADMIN_INVITE_BINDING_SECRET` can be deleted after the PR decision.

## H1 PR #41 focused re-review

- verdict: PASS-WITH-FIX for source; fixed head `59f4f53`; previous candidate `6b25305`.
- separate publish authority and 30-day maximum window fail closed for no row/off/revoked/not-started/expired, consent/admin/account disables and exact account mismatch. Stage 3A refresh ceiling remains refresh-only. Rollback `revoked` blocks subsequent X creates at the next check; one already in-flight create may cross the commit boundary.
- matching AI Lab row/account is rejected by generic completion without fingerprint/log/status write; AI Lab and Kabumori specialized routes unchanged.
- H1 fixed final-check gap across proactive/reactive token refresh; PR #41 updated, but no merge, migration, deploy, real token refresh or X post. Owner consent, content-settings contract and separately authorized pilot remain pending. See `.agent/CODEX_REPORT.md`; C1 required.


## Final C1 Stage 3B focused re-review

- verdict: **PASS-WITH-FIX for source readiness**.
- PR #41 final reviewed/fixed head `59f4f53037f231e831774c04e9a1b1982eff3bd9`.
- publish authority/timebox and AI Lab exclusion are accepted.
- H1 fixed one additional revocation gap by rechecking publish authority immediately before each actual X create, including post-refresh retry paths.
- Deno 619/0 plus focused disposable DB behavior/ACL/race tests PASS; production mutation=0.
- no merge/apply/deploy/second-account production activation occurred.
- current product direction is to pause further infrastructure deepening and prioritize user-facing X auto-post app features; any Stage 3B production pilot should be a separately authorized future task.


## X social-mobile app implementation phase 1

- user explicitly directed pausing deeper Stage 3B/Admin infrastructure work and moving to user-facing app feature implementation.
- G3 assigned: `x-social-mobile-auth-x-connect-onboarding-phase1-20260928`.
  - scope: auth/session/X connect/reauth/onboarding inventory + narrow implementation gaps.
  - must reuse existing OAuth/Vault authority; no Stage 3B production activation.
  - recommended Claude model: Opus5.5（高）.
- G4 assigned: `x-social-mobile-home-posting-settings-ux-phase1-20260928`.
  - scope: Home/posting status/settings/schedule/history/posting UX inventory + narrow user-facing implementation gaps.
  - no fake backend behavior, no production posting.
  - recommended Claude model: Sonnet5（高）.
- G3/G4 must use independent worktrees and stop on file overlap.


## Final K3 social-mobile auth/X-connect/onboarding phase 1

- verdict: **PASS**.
- PR #42 head `c5e0157f867450047a5f79a204df45aaeefecfa6`.
- login -> X connect/reconnect -> verified handle -> minimum settings gate/skip -> Home is now represented as one first-run source journey.
- existing Supabase session and `x-oauth-connect-user` OAuth path are reused; no parallel auth/token path.
- real-data fake-account fallback removed; ambiguous workspace/account state fails closed.
- tests 16/16 plus typecheck/lint/Expo web export PASS; production mutation=0.
- new signup and password recovery remain explicit product decisions.
- per reduced-review policy, no H1 is inserted now; review app-side Phase 1 in a consolidated pass after G4 unless a new high-risk boundary is introduced.


## Final K4 social-mobile Home/posting UX phase 1

- verdict: **PASS**.
- PR #44 head `f0ecc9f984a676acb3a2d4fd522c6219583e06eb`.
- Home now exposes connected account summary, auto-post state, next scheduled post, latest result and clear settings/schedule/history navigation.
- fixed three truthfulness bugs: invalid per-account filtering of real scheduled/history rows, blocked/unavailable falling through to mock preview, and real post detail reading mockRepository only.
- consult confirmation now persists through the existing content-settings repository and preserves already-saved settings instead of merging from defaults.
- no G3-owned provider/auth files changed; no DB/RLS/RPC/migration/production mutation.
- one consolidated H1 review assigned for PR #42 + #44 integration before merge.
- recommended Codex model: Luna（高）.


## Queued G3 next — multi-provider signup/login

Status: queued / do not start before Phase 1 consolidated H1/C1 and PR #42/#44 merge decision.

Planned task:
- X / Apple / Google / Email signup/login
- provider linking / duplicate-account prevention
- X login versus X posting-account connection must remain separate trust/consent steps
- first-workspace creation/onboarding continuation
- password recovery/deep-link design
- no production Auth provider/config changes without separate authorization

Reason for deferral:
- H1 is currently reviewing PR #42 + #44 exact heads and their combined provider/state contract.
- starting auth/signup work now would touch the same auth/onboarding area and could invalidate or duplicate the review.
- after C1, merge/integrate Phase 1 first, then branch the next G3 from the accepted main state.

Recommended Claude model: Opus5.5（高）.


## Final C1 social-mobile Phase 1 consolidated review

- verdict: **PASS-WITH-FIX**.
- accepted heads: PR #42 `c5e0157f867450047a5f79a204df45aaeefecfa6`; PR #44 fixed `966d4123c13c4dcda1799772d262dde5be8cacb8`.
- H1 fixed one P2 status-mapping/history issue in PR #44 and retested the combined tree.
- required merge order: #42 then #44.
- combined checks: social-mobile 16/16, data-view 14/14, typecheck/lint/Expo web export/diff PASS.
- Phase 1 auth/X-connect/onboarding + Home/posting/history source work is accepted and may be closed after merge.
- production DB/config/OAuth/real-account E2E remain separate future gates.
- next G3 after merge: queued multi-provider signup/login (X / Apple / Google / Email), provider linking, duplicate-account prevention, password recovery and first-workspace onboarding.


## G3 social-mobile multi-provider Auth Phase 2

- assigned: `x-social-mobile-multi-provider-auth-phase2-20260928`.
- mandatory first step: integrate accepted Phase 1 in reviewed order PR #42 `c5e0157` -> PR #44 `966d412`, with exact-head/check verification and fresh-main regression.
- after integration, implement source-first X / Apple / Google / Email signup/login.
- X app-auth and X posting-account authorization must remain separate; posting continues through existing `x-oauth-connect-user`/Vault path.
- provider linking and duplicate-account prevention are mandatory.
- password recovery and first-workspace/onboarding continuation are included.
- no production provider enablement, Auth console mutation, DB migration, Stage 3B activation or real X post without separate authorization.
- recommended Claude model: Opus5.5（高）.

## Queued G4 next — posting interaction Phase 2

Status: queued; start after PR #42/#44 are integrated to main to avoid stale-base/provider overlap.

Planned scope:
- draft/post preview
- manual edit
- AI regenerate
- approve
- schedule/post action wiring only where backend contract already exists
- failure reason
- retry
- reconnect-to-X CTA when auth requires it
- schedule/history -> detail -> edit/approve flow
- preserve explicit distinction between manual approval and auto-post
- no production post or publish-authority activation by default

Recommended Claude model: Sonnet5（高）.


## Final K3 social-mobile multi-provider Auth Phase 2

- verdict: **PASS for source implementation**.
- Phase 0 merged accepted Phase 1 in required order:
  - PR #42 -> `f0cac1505184a2abd9c9d504142012a1be999cf3`
  - PR #44 -> `7870d10170d31e0a6b78ab245f4e9152a3628f00`
- Phase 2 PR #47 head `7bda196147a749431774fba915a86d41bf43dc5d`.
- X / Apple / Google / Email signup/login source support implemented.
- email signup/recovery, explicit provider linking, duplicate-account guard and first-workspace/onboarding continuation implemented.
- X app-auth and posting-account OAuth/Vault path remain intentionally separate.
- tests 32/32 + data-view 14/14 + typecheck/lint/Expo web+iOS export PASS.
- production Auth/config/DB/X mutation=0.
- because this changes Auth/provider identity boundaries, one focused H1 review is assigned before merge/provider activation.
- recommended Codex model: Sol（高）.


## Final C1 multi-provider Auth focused review

- verdict: **FAIL**.
- PR #47 reviewed head `7bda196147a749431774fba915a86d41bf43dc5d`; remains unmerged.
- seven executable Auth-boundary failures reproduced:
  1. explicit provider linking rejects Supabase-returned external provider URL.
  2. duplicate callbacks can report false success before/after failed exchange.
  3. native PKCE callback drops `sb_flow_id`, risking wrong verifier selection.
  4. signup UI reintroduces existing-email enumeration through distinct messages.
  5. provider access/refresh credentials can be persisted implicitly in plaintext AsyncStorage by SDK session persistence.
  6. password-recovery mode is not exact-user/session bound and survives incompatible user switch.
  7. callback parser accepts malformed/ambiguous authority/duplicate-conflicting credential params.
- additional gaps: stale onboarding/new-account state across time/user switch; provider/email readiness truthfulness; Apple linking config/path distinction.
- passed boundaries: X app-login remains separate from posting-X; Apple native nonce source contract passed; no service_role/user_metadata authorization/provider-token logging found.
- production_mutation=0.
- G3 reassigned one bundled Auth correction task; recommended Claude model Opus5.5（高）.
- after K3, use one final focused H1 acceptance pass only.


## Final K3 Auth Phase 2 bundled correction

- verdict: **PASS for source correction**.
- PR #47 fixed head `5fd483a5fc651da07d0791c68eaa557cdb201357`.
- all seven prior H1 Auth findings corrected:
  provider-link URL provenance, duplicate callback truthfulness, flowId PKCE selection, signup enumeration, provider-credential persistence, exact-user/session recovery, strict callback parsing.
- additional corrections: exact-user onboarding/user-switch handling, fail-closed provider readiness, Apple native-vs-browser linking/config distinction.
- provider tokens are stripped from persisted storage/context while Supabase app-session restore remains supported.
- X app-auth remains separate from posting-X/Vault.
- tests 37/37 + data-view 14/14 + typecheck/lint + Expo web/iOS export PASS; mutation tests 11/11 detect guarded regressions.
- production_mutation=0.
- one final focused H1 acceptance review assigned; no further review loop unless it finds a concrete defect.
- recommended Codex model: Sol（高）.
