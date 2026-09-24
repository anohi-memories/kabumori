# Claude Task 1

- task_id: kabumori-mobile-auth-real-e2e-disposable-account-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus 5.5
- purpose: K1 PASS済みのmobile Auth/account lifecycleを、production backend + real dev client/deviceで disposable test account 1件だけ使って end-to-end 検証する。signup → confirmation → first login/profile creation → password recovery/deep-link → new password → in-app account deletion → backend deletion確認までを安全に通す。

## User authorization

2026-09-24、ユーザーは前K1で提示した次工程「disposable test accountで実E2E」に対して「やるか」と明示した。

このTASKで許可される本番操作は、**新規に作る disposable test account 1件だけ**に限定する。

Allowed:
- disposable test account 1件のsignup
- そのtest account宛のconfirmation email
- first login
- `ensure_my_profile()`によるそのtest account自身のprofile作成
- そのtest account宛のpassword reset email
- `kabumori://reset-password` deep-link
- test accountのpassword変更
- app内のDelete Accountによる、そのtest account自身の削除
- deletion後のAuth/profile/user-owned rowsのread-only確認

Forbidden:
- 既存production user/accountの変更・削除・password reset
- 他ユーザー行の変更
- admin/service-roleによる任意user id指定削除
- migration/deploy追加
- Auth provider/site URL/email template変更
- wildcard redirect追加
- TestFlight/App Store submission
- Vercel/Netlify変更
- Important News/H1、x-test-post/H2、admin/G2、market-report変更

## Approved current production state

K1 PASS:
- `public.ensure_my_profile()` production適用済み
- security invoker / expected grants / search_path verified
- `account-delete` v1 ACTIVE
- `verify_jwt=true`
- unauthenticated / non-user tokenは401 fail-closed
- production user/account deletionは未実施

User manual action completed:
- user reported `kabumori://reset-password` was added to Supabase Auth Redirect URLs.

Do not assume the redirect is correct if it can be verified safely; verify by actual recovery deep-link behavior during this E2E.

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK and prior G1/K1 report
5. Fresh fetch `origin/main`
6. Confirm no H1/H2/G2 overlap
7. Verify current dev server/app target and app scheme:
   - expected app scheme `kabumori`
   - current Expo dev-client route behavior
8. Read-only production baseline:
   - auth.users count
   - profiles count
   - no existing candidate test identity reused accidentally
   - `ensure_my_profile` exists
   - `account-delete` ACTIVE / verify_jwt=true
9. Do not print user emails, tokens, magic links, passwords, or reset URLs containing credentials into reports.

## Test identity safety

Use exactly one **new disposable email identity** that the user can actually receive.

If no safe disposable/test email address is already configured in project context:
- STOP before signup
- ask the user only for a test email address they control
- do not ask for or store their password
- do not use an existing production account as a substitute
- do not invent or use a public throwaway mailbox service

Password:
- user should enter it locally in the app/device
- never request the password in chat
- never record it in TASK/Report/logs

## E2E sequence

### Gate A — signup + confirmation

Using the real app/dev client:
1. signup the new disposable test account
2. verify the confirmation email is received
3. open/complete confirmation using the normal user flow
4. ensure no existing account/user was touched

Record only non-sensitive facts:
- signup accepted/rejected
- confirmation received yes/no
- confirmation completed yes/no
- resulting user existence yes/no

### Gate B — first login + profile lifecycle

1. first login with the confirmed test account
2. verify app reaches authenticated state
3. verify `ensure_my_profile()` succeeds
4. read-only verify exactly one `profiles` row exists for the test user
5. verify a second login/session restore does not duplicate profile
6. verify logout and re-login

Do not select/report the email or auth token in the task report.

### Gate C — password recovery

1. logout
2. request password reset from the app
3. verify reset email received
4. open the recovery link on the test device
5. verify it resolves to `kabumori://reset-password` / app recovery screen
6. set a new password locally
7. verify authenticated session behaves correctly
8. logout
9. verify login with new password succeeds
10. do not test the old password in a way that risks lockout/rate-limit loops; one negative check maximum if needed

If deep link fails:
- capture only non-secret route/error metadata
- do not paste the reset URL/token into reports
- stop before changing Auth config unless separately approved

