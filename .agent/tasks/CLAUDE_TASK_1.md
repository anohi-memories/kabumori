# Claude Task 1

- task_id: kabumori-release-branding-eas-preflight-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: PR #18 merge後の次工程として、App Store提出前に残っている「Expoテンプレート表示」「アプリ表示名」「EAS production環境変数不足」をsource/readiness観点で解消・具体化する。Production deploy/build/config mutationは行わない。

## Context

PR #18はmainへmerge済み:
- reviewed head: `6f3277639bc19fb1f420cd0e771c1d77f6d23519`
- merge/main SHA: `a41b306de1cdf6e9c7e91ad7e22403a031650883`
- post-merge verification: 108/108 tests PASS, src tsc 0 errors, Expo export 10 routes, Web preview/production dry-run build PASS.

Remaining release blockers from prior audit:
1. app icon/splash still Expo template
2. app display name currently `kabumori`
3. EAS production needs:
   - EXPO_PUBLIC_SUPABASE_URL
   - EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
   - EXPO_PUBLIC_KABUMORI_WEB_URL
4. Netlify public site/operator values/domain are separate later work
5. Auth Site URL/SMTP/App Store Connect/TestFlight are separate later work

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK.
3. Fresh fetch origin/main.
4. Confirm no overlap with G2/PR #19.
5. Audit current app.json/app.config/eas.json/assets and any existing Kabumori brand assets in-repo.

## Work scope

### A. Display name
- Confirm current Expo display name.
- If repo branding consistently uses 「かぶモリ」 and no conflicting approved product name exists, update the user-visible app display name to 「かぶモリ」.
- Do not change bundle identifier or URL scheme.

### B. Icon / splash
- Determine whether a real Kabumori icon/logo asset already exists in the repo and is suitable for App Store/native use.
- If a suitable official asset exists, wire it into Expo icon/splash configuration and remove only clearly-unused template references.
- If no suitable official asset exists, **do not invent or generate branding artwork in this TASK**. Leave source unchanged for icon/splash and report the exact asset specifications needed from the operator/designer.

### C. EAS production env preflight
- Audit how Expo/EAS reads the three required public env values.
- Ensure source/config/docs clearly define the required production variables.
- Do not hardcode real project values.
- Do not create/update EAS secrets or remote env values in this TASK.
- Add/adjust safe validation/documentation only if needed so a production build cannot silently ship without backend/legal-web configuration.

### D. Release-readiness doc
Update RELEASE_READINESS.md only for verified current facts:
- display name status
- icon/splash status
- EAS env preflight status
- exact remaining operator actions

## Tests

Run as applicable:
- relevant app/release tests
- src TypeScript
- Expo config/export smoke
- web/legal tests only if touched
- git diff --check

## Forbidden

- production EAS build
- TestFlight/App Store submission
- EAS remote env mutation
- Netlify deploy/domain mutation
- Supabase Auth/SMTP mutation
- DB/migration changes
- G2/PR #19 files
- X/admin/MIC work
- generating a new logo/icon without explicit asset/design approval

## Production mutation budget

0.

## Completion / K1

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report:
  - fresh main SHA
  - display-name result
  - icon/splash audit + exact asset decision
  - EAS env preflight result
  - changed files
  - tests/checks
  - commit/push/PR status if source changed
  - production mutation=0
  - remaining operator inputs/actions
  - recommended next G1 task
- STOP for K1.

## Report — G1 result

- task_id: kabumori-release-branding-eas-preflight-20260924
- result: **source changes complete. PR #21 is open and unmerged.** Production mutation = 0.
- workspace: a fresh independent clone (not the shared `ios-push-e2e` worktree).

### 1. Fresh main

- task start: `39ea79e` (in_progress control commit, rebased on `0763c71`)
- G2/PR #19 overlap: none. This task touched `app.json`, `docs/mobile-release/RELEASE_READINESS.md`, `package.json`, `scripts/verify-production-env.mjs`, `tests/app/verify-production-env_test.ts` only.

### 2. Display-name result

- `app.json`: `expo.name` changed from `"kabumori"` to `"かぶモリ"`.
- Confirmed from the installed `@expo/config-types` declaration that `name` is documented as display-only ("the name of your app as it appears both within Expo Go and on your home screen"), distinct from `slug` (project identity), `scheme` (deep links) and `ios.bundleIdentifier`.
- `slug`, `scheme` and `bundleIdentifier` are **unchanged**, so the Auth redirect allowlist entry and the recovery deep link (both keyed on `scheme`) are unaffected, and EAS project linkage (keyed on `slug` + the existing `extra.eas.projectId`) is unaffected.
- The choice to use 「かぶモリ」 follows the repo's own overwhelming convention: every user-facing surface — the app's own dashboard greeting, the new public web pages, and the account-lifecycle docs — already calls the product 「かぶモリ」. The all-caps `KABUMORI` wordmark used as a stylised login-screen logotype element was left alone; it is a design choice inside the screens, not the OS-level app name this task's Part A asked about.

### 3. Icon/splash audit — exact asset decision

**No suitable official Kabumori icon/logo asset exists in the repository.** Per the task, none was generated or guessed. Two distinct findings are documented in `RELEASE_READINESS.md`, not one:

