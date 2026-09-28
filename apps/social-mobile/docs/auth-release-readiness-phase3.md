# App login release readiness — phase 3 (G3, 2026-09-28)

Source/UI/config only. No Supabase Auth provider, redirect allow-list, SMTP/template, Apple/Google/X console, migration or deploy change. `production_mutation=0`.

Builds on the accepted Phase 2 (PR #47 head `ed5f8b7`, main `fbddef2`); every Phase 2 boundary is unchanged (see `multi-provider-auth-phase2.md`).

## 1. Readiness model

`src/domain/auth-release-readiness.ts` (pure, deterministic) answers per provider:

| field | source | notes |
| --- | --- | --- |
| `enabledInSupabase` | public `GET /auth/v1/settings` | `yes` / `no` / `unknown` (unreadable ⇒ `unknown`) |
| `buildConfigPresent` | Supabase client config, `EXPO_PUBLIC_AUTH_PROVIDERS`, app scheme, plugins, Apple entitlement, `ios.bundleIdentifier` | device capability is not counted as build config |
| `sourceImplemented` | constant per provider | all four have an implemented path |
| `e2eVerified` | constant `false` | only a real-device run may claim it; source never does |
| `usableNow` | fail-closed conjunction | social: Phase 2 gate **and** no blocker at all; e-mail: sign-in capability |
| `blockers` | fixed codes | `backend_config`, `supabase_disabled`, `supabase_unknown`, `not_declared_for_build`, `callback_scheme`, `browser_plugin`, `apple_native_plugin`, `ios_bundle_identifier`, `apple_native_unavailable` |

The AuthProvider now gates sign-in, linking and e-mail sign-up/reset on this report (`readiness(p).usableNow`, `email`). E-mail sign-up and reset also require the callback scheme (their links return through it).

- Users see only 「利用中」/「追加できます」/「準備中」. They never see operator detail.
- Developer builds (`__DEV__`) show the diagnostic lines on the login-methods screen.
- Operators run `npm run auth:readiness -- [--platform ios|android|web] [--settings file.json | --fetch-settings]`:
  - It prints booleans and codes only, never the URL, keys or tokens.
  - It exits 1 on a blocking config error.
  - `--fetch-settings` is one read-only GET of the public settings endpoint.

## 2. Account / login UX (login-methods screen)

- **Signed-in account:** shows the e-mail address with 確認済み/未確認, or 「メールアドレスは登録されていません」 for accounts without e-mail.
- **Login methods:** e-mail, X, Apple and Google are each shown as 利用中/追加できます/準備中, from `getUserIdentities()` of the authenticated user.
  - 追加 is offered only when `usableNow`, through the Phase 2 explicit `linkIdentity` path.
  - Adding e-mail as a login method is shown as 準備中, because no safe path exists yet.
  - Unlink is not offered (no explicit backend/product contract). The screen says so.
- **Password:** for e-mail users, 「再設定メールを送る」 sends the same neutral recovery mail to the signed-in address, gated by `email.reset`. Users without e-mail get an explanation that they have no password.
- **X login vs X posting:** two separate rows with a link to Accounts.
  - The X login row shows 利用中/未設定.
  - The posting X connection row is 接続済み/要再接続/未接続, or 確認できません for mock/unloaded data.

## 3. App / deep-link config audit

| item | state | action |
| --- | --- | --- |
| app scheme | `kabumori-social` = `AUTH_CALLBACK_URL` scheme | checked by test against the real `app.json` |
| auth callback route | `kabumori-social://auth-callback` (`src/app/auth-callback.tsx` redirects; the provider completes) | unchanged |
| recovery / confirmation redirect | `emailRedirectTo` / `redirectTo` = auth callback | unchanged |
| PKCE `sb_flow_id` | `appendPkceFlowIdToRedirects: true`; code needs a valid flow id | allow-list must accept the appended query (operator gate G0) |
| posting callback | `kabumori-social://oauth-callback`, rejected by the auth parser | unchanged |
| iOS bundle identifier | **absent** in `app.json` | Apple native stays 準備中 (`ios_bundle_identifier`); must be chosen by the owner, not invented |
| Apple native | `expo-apple-authentication` plugin + `ios.usesAppleSignIn: true` present | checked |
| Browser OAuth | `expo-web-browser` plugin present; opens only the project authorize URL / validated provider URL | checked |
| Supabase client config | URL must be https, and the key must not be a secret/service_role key | `supabase_config_invalid` otherwise |
| secrets | none in source; `.env.example` has public names only | secret scan |

## 4. Real-device E2E checklist (future; none executed here)

**G0: redirect allow-list**
- Prerequisite: none.
- User action: the operator adds `kabumori-social://**` or an exact entry that accepts `?sb_flow_id=`.
- Expected: later gates return to the app.
- Failure/rollback: redirect to the Site URL instead of the app. Revert the entry.
- Mutates production config: **yes**.

**G1: e-mail sign-up and login**
- Prerequisite: G0; e-mail enabled; sign-up open; SMTP; `EXPO_PUBLIC_AUTH_PROVIDERS` includes `email`.
- User action: sign up with a new address, then with an already registered one.
- Expected: the same 「確認メールを送信しました…」 message both times. Password login works after confirmation.
- Failure/rollback: different messages (enumeration). Disable sign-up.
- Mutates production config: yes (settings/SMTP).

**G2: e-mail confirmation**
- Prerequisite: G1; "Confirm email" on.
- User action: open the confirmation link on the same device.
- Expected: signed in, then onboarding.
- Failure/rollback: 「同じ端末でもう一度お試しください」. Check the template and allow-list.
- Mutates production config: yes (template).

**G3: password recovery**
- Prerequisite: G1.
- User action: 「パスワードを忘れた」 (signed out) or 「再設定メールを送る」 (login-methods), open the link, set a new password.
- Expected: the new-password screen appears first. The new password works and the old one fails.
- Failure/rollback: `recovery_context_lost`. Check the allow-list.
- Mutates production config: no (uses G0/G1).

**G4: X app login**
- Prerequisite: G0; X provider enabled with an OAuth 2.0 client for the Supabase callback; `x` declared.
- User action: 「Xで続ける」.
- Expected: signed in. No posting permission. Onboarding still asks for the posting X connection.
- Failure/rollback: `provider_disabled` / cancel. Disable the provider.
- Mutates production config: **yes**.

**G5: Google login**
- Prerequisite: G0; Google provider and OAuth client; `google` declared.
- User action: 「Googleで続ける」.
- Expected: signed in. The same verified e-mail links automatically.
- Failure/rollback: as G4.
- Mutates production config: **yes**.

**G6: Apple login (iOS)**
- Prerequisite: owner chooses `ios.bundleIdentifier`; registered as Apple Client ID; dev build; `apple` declared.
- User action: 「Appleで続ける」 on a device.
- Expected: native sheet, then signed in. Cancel shows the cancel message.
- Failure/rollback: `apple_native_*` blockers in diagnostics. Remove `apple` from the declaration.
- Mutates production config: **yes** (Apple/Supabase).

**G7: explicit linking**
- Prerequisite: "Manual linking" on; G4–G6 as needed.
- User action: login-methods → 「○○を追加」.
- Expected: the method appears as 利用中 for the same user. A method used by another user shows the `identity_already_exists` message.
- Failure/rollback: `link_user_mismatch` signs out, which is safe. Turn manual linking off.
- Mutates production config: **yes**.

**G8: user-switch / recovery negatives**
- Prerequisite: G1–G3.
- User action: open a recovery link for A, then sign in as B before saving. Also switch users mid-onboarding.
- Expected: A's recovery is cancelled; B's password is untouched. Onboarding shows loading, then B's own state.
- Failure/rollback: any carry-over is a release blocker.
- Mutates production config: no.

**G9: simultaneous PKCE flows**
- Prerequisite: G4 or G5.
- User action: start two logins (e.g. Google, then cancel and start X) and complete the older one.
- Expected: each completes only with its own `sb_flow_id`. A stale one fails closed.
- Failure/rollback: login succeeds as the wrong flow. Release blocker.
- Mutates production config: no.

**G10: X login ≠ posting X**
- Prerequisite: G4 and the posting connector.
- User action: log in with X, then open login-methods and Accounts.
- Expected: 「Xでログイン: 利用中」 while 「投稿用のX接続」 stays 未接続 until the posting connect is done. No post is possible before it.
- Failure/rollback: posting enabled by the login alone. Release blocker.
- Mutates production config: no.

After each passing gate, the operator adds the provider to that build's `EXPO_PUBLIC_AUTH_PROVIDERS`. `e2eVerified` stays `false` in source; record the verification in the release notes.
