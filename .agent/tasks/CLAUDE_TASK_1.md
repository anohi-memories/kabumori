# Claude Task 1

- task_id: kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924
- owner: claude
- slot: claude-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus 5.5
- purpose: K1で確認した mobile recovery deep-link の Unmatched Route blockerを最小修正し、既存の同一disposable test accountで残りE2Eを完了する。

## Prior K1 facts

- signup/confirmation PASS
- first login/profile lifecycle/session restore/logout/re-login PASS
- recovery email delivery PASS
- iOSは kabumori://reset-password をアプリへ渡した
- expo-router Unmatched Route で停止
- password変更、Delete Account、最終regressionは未完了
- disposable test accountは再試験用に保持中
- 既存production userへの変更なし

## Scope

1. fresh origin/main と他slotのscopeを確認
2. Expo Router/native linking構成を調査
3. recovery intentだけを正しい既存recovery処理へ渡す最小source fixを実装
   - +native-intent.tsx 等を候補とするがfresh sourceに合わせて判断
   - recovery情報を失わない
   - unrelated unknown routeをcatch-allで握りつぶさない
   - visible tabを増やさない
4. focused recovery-routing tests + existing auth/mobile tests + type/lint/diff check
5. real iPhoneで同じdisposable accountを使って recovery flowを再試験
6. recovery成功後、アプリ内の通常Delete Account flowを実行
7. read-onlyで disposable account/profile/user-owned rowsの削除を確認
8. 最終regression確認

## Safety

- 新しいtest accountを作らない
- 既存production userを変更しない
- password/token/reset URLをTASK/Reportへ記録しない
- Supabase Auth Site URL / email template / provider設定を変更しない
- migration / unrelated deploy / admin manual delete禁止
- H1 queue/dispatcher、G2 admin、他workstreamを変更しない
- confirmation後に到達するunreachable Site URL問題は別blockerとして記録のみ

## Completion / K1

PASS条件:
- recovery deep-linkが実機でrecovery UIへ到達
- recovery flow完了
- 再login確認
- in-app account deletion成功
- disposable auth user/profile/user-owned rows削除確認
- 既存production userへの影響なし

完了時:
- status -> review_required
- next_owner -> chatgpt
- Reportに fresh main、changed files、root cause/fix、test counts、実機Gate C/D/E結果、削除確認、残blockerを記録
- STOP for K1

## Report — G1 result

