# Claude Task 2

- task_id: kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5.5
- purpose: かぶモリ正式リリースに向け、consumer mobile app側の最優先release blockersをまとめて片付けるsource candidateを作る。Codexが並行して扱うImportant News caller-authには触れず、mobile/Auth/account/settings/legal導線に集中する。production mutationは行わない。

## Why this task now

直近のrelease-readiness監査で、正式リリースまでの最短経路は以下と整理された。

1. production security blockerを解消
2. Auth/profile/account lifecycleを完成
3. consumer app core E2Eを通せる状態へ
4. account deletion / privacy / support / legalを整える
5. Netlify admin trial
6. TestFlight / App Store準備
7. final security/release gate

Codex slot 1は現在、`important-news-monitor` caller-auth PR #12のmerge-only作業を担当する。Claude slot 2は完全に別workstreamとして、consumer appのrelease blockerを進める。

### Current architecture direction

- Mobile: Expo / React Native / Expo Router
- Backend: Supabase Auth + Postgres/RLS/RPC + Edge Functions/Cron
- Admin: Next.js admin;将来Netlify Freeを本番候補として検証
- Vercel Pro前提にしない
- 追加インフラ月額0円を基本目標
- heavy scheduled/AI/posting処理はSupabase側に置く
- 現行Vercelは安全に残し、別タスクでNetlify trial後に判断
- UIの細かい磨き・追加機能はrelease blockers後。ただし「押せない/読めない/迷って操作不能」はrelease前に直す

### Known current mobile state from audit

確認済み:
- Expo Router / React Native app
- email/password login/signup
- session restore + auth-state subscription
- native Supabase session persistence
- Home / Explore / Search / Portfolio / Important News / Personalized Reports routes exist
- holdings/watchlist/search functionality exists
- push関連コード/導線は存在
- bundle id: `com.anohimemories.kabumori`
- scheme: `kabumori`
- app version currently 1.0.0
- EAS project config exists

Release blockers / gaps identified:
- in-app account deletion flowが見当たらない
- password reset/recovery flowが見当たらない
- profile lifecycleに不整合可能性あり
  - production read-only inventoryではAuth users 2に対しprofiles 1
  - root cause未確定
  - source上は一部session pathでprofile ensureするが、auth.users triggerは見つかっていない
- consumer appに明確なSettings / Support / Contact / Privacy / Terms入口が不足
- signup -> confirmation -> profile作成 -> first loginの完全保証が未確認
- logout / session restore / missing-profile recoveryのE2Eが未確認
- account deletion時にuser-owned dataとauth.usersを安全に消す設計が必要
- Appleはアプリ内でaccount creationを提供する場合、アプリ内account deletion導線が必要
- Privacy/Support URL等は最終App Store提出前に必須
- iPhone実機/TestFlight QAは後続タスク

## Mandatory startup

開始前に必ず:

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. this TASK
5. `.agent/tasks/CODEX_TASK.md` — Important News caller-auth ownershipを確認
6. `.agent/tasks/CODEX_TASK_2.md` — backend parallel ownershipを確認
7. `.agent/tasks/CLAUDE_TASK_1.md`
8. fresh `origin/main`
9. current consumer mobile source tree
10. Auth/profile schema/migrations/RLS
11. current legal/support pages or URLs if any
12. current Expo 57 official docs relevant to auth deep links / linking / secure navigation

If another slot currently owns any exact file/DB object/Function you need, do not edit it. Split/stop and report the overlap.

## Workstream boundary

### Claude owns for this task

Consumer mobile release lifecycle only:
- `src/app/**` consumer mobile screens/routes
- `src/lib/auth.ts` and directly related consumer-auth helpers/tests
- new app-only Settings / Account / Support / Legal routes/components as needed
- source candidate for a **dedicated account-deletion backend path**, only if required
- narrowly scoped profile-lifecycle remediation candidate, only after root-cause audit
- tests/docs directly related to this workstream

### Claude must NOT touch

- `supabase/functions/important-news-monitor/**`
- caller-auth migration `20260923110440_important_news_monitor_caller_auth.sql`
- Important News Cron/Vault/config
- x-test-post / social-mobile workstream
- market-report shared platform
- Netlify/Vercel settings
- production deploy/migration/apply
- App Store Connect/TestFlight submission
- existing X OAuth production accounts/secrets
- unrelated UI redesign

## Phase A — exact read-only audit before implementation

First determine the actual current behavior, not assumptions.

### Auth/profile lifecycle

Trace:
- signup
- email confirmation behavior
- initial login
- session restore
- profile creation/ensure
- missing-profile behavior
- logout
- re-login
- deleted/disabled user behavior
- RLS dependency on `profiles`

