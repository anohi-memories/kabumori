# Claude Task 2

- task_id: kabumori-netlify-expo-web-preview-pipeline-20260924
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: かぶモリアプリの開発中テストをVercel制限に依存させないため、Expo Web exportをNetlify Deploy Previewで確認できるテスト環境を構築する。本番配布/iOS実機確認は従来どおり別工程とし、Netlifyをproduction代替にはしない。

## User-approved deployment policy

今後の基本運用:
- 開発中のpreview/test deploy: Netlify
- レビュー完了後の最終production deploy: Vercel（Web対象のみ）
- Expo/iOS native実機・TestFlight確認はNetlifyでは代替しない
- 現在Vercel制限待ちの既存production作業は保留し、Netlify Preview整備を先に進める

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Fresh fetch origin/main
6. Confirm dedicated independent G2 worktree/checkout
7. Inspect G1/H1 current mobile recovery/auth scope and prove no conflicting file ownership
8. Audit root Expo package.json/app.json/eas.json and current web export behavior
9. Audit existing GitHub/Vercel/Netlify configuration before adding anything

STOP if another slot owns the exact same Expo config/workflow files.

## Scope A — determine safe Netlify target

The root Kabumori app is Expo/native-first.

Create the Netlify preview around the supported web output only:
- identify the correct Expo web export/build command from current source
- produce a static or supported web preview artifact suitable for Netlify
- preserve existing native iOS behavior/config
- do not claim Netlify Preview validates native-only behaviors such as push notifications, deep links, SecureStore, native OAuth handoff, TestFlight, or App Store behavior

Document exactly what the web preview can and cannot validate.

## Scope B — Netlify configuration

Prepare the minimal source configuration required for reliable Preview deploys.

Requirements:
- Netlify is preview/test only
- no production DNS/domain cutover
- no Vercel project mutation
- no production Supabase schema/config mutation
- no secrets committed
- use only public/client-safe environment variables in browser bundles
- fail closed if a required server-only secret would otherwise be exposed
- configure SPA/router fallback only if Expo Router web output requires it and prove it does not mask broken routes
- prefer repo-tracked config such as netlify.toml only when justified by the actual build

If Netlify account/site creation requires interactive external authorization, complete all source-side preparation first and clearly report the exact remaining UI step instead of inventing success.

## Scope C — Preview CI behavior

Goal:
- PR/branch changes to Kabumori app can produce a Netlify Deploy Preview without consuming Vercel deploy quota
- preview URL is suitable for browser smoke testing
- production deployment remains a separate final gate

Verify:
- clean install/build
- Expo web export/build succeeds
- generated preview artifact contains expected app entrypoint/assets
- direct navigation / refresh on representative routes does not 404 where routing is expected
- auth/public route boundaries do not accidentally expose secrets

## Scope D — documentation / operating flow

Add concise project documentation describing:

development:
source change -> local tests -> Netlify Preview -> review -> native E2E when required -> final production gate

State explicitly:
- Netlify Preview is not an iPhone build
- Vercel production is not triggered during ordinary preview testing
- sensitive/auth/native changes still require dedicated native E2E and review

## Tests

Run at minimum:
- existing relevant app tests
- npm/typecheck/lint as appropriate
- Expo web export/build
- git diff --check
- secret scan for newly changed config
- local static serving/smoke test of exported web output if feasible

Report exact counts/results.

## Forbidden

- production Vercel deploy
- Vercel plan/config mutation
- production domain/DNS change
- Supabase production schema/RPC/Auth config mutation
- production user/account mutation
- exposing service_role/OAuth/private API secrets to Netlify browser env
- changing native recovery/auth semantics unrelated to making the web preview build
- H1 PR #17 review files unless strictly needed and explicitly proven non-overlapping
- X auto-post/admin work

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- append Report with:
  - fresh main SHA
  - worktree
  - exact changed files
  - Expo web build/export command
  - Netlify config
  - preview deploy result or exact external authorization blocker
  - what the preview validates / does not validate
  - tests/checks with counts
  - secrets/environment safety
  - Vercel production mutation=0
  - remaining manual setup if any
  - next recommendation
- STOP for K2.
