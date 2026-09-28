# Multi-provider sign-up / login — phase 2 (G3, 2026-09-28)

Source-only. No Supabase Auth provider/config change, no migration, no OAuth console change, no X post.

## 0. Phase 0 integration

PR #42 merged at `f0cac1505184a2abd9c9d504142012a1be999cf3` (head `c5e0157`), PR #44 merged at `7870d10170d31e0a6b78ab245f4e9152a3628f00` (head `966d412`). Every accepted file is byte-identical on main; only `package.json` overlapped (non-conflicting). Regression on the merged main: `npm test` 16/16, data-view 14/14, typecheck, lint, Expo web export.

## 1. Inventory before phase 2

| contract | state |
| --- | --- |
| e-mail/password sign-in, session restore, logout | usable |
| e-mail sign-up, verification, password recovery | missing |
| Apple / Google / X app login | missing |
| auth deep link | missing (only the posting-X `oauth-callback` existed) |
| identity linking | missing |
| posting-X connect (`x-oauth-connect-user` + Vault) | usable (phase 1) |
| first workspace | server-side only, created by `begin_social_mobile_x_oauth_connection` on the first posting connect |
| provider configuration | config-gated (unknown per project) — now read at runtime from `GET /auth/v1/settings` |

## 2. Provider matrix (after phase 2)

| provider | flow | client state | config gate |
| --- | --- | --- | --- |
| メールアドレス | `signUp` (PKCE, `emailRedirectTo` auth callback) / `signInWithPassword` / `resetPasswordForEmail` → recovery link → `PASSWORD_RECOVERY` → new-password screen → `updateUser` | implemented | "Confirm email" choice, SMTP, redirect allow-list `kabumori-social://**` |
| X | Supabase Auth provider `x` (OAuth 2.0) via `signInWithOAuth` + in-app browser + `exchangeCodeForSession` | implemented, offered only if `external.x` | X app: OAuth 2.0 client for Supabase callback `https://<ref>.supabase.co/auth/v1/callback`, "Request email" on; Supabase X provider enabled |
| Apple | iOS: native `expo-apple-authentication` → `signInWithIdToken` with nonce (hashed to Apple, raw to Supabase); other platforms: OAuth in browser | implemented, offered only if `external.apple` (+ native availability on iOS) | Apple provider with the app bundle id as Client ID; `ios.bundleIdentifier` (not yet set in app.json); OAuth (Services ID + key rotation every 6 months) only if Android/web Apple is wanted |
| Google | `signInWithOAuth` + in-app browser + PKCE | implemented, offered only if `external.google` | Google OAuth client for the Supabase callback. Native `@react-native-google-signin` (Supabase's recommended mobile flow) is a later upgrade needing web/iOS/Android client ids and a dev build |

Providers not enabled on the project are shown as "（準備中）" and are not pressable — never a fake success.

## 3. App login X ≠ posting X

- Login uses Supabase Auth; only the Supabase session is kept. `provider_token` / `provider_refresh_token` are never read (enforced by test).
- Posting X stays the existing `x-oauth-connect-user` + Vault + refresh authority path (`useXConnect`); login code never calls it and the posting hook never calls login APIs (enforced by test).
- Separate deep links: `kabumori-social://auth-callback` (login) vs `kabumori-social://oauth-callback` (posting); each parser rejects the other.
- After an X login the onboarding explains that using the same X account for posting is a separate permission and continues into the posting connect step.

## 4. Identity linking / duplicate-account policy

- Automatic linking is Supabase's own behavior only: identities with the **same verified e-mail** are linked by Supabase; unverified ones are not. The app never merges by name/handle and never reads `user_metadata` (enforced by test).
- E-mail then Google (same verified address): Supabase links automatically.
- Later adding Apple / X to the same user: explicit, authenticated `linkIdentity()` from **アカウント → ログイン方法** (requires "Manual linking" enabled; otherwise a truthful `manual_linking_disabled` message).
- Provider with no trusted e-mail (typical for X, Apple private relay): Supabase creates a new user. Before any workspace exists the app shows 「新しいアカウントを作成しました」 with the recovery instruction (log out → sign in with the original method → add this method). No workspace is created until the user continues and connects posting X.
- Linking a method already used by another user fails with `identity_already_exists` → fixed message; nothing is merged.
- E-mail sign-up for an existing address returns Supabase's obfuscated response; the app shows a neutral next step (no enumeration). Password reset always answers the same.
- Recovery for a mistaken second account: sign in with the original method; the stray account has no workspace and can be deleted by the existing account-deletion path/operator.
- Unlinking is not offered in this phase.

## 5. First workspace / onboarding continuation

Unchanged model: login → (new-account notice if applicable) → onboarding gate → posting X connect (`begin_social_mobile_x_oauth_connection` creates exactly one `u_…` workspace + owner membership server-side) → verified handle → minimum settings → Home. No client-side privileged writes.

## 6. Activation order (recommendation, not executed)

1. Redirect allow-list: add `kabumori-social://**`; enable PKCE-compatible e-mail templates (`{{ .ConfirmationURL }}` default works) and decide "Confirm email".
2. E-mail sign-up + recovery (lowest external dependency) → real-device test of confirmation and recovery links.
3. X provider (OAuth 2.0 client for the Supabase callback, request e-mail) — note it is a different client/callback from the posting connector.
4. Apple: set `ios.bundleIdentifier`, register it as Apple Client ID, dev build test on device.
5. Google: OAuth client; later migrate to native Google Sign-In.
6. Enable "Manual linking" once 2–5 are verified; then test linking and `identity_already_exists`.