Answer:
- Which tables require `profiles.id` FK?
- Is profile creation client-driven, RPC-driven, trigger-driven, or mixed?
- Can a confirmed Auth user exist without a profile today?
- If yes, what breaks?
- Can profile creation be made idempotent and server-enforced without broad migration risk?
- Is a DB trigger actually appropriate, or is an authenticated RPC/ensure path safer in this schema?

Do not immediately add a trigger just because one is absent.

### Password recovery

Inspect current Supabase Auth config/source expectations and Expo Router linking.
Determine a safe release-ready flow:
- request password reset email
- deep-link back to app
- recovery session handling
- enter/update new password
- expired/invalid link UX

Prefer the simplest path supported by the current Expo/Supabase versions.

### Account deletion

Audit all user-owned data and foreign-key behavior before writing deletion code.

Determine:
- which tables reference `auth.users` directly
- which reference `profiles`
- CASCADE / RESTRICT behavior
- storage/push-token/notification rows
- holdings/watchlist/report-related user data
- whether account deletion can be performed atomically enough
- whether deletion requires a service-role Edge Function or existing RPC
- re-authentication/confirmation UX appropriate for destructive action

Security requirement:
- mobile client must never receive service-role key
- user can delete only self
- backend derives user identity from verified JWT, never from caller-supplied arbitrary user id
- operation is idempotent or safely repeatable
- failure must not leave a falsely “deleted” UI state
- secrets/tokens are not logged
- no other user's rows can be affected

If a backend candidate is required, prefer a **new dedicated function** (for example account deletion) rather than broadening unrelated Functions. Source-only; do not deploy.

### Settings/legal/support

Audit whether legal/support pages already exist in:
- mobile app
- admin web
- public web
- docs

Avoid duplicating content unnecessarily.

Create clear in-app entry points for:
- Account
- Password reset/recovery where appropriate
- Delete account
- Privacy Policy
- Terms
- Support/Contact
- Logout

If final production URLs are not yet available, implement a clean configuration boundary and document the exact unresolved URL values instead of hardcoding fake URLs.

## Phase B — implementation candidate

After Phase A, implement the minimum release-ready candidate.

Expected user-facing result:

1. A discoverable Settings/Account area.
2. Logout works from there.
3. Password recovery flow exists and handles deep-link/session state safely.
4. Account deletion can be initiated in-app with explicit confirmation.
5. Account deletion backend candidate securely deletes only the authenticated user and required owned data.
6. Missing-profile state either self-heals safely or shows a controlled recovery path, based on the chosen architecture.
7. Privacy / Terms / Support / Contact entries are visible and do not dead-end.
8. No unrelated visual redesign.

You may adjust exact file structure to fit the current app architecture.

## Validation expectations

Run the strongest relevant checks available in repo:

- targeted auth/account tests
- app route/navigation tests
- RLS/profile tests where source candidate changes DB behavior
- account deletion authorization tests
- password recovery state/deep-link tests
- TypeScript/typecheck for app scope
- Expo web export if it is the established regression check
- `git diff --check`

If a new Edge Function is added:
- test unauthenticated reject
- test authenticated self-delete path
- test spoofed user-id cannot target another user
- test repeated invocation behavior
- verify service-role never returned/logged
- do not deploy

If a migration is proposed:
- one narrow forward migration
- no blind `db push`
- static contract tests
- disposable DB proof if it changes FK/trigger/security-definer behavior
- source-only; production apply separately approved

## Branch / PR strategy

Use a dedicated branch from fresh `origin/main`.
Do not commit unrelated `.agent` history into the implementation PR unless repository convention requires it.

Create a focused PR for review. Do not merge it yourself unless the TASK is later explicitly changed to allow merge.

## Production restrictions

Production mutation = 0 for this task.

Do NOT:
- apply DB migration
- deploy Edge Function
- change Auth provider/dashboard settings
- send real password reset email as a test unless explicitly approved
- delete any real account
- modify real user rows
- deploy EAS/TestFlight
- change App Store Connect
- change Vercel/Netlify
- modify Important News caller-auth rollout
- change Push production settings

## Detailed handoff required

Because this workstream is being handed back to Claude after a long Codex-heavy period, the Report must be unusually explicit.

Update this TASK's `## Report` with:

1. fresh main SHA / branch / final commit
2. exact pre-change Auth/profile lifecycle
3. root cause analysis for missing-profile possibility
4. chosen remediation and rejected alternatives
5. password recovery architecture
6. account deletion architecture
7. exact user-owned tables/data touched by deletion candidate
8. security model and auth boundary
9. Settings/legal/support route map
10. every changed file
11. every migration/RPC/Edge Function candidate
12. tests and exact results
13. known limitations / manual steps
14. App Store implications
15. production mutation = 0 confirmation
16. PR URL/head SHA
17. next recommended phase
18. explicit note confirming Important News caller-auth files were untouched

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K2

**推奨モデル：Opus 5.5。**
