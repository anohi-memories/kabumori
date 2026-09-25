# Claude Task 1

- task_id: kabumori-release-readiness-gap-closure-20260925
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report — G1 result

- task_id: kabumori-release-readiness-gap-closure-20260925
- result: **audit complete, no code bug found. PR #35 (documentation only) is open and unmerged.** Production mutation = 0.
- fresh main at task start: `83375da`; in_progress control commit `da65931`.
- G2/G4 overlap: none. G2's `personalized-reports` was read (audit only, never edited). G4's admin/Netlify work is a different app (`apps/admin`) and was not touched.

### Release readiness table

| Area | Status | Detail |
| --- | --- | --- |
| A. EAS/Expo production config | **READY (source)**, **OPERATOR_ACTION (remote values)** | `app.json`/`eas.json` valid; `npm run verify-production-env` still correctly enforces the 3 required vars. Whether they're actually set in EAS's remote `production` environment cannot be checked from any session in this environment. |
| B. Public Web (`apps/kabumori-web`) | **READY (source)**, **OPERATOR_ACTION (publish)** | Re-audited; no stale domain/Vercel/admin-branding references; no privacy wording gap. **No Netlify site has ever existed for this app** (new, explicit finding — see below). |
| C. Supabase Auth (Site URL/redirect) | **BLOCKED (read-only)** | No available tool reads live Auth config without extracting a CLI access token, which is refused by policy. Same conclusion as the earlier production-rollout task. |
| D. Custom SMTP | **BLOCKED (read-only)** | Same reason as C. Assumed **not configured**, since the built-in ~2/hour limiter was hit during the real-device E2E; not independently reconfirmed this session. |
| E. App Store/TestFlight metadata | **OPERATOR_ACTION** | Unchanged list (app record, listing name, URLs, App Privacy answers, age rating, metadata, demo account, export compliance, `submit.production`). One new, non-blocking observation below. |
| F. Splash/startup artwork | **BLOCKED (needs artwork)** | Icon is done. Splash background/image and `AnimatedSplashOverlay` are still the Expo template — see reclassification below. |

### A. EAS / Expo production preflight

- `app.json`: `name`/`slug`/`scheme`/`bundleIdentifier`/`icon`/`ios.icon`/`extra.eas.projectId` all correct, all consistent with the Auth redirect and the working recovery deep link (re-verified, unchanged since the icon merge).
- `eas.json`: `build.production.autoIncrement: true`, `cli.appVersionSource: "remote"` — correct modern config for EAS-managed build numbers.
- `scripts/verify-production-env.mjs` still checks exactly `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_KABUMORI_WEB_URL` (names only reported here; no values). Ran it with no env set: correctly fails, naming all three.
- No source gap found. Whether these are actually set as **EAS remote** environment variables is not verifiable from this environment — **OPERATOR_ACTION**, unchanged from prior reports.

### B. Kabumori public Web / Netlify

- Read `apps/kabumori-web/pages/{index,privacy,terms,support,account-deletion}.html` and `layout.html`/`netlify.toml` in full. No `localhost`, Vercel, or wrong-domain reference. No accidental X/admin branding (grepped for "Twitter"/"autopost"/"admin" — none).
- **New, explicit finding:** searched `.agent/CURRENT_STATE.md`'s entire Netlify history — every entry is about `apps/admin` (the X-autopost management web app, G4-owned), which now has its own connected Netlify site. **`apps/kabumori-web` has zero mentions and has never had a Netlify site connected.** The prior doc's "create the Netlify site" line didn't make this distinction explicit; now that one of the two apps' sites is live, the risk of conflating them is real, so it's now stated plainly in `RELEASE_READINESS.md`.
- Privacy dataflow re-checked (see next section).

### C. Supabase Auth readiness — read-only

- The `supabase` CLI has no read subcommand for live Auth config (`supabase config` only has `push`, a write). Reading via the Management API would require extracting a CLI access token, which I did not do, per the same policy the 2026-09-24 production-rollout task followed.
- **Documented requirement (from source, not live-read):** the app expects `kabumori://reset-password` in the redirect allowlist (already confirmed working end-to-end on a real device in an earlier task) and a reachable Site URL for the signup-confirmation link (currently unreachable — a known, previously reported issue, unchanged).
- No mutation attempted. Status: **BLOCKED (read-only)**, not silently skipped.

### D. SMTP readiness — read-only

- Same tooling limitation as C. No dashboard or Management API access is available in this environment to check configured/not-configured.
- Best available evidence: the built-in Supabase email sender's ~2/hour limit was actually hit during the real-device Auth E2E task, which is consistent with custom SMTP still being unconfigured, but that is not a live re-verification this session. Reported as **BLOCKED (read-only)**, with that caveat stated.

### E. App Store / TestFlight readiness

- App name: 「かぶモリ」 (done). Icon: approved artwork (done). Privacy/Support/account-deletion URLs: exist in source, not yet publicly reachable (depends on B). Version/build config: correct (remote build numbers, `autoIncrement`).
- Permission strings: only `Notifications.requestPermissionsAsync()` is called anywhere in the app (grepped for camera/location/contacts/media APIs — none found); iOS notification permission needs no custom `Info.plist` usage-description string, so nothing is missing here.
- **New, non-blocking observation:** `src/hooks/use-register-push-token.ts` requests notification permission immediately on every login with no pre-permission explanation screen. This is a UX best-practice gap, not a hard App Store rule, and changing it is a feature change outside this task's scope — recorded, not fixed.
- Remaining blockers are unchanged and are all App Store Connect data-entry / account items (app record, listing name, App Privacy questionnaire, age rating, metadata, demo account, export-compliance declaration, `submit.production` fields) — **OPERATOR_ACTION**.

