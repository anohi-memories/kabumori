# Kabumori Release Readiness Audit (2026-09)

Audit date: 2026-09-23 (JST)  
Task: kabumori-release-readiness-audit-and-roadmap-20260923  
Repository: anohi-memories/kabumori  
Source audit base: 113df8219e586a813cb4a1936e5152620958b435  
Fresh-main control baseline at handoff: f4e1fe98b679d6a7e29c3c7d150ddad0312085b8  
Scope: read-only audit plus this document; no app/backend implementation or production changes.

## Executive summary

Release status: **NOT READY**. The shortest path is to first close the production security boundary issue below, then resolve Auth/profile and account-deletion gaps, complete consumer app flows and real-device QA, validate Admin on Netlify Free without removing Vercel, and only then prepare App Store materials.

### Urgent production security finding — important-news-monitor

Source at the audit base shows the Edge Function has verify_jwt=false; its Deno.serve entry path accepts POST, reads privileged server environment values, parses the JSON body, and dispatches by mode. A source scan found no inbound Authorization/JWT or custom cron-secret validation before mode dispatch. Production metadata read-only also reported ACTIVE, verify_jwt=false; important_news_monitor_settings reports is_active=true, auto_publish=true.

Supabase documents that disabling JWT verification permits invocation without a valid JWT: [Function configuration](https://supabase.com/docs/guides/functions/function-configuration). This is a **potential unauthenticated privileged workload / publish exposure** and must be treated as P0 until independently reviewed and mitigated. This audit did not invoke the function, create candidates, post to X, change settings, or deploy a fix. Recommend pausing further auto-publish through a separately approved operational decision and prioritizing a reviewed caller-authentication remediation. Do not assume endpoint exploitability or that a post occurred; neither was tested.

## Current architecture and app status

- Consumer app: Expo Router / React Native; package versions observed include Expo ~57, React Native 0.86, Supabase JS 2.115, strict TypeScript 6. Root app includes home, explore, search, portfolio, news and report routes.
- Auth/session: email/password login/signup, session restore and auth-state subscription exist. Native Supabase client uses AsyncStorage, process lock and AppState auto-refresh. Signup confirmation is expected before login. A profile is ensured on some session paths, but there is no auth.users trigger.
- Production read-only inventory reports 2 Auth users and 1 profile; one Auth account lacks a profile. Cause is unknown. Since user-owned rows reference profiles, profile lifecycle must be resolved before relying on CRUD for every newly-created account.
- Stocks/search/tracked holdings/watch, Important News, Personalized Reports and Push-related app areas exist, but full end-user behavior, error/empty/offline states, deep links and native-device UX were not validated in this audit.
- No in-app account deletion flow, password reset flow, or clear consumer settings/support/legal entry was found in the app route tree.
- App config: bundle ID com.anohimemories.kabumori, scheme kabumori, version 1.0.0, icon/splash references, EAS project ID; remote app version source. Production EAS profile/submit settings are sparse and no build/TestFlight/App Store evidence was available.
- Root package has start/lint scripts but no standard typecheck/test/build script. This audit did not run a local build: the local checkout was dirty and 812 commits behind the fresh remote baseline; no local files were modified.

| Area | Status | Release note |
|---|---|---|
| Auth/session | Implemented, lifecycle incomplete | Resolve missing profile case and signup/profile guarantees; add recovery path. |
| Account deletion | Blocker | Apple requires in-app deletion when an app supports account creation: [Apple requirement](https://developer.apple.com/support/offering-account-deletion-in-your-app). |
| Privacy/legal/support | Blocker/unverified | App Store privacy policy URL and privacy disclosures are required; terms/support URLs and in-app discoverability need product/legal confirmation. [App privacy details](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/) |
| Search/holdings/watch | Implemented, E2E unverified | Validate complete account-owned CRUD and RLS under real iOS app. |
| Important News | Implemented, security blocker | Urgent inbound-auth finding above; no runtime invocation in this audit. |
| Personalized Reports | Implemented, UX/E2E unverified | Validate freshness, loading/failure states, ownership and current production path. |
| Push | Partial/unverified | Validate permission rationale, token lifecycle and deep links; deferred until core release gates. |
| Native release | Unverified | Need production EAS build, Apple signing, TestFlight install and device QA. |

## Supabase production and security

- The user-owned app tables reviewed have RLS enabled with user-scoped policies; stocks_master has authenticated read access. This supports the intended per-user boundary, but cross-user denial was not actively probed.
- Database is Postgres 17.6.1, project ACTIVE_HEALTHY, region ap-northeast-1, Free plan; reported DB size 73 MB / 500 MB project limit (~15%).
- Source contained 81 migration files vs 56 production history entries. Filename/version comparison found mismatches both ways; existing objects/history naming differences mean this is **migration ledger drift requiring a dedicated read-only reconciliation**, not proof every absent filename is unapplied. Do not run blind db push or repair history in this release audit.
- Supabase Security Advisor (read-only, 2026-09-23) reported: 21 RLS-enabled tables with no policies (review whether service-only tables are correctly inaccessible through exposed roles); mutable search_path on public.is_us_daylight_saving; anon-executable SECURITY DEFINER RPCs including complete_morning_greeting_post and rls_auto_enable; authenticated-executable SECURITY DEFINER RPCs including OAuth helpers and get_my_important_stock_news; leaked-password protection disabled. These are inventory signals, not all confirmed exploitable. Assign a separate least-privilege review; no advisor findings were changed.
- Edge Function metadata showed important-news-monitor ACTIVE with verify_jwt=false; other app/dispatch Functions also have this Gateway setting, with some custom secret validation in source. Each public endpoint needs an explicit caller-auth review.
- Active schedule inventory includes two every-minute jobs (~86,400 invocations/30 days) plus five Important News schedules (~19,440/month), a rough baseline of ~105,840 scheduled invocations/month before other jobs, retries and app calls (~21% of the 500k Free monthly invocation allowance). This is cadence arithmetic, not measured usage.
- No current egress, storage, invocation consumption, or alert thresholds were available. Establish usage monitoring and budget alerts before launch.

## Admin Web, Netlify Free and Vercel

Admin is Next.js 16.3.4 App Router with Server Components and Server Actions. A protected layout rechecks user/admin membership; the server action also rechecks authorization and allowlists toggles. No service-role key was found in the checked admin env example. Supabase SSR uses per-request clients and a session-refresh proxy, but cache-header behavior should be reviewed before CDN hosting.

| Compatibility point | Assessment |
|---|---|
| App Router / Server Components | Likely compatible; must trial deploy. |
| Server Actions / proxy session refresh | Likely compatible; validate redirects, cookies and mutations on Netlify. |
| Next 16.3.4 on Netlify | Supported framework family, but exact app needs trial deploy using the OpenNext adapter. [Netlify Next.js guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) |
| Dynamic admin pages / compute | Likely serverless compute per request; measure actual workload. |
| Heavy scheduled/AI/posting work | Already belongs in Supabase; keep it off Netlify. |
| Current Vercel setup | Preserve as fallback until Netlify trial and rollback are proven. No Vercel settings or project state changed in this audit. |
| Vercel CI/Preview checks | Repository history reports have depended on Vercel checks; decoupling branch protection is a separate decision and must not happen before replacement checks are proven. |
| Production Netlify deployment | Not performed; domain, env vars, redirects, auth callbacks, deploy previews, rollback and limits remain unverified. |

Netlify Free currently uses a 300-credit monthly allowance; production deploy is 15 credits, compute 10 credits/GB-hour, bandwidth 20 credits/GB and web requests 2 credits/10k. Twenty production deploys alone consume the monthly allowance before compute or requests; hard limits can pause sites. Verify current [Netlify pricing](https://www.netlify.com/pricing/) and usage before launch. Keep deploy cadence low, monitor credits and retain Vercel fallback. No paid-plan change is recommended.

## Vercel dependency inventory

| Dependency | Current understanding | Action |
|---|---|---|
| Admin production runtime | Existing Vercel setup is preserved; exact live project configuration was not accessible in this audit. | Keep until Netlify E2E and rollback pass. |
| PR build/preview checks | Prior H1 reports show required Vercel PR checks and prior rate limiting. | Keep checks until equivalent CI/build checks are reliable; separate branch-protection change later. |
| Vercel-specific source runtime | No repo vercel.json or Vercel SDK/runtime reference found in the inspected source tree. | Confirm with trial build/deploy; absence in source does not prove no dashboard dependency. |
| App hosting | Expo/EAS, not Vercel. | No change. |

## Shortest-path roadmap

1. **P0 security:** independently validate and remediate the important-news-monitor inbound auth boundary under explicit approval; confirm no unauthorized side effect path. Keep X/cron operations constrained during review.
2. **Auth/data integrity:** establish reliable profile creation for every confirmed user; test signup-confirmation, login, logout, recovery, missing-profile behavior and RLS account isolation.
3. **Consumer core E2E:** iPhone search → holding/watch CRUD → Important News/Reports read flows; validate errors, empty/offline states, ownership, safe-area, keyboard, numeric entry and deep links.
4. **Release UX/legal:** account deletion, privacy policy, terms/support/contact, permission explanations, App Store privacy answers and screenshots/metadata.
5. **Admin hosting trial:** deploy a non-production Netlify preview, verify Auth cookies/redirects/actions/admin authorization and rollback; measure Free credits. Do not remove Vercel yet.
6. **Store readiness:** configure EAS production build/submit, Apple signing, TestFlight, review notes/demo access and crash/error reporting; run real-device QA then App Store review.
7. **Final gate:** reconcile migration ledger, review Advisor warnings, endpoint auth, secrets, RLS and operational cost; obtain explicit release approval.

Suggested ownership split avoiding overlapping objects/files:
- H1: consumer app completion and iPhone E2E; app files only.
- H2: Supabase security/migration-ledger audit and narrowly-scoped backend remediations; assign disjoint objects per task before editing.
- G1: Admin Netlify preview compatibility; apps/admin/Netlify config only.
- G2: App Store legal/content/asset checklist and release metadata; docs/assets only.
- Reserve final cross-system security and release gate for a dedicated sequential review. Avoid parallel edits to the same function, migration, workflow, production setting, or control file.

## Final release gates

| Gate | Status |
|---|---|
| Critical Function caller auth reviewed/remediated | **FAIL** |
| Auth/profile lifecycle for all users | **FAIL** |
| Account deletion in app | **FAIL** |
| Privacy/support/legal URLs and disclosures | **FAIL / UNVERIFIED** |
| Consumer app iPhone E2E | **UNVERIFIED** |
| Per-user RLS isolation adversarial test | **UNVERIFIED** |
| Admin Netlify preview + rollback | **UNVERIFIED** |
| Supabase migration ledger reconciled | **FAIL / UNVERIFIED** |
| EAS production build + TestFlight | **UNVERIFIED** |
| App Store assets, metadata and review notes | **UNVERIFIED** |
| Free-tier usage monitoring/budget headroom | **UNVERIFIED** |
| Production mutations during this audit | **PASS — 0** |

## Sources and confidence

Evidence comes from source at the audit base, GitHub main control state, read-only Supabase project/function/advisor metadata and the production table/catalog inventory. Exact live hosting configuration, current quota consumption, real-device behavior, and endpoint behavior were not exercised. Official references: [Supabase Function configuration](https://supabase.com/docs/guides/functions/function-configuration), [Supabase SSR clients](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Netlify Next.js](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/), [Netlify pricing](https://www.netlify.com/pricing/), [Expo iOS production build](https://docs.expo.dev/tutorial/eas/ios-production-build/), [Expo app versions](https://docs.expo.dev/build-reference/app-versions/), [Apple account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app), [Apple app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/).
