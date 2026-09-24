# Claude Task 1

- task_id: kabumori-mobile-auth-real-e2e-disposable-account-20260924
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
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