### F. Splash / startup artwork — reclassified

- **App icon: done**, confirmed unchanged since the PR #31 merge.
- **Native splash** (`expo-splash-screen` plugin: `image: splash-icon.png`, `backgroundColor: #208AEF`): still the Expo template. `git diff` from before the whole icon workstream (`c38a7f8`) shows this file/config untouched.
- **`AnimatedSplashOverlay`** (`src/components/animated-icon.tsx`, rendered by `src/app/_layout.tsx` on every normal launch): still displays `assets/images/expo-logo.png` over the same `#208AEF` gradient, animated. Confirmed unchanged (empty diff).
- **Reclassified:** after the icon fix, this overlay is now the single most visible remaining piece of Expo branding in the app — more so than the static splash background, since it fully renders Expo's animated logo on nearly every cold start. Moved from "optional/can defer" to **should fix before first TestFlight build**, since internal testers will see it every time.
- Also newly found: `assets/images/favicon.png` (web favicon) is still the Expo template mark too — lowest priority, not part of the iOS bundle or App Store review, recorded for completeness only.
- No artwork was generated or changed in this task, per its own constraint.

### Exact safe source changes

**None.** The audit found every prior source fix (EAS preflight script, legal-link centralization, icon integration) still correct and unbroken. The only change is documentation: `docs/mobile-release/RELEASE_READINESS.md` was updated to correct the two stale/missing facts above (icon status, Netlify distinction) and record the two new non-blocking observations. No true auth/security logic change was found, so nothing needed a STOP-and-report escalation.

### Tests / checks

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **126 passed / 0 failed** (unchanged — no code was touched) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** |
| `npx expo export --platform web`, dummy non-secret env | PASS, **10 static routes (unchanged)** |
| `apps/kabumori-web` preview build (`node build.mjs`, no env) | built, gaps shown as 未設定 |
| `apps/kabumori-web` production build (dummy operator values) | built |
| `npm run verify-production-env` with no env set | correctly fails, naming all 3 variables |
| secret scan (JWT/Supabase-key/service_role/OpenAI-key/project-ref/UUID patterns) on the changed file | clean — the one "service_role" match is the doc's own advisory text, not a value |
| `git diff --check` | PASS |

### Commit / push / PR

- branch `claude1/release-readiness-gap-closure`, commit `5b5acd6`, pushed
- **PR #35: https://github.com/anohi-memories/kabumori/pull/35 — open, not merged**

### Public URLs

None verified — `apps/kabumori-web` has no Netlify site yet, so there is no URL to report.

### Missing env — names only

`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_KABUMORI_WEB_URL` (EAS production environment); `KABUMORI_OPERATOR_NAME`, `KABUMORI_SUPPORT_EMAIL`, `KABUMORI_POLICY_EFFECTIVE_DATE` (Netlify site environment, once created). No values were read or printed for any of these.

### Exact Auth redirect / Site URL requirements

- Redirect allowlist must contain `kabumori://reset-password` (already added and confirmed working on a real device by an earlier task; not re-verified live this session since that requires the same unavailable read access).
- Site URL should point somewhere reachable — currently does not, and the eventual `apps/kabumori-web` origin is the natural candidate once it exists.

### SMTP status

Cannot verify live; assumed not configured based on the earlier real-device E2E's observed rate limiting, not re-confirmed this session (see Section D).

### Remaining startup-artwork status

Icon: done. Splash background/image: template, artwork needed. `AnimatedSplashOverlay`: template, artwork needed, **reclassified as should-fix-before-first-TestFlight**. Android adaptive icon and web favicon: template, lower priority, unchanged from prior reports (favicon newly confirmed still-template this session).

### Production mutation = 0

No Supabase Auth/SMTP mutation, no DB/schema/RLS/RPC change, no `personalized-reports` edit, no EAS credential/build/env mutation, no TestFlight/App Store Connect action, no DNS/Netlify change.

### Exact next action needed before first EAS/TestFlight build

1. Operator decides splash/launch-overlay artwork (specs in `RELEASE_READINESS.md` §4 item 1) — the `AnimatedSplashOverlay` piece is now flagged as should-fix-before-TestFlight, not optional.
2. Operator provides `KABUMORI_OPERATOR_NAME`/`KABUMORI_SUPPORT_EMAIL`/`KABUMORI_POLICY_EFFECTIVE_DATE` and a domain decision; someone creates a **separate** Netlify site (base `apps/kabumori-web`) — distinct from the already-connected `apps/admin` site.
3. Once published, set `EXPO_PUBLIC_KABUMORI_WEB_URL` plus the two Supabase values as EAS production environment variables.
4. Separately approved: point the Supabase Auth Site URL at the published site and configure custom SMTP.
5. Then a first internal/TestFlight-track EAS build, per this task's own restriction, still requires separate authorization and is not part of this task.

No Codex review requested, per the reduced-review policy for ordinary source/config/doc audits (and no code changed at all here).