### Gate D — in-app account deletion

1. from authenticated Settings, initiate Delete Account
2. complete the confirmation UX using the registered address locally
3. verify app receives success and signs out
4. read-only verify:
   - auth user no longer exists
   - profile no longer exists
   - tracked_stocks/alerts/notifications/device_push_tokens/personalized_reports rows for that test user are gone where applicable
5. invoke no admin delete manually unless diagnosing a failed app flow and explicitly approved
6. verify a repeated delete is not needed; do not recreate the account in this task

### Gate E — regression/readiness

After deletion:
- ensure no existing production user/account/profile counts changed except the temporary +1 then -1 disposable lifecycle
- verify `account-delete` function remains ACTIVE and unchanged
- verify `ensure_my_profile` remains unchanged
- no unrelated Functions/DB objects changed
- no production secrets printed

## Device/dev-server handling

The current dev server was previously reported on port 8082 because 8081 is occupied by `kabumori-social-mobile`.

Do not stop the 8081 process.
Use the current Kabumori dev server/Expo dev client as-is if healthy.
If a restart is required, restart only the Kabumori process and preserve the other project.

If the task needs the user to tap an email/deep link or enter credentials on-device:
- stop at that exact step
- tell the user exactly what to tap/type
- resume after the user confirms completion

## Success criteria

PASS only if all are true:
- signup works
- email confirmation works
- first login works
- profile created exactly once
- session restore/logout/re-login works
- reset email arrives
- recovery deep-link opens correct app screen
- new password set succeeds
- login with new password succeeds
- in-app deletion succeeds
- Auth user removed
- profile/user-owned rows removed
- no other account affected

If any stage fails, do not patch production automatically. Report exact failing gate and likely cause for K1.

## Report

Update this TASK with:
- fresh main SHA
- device/dev-client/server context
- baseline counts (counts only)
- each Gate A-E PASS/FAIL
- profile row lifecycle result
- recovery deep-link result without URL/token
- deletion cascade result by table/count only
- exact production mutations attributable to the disposable test lifecycle
- confirmation that no existing user was changed
- any rate-limit/email-delivery/deep-link issue
- next release blocker
- status `review_required`
- next_owner `chatgpt`
- STOP for K1

**推奨モデル：Opus 5.5。**

## Report — G1 result

- task_id: kabumori-mobile-auth-real-e2e-disposable-account-20260924
- result: **Gate A PASS, Gate B PASS, Gate C FAIL** (a source bug in the recovery deep-link handling). **Gate D and Gate E not run.** I stopped here per this TASK. No production patch was made.
- fresh main at start: `3e026ee`; in_progress control commit `61ffed2`

### Device / dev-client / server context

- real iPhone running the Kabumori dev client, against the production Supabase backend
- the Mac was rebooted during the task. After the reboot port 8081 was free (social-mobile was no longer running), so I restarted **only the Kabumori Metro**, on `8081`, from this worktree at main's code. LAN IP after the reboot: `192.168.188.127`. `packager-status:running` confirmed.
- app scheme: `kabumori`

### Baseline (counts only, before signup)

| Table | Count |
| --- | --- |
| `auth.users` | 2 |
| `profiles` | 1 |
| `tracked_stocks` | 20 |
| `alert_settings` | 1 |
| `alert_category_settings` | 16 |
| `notifications` | 18 |
| `device_push_tokens` | 1 |
| `personalized_reports` | 12 |

- `ensure_my_profile` present: security invoker, ACL `{postgres=X/postgres,authenticated=X/postgres}`
- `account-delete` ACTIVE, `verify_jwt=true`, ezbr `0f1cc97736e3` and `updated_at` unchanged since my deploy
- the test identity was checked before signup: 0 existing `auth.users` rows for it
- Observations (not mine):
  - Every function's listed version moved +1 at the same moment with unchanged `updated_at` and hash, which looks like platform renumbering (`account-delete` is now listed as v2 with identical code).
  - `important-news-monitor` changed hash and `updated_at` (v66), consistent with the H1 rollout.

### Gate A — signup + confirmation: **PASS**

- signup accepted in the app, and the 「確認メールを送信しました」 message was shown
- confirmation email received
- confirmation completed: `email_confirmed_at` is set. `auth.users` went 2 → 3, and exactly 1 row exists for the test identity.
- no profile at this point. This is expected (confirmation on means no session at signup) and confirms root cause #1 from the phase-1 audit.
- **Issue found (release blocker, not changed):** after the link verifies, Supabase redirects to the project Site URL. On the phone this showed 「サーバーに接続できませんでした」. The confirmation itself succeeded, but a real user sees what looks like an error. It needs a reachable Site URL or a confirmation redirect, which is an Auth config change and was not approved here.

### Gate B — first login + profile lifecycle: **PASS**

- The first login reached the home screen, with no profile recovery screen.
- `ensure_my_profile()` created the test user's profile. Profiles went 1 → 2, with **exactly 1** row for the test user.
- Session restore (full app kill and relaunch) stayed signed in.
- Logout from 設定 worked, and re-login worked.
- After all of the above the test user still had **exactly 1** profile row, so there was no duplicate.
- The test user had 1 `device_push_token` row: this device, registered by the app. It is left for the deletion cascade check.

### Gate C — password recovery: **FAIL at step 5**

- The reset request from the login screen worked, and the success message was shown. `recovery_sent_at` is set for the test user.
- The reset email was received.
- The link opened on the iPhone, went through Supabase's verify step, and **iOS handed `kabumori://reset-password` to the Kabumori app**. So the Redirect URL allowlist entry the user added works, and the scheme is registered.
- **Failure:** the app showed expo-router's default 「Unmatched Route — Page could not be found. kabumori://reset-password」 screen instead of the password reset screen. No password was changed.
- **Likely cause (source):**
  - The recovery screen is rendered by `AuthGate` in `src/app/_layout.tsx` via `useRecoveryLink()`.
  - When the incoming path matches no route, expo-router renders its Unmatched screen and our root layout's gate is not shown. The user was signed out, and the phone showed the Unmatched screen rather than the login form, which means `AuthGate` was not what rendered.
  - There is no route for `/reset-password`, and there is no `src/app/+native-intent.tsx`.
  - The unit tests covered `parseRecoveryLink` in isolation but not expo-router's handling of an unknown system path. That gap in the phase-1 tests is my own.
- **Candidate fix (needs its own PR and review; not done here):**
  - Add `src/app/+native-intent.tsx` whose `redirectSystemPath` maps an incoming `reset-password` system path to `/`, so the router never lands on Unmatched.
  - Keep the original URL available to `useRecoveryLink()`, either from `Linking.useURL()` or by carrying the link parameters over.
  - Add a test that feeds a `reset-password` system path through the redirect function.
  - A real `app/reset-password` route is not an option, because under `NativeTabs` it would become a visible tab.
- Nothing about the link or token was recorded. The user was asked not to paste the URL.

### Gate D — in-app deletion: **not run**

The test account was **kept on purpose**, so Gate C can be re-run with the same identity after the fix and then continue straight into Gate D in the planned order. This TASK forbids recreating the account, and deleting it now would mean a second disposable signup later. If K1 prefers cleanup now, the next G1 can run Gate D alone with this account: in-app deletion, then a cascade check.

### Gate E — regression: **partial**

- Current counts: `auth.users` 3 (+1, the test user) and `profiles` 2 (+1, the test user's profile). No existing user or profile changed.
- `account-delete` and `ensure_my_profile` are unchanged.
- No secrets, tokens, reset URLs or passwords were printed or recorded. The test email appears only in read-only query predicates; no email appears in this report.

### Production mutations attributable to this task

All of them are the disposable identity's own normal user flow:

1. signup of 1 test auth user
2. its confirmation
3. its sessions
4. its own `profiles` row (created by the RPC)
5. its own `device_push_tokens` row (created by the app)
6. one recovery email to it

Nothing else was mutated: no admin or service-role action, no Auth config, no deploy, no migration, and no other user touched.

### Next release blockers

1. **Recovery deep link fix.** `+native-intent` redirect plus a test, through a PR and K1. Then re-run Gate C → D → E with the same test account.
2. **Confirmation (and recovery) redirect lands on an unreachable Site URL.** Decide a reachable Site URL, or add an `emailRedirectTo` for signup. This is an Auth config change and needs its own approval.
3. Privacy / terms / support URLs are still undecided.
