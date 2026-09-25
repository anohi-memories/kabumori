# Kabumori release readiness (App Store / EAS)

Status as of `kabumori-release-readiness-gap-closure-20260925`, the latest of a running series
(`...-20260924` foundation, `...-privacy-dataflow-reaudit-...`, `...-approved-app-icon-integration-...`).
Anything not marked **source-complete** needs a person, an account, or a production setting.

## 0. Release readiness table (2026-09-25)

| Area | Status | Note |
| --- | --- | --- |
| A. EAS / Expo production config | **READY (source)** | `app.json`/`eas.json` valid; `npm run verify-production-env` checks the 3 required vars. Whether they are actually set in EAS's remote `production` environment cannot be checked from here — **OPERATOR_ACTION**. |
| B. Public Web (`apps/kabumori-web`) | **READY (source)**, **OPERATOR_ACTION (publish)** | Re-audited against current `personalized-reports` (see §1); no stale domain/Vercel/admin references found; no wording gap found. **No Netlify site has ever been connected for this app** — see the warning in §4. |
| C. Supabase Auth (Site URL / redirect) | **BLOCKED (read-only)** | No tool available in this environment can read live Auth config without extracting an access token, which is refused by policy (same conclusion as the 2026-09-24 rollout task). Requirements are documented in §4; `kabumori://reset-password` was already confirmed working end-to-end on a real device. |
| D. Custom SMTP | **BLOCKED (read-only)** | Same reason as C: cannot verify configured/not-configured without dashboard or Management API access this session does not have. Assume **not configured** (the built-in ~2/hour limiter was hit during the real-device E2E) until an operator confirms otherwise. |
| E. App Store / TestFlight metadata | **OPERATOR_ACTION** | See §4 item 6. One new minor observation: push-permission is requested immediately on first login with no pre-permission explanation screen — not a hard App Store rule, not fixed here (a UX/feature change, out of this task's scope). |
| F. Splash / startup artwork | **BLOCKED (needs artwork)** | App icon is now done (§1). Native splash background/image and `AnimatedSplashOverlay` are still the Expo template — classification below. |

## 1. Source-complete

| Item | Where |
| --- | --- |
| Signup / login / session lifecycle, verified on a real device | `src/lib/auth.ts`, `src/providers/auth-provider.tsx` |
| Password recovery, verified on a real device | `src/lib/password-recovery.ts`, `src/app/+native-intent.tsx` |
| In-app account deletion with cascade, verified on a real device | `supabase/functions/account-delete`, settings sheet |
| Public pages: `/privacy`, `/terms`, `/support`, `/account-deletion`, `/` | `apps/kabumori-web` |
| In-app links to privacy / terms / support, from one origin | `src/lib/legal-links.ts` (`EXPO_PUBLIC_KABUMORI_WEB_URL`) |
| Production build number auto-increment | `eas.json` → `build.production.autoIncrement` |
| Home-screen app display name is 「かぶモリ」 | `app.json` → `expo.name` |
| Production-env preflight, checked by hand or CI before `eas build --profile production` | `scripts/verify-production-env.mjs` (`npm run verify-production-env`) |
| **Approved app icon integrated** (user-supplied artwork, not a template) | `assets/images/icon.png`, `app.json` → `expo.icon`/`ios.icon`; master preserved at `assets/branding/kabumori-icon-master-2026-09-25.png`. Verified with a real `expo prebuild`. **Not yet seen on an actual iPhone home screen** — that still needs a separately authorized real-device build. |

The privacy page describes the data flows as implemented today, audited from source:

- Supabase stores the account and the app data.
- Expo Push and APNs deliver notifications.
- OpenAI receives the portfolio fields used to write personalized reports: ticker, name, sector, holding or watch, quantity, average cost, cash or margin, long or short, derived P/L, portfolio-level totals and sector-weight composition, and TOPIX-relative comparisons, plus related news headlines/summaries and public market data/analysis. It receives no email, user id, memo or target price. Requests use `store: false`, which disables Responses API application-state storage, not abuse-monitoring logs; OpenAI's default abuse-monitoring retention may keep prompts and responses for up to 30 days, subject to applicable data controls ([OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)).
- Account deletion removes the active account and associated service data, but provider backups or security logs may retain copies for their configured retention periods.

**If the report generator changes what it sends** (G2 is currently working on reports), the table in `apps/kabumori-web/pages/privacy.html` must be updated in the same PR. Re-audited 2026-09-24 (`kabumori-privacy-dataflow-reaudit-after-report-upgrade-20260924`) against the current `personalized-reports/report_logic.ts` and `market_detail.ts`: portfolio totals and sector-weight composition were being sent but not named, and are now added above; everything else already matched.

**Re-checked 2026-09-25** against every `personalized-reports` commit since that re-audit (`delivery_policy.ts`, `mic_market_context.ts`, morning/close prompt hardening). Two are new, neither needs a wording change:
- `mic_market_context.ts` reads only the shared, system-wide `market_state_current` table (rates/macro/equity-index narrative, not tied to any one user) and is sent to OpenAI as `packet.mic_market`. It is the same kind of content the page already calls "公開市場データ・分析" (public market data/analysis), so it is already covered without naming the specific table.
- `delivery_policy.ts` is shadow/telemetry classification derived from an already-generated report (its own header: "never feeds back into generation... the save/notify decision"). It sends nothing to OpenAI and stores no new user data category.
No other data-flow change was found.

## 2. Values only the operator can decide

The public site will not build for production until these are set in the Netlify site's environment:

| Variable | Meaning |
| --- | --- |
| `KABUMORI_OPERATOR_NAME` | operator name shown on every page |
| `KABUMORI_SUPPORT_EMAIL` | support / privacy contact (must be monitored) |
| `KABUMORI_POLICY_EFFECTIVE_DATE` | effective date, `YYYY-MM-DD` |

For the native build:

| Variable | Meaning |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL` | the Supabase project API URL used by the app client |
| `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the client-side publishable key; never use a secret or `service_role` key |
| `EXPO_PUBLIC_KABUMORI_WEB_URL` | the published https origin of `apps/kabumori-web`, with no path |

**The legal text is a factual first draft, not legal advice.** Have the operator, and ideally a professional, review it before publication.

## 3. Blockers found by the App Store / EAS audit

| # | Finding | Why it matters | Needs |
| --- | --- | --- | --- |
| A1 | ~~`app.json`'s app icon and `ios.icon` are the Expo template~~ **Fixed 2026-09-25** (`kabumori-approved-app-icon-integration-20260925`, merged): `expo.icon`/`ios.icon`/the notifications-plugin icon all point at the user-approved artwork, verified with a real `expo prebuild`. **The native splash background (`#208AEF`, Expo brand blue) is still the template** — see A1b, now the only open part of this finding. | The home screen icon is done; the launch experience (splash + overlay) is not. | Splash/launch-overlay artwork (see exact specs below); real-device visual acceptance still pending |
| A1b | **`src/components/animated-icon.tsx`'s `AnimatedSplashOverlay`, rendered by `src/app/_layout.tsx` on every normal launch (a recovery-link route takes precedence over it), still displays `assets/images/expo-logo.png` — Expo's own wordmark — over a `#208AEF` gradient, animated in and out.** Re-confirmed unchanged as of 2026-09-25 (empty diff against `c38a7f8`, before the icon workstream). | This is live in-app UI shown on nearly every open, and after the icon fix it is now the single most visible remaining piece of Expo branding in the app — more so than the native splash background, since it fully renders Expo's logo, animated. | **Classified: should fix before first TestFlight build**, not merely "can defer." Internal testers will see it on every cold start. Replace with a Kabumori equivalent once artwork exists (see below); this file is unchanged in this task per the "do not generate artwork without approval" rule. |
| A2 | **The repository does not provide or enforce EAS production values.** `src/lib/supabase.ts` creates the client during app startup from `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; absent build-time values cause startup failure (`supabaseUrl is required` was reproduced in the prior export smoke). The legal-web URL instead fails soft and shows a preparation message. | EAS can still produce a build if the operator has not configured its production environment; the missing Supabase values prevent the app from starting. | Set all three values in EAS's `production` environment. The verifier checks only the current process environment, does not read remote EAS values, and is manual/CI-only; it does not automatically gate `eas build`. |
| A3 | ~~Home-screen name is `kabumori`~~ **Fixed in this task**: `expo.name` is now 「かぶモリ」. `slug`, `scheme` and `bundleIdentifier` are untouched. | — | done |
| A4 | `submit.production` is empty. | `eas submit` will prompt for the App Store Connect app, Apple ID and team. | Fill in once the App Store Connect record exists |
| A5 | Export compliance (`ITSAppUsesNonExemptEncryption`) is not declared. | Every upload asks the question. The app only uses the OS's HTTPS, which is normally exempt, but this is a legal declaration. | The operator confirms, then set `ios.config.usesNonExemptEncryption: false` |
| A6 | `assets/images/react-logo*.png`, `tutorial-web.png` and `expo-badge*.png` are not referenced anywhere in `src/` or `app.json` and are not bundled. `logo-glow.png` is referenced only by the unused `AnimatedIcon` export in the same file as A1b (not rendered anywhere). Cosmetic, no release impact. | — | Optional cleanup |

Checked and fine as-is:

- bundle identifier `com.anohimemories.kabumori` and scheme `kabumori`, consistent with the Auth redirect and the recovery deep link
- iPhone-only (`supportsTablet` unset, defaults to false)
- notifications plugin configured
- no location, camera, photo or contacts APIs, so no extra permission strings
- AsyncStorage and the Expo modules ship their own privacy manifests
- version `1.0.0` with a remote build number

## 4. Pending production / account work (not done by source changes)

1. **Kabumori splash and launch-overlay artwork.** ~~App icon~~ done (§1, A1). Still no suitable official asset for the launch experience. Exact specs needed from the operator/designer:
   - **Splash**: a mark or wordmark PNG plus a background colour, sized to work with `expo-splash-screen`'s existing `imageWidth: 76` config in `app.json` (or a chosen new width), to replace `splash-icon.png` and the `#208AEF` background.
   - **Animated launch overlay** (recommended to prioritize — see A1b: this is now the single most visible remaining Expo branding in the app): a PNG to replace `assets/images/expo-logo.png` in `src/components/animated-icon.tsx`, plus a background colour/gradient to replace `#208AEF` / `linear-gradient(180deg, #3C9FFE, #0274DF)` in that file's `splashOverlay`/`background` styles. The app's existing accent colour is `#397449` (`KABUMORI_COLORS.light.accent` in `src/constants/kabumori-theme.ts`); the approved icon's own green/leaf palette is another natural reference.
   - **Android adaptive icon**: foreground/background/monochrome layers, replacing the three `android-icon-*.png` files (background colour currently `#E6F4FE`, unrelated to A1/A1b, not investigated further as this task audits the iOS release path).
   - **Web favicon** (`assets/images/favicon.png`, found still-template 2026-09-25): lowest priority, not part of the iOS app bundle or App Store review; defer to whenever `apps/kabumori-web` gets its own design pass.
2. **Supabase Auth Site URL and redirect.** The signup confirmation link currently lands on an unreachable page. Once the site exists, the site origin or a confirmation page is a natural target.
3. **Custom SMTP.** The built-in sender allows about 2 emails per hour. Choose a provider and set up the sending domain's SPF and DKIM.
4. **Netlify — genuinely not started, distinct from the admin app's Netlify.** `apps/admin` (the X-autopost web management app, G4-owned) now has its own connected Netlify site; `apps/kabumori-web` (these public legal/support pages) does **not**, and never has — confirmed 2026-09-25 by finding zero `apps/kabumori-web` mentions anywhere in `.agent/CURRENT_STATE.md`'s Netlify history. They are two separate apps needing two separate Netlify sites. Still needed: create a **second, separate** site with base directory `apps/kabumori-web`, set the three `KABUMORI_*` operator variables there, publish, and map a domain (or use the Netlify-assigned one).
5. **EAS production environment variables**, verified locally first with `npm run verify-production-env`.
6. **App Store Connect:**
   - app record
   - set the localized App Store product name to 「かぶモリ」 (separate from the home-screen name in `expo.name`)
   - Privacy Policy URL (`/privacy`) and Support URL (`/support`)
   - App Privacy questionnaire, answered consistently with `/privacy` (email and portfolio data linked to the user, no tracking)
   - age rating
   - screenshots, description and category
   - review notes that give reviewers a demo account
   - export compliance declaration (A5)
7. **EAS / TestFlight:** production build, TestFlight upload, internal test on a real device, then submission.
