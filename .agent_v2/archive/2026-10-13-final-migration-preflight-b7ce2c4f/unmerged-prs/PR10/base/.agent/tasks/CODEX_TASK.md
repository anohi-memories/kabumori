# Codex Task

- task_id: kabumori-release-readiness-audit-and-roadmap-20260923
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: かぶモリを正式リリース可能な状態へ最短で持っていくため、現状実装をread-onlyで棚卸しし、Expo + Supabase + Netlify Free（Vercel Pro前提なし、追加インフラ月額0円方針）との差分・未完成・release blocker・最短ロードマップを確定する。実装や本番変更はまだ行わない。

## Context

Important News GPT-6 production rollout is C1 PASS済み。
- GPT-6 metadata migration applied
- both CHECK constraints allow GPT-6 Luna/Sol
- only `important-news-monitor` deployed
- natural Cron runs succeeded
- no manual traffic/X/Push
- Personalized Reports / 9/18 regeneration untouched

The project now shifts toward release completion.

## User-approved architecture/cost direction

- Smartphone app: Expo / React Native
- Backend: Supabase
  - DB
  - Auth
  - Edge Functions
  - Cron / scheduled processing
- Operator Web Admin: Netlify Free as production hosting candidate
- Do not require Vercel Pro
- Do not unnecessarily increase Vercel dependency
- Target additional infrastructure monthly cost: 0 JPY
- Keep heavy/periodic/AI/posting processing on Supabase rather than Netlify where practical
- Do not destroy/delete/change the currently working Vercel setup without a separate approved migration plan
- If Netlify Free / Supabase Free limits appear likely to be exceeded, report before any paid-plan proposal

## Priority order for release work

1. Release blocker inventory
2. Smartphone app required-function completion
3. Supabase production stabilization
4. Netlify Free compatibility verification for admin
5. Netlify trial deployment readiness
6. iPhone real-device / TestFlight E2E QA
7. App Store required items, legal/account deletion/privacy/support
8. Final security/release audit
9. App Store submission
10. UI polish / optional features after blocker removal unless UI issue affects usability

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK
5. Read relevant recent reports only as needed
6. Fresh fetch `origin/main`
7. Confirm no overlap/conflict with H2/G1/G2
8. Do not alter other slot TASK/Report files

## Read-only audit scope

### A. Smartphone app
Inventory current state of:
- Auth/login/signup/session restore/logout
- profile lifecycle
- account deletion
- holdings/watchlist/search
- Portfolio
- Personalized Reports
- Important News
- Push permission/token/deep-link flow
- loading/error/empty/offline behavior
- settings/support/contact/legal entry points
- native iOS assumptions
- app icon/splash/scheme/bundle/version/build config
- EAS/TestFlight/App Store prerequisites
- any current release-blocking UX problems

Classify every major area:
- implemented
- incomplete
- unverified
- blocker
- deferred polish

### B. Supabase backend
Audit:
- production-vs-source status for consumer-facing migrations/RPC/RLS
- Auth dependencies
- Edge Functions used by app
- Cron/scheduled jobs
- Important News
- Personalized Reports
- Push
- known migration-history drift
- known build/type issues
- security boundaries
- free-tier risk: DB size, egress, Function invocation count, Cron cadence

Do not mutate production.

### C. Admin Web / Netlify
Audit `apps/admin` for Netlify Free suitability:
- Next.js version
- App Router
- Server Components
- Server Actions
- proxy/middleware behavior
- Route Handlers if any
- environment variables
- Supabase SSR/Auth cookies
- redirect URLs
- admin authorization boundary
- any Vercel-specific runtime/build assumptions
- likely Netlify Functions usage
- whether heavy work already lives in Supabase

Classify each compatibility point:
- confirmed
- likely
- needs trial deploy

Use official current docs if needed.

### D. Vercel dependency inventory
Identify:
- production runtime dependencies
- Preview/CI-only dependencies
- branch protection/check dependencies
- what can remain temporarily
- what must be decoupled to achieve “Vercel Pro not required”

No Vercel changes.

### E. App Store release readiness
Inventory at minimum:
- bundle identifier
- version/build strategy
- app icon/splash
- privacy policy URL
- terms/support/contact URL
- account deletion flow
- permissions/privacy disclosures
- push permission UX
- screenshots/metadata
- review notes/demo account need
- TestFlight readiness
- production EAS build/submit readiness
- crash/error logging expectation
- final security checklist

## Deliverable

Create a new concise document under `docs/` containing:

1. Current architecture
2. Confirmed implemented features
3. Incomplete/unverified items
4. Release blockers
5. Deferred polish
6. Netlify Free compatibility matrix
7. Vercel dependency matrix
8. Supabase/Netlify free-tier cost-risk checklist
9. Shortest-path roadmap to first App Store release
10. Recommended H1/H2/G1/G2 decomposition that avoids overlapping files/DB objects
11. Final release-gate checklist with PASS/FAIL fields

Also update `PROJECT_RULES.md` only if a short permanent section can safely record the user-approved architecture/cost policy without changing orchestration semantics.

## Restrictions

Forbidden:
- production deploy/mutation
- DB write/migration apply
- Netlify deploy
- Vercel setting change
- Supabase setting change
- App Store/TestFlight submission
- feature implementation
- Vercel deletion/destructive change
- paid-plan change

Read-only web research is allowed only for current Netlify/Expo/Supabase compatibility questions.

## Handoff

Update `.agent/CODEX_REPORT.md` with:
- audit base SHA
- docs/rules changed
- release blockers
- Netlify findings
- Vercel dependency findings
- App Store blockers
- next 3 recommended implementation tasks
- production mutation = 0

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