- **A1 (as previously known):** `app.json`'s icon (`assets/images/icon.png`, and its iOS Icon Composer counterpart `assets/expo.icon`) and the native splash background (`#208AEF`) are Expo's template artwork.
- **A1b (found in this task, not previously documented):** `src/components/animated-icon.tsx` exports `AnimatedSplashOverlay`, which `src/app/_layout.tsx` renders on **every app launch**. It displays `assets/images/expo-logo.png` — Expo's own wordmark — over a `#208AEF`/`linear-gradient(180deg, #3C9FFE, #0274DF)` background, animated in and out. This was found by reading the component, not inferred from a filename. It is live in-app UI shown to every user every time the app opens, which is a more visible instance of Expo branding than the static app.json icon/splash the prior audit already knew about. A second export in the same file, `AnimatedIcon` (uses `logo-glow.png`), is unused anywhere in `src/` — dead code, no release impact.
- `RELEASE_READINESS.md` §4 item 1 now lists exact specs for all of: the 1024×1024 app icon, the splash image/background, the launch-overlay image/background (to replace A1b), and the Android adaptive-icon layers — including the app's real accent colour (`#397449`, from `KABUMORI_COLORS.light.accent`) as a candidate reference for the new artwork.
- No icon/splash/animated-overlay **file** was changed in this task.

### 4. EAS production env preflight result

- New `scripts/verify-production-env.mjs` (`npm run verify-production-env`). Checks `EXPO_PUBLIC_SUPABASE_URL` (must look like `https://<ref>.supabase.co`), `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (non-trivial length), and `EXPO_PUBLIC_KABUMORI_WEB_URL` (reuses `normalizeWebOrigin` from `src/lib/legal-links.ts`, so its rule is exactly the app's own rule). Prints each specific problem and exits 1 if any value is missing or malformed; exits 0 otherwise.
- It is meant to run by hand or from CI **before** `eas build --profile production`. It does not run automatically as part of any existing build step. It reads no EAS remote state and creates or updates nothing — **no EAS secret/env mutation was made**, as forbidden.
- **Behavioural fact documented, not just asserted:** `src/lib/supabase.ts` uses a non-null assertion (`!`) on both Supabase values. I reproduced the actual failure mode while export-smoke-testing this repo with dummy env values in this and the two prior merge tasks: `Error: supabaseUrl is required`. So a production build shipped without these two values does not silently degrade — **it crashes on launch.** `EXPO_PUBLIC_KABUMORI_WEB_URL` fails soft by design (legal links show 準備中), which is correct for a dev/preview build but should still not ship unset to production; the preflight script treats all three the same way for that reason.

### 5. Changed files (PR #21, branch `claude1/release-branding-eas-preflight`, head `db5143f`)

- `app.json` — `expo.name` only
- `package.json` — one new npm script (`verify-production-env`)
- `scripts/verify-production-env.mjs` (new)
- `tests/app/verify-production-env_test.ts` (new, 6 tests)
- `docs/mobile-release/RELEASE_READINESS.md` — corrected/expanded A1, new A1b, A3 marked done, expanded §4 item 1 with exact artwork specs, A2's description sharpened to "crashes" rather than "starts without a backend"

### 6. Tests / checks

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **114 passed / 0 failed** (108 existing + 6 new) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** |
| `npx tsc --noEmit`, `scripts/` scope | 7 pre-existing errors in `morning-greeting-image.ts`/`.test.ts`, unrelated to this change. Verified present on the unmodified base via `git stash` before/after comparison. |
| `node --experimental-strip-types scripts/verify-production-env.mjs` | manually run with no env (fails, all 3 named) and with valid dummy values (passes) |
| `npx expo export --platform web`, dummy non-secret env | **PASS, 10 static routes (unchanged)** |
| `python3 -c "import json; json.load(open('app.json'))"` | valid JSON |
| `git diff --check` | PASS |

### 7. Commit / push / PR

- branch `claude1/release-branding-eas-preflight`, commit `db5143f`, pushed
- **PR #21: https://github.com/anohi-memories/kabumori/pull/21 — open, not merged**

### 8. Production mutation = 0

No EAS remote env/secret change, no Netlify, Supabase Auth, SMTP, App Store Connect, DB or migration change, and no icon/splash asset file changed.

### 9. Remaining operator inputs / actions

1. **Icon, splash and launch-overlay artwork** — the three items in §3/RELEASE_READINESS.md §4 item 1, from the operator/designer.
2. Decide whether to keep or drop the separate iOS Icon Composer asset (`assets/expo.icon`) once real artwork exists, or use a single flat icon for both.
3. Set `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_KABUMORI_WEB_URL` as EAS production environment variables — verify locally first with `npm run verify-production-env`.
4. Everything from the prior report unchanged: Netlify publication, operator legal values, Supabase Auth Site URL/redirect, custom SMTP, App Store Connect setup, `submit.production`, export-compliance declaration, EAS build → TestFlight → submission.

### 10. Recommended next G1 task

K1 review of PR #21 and #18's merge state (#18 already merged; #21 pending). Once artwork exists (operator-provided), a follow-up task to wire the new icon/splash/launch-overlay files into `app.json` and `animated-icon.tsx` — source-only, still no EAS build. In parallel, a Netlify-publication task can proceed once the three `KABUMORI_*` operator values and a domain are provided (independent of artwork).
