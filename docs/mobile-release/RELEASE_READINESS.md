# Kabumori release readiness (App Store / EAS)

Status as of `kabumori-release-foundation-appstore-web-links-eas-audit-20260924`. Anything not
marked **source-complete** needs a person, an account, or a production setting.

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

The privacy page describes the data flows as implemented today, audited from source:

- Supabase stores the account and the app data.
- Expo Push and APNs deliver notifications.
- OpenAI receives the portfolio fields used to write personalized reports: ticker, name, sector, holding or watch, quantity, average cost, cash or margin, long or short, derived P/L, portfolio-level totals and sector-weight composition, and TOPIX-relative comparisons, plus related news headlines/summaries and public market data/analysis. It receives no email, user id, memo or target price. Requests use `store: false`, which disables Responses API application-state storage, not abuse-monitoring logs; OpenAI's default abuse-monitoring retention may keep prompts and responses for up to 30 days, subject to applicable data controls ([OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)).
- Account deletion removes the active account and associated service data, but provider backups or security logs may retain copies for their configured retention periods.

**If the report generator changes what it sends** (G2 is currently working on reports), the table in `apps/kabumori-web/pages/privacy.html` must be updated in the same PR. Re-audited 2026-09-24 (`kabumori-privacy-dataflow-reaudit-after-report-upgrade-20260924`) against the current `personalized-reports/report_logic.ts` and `market_detail.ts`: portfolio totals and sector-weight composition were being sent but not named, and are now added above; everything else already matched.

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
| A1 | **`app.json`'s app icon (`assets/images/icon.png`, also used for `ios.icon` via the Icon Composer bundle `assets/expo.icon`) and the native splash background (`#208AEF`, the Expo brand blue) are the Expo template artwork, not a Kabumori mark.** | The App Store listing and the home screen icon would show Expo's default template, not Kabumori. | Kabumori icon and splash artwork (design decision — see exact specs below) |
| A1b | **On normal launches, `src/app/_layout.tsx` renders `AnimatedSplashOverlay` after auth loading; a recovery-link route takes precedence. The overlay displays `assets/images/expo-logo.png` — Expo's own wordmark — over a `#208AEF` gradient, animated in and out.** Confirmed by reading the component, not inferred from the filename. | This is live in-app UI, not an unused leftover, and appears during normal startup. | Replace with a Kabumori equivalent once artwork exists (see below); this file is unchanged in this task per the "do not generate artwork" rule |
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

1. **Kabumori icon and splash artwork.** No suitable official asset exists in the repo today (only the Expo template — see A1/A1b). Exact specs needed from the operator/designer:
   - **App icon**: 1024×1024 PNG, no transparency, no rounded corners (Apple applies the mask). Replaces `assets/images/icon.png`. If a distinct iOS Icon Composer variant is wanted, replaces `assets/expo.icon` (otherwise that field can be dropped and `expo.icon` alone will be used for iOS).
   - **Splash**: a mark or wordmark PNG plus a background colour, sized to work with `expo-splash-screen`'s existing `imageWidth: 76` config in `app.json` (or a chosen new width), to replace `splash-icon.png` and the `#208AEF` background.
   - **Animated launch overlay** (optional but recommended, since A1b is currently the most visible Expo branding in the app): a PNG to replace `assets/images/expo-logo.png` in `src/components/animated-icon.tsx`, plus a background colour/gradient to replace `#208AEF` / `linear-gradient(180deg, #3C9FFE, #0274DF)` in that file's `splashOverlay`/`background` styles. The app's existing accent colour is `#397449` (`KABUMORI_COLORS.light.accent` in `src/constants/kabumori-theme.ts`).
   - **Android adaptive icon**: foreground/background/monochrome layers, replacing the three `android-icon-*.png` files (background colour currently `#E6F4FE`, unrelated to A1/A1b, not investigated further as this task audits the iOS release path).
2. **Supabase Auth Site URL and redirect.** The signup confirmation link currently lands on an unreachable page. Once the site exists, the site origin or a confirmation page is a natural target.
3. **Custom SMTP.** The built-in sender allows about 2 emails per hour. Choose a provider and set up the sending domain's SPF and DKIM.
4. **Netlify:** create the site with base directory `apps/kabumori-web`, set the three operator variables, publish, and map a domain.
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
