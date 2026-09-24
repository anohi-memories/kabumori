# Claude Task 1

- task_id: kabumori-release-foundation-appstore-web-links-eas-audit-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
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