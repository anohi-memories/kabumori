# Claude Task 1

- task_id: kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

Codex slot 1は現在、`important-news-monitor` caller-auth PR #12のmerge-only作業を担当する。Claude slot 1は完全に別workstreamとして、consumer appのrelease blockerを進める。

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
- STOP for K1

**推奨モデル：Opus 5.5。**

## Report

- task_id: kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924
- result: source candidate complete, PR open, **production mutation = 0**
- fresh main at start: `bc302947` (my own in_progress control commit on `ef49385a`)
- fresh main at report time: `f36d4e3567994876c824642c20d16350ac4b81d8` — no file overlap with this branch
- branch: `claude1/mobile-release-blockers-auth-account`
- commit_hash: `8b78ecc22524b830c5e440e8f0b995fbb9a6f014`
- PR: https://github.com/anohi-memories/kabumori/pull/13 (head `8b78ecc2…`, not merged)
- push: branch pushed; `.agent` control sync pushed separately to `main` so it stays out of the PR diff
- deploy: none

### 1. Exact pre-change Auth/profile lifecycle

| Step | Actual behaviour on main |
| --- | --- |
| signup | `signUpWithEmail` → `auth.signUp`. Profile created **only if** the response already had a session. With email confirmation on it does not, so no profile at signup. |
| email confirmation | Entirely Supabase-hosted. The app has no route and never observes it. |
| first login | `signInWithEmail` → `prepareSession` → `ensureProfile`. First point a profile actually appeared. |
| session restore | `AuthProvider.getSession()` → `prepareSession`, same ensure path. |
| auth state change | `onAuthStateChange`, deferred one task so no Data API call runs inside Supabase's lock. |
| missing profile | `ensureProfile` threw → provider **dropped the session** and rendered the login form with the error attached. |
| logout | `signOut` removes this device's push token while RLS still authorises it, then signs out. Reachable only from the 銘柄 screen header. |
| deleted/disabled user | No in-app path existed. |
| RLS dependency | `profiles.id` → `auth.users(id) on delete cascade`; `tracked_stocks`, `alert_settings`, `alert_category_settings`, `notifications`, `device_push_tokens`, `personalized_reports` → `profiles(id) on delete cascade`. |

Profile creation was **client-driven**: no `auth.users` trigger exists, and no RPC owned it.

### 2. Root cause analysis for the missing-profile possibility

A confirmed auth user **can** exist without a profile today. Two source-level causes, both real:

1. Profile creation only ran on a session the client accepted, so an auth user who signed up but never completed a first login in the app has no profile row.
2. `ensureProfile` was a `select` then an `insert`. A failure between them (offline, transient error) left a valid session with no profile — and the old provider then showed that user the **login screen**, i.e. reported an auth failure for something that was not one.

What breaks without a profile: every user-owned table FKs to `profiles`, so tracked stocks, alert settings, notifications and reports cannot be written at all.

Which of the two produced the specific production pair (Auth users 2 / profiles 1) was **not** confirmed — that would need a read-only production query, which this task did not run. Stated as unconfirmed rather than guessed.

### 3. Chosen remediation and rejected alternatives

**Chosen:** `public.ensure_my_profile()` — one idempotent RPC, `security invoker`, id from `auth.uid()` only, `insert … on conflict (id) do nothing`, executable by `authenticated` only.

- `security invoker` rather than `definer`: the existing `profiles_insert_own` policy already restricts the write, so no elevated privilege is created.
- No argument exists, so a caller cannot name another account even if RLS were later relaxed.
- One statement: no TOCTOU window, safe to repeat.

**Rejected — trigger on `auth.users`:** it runs inside Supabase's signup transaction, so any failure turns every new signup into a 500, and this repo has a known migration-history inconsistency that makes broad auth-schema changes riskier than they look. The actual gap was the creation path the client already runs.

**Rejected — backfilling the existing profile-less auth user:** production data mutation, out of scope, and unnecessary: that user gets a profile at their next sign-in on this build.

**Also changed:** a failed profile preparation keeps the session and surfaces `profileError`; the app shows a recovery screen with 「もう一度試す」/「ログアウトする」 instead of the login form.

### 4. Password recovery architecture

```
login 「パスワードをお忘れの方」
 → resetPasswordForEmail(email, { redirectTo: Linking.createURL('reset-password') })
 → mail → kabumori://reset-password…
 → useRecoveryLink() (Linking.useURL) → parseRecoveryLink()
 → PasswordResetScreen, rendered ABOVE the auth gate
 → startRecoverySession() → applyNewPassword() → auth.updateUser({ password })
```

