# Claude Task 1

- task_id: kabumori-release-readiness-gap-closure-20260925
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: かぶモリiOS/TestFlight前の残ブロッカーをfresh mainと実サービスread-onlyで再確認し、コード/設定ファイル側で安全に解消できるものをまとめて解消する。秘密情報・本番Auth mutation・TestFlight uploadは行わない。

## Accepted baseline

Native/app:
- approved icon merged and verified
- PR #31 merge: `7aa394fc1dc73edd0c67b6529923ec4dc9616e7f`
- Expo/iOS icon wiring verified with real prebuild
- splash / AnimatedSplashOverlay remain unchanged and not yet visually accepted

Reports:
- personalized-reports v30 deployed
- app_enabled=false
- x_enabled=false
- report/VOICE work is G2-owned and must not be touched

Web/release:
- Kabumori public Web uses Netlify Preview + Production
- do not use Vercel for Kabumori Web
- legal/public pages already exist in `apps/kabumori-web`
- prior release-readiness work added EAS prod preflight and legal links
- privacy wording was re-audited after report upgrade

## Goal

Produce one authoritative release-readiness pass covering:
1. EAS production env prerequisites
2. public Web/legal/support/account-deletion URLs
3. Supabase Auth Site URL / redirect URL requirements
4. custom SMTP readiness
5. App Store / TestFlight metadata prerequisites
6. native startup assets still pending
7. exact operator-only steps that cannot safely be automated

Fix only safe source/config/documentation gaps discovered during the audit.

## Mandatory startup

1. Independent worktree.
2. Read:
   - PROJECT_RULES.md
   - .agent/ORCHESTRATION.md
   - .agent/CURRENT_STATE.md
   - this TASK
   - prior G1 release-readiness reports
3. Fresh fetch origin/main.
4. Confirm G2 is done and no overlap with personalized-reports.
5. Confirm G4/X/admin scope does not overlap Kabumori public Web/native release scope.
6. Do not reuse stale Vercel assumptions; Kabumori public Web = Netlify.

## A. EAS / Expo production preflight

Read-only inspect:
- `app.json`
- `eas.json`
- env verifier
- package scripts/config

Verify exact required production vars:
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_KABUMORI_WEB_URL`

Confirm:
- production profile exists and is valid
- iOS autoIncrement policy
- bundleIdentifier
- projectId
- scheme
- slug
- app name
- legal URLs resolve through configured web base URL

Do not print secret values.
Only report set/missing/shape-safe status.

If source-side validation is incomplete, fix it with tests.

## B. Kabumori public Web / Netlify

Use the approved architecture:
- Preview + Production = Netlify
- no Vercel for Kabumori Web

Verify source/build for:
- /
- /privacy
- /terms
- /support
- /account-deletion

Confirm:
- links are production-safe
- no stale localhost/Vercel/Kabumori-wrong-domain references
- privacy/terms/support/account deletion wording matches current app/data flow
- no accidental X/admin branding

If Netlify production URL can be identified read-only, record only the public URL.
Do not change DNS or production domain in this task.

If source fixes are required:
- make minimal changes
- add/update tests

## C. Supabase Auth readiness — read-only

Determine current requirements for:
- Site URL
- redirect allowlist
- native deep link `kabumori://reset-password`
- public Web account/legal URLs
- password recovery behavior used by Kabumori app

Do not mutate production Auth settings.

Report exact desired final values/entries, but never expose secrets.

Check whether current repo code expects redirects that are not yet allowlisted.
If source-side redirect handling has a defect, fix source only.
Do not touch X/admin Auth flows.

## D. SMTP readiness — read-only

Determine whether custom SMTP is configured/readiness can be established without revealing credentials.

Report:
- configured / not configured / cannot verify
- exact operator action still required
- which auth emails depend on it

Do not modify SMTP credentials/settings.

## E. App Store / TestFlight readiness

Read-only/source audit:
- app name
- icon
- privacy URLs
- support URL
- account deletion URL
- version/build config
- permission descriptions
- notification permission rationale if applicable
- any remaining Expo template branding/artwork

Identify exact blockers for a first TestFlight build.

Do not:
- run EAS production build
- upload to TestFlight
- mutate App Store Connect
- change credentials
- submit review

## F. Splash / startup artwork

Verify current remaining template/startup artwork:
- native splash config
- AnimatedSplashOverlay
- expo-logo or template remnants

Do not redesign in this task.
Classify:
- must fix before first TestFlight
- can test on device first
- can defer until App Store submission

## Safe fixes allowed

Allowed:
- repo source/config validation
- tests
- legal/public Web copy corrections
- broken internal URLs
- non-secret EAS config validation
- documentation/checklists

Forbidden:
- production Auth mutation
- SMTP mutation
- secret creation/rotation
- EAS credential mutation
- EAS production build
- TestFlight/App Store upload
- DNS change
- DB/schema/RLS/RPC
- personalized-reports
- X/admin/MIC

## Tests

Run relevant:
- app/release tests
- Kabumori web build tests
- src TypeScript
- Expo config
- Expo web export if applicable
- Netlify build for apps/kabumori-web
- secret scan for changed files
- git diff --check

## Output / K1

Report:
- current release readiness table
- READY / SOURCE_FIX_DONE / OPERATOR_ACTION / BLOCKED for each area
- exact safe source changes
- tests
- commit/PR if changed
- public URLs if verified
- missing env names only, never values
- exact Auth redirect/Site URL requirements
- SMTP status
- remaining startup-artwork status
- exact next action needed before first EAS/TestFlight build
- production mutation=0

Do not create a Codex review for ordinary source/config/doc fixes under the reduced-review policy.
If you discover a true auth/security logic change, STOP and report before implementing it.

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.
