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

The privacy page describes the data flows as implemented today, audited from source:

- Supabase stores the account and the app data.
- Expo Push and APNs deliver notifications.
- OpenAI receives the portfolio fields used to write personalized reports: ticker, name, sector, holding or watch, quantity, average cost, cash or margin, long or short, and derived P/L, plus related news headlines/summaries and public market data/analysis. It receives no email, user id, memo or target price. Requests use `store: false`, which disables Responses API application-state storage, not abuse-monitoring logs; OpenAI's default abuse-monitoring retention may keep prompts and responses for up to 30 days, subject to applicable data controls ([OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)).
- Account deletion removes the active account and associated service data, but provider backups or security logs may retain copies for their configured retention periods.

**If the report generator changes what it sends** (G2 is currently working on reports), the table in `apps/kabumori-web/pages/privacy.html` must be updated in the same PR.

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
| `EXPO_PUBLIC_KABUMORI_WEB_URL` | the published https origin of `apps/kabumori-web`, with no path |

**The legal text is a factual first draft, not legal advice.** Have the operator, and ideally a professional, review it before publication.

## 3. Blockers found by the App Store / EAS audit

| # | Finding | Why it matters | Needs |
| --- | --- | --- | --- |
| A1 | **The app icon and splash are still the Expo template.** `assets/expo.icon` is the Expo logo; `splash-icon.png` is the template splash on the template blue `#208AEF`. | The store listing and home screen would show Expo's logo, a likely review problem and not Kabumori. | Kabumori icon and splash artwork (design decision) |
| A2 | **Production builds have no Supabase configuration.** `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exist only in the git-ignored local `.env`, which EAS cloud builds do not receive. | A production build would start without a backend. | Create them, plus `EXPO_PUBLIC_KABUMORI_WEB_URL`, as EAS environment variables for the `production` environment. They are public values. |
| A3 | Home-screen name is `kabumori`, from `expo.name`. | The icon label shows the romanised lowercase name. | Decide the display name, e.g. 「かぶモリ」 |
| A4 | `submit.production` is empty. | `eas submit` will prompt for the App Store Connect app, Apple ID and team. | Fill in once the App Store Connect record exists |
| A5 | Export compliance (`ITSAppUsesNonExemptEncryption`) is not declared. | Every upload asks the question. The app only uses the OS's HTTPS, which is normally exempt, but this is a legal declaration. | The operator confirms, then set `ios.config.usesNonExemptEncryption: false` |
| A6 | Leftover template images (`expo-logo.png`, `react-logo*.png`, `tutorial-web.png`, `expo-badge*.png`). | Not bundled unless referenced. Cosmetic. | Optional cleanup |

Checked and fine as-is:

- bundle identifier `com.anohimemories.kabumori` and scheme `kabumori`, consistent with the Auth redirect and the recovery deep link
- iPhone-only (`supportsTablet` unset, defaults to false)
- notifications plugin configured
- no location, camera, photo or contacts APIs, so no extra permission strings
- AsyncStorage and the Expo modules ship their own privacy manifests
- version `1.0.0` with a remote build number

## 4. Pending production / account work (not done by source changes)

1. **Supabase Auth Site URL and redirect.** The signup confirmation link currently lands on an unreachable page. Once the site exists, the site origin or a confirmation page is a natural target.
2. **Custom SMTP.** The built-in sender allows about 2 emails per hour. Choose a provider and set up the sending domain's SPF and DKIM.
3. **Netlify:** create the site with base directory `apps/kabumori-web`, set the three operator variables, publish, and map a domain.
4. **App Store Connect:**
   - app record
   - Privacy Policy URL (`/privacy`) and Support URL (`/support`)
   - App Privacy questionnaire, answered consistently with `/privacy` (email and portfolio data linked to the user, no tracking)
   - age rating
   - screenshots, description and category
   - review notes that give reviewers a demo account
5. **EAS / TestFlight:** production build, TestFlight upload, internal test on a real device, then submission.
