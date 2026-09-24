# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST
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

## Deployment policy — user approved

- X自動投稿・Web管理画面の開発中/PR/テスト用PreviewはNetlifyへ寄せる。
- レビュー完了後の最終production deployのみVercelを使う。
- Vercelのrate limitを通常のX/Web開発・レビュー工程のブロッカーにしない。
- 現在Vercel待ちのPR #15 final gateは一旦保留。
- かぶモリExpo/native本体はVercel制限の主対象ではないため、Netlify Web Preview対応は現時点では進めない。
- かぶモリのiOS実機/TestFlight/native-only機能は従来どおりExpo/EAS/実機で確認する。

## Current slot snapshot

- H1: `ready` — `x-autopost-phase1e-auth-secret-provider-final-review-20260924`
- H2: `done` — `kabumori-pr19-report-detail-portfolio-privacy-final-review-20260924`
- G1: `ready` — `kabumori-release-branding-eas-preflight-20260924`
  - PR #18 merged at reviewed head `6f32776` -> main `a41b306`. Files byte-identical; 108/0 tests, tsc src 0, web export 10 routes, public-site preview+production dry-run builds PASS. Vercel ignored per Netlify hosting policy. Mutation 0.
- G2: `ready` — `kabumori-pr19-merge-postmerge-verify-20260924`
- G3: `done` — `x-autopost-phase1e-exact-account-credential-resolver-20260924`
- G4: `done` — `x-admin-netlify-deploy-preview-pipeline-20260924`

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

## K2 result

- G2 implementation PASS for PR #19 at head `acbc1b6`.
- PR #19 remains open/unmerged.
- 151/0 tests; deno check/lint PASS; no new src TypeScript errors; production mutation=0.
- Codex review required before merge due LLM validation, user-bound morning lookup, and portfolio privacy boundaries.
- H2 has now been assigned the PR #19 review after C2 closed the Phase1D review.

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

## K4 Netlify result

- Final K4 PASS for repository-side Netlify Deploy Preview preparation.
- implementation commit: `12b994e00a4f7ae83076e6c9c44a09d339cebb9d`.
- dedicated remote branch: `admin-netlify-deploy-preview-phase2-20260924`.
- apps/admin source semantics unchanged; config/docs only.
- Vercel/production/DB/DNS mutation=0.
- Live Netlify site creation and `proxy.ts` runtime QA are still pending interactive account authorization.

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
