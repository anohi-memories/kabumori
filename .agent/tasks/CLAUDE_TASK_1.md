# Claude Task 1

- task_id: kabumori-release-foundation-appstore-web-links-eas-audit-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: かぶモリをApp Store提出可能な状態へ近づけるため、Apple審査で必要になる公開Web導線（Privacy / Terms / Support / Account deletion案内）、アプリ内リンク、EAS/App Store向け設定を監査・実装する。G2の朝刊/大引け機能改修とは完全に分離する。

## User-approved release direction

- Native app: Expo / React Native
- iOS build/distribution: EAS / TestFlight / App Store
- Backend: Supabase
- Real-device verification: iPhone
- Kabumori future Web Preview: Netlify
- Kabumori future Web Production: Netlify
- Vercel is not used for Kabumori native development or Kabumori Web
- G1 is the release-readiness implementation lane while G2 improves app content/features

## Current accepted release facts

Already complete:
- signup/login/session lifecycle E2E
- password recovery real-device E2E
- in-app account deletion E2E
- account-delete cascade verification
- PR #17 merged and post-merge verified
- Auth/security review PASS

Known remaining blockers:
1. public Privacy Policy URL
2. public Terms URL
3. public Support URL
4. public Account deletion/privacy choices guidance URL if useful
5. reachable Supabase Auth confirmation/recovery redirect / Site URL
6. custom SMTP
7. App Store / EAS release configuration audit

This task addresses 1-4 + source-side release config audit for 7.
Items 5-6 are NOT configured in production in this task.

## Apple-facing public Web

Implement a small public Kabumori web surface suitable for Netlify:
- /privacy
- /terms
- /support
- /account-deletion or equivalent explicit account-deletion guidance
- optional simple / landing page if needed for navigation

Requirements:
- publicly reachable when later deployed
- mobile-friendly
- clearly identify Kabumori
- no login
- no secrets/internal IDs
- accurate descriptions based on actual app behavior
- do not invent legal guarantees or data practices

Privacy page must accurately cover, based on source audit:
- account/auth data
- tracked stocks / user portfolio-like data
- notification/push-token handling
- personalized reports if present
- third-party/backend services actually used
- data-use purposes
- retention/deletion behavior
- how users delete account/data
- support/contact path

Terms page:
- reflect current service behavior
- state market/investment content is informational
- do not promise investment outcomes
- avoid unsupported legal clauses

Support page:
- support/contact instructions
- account/auth troubleshooting
- password-reset guidance
- account-deletion guidance
- no fake SLA

Account deletion page:
- explain the in-app deletion path
- explain associated user-owned data deletion according to current implementation
- do not replace the already-working in-app deletion flow

## Native app integration

Audit settings/account UI and add clear links where appropriate:
- Privacy Policy
- Terms
- Support
- Account deletion guidance if useful

Rules:
- centralize public URL configuration
- do not scatter URL strings
- do not change account-delete behavior
- do not weaken Auth/RLS
- do not expose service-role credentials
- no Vercel dependency
- if final production domain is not configured, use one centralized release URL base/config and clearly document what must be replaced before production

## Web architecture

First audit the repo and choose the smallest maintainable implementation.
Prefer a small static/web surface suitable for Netlify.
Do not add a large framework solely for four simple pages if unnecessary.
Do not touch X/admin web apps or Vercel config.

## App Store / EAS release audit

Audit at minimum:
- app.json
- eas.json
- iOS bundle identifier
- app name / slug / scheme
- production build profile
- submit profile
- icon/splash references
- version/version-source behavior
- notifications config
- deep-link scheme consistency
- iOS permission strings actually needed
- release-specific environment variables
- App Store metadata that remains outside source

Implement only safe source-side fixes that are clearly required.

Do NOT:
- submit to App Store
- create production EAS build
- mutate Apple Developer/App Store Connect
- mutate Supabase Auth settings
- configure SMTP
- change DNS
- publish Netlify production

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, and this TASK.
3. Fresh fetch origin/main.
4. Confirm G2 ownership and avoid morning/closing report implementation files.
5. Audit actual data flows before writing Privacy text.
6. Audit settings/account UI before adding links.
7. Audit existing public/legal/support pages before creating new ones.
8. Audit app/eas config before changing anything.
9. STOP if implementation materially overlaps G2.

## Tests / verification