All three shapes Supabase may send are handled, because the client cannot choose which arrives: implicit (`#access_token`/`refresh_token` → `setSession`), PKCE (`?code` → `exchangeCodeForSession`), token hash (`?token_hash&type=recovery` → `verifyOtp`), plus `?error_code=otp_expired` → a plain Japanese message. Raw provider error text is never shown.

Rendered above the gate on purpose: the link arrives while signed out (no route would be mounted) **and** it creates a session of its own, which would otherwise drop the user into the app without ever setting a password.

The request reveals nothing about who is registered: success and "no such user" produce the same message.

### 5. Account deletion architecture

```
設定 → アカウントを削除 → retype the registered address
 → POST /functions/v1/account-delete   Authorization: Bearer <user JWT>, NO body
 → GET /auth/v1/user with that token            ← the only source of the user id
 → DELETE /auth/v1/admin/users/{verified id}    ← service role, hard delete
 → existing cascades remove the rows
 → client signs out (best effort; its failure cannot un-delete the account)
```

### 6. Exact user-owned data the deletion candidate touches

Removed by cascade from the single auth-user delete: `profiles`, `tracked_stocks`, `alert_settings`, `alert_category_settings`, `notifications`, `device_push_tokens`, `personalized_reports`, and any `admin_users` / `brand_memberships` / `social_account_oauth_states` rows keyed to that auth user. No per-table delete list is maintained in code that could drift from the schema.

### 7. Security model and auth boundary

- The function **never reads the request body** — there is no client-supplied id to trust. Pinned by a static test against the source.
- The user id comes only from the verified token; `deleteOwnAccount` has no id parameter.
- The service role key is used for exactly one call, is never returned, never logged, and never appears in an error. Every client-visible error is one of two fixed codes.
- The mobile client never receives the service role key.
- `404` (already gone) = success, so the call is safely repeatable.
- Every other non-2xx is a failure, so the UI can never show a deleted state the server did not confirm.

### 8. Settings/legal/support route map

No legal/privacy/support page exists anywhere in the repo (mobile, admin, web, docs) — nothing was duplicated.

Entry: 設定 button in the ホーム header → settings sheet: ログイン中のメールアドレス / パスワードを変更 / 通知の設定（既存の重要ニュース画面を案内、複製しない）/ プライバシーポリシー / 利用規約 / お問い合わせ・サポート / ログアウト / アカウントを削除.

**Why a sheet and not `app/settings`:** the navigator is expo-router `NativeTabs`, where every top-level route becomes a visible tab, and `hidden` tabs cannot be navigated to at all (`expo-router` types.d.ts). A new route would have added a sixth tab. The web export confirms the static route count is unchanged at 10. The screens are self-contained and can become real routes unchanged once a stack exists above the tabs.

**Unresolved URL values (no placeholder committed):** `EXPO_PUBLIC_PRIVACY_POLICY_URL`, `EXPO_PUBLIC_TERMS_OF_SERVICE_URL`, `EXPO_PUBLIC_SUPPORT_URL`. A value that is not `https://` or `mailto:` is treated as unset, so a leftover `TODO` can never become a broken link in review; the entry then says 準備中 instead of dead-ending.

### 9. Every changed file

New:
- `supabase/migrations/20260924100000_ensure_my_profile.sql`
- `supabase/functions/account-delete/{index.ts,delete_logic.ts,delete_logic_test.ts,wiring_test.ts}`
- `src/lib/{password-recovery.ts,account-deletion.ts,account-deletion-client.ts,legal-links.ts,settings-menu.ts}`
- `src/components/{password-reset-screen.tsx,profile-recovery-screen.tsx,settings-sheet.tsx}`
- `src/hooks/use-recovery-link.ts`
- `tests/app/{password-recovery_test.ts,account-deletion_test.ts,legal-links_test.ts,settings-menu_test.ts}`
- `docs/mobile-release/{ACCOUNT_LIFECYCLE.md,ensure_my_profile_proof.sql}`

Modified:
- `src/lib/auth.ts` — `ensureProfile` now calls the RPC; added `requestPasswordReset`
- `src/providers/auth-provider.tsx` — keeps the session on profile failure, exposes `profileError`
- `src/app/_layout.tsx` — recovery link above the gate, profile recovery screen
- `src/app/index.tsx` — 設定 entry point in the header
- `src/components/auth-screen.tsx` — 「パスワードをお忘れの方」

### 10. Migration / RPC / Edge Function candidates

- migration `20260924100000_ensure_my_profile.sql` — one narrow forward migration, function only (a test asserts it contains no table/policy/trigger/auth-schema change). **Not applied.** No `db push`, no history repair/reconcile.
- RPC `public.ensure_my_profile()` — `security invoker`, `search_path = ''`, `authenticated` only.
- Edge Function `account-delete` — new dedicated function, not a broadening of an existing one. **Not deployed.**

