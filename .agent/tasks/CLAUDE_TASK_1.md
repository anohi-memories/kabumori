# Claude Task 1

- task_id: kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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