At minimum:
- public pages build/render successfully
- all release routes exist
- no secret/internal identifiers in static output
- native settings links compile and use centralized config
- relevant mobile tests PASS
- TypeScript/static checks PASS
- git diff --check PASS
- Expo export/build smoke if relevant
- Netlify build config local/dry-run if possible without credentials

No production deploy in this task.

## Deliverables

1. Netlify-ready public release pages
2. Native in-app links to required public pages
3. release URL/config centralization
4. App Store/EAS source-side audit and safe fixes
5. release-readiness checklist documenting:
   - source-complete items
   - manual App Store Connect items
   - pending Supabase Auth Site URL/redirect config
   - pending custom SMTP
   - pending Netlify production publication/domain mapping
   - pending TestFlight/App Store submission

## Forbidden

- G2 report-generation files
- G3/G4 X/admin files
- production Supabase Auth mutation
- SMTP configuration
- DNS mutation
- Netlify production deploy
- Vercel config/deploy
- EAS production build
- TestFlight upload
- App Store submission
- DB migration / blind supabase db push
- unrelated app feature work

## Production mutation budget

0.

## Completion / K1

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  1. fresh main SHA
  2. source audit
  3. exact changed files
  4. web routes created
  5. native links added
  6. App Store/EAS audit findings
  7. tests/checks with exact counts
  8. commit/push/PR status
  9. production mutation=0
  10. exact remaining manual/release blockers
  11. recommended next G1 release task
  12. whether Codex review is recommended and why
- STOP for K1.

## Report — G1 result

- task_id: kabumori-release-foundation-appstore-web-links-eas-audit-20260924
- result: **source-complete candidate. PR #18 is open and unmerged.** Production mutation = 0.

### 1. Fresh main

- task start: `334d7a5` (my in_progress control commit, rebased on `265416e`)
- PR base: `origin/main` at branch time
- workspace: an independent clone in my scratchpad, not the shared worktree

### 2. Source audit

**G2 overlap:** G2 owns `supabase/functions/personalized-reports`, `src/app/reports/*` and report presentation. This PR touches none of them, and none of G3's or G4's files. There was no stop condition.

**Data flows**, audited from source rather than assumed:

- Supabase: Auth plus these tables:
  - `profiles`
  - `tracked_stocks` (holding/watch, quantity, average price, cash/margin, long/short, target prices, memo)
  - `alert_settings` / `alert_category_settings`
  - `notifications`
  - `device_push_tokens` (Expo token plus a device label such as "Apple iPhone 15")
  - `personalized_reports`
- Push: `send-push-notifications` → Expo Push API (`exp.host`) → APNs.
- OpenAI: `personalized-reports` sends, per stock:
  - ticker, name and sector
  - holding or watch
  - quantity and average price (holdings only)
  - cash/margin and long/short
  - derived market value and P/L

  It does **not** send the email, user id, memo or target prices. Requests use `store: false`.
- No analytics, crash or ad SDK in `package.json`. No location, camera, photo or contacts APIs.

**Existing public pages:** none anywhere in the repo, so nothing was duplicated.

**Settings UI:** already has privacy/terms/support entries from phase 1. Only their URL source changed.

### 3. Changed files (PR #18, head `2b91cc4`)

- new `apps/kabumori-web/`:
  - `build.mjs`, `build_test.ts`
  - `layout.html`, `styles.css`, `netlify.toml`
  - `pages/{index,privacy,terms,support,account-deletion}.html`
- `src/lib/legal-links.ts`: one origin plus a route table
- `tests/app/legal-links_test.ts`, `tests/app/settings-menu_test.ts`
- `eas.json`: `build.production.autoIncrement: true`
- `docs/mobile-release/RELEASE_READINESS.md` (new)
- `docs/mobile-release/ACCOUNT_LIFECYCLE.md`: points at the new config

### 4. Web routes created

`/`, `/privacy`, `/terms`, `/support`, `/account-deletion`. Each is built as `<route>/index.html`, is mobile-friendly and supports dark mode, and needs no login.

- The operator name, support email and effective date come from `KABUMORI_OPERATOR_NAME` / `KABUMORI_SUPPORT_EMAIL` / `KABUMORI_POLICY_EFFECTIVE_DATE`.
- **A production build refuses to run without them.** A preview marks the gaps and is `noindex`.
- Nothing about the operator was invented.