- task_id: kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924
- result: **source fix complete (PR #17, unmerged). Real-device E2E paused by the user** after the retest hit Supabase's built-in email rate limit. **Resume later with the same disposable account.** Gate C retest, Gate D and Gate E are still pending.
- fresh main at start: `714ffe4`; in_progress control commit `3ee7c1d`

### Root cause and fix

- **Root cause:**
  - expo-router resolves every incoming system URL to a route before any component renders.
  - No route matches `kabumori://reset-password`, so it showed its Unmatched Route screen. The recovery screen rendered by `AuthGate` / `useRecoveryLink()` in the root layout never mounted.
  - The phase-1 unit tests covered `parseRecoveryLink` only, not the router's handling of an unknown system path.
- **Fix:**
  - New `src/app/+native-intent.tsx`: its `redirectSystemPath` delegates to a new `recoveryRedirectPath()` in `src/lib/password-recovery.ts`.
  - Recovery links go to `/`. That covers every shape `parseRecoveryLink` accepts (implicit / PKCE / token hash / expired-link error) plus bare paths.
  - The original URL, fragment included, still reaches `useRecoveryLink()` through expo-linking, which reads the native URL event itself. No recovery information is lost.
  - Every other link, including genuinely unknown ones, is returned unchanged, so it is not swallowed by a catch-all.
  - No route or tab is added.
- I confirmed in the installed expo-router source (`build/link/linking.js`, `build/getLinkingConfig.js`) that `redirectSystemPath` is applied to both the initial URL and later URL events.

### Changed files (PR #17, branch `claude1/recovery-deeplink-fix`, head `7dc5c9a`)

- `src/app/+native-intent.tsx` (new)
- `src/lib/password-recovery.ts` (adds `recoveryRedirectPath`)
- `tests/app/recovery-routing_test.ts` (new, 4 tests)

PR: https://github.com/anohi-memories/kabumori/pull/17

### Tests

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read tests/app/ supabase/functions/account-delete/` | **98 passed / 0 failed** (94 before + 4 new) |
| `npx tsc --noEmit`, `src/` scope | **0 errors** (the two earlier stale typed-route errors are gone after type regeneration) |
| `npx expo export --platform web` | PASS, **10 static routes (unchanged, no tab added)** |
| `git diff --check` | PASS |

### Real-device E2E status

- **Kabumori Metro:** restarted with `--clear` on 8081 from the fix branch in this worktree. LAN IP `192.168.188.127`. `packager-status:running` confirmed. No other project's process was touched.
- **Gate C retest: not yet executed.** The reset request in the app returned 「試行回数が多すぎます」.
  - Read-only timestamps for the test identity: confirmation sent 05:20:42 UTC, previous recovery sent 05:45:55 UTC. The request was at about 06:04 UTC, so two emails had gone out in under an hour.
  - This matches Supabase's built-in email sender limit (about 2 per hour). The rejected request sent nothing and consumed nothing.
- **Gate D (in-app deletion) and Gate E (final regression): not run.** They follow the Gate C retest.
- **Disposable test account:** still present and intentionally kept for the resume. Password unchanged, profile row still exactly 1.
- Current counts: `auth.users` 3 / `profiles` 2 (+1 each, the test identity only). No existing production user changed.

### How to resume (next G1)

1. Wait until at least one hour has passed since the last email to the project, so the rolling limit has cleared.
2. The user fully restarts the dev client and connects to the Kabumori Metro running from `claude1/recovery-deeplink-fix`, or from main once PR #17 is merged.
3. Gate C: request a reset from the login screen, open the new email's link on the iPhone, then check that the 「パスワードの再設定」 screen appears, the new password is set, and a logout followed by a login with the new password works.
4. Gate D: 設定 → アカウントを削除, retyping the address. Then read-only checks that the auth user, profile and user-owned rows are gone.
5. Gate E: counts back to the baseline (`auth.users` 2 / `profiles` 1), and `account-delete` / `ensure_my_profile` unchanged.

### Production mutations in this task

- **None beyond the disposable identity's own flow.** The retest request was rate-limited and sent no email.
- No Auth, SMTP or rate-limit setting, migration, deploy or admin action was touched.

### Release blockers (new or updated)

1. **Custom SMTP is required before release (new).**
   - Supabase's built-in sender is for testing only: about 2 emails per hour, and it applies regardless of plan.
   - Real signups and recoveries would be throttled almost immediately.
   - A custom SMTP provider works on the free Supabase plan. Candidates with free tiers: Resend, Brevo, and Amazon SES (pay-as-you-go).
   - It needs a sending domain with SPF/DKIM DNS records.
   - It is an Auth configuration change, so it needs its own approval.
2. The confirmation (and recovery) redirect lands on an unreachable Site URL (from the previous report).
3. Privacy / terms / support URLs are still undecided.
4. PR #17: K1 review, then merge. After that, finish the E2E resume above.


## K1 review — 2026-09-24

Result: **SOURCE FIX APPROVED / FULL E2E NOT YET PASS**.

Reviewed PR #17 at head `7dc5c9ae2b5c5dea626c8a21bc2bc7c18c724a43`.

Accepted source evidence:
- only 3 files changed: `src/app/+native-intent.tsx`, `src/lib/password-recovery.ts`, `tests/app/recovery-routing_test.ts`
- recovery system paths are redirected to the valid root route so the existing recovery gate can render
- original recovery URL data remains available to the existing recovery hook
- unrelated/unknown routes pass through unchanged
- no visible tab/route was added
- focused/auth tests: 98 passed / 0 failed
- TypeScript src scope: 0 errors
- Expo web export: PASS, 10 routes unchanged
- git diff --check: PASS
- no production mutation from the source fix

PR state:
- PR #17 remains open and unmerged
- Vercel status is failure only because of the repository deployment free-tier rate limit
- do not bypass that check merely to merge

E2E status:
- Gate C real-device retest is still pending because Supabase built-in email sending rate-limited the reset request
- Gate D account deletion and Gate E final regression are still pending
- same disposable account must be reused; do not create another account

Resume:
- keep this same task
- after the email rate limit clears, retry Gate C on the real iPhone using the same account
- if Gate C passes, continue directly to Gate D and Gate E
- after full E2E passes, return to `review_required` / `next_owner: chatgpt` for final K1
- PR #17 merge remains gated by successful required checks and final fresh-main review

No Auth Site URL/SMTP/config change is authorized by this K1.

## Report — G1 resume result (full E2E)

- result: **FULL E2E PASS**: Gate C (retest), Gate D and Gate E all pass on the real iPhone with the same disposable account. One side effect on an existing user's push-token row is disclosed below.
- source under test: PR #17 head `7dc5c9ae2b5c5dea626c8a21bc2bc7c18c724a43`, served by the Kabumori Metro on 8081 from `claude1/recovery-deeplink-fix` (LAN `192.168.188.127`). PR #17 is still **unmerged**, gated on required checks and the final fresh-main review, as K1 instructed.
- resume control commit: `05e183d`
- email rate limit: the retest was run after the rolling hour cleared; the only email in the previous hour was the one at 05:45 UTC. No Auth, SMTP or rate-limit setting was changed.

### Gate C — password recovery retest: **PASS**

- The reset email arrived, and the link opened the Kabumori app.
- The 「パスワードの再設定」 screen was shown. The fix works on the device: no Unmatched Route.
- The new password was set, followed by 「かぶモリを開く」 → logout → a successful login with the new password.
- Read-only: the test user's `auth.users.updated_at` advanced after the resume, consistent with the password update. The test user still had exactly 1 `profiles` row.
- No URL, token or password was recorded.

### Gate D — in-app account deletion: **PASS**

Rows owned by the test user just before deletion:

| Table | Rows |
| --- | --- |
| auth user | 1 |
| `profiles` | 1 |
| `tracked_stocks` | 1 (added by the user during testing) |
| `device_push_tokens` | 1 |
| `alert_settings` | 0 |
| `alert_category_settings` | 0 |
| `notifications` | 0 |
| `personalized_reports` | 0 |

- The app flow was 設定 → アカウントを削除 → retype the address → 「アカウントを完全に削除する」. The app returned to the login screen.
- No admin or manual delete was used. The only deleting path was the app → `account-delete` → a service-role delete of the verified caller.

After deletion (read-only):

- auth rows for the test identity: **0**
- orphan checks: `profiles` without an auth user 0; `tracked_stocks`, `device_push_tokens` and `notifications` without a profile all 0

| Table | Baseline | Now |
| --- | --- | --- |
| `auth.users` | 2 | **2** |
| `profiles` | 1 | **1** |
| `tracked_stocks` | 20 | **20** |
| `alert_settings` | 1 | **1** |
| `alert_category_settings` | 16 | **16** |
| `notifications` | 18 | **18** |
| `personalized_reports` | 12 | **12** |
| `device_push_tokens` | 1 | **0** (see below) |

The cascade removed every row the test user owned.

### Gate E — regression: **PASS, with one disclosed side effect**

- `account-delete`: v2, ACTIVE, `verify_jwt=True`, ezbr `0f1cc97736e3`, `updated_at` `1790210823880`. Unchanged.
- `ensure_my_profile`: security invoker, `search_path=""`, ACL `{postgres=X/postgres,authenticated=X/postgres}`. Unchanged.
- All 17 functions match the snapshot taken at the start of this E2E. The only change during the day was H1's `important-news-monitor` (v66), before this resume.
- **Side effect on an existing user:** the existing user's `device_push_tokens` row for this iPhone is gone (1 → 0).
  - Cause: the E2E ran on the owner's own iPhone. `device_push_tokens.expo_push_token` is globally unique by design (one device notifies one account).
  - Signing the real account out (`signOut` removes this device's token) or signing the test account in (the upsert reassigns the token) moved the row to the test user. The deletion cascade then removed it.
  - This is the app's intended device-switch behaviour. It is not data corruption and no other user row was touched.
  - It is **restored automatically when the owner signs back in to their real account on this iPhone**. Until then, that account gets no push on this device.
  - The user has been told to sign back in.
- No other existing user or row changed. No secrets, tokens, URLs or passwords were printed or recorded.

### Production mutations attributable to this task (all normal app flows)

1. the test user's recovery email
2. its recovery session
3. its password update
4. its sessions
5. one stock the user added while testing
6. its in-app self-deletion, with the cascade
7. the reassignment and removal of this iPhone's push-token row, as above

No migration, deploy, Auth config change, or admin/manual action was made.

### Remaining blockers

1. PR #17 merge. It is blocked only on the repository's Vercel free-tier deployment rate limit; per K1 that check must not be bypassed. Merge once checks are green, after a fresh-main review.
2. Custom SMTP (Auth config, needs approval).
3. The confirmation/recovery redirect lands on an unreachable Site URL (Auth config, needs approval).
4. Privacy / terms / support URLs are still undecided.
5. For future E2E runs: use a separate device or simulator, so the owner's own push-token row is not moved.


## Final K1 — 2026-09-24

Result: **PASS — real-device Auth/recovery/account-deletion E2E complete.**

Accepted:
- recovery deep-link opens the intended recovery UI on the real iPhone
- password reset succeeds
- logout and login with the new password succeeds
- in-app self-deletion succeeds
- disposable auth user/profile/user-owned rows are removed
- baseline counts are restored except the disclosed owner-device push-token side effect
- account-delete and ensure_my_profile remained unchanged
- no unrelated production mutation, migration, deploy, Auth config change, admin delete, secret/token/password exposure

Disclosed side effect:
- the owner's iPhone push-token row moved to the disposable account during device switching and was deleted with that account
- no other existing-user data changed
- the push token is expected to restore when the owner signs back in on that device

Source state:
- PR #17 remains open/unmerged
- source fix and real-device behavior are accepted by K1
- merge is deferred pending final Codex auth/security review and repository check availability

Remaining release blockers outside this completed G1:
- custom SMTP
- reachable confirmation/recovery redirect/Site URL
- privacy / terms / support URLs