### 11. Tests and exact results

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read tests/app/` | **77 passed / 0 failed** (50 pre-existing + 27 new) |
| `deno test --no-check --no-lock --allow-read supabase/functions/account-delete/` | **17 passed / 0 failed** |
| combined run of both | **94 passed / 0 failed** |
| `deno check --no-lock` on both new function files | PASS |
| `npx tsc --noEmit`, `src/` scope | **2 errors, both pre-existing on main** (stale `.expo/types` typed-route for `/portfolio`, same 2 at the clean base) |
| `npx expo export --platform web` | PASS — bundled, **10 static routes, unchanged** |
| disposable PostgreSQL proof (`public.ecr.aws/supabase/postgres:17.6.1.165`) | `PROOF_RESULT PASS` |
| `git diff --check` | PASS |

Deletion authorization coverage: unauthenticated/malformed header rejected **before any network call**; auth-server rejection never reaches the admin endpoint; verified caller deletes exactly their own id with the service role key and **no body**; a spoofed id cannot appear in any call; repeated invocation after deletion reports success; 400/403/429/500/503 all fail closed; network failure on either hop fails closed; no thrown error carries the service role key or the caller token.

Password recovery coverage: all three link shapes, expired link, unknown error code, non-recovery links ignored, recovery path with no usable parameter, provider error text kept out of the UI, validation before any request, weak-password translation.

The DB proof asserts: caller gets their own id back; three calls produce one row; a second user is unaffected; a JWT-less call raises the function's own `AUTHENTICATION_REQUIRED` (message checked, not just SQLSTATE); `anon` and `service_role` hold no EXECUTE while `authenticated` does. A **negative control was run**: an extra `grant execute … to anon` is detected by that step, so it is not passing blindly. An earlier draft of that step *was* blind (it would have passed via anon's missing insert grant); it was found by the control and rewritten.

### 12. Known limitations / manual steps

1. Apply the migration (single-file, separately approved; no `db push`).
2. Deploy `account-delete`; it needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and should keep platform JWT verification on (it re-verifies the caller regardless).
3. Add `kabumori://reset-password` (plus the Expo dev URL while testing) to Supabase Auth's redirect allowlist.
4. Confirm the project's auth flow: `exchangeCodeForSession` only succeeds on PKCE; on a non-PKCE project that branch reports an expired-link message. The other two shapes are unaffected.
5. Decide and set the three URL values.
6. Send one real reset mail and run one real deletion against a disposable test account — **neither was done here**, both are production mutations.
7. **Social-mobile limitation, deliberately not handled:** deleting a user who connected X leaves the `brands` / `social_accounts` rows that flow created, since `brand_memberships` cascades but those tables do not. They belong to the social-mobile workstream and were not touched. Consumer Kabumori accounts do not go through that flow today. Recommend a dedicated follow-up owned by that workstream.
8. The 銘柄 screen keeps its existing ログアウト button; it was left unchanged to avoid an unrelated edit. Logout now also exists in Settings.
9. No iPhone/TestFlight E2E was run (out of scope for this task).

### 13. App Store implications

- Apple requires in-app account deletion when an app offers in-app account creation. This candidate is that path; it needs the deploy in step 2 to actually function.
- Working privacy and support URLs are required at submission and are still undecided (configuration, not code).
- Deletion is a hard delete, so the same address can sign up again afterwards.

### 14. Production mutation = 0 — confirmed

No migration applied, no `db push`, no history repair/reconcile, no Edge Function deployed, no Cron/Vault/OAuth/Function-secret change, no Auth provider or dashboard setting changed, no real reset mail sent, no real account deleted, no user row modified, no EAS/TestFlight/App Store Connect action, no Vercel/Netlify change, no Push production setting change. The disposable PostgreSQL proof ran in a throwaway container, which was removed afterwards.

### 15. Important News caller-auth — untouched (explicit)

`git diff --name-only` for this branch contains **zero** paths matching `important-news` or `20260923110440`. The seven H1 implementation files and the caller-auth migration were not read into this change, not edited and not tested against. Fresh `origin/main` (`f36d4e3`) merged PR #12 in the meantime; its changed files have **no overlap** with this branch. Other slots' uncommitted working-tree changes (`docs/news-cost-optimization/AUDIT_AND_PLAN.md` and other untracked files) were left untouched and unstaged.

### 16. Next recommended phase

1. K1 review of PR #13.
2. On PASS: apply the one migration and deploy only `account-delete`, with runtime read-back and a check that no other Function's version/`updated_at` moved.
3. Then set the Auth redirect allowlist and the three URLs, and run one real recovery and one real deletion on a disposable test account.
4. Then phase 2: iPhone/TestFlight E2E of signup → confirmation → first login → recovery → deletion.