### 5. Native links

- Settings → プライバシーポリシー / 利用規約 / お問い合わせ・サポート now resolve from **one** `EXPO_PUBLIC_KABUMORI_WEB_URL` origin (bare https only; anything else shows 準備中).
- `PUBLIC_WEB_ROUTES` also exports `/account-deletion` for App Store Connect.
- The in-app deletion flow is unchanged.
- Tests enforce two things:
  - the app's routes are all built by the site
  - no other `src/` file carries these URLs or env names

### 6. App Store / EAS audit findings (details in `RELEASE_READINESS.md` §3)

- **A1 blocker: the app icon (`assets/expo.icon`) and splash are still the Expo template** (the Expo logo, template blue). Kabumori artwork is needed.
- **A2 blocker: `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exist only in the git-ignored `.env`**, so an EAS production build would have no backend. Create them, plus `EXPO_PUBLIC_KABUMORI_WEB_URL`, as EAS production environment variables.
- A3: the home-screen name is `kabumori`. The display name needs deciding.
- A4: `submit.production` is empty. Fill it in when the App Store Connect record exists.
- A5: export compliance is not declared. The operator must confirm before `ios.config.usesNonExemptEncryption: false` is set. Not changed, because it is a legal declaration.
- A6: leftover template images (cosmetic).
- Fine as-is:
  - bundle id and scheme are consistent with the Auth redirect and the recovery link
  - the app is iPhone-only
  - the notifications plugin is configured
  - no extra permission strings are needed
  - the libraries ship their own privacy manifests
  - version 1.0.0 with a remote build number
- Safe fix applied: `autoIncrement` for production build numbers.

### 7. Tests / checks

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **108 passed / 0 failed** (98 existing + 8 web + 2 net new link tests) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** |
| `npx expo export --platform web`, with dummy non-secret env | PASS, **10 routes** (unchanged) |
| `node build.mjs` | preview built. Production without values **refused (exit 1)**. Production with values built. |
| Netlify config | Local build dry run only. No Netlify CLI or credentials were used and nothing was deployed. |
| 375px render of `/privacy` | no horizontal overflow (`scrollWidth` = `clientWidth` = 375) |
| static output secret scan (a test) | no JWT, Supabase key, `service_role`, OpenAI key, project ref or UUID |
| `git diff --check` | PASS |

### 8. Commit / push / PR

- branch `claude1/release-foundation-web-links`, commit `2b91cc4`, pushed
- **PR #18: https://github.com/anohi-memories/kabumori/pull/18 — open, not merged**

### 9. Production mutation = 0

No Supabase Auth, SMTP, DNS, Netlify, Vercel, EAS build, TestFlight, App Store Connect, migration or DB change.

### 10. Remaining manual / release blockers

1. Operator values: operator name, a monitored support email, the effective date, and a professional review of the legal text.
2. Netlify: create the site (base `apps/kabumori-web`), set the three variables, publish, and map a domain.
3. EAS production environment variables (A2), and set `EXPO_PUBLIC_KABUMORI_WEB_URL` to the published origin.
4. Kabumori icon and splash artwork (A1), and the display name (A3).
5. Supabase Auth Site URL / confirmation and recovery redirect, to a reachable page such as the new site.
6. Custom SMTP.
7. App Store Connect:
   - app record
   - Privacy URL and Support URL
   - App Privacy answers consistent with `/privacy`
   - age rating
   - metadata and screenshots
   - a demo account for review
   - export compliance (A5)
   - `submit.production` (A4)
8. EAS production build → TestFlight → real-device check → submission.

### 11. Recommended next G1 task

After PR #18 is reviewed and merged: **a Netlify preview/production publication of `apps/kabumori-web` plus the EAS production environment variables**, once the operator values and domain are provided. Then point the Supabase Auth Site URL at the published site, and configure custom SMTP (the operator's approval is needed for both). Icon artwork can run in parallel.

### 12. Codex review recommended?

**Yes, a light one.**

- The code risk is low: static pages, a pure link builder, and one `eas.json` key.
- But the privacy and terms text makes factual claims about data flows that must stay true. An independent reviewer should re-verify the OpenAI field list against `personalized-reports` (especially after G2's changes) and check the `/privacy` table against the tables that actually exist.
- No Auth or security code changed.
