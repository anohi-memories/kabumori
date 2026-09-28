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

## 2. Provider matrix and readiness (after the H1 correction)

Readiness is three separate facts, never merged into one "ready" flag (`providerReadiness` in `src/domain/auth-flows.ts`):

| level | source | meaning |
| --- | --- | --- |
| `enabledInSupabase` | public `GET /auth/v1/settings` (`external.<provider>`) | the project accepts the provider; unknown settings ⇒ false |
| `configuredForBuild` | build declaration `EXPO_PUBLIC_AUTH_PROVIDERS` (default `email`) + platform facts | the operator configured this build for it (Apple native also needs `ios.bundleIdentifier` + native availability) |
| `e2eVerified` | constant `false` | no provider is claimed end-to-end verified by code; that is a device/console gate |

A method is offered only when `usable = enabledInSupabase && configuredForBuild`; otherwise it shows 「（準備中）」 and is not pressable. E-mail: sign-in needs `email` configured and not disabled on the project; sign-up additionally needs `external.email` and `disable_signup === false` (unknown ⇒ no sign-up); reset needs `external.email`. The UI disables the corresponding tab/button and the provider re-checks before calling Auth.

| provider | flow | build declaration | console gate |
| --- | --- | --- | --- |
| メールアドレス | `signUp` (PKCE, `emailRedirectTo` auth callback) / `signInWithPassword` / `resetPasswordForEmail` → recovery link → bound recovery → `updateUser` | `email` | "Confirm email", SMTP, redirect allow-list |
| X | `signInWithOAuth('x')` → in-app browser → callback with `sb_flow_id` → `exchangeCodeForSession(code, { flowId })` | `x` | X OAuth 2.0 client for `https://<ref>.supabase.co/auth/v1/callback`, request e-mail; Supabase X provider |
| Apple (iOS) | native `expo-apple-authentication` → `signInWithIdToken` (nonce: SHA-256 to Apple, raw to Supabase) | `apple` + `ios.bundleIdentifier` (not set yet ⇒ not usable) | Apple provider Client IDs include the bundle id |
| Apple (web/Android) | browser OAuth like X | `apple_web` | Services ID + secret key (rotates every 6 months) |
| Google | `signInWithOAuth('google')` → browser → PKCE by flow id | `google` | Google OAuth client for the Supabase callback |

## 3. App login X ≠ posting X

- Login uses Supabase Auth; only the Supabase app session is kept. Posting X stays `x-oauth-connect-user` + Vault (`useXConnect`); login code never calls it and the posting hook never calls login APIs (enforced by test).
- Separate deep links: `kabumori-social://auth-callback` (login) vs `kabumori-social://oauth-callback` (posting); the strict auth parser rejects the posting callback.

## 4. Provider credential storage policy

- `provider_token` / `provider_refresh_token` are never persisted and never placed in React context. The Supabase client storage is `createSanitizingStorage(AsyncStorage | localStorage)` (`src/lib/session-storage.ts`): every `setItem` removes both fields (top level and nested `currentSession`) before writing. The context's `session` is `stripProviderCredentials(session)`.
- The app session (access/refresh token, user) is persisted unchanged, so restore/refresh/logout behave as in phase 1.
- Verified behaviorally with the real locked supabase-js (`tests/auth-sdk-behavior.test.mjs`): after a PKCE exchange whose response carries provider tokens, the storage payload contains neither the values nor the field names, and a fresh client restores the session. No code reads provider tokens (only the sanitizer names the fields; enforced by test).
- Provider API access is not needed for login. The posting X token lives only in Vault on the server.

## 5. Callback parsing, flow id and duplicate delivery

- `parseAuthCallbackUrl` accepts only exactly `kabumori-social://auth-callback` (no userinfo, no port, empty path or `/`). Only `code`, `sb_flow_id`, `token_hash`, `type`, `error`, `error_code`, `error_description` are allowed; any other field (including implicit `access_token`), a repeated field within or across query/fragment, `code`+`token_hash`, `code`+`type`, or an error together with a credential ⇒ invalid.
- supabase-js is created with `flowType: 'pkce'` and `experimental.appendPkceFlowIdToRedirects: true`, so each redirect carries its own `sb_flow_id`. A `code` without a valid `sb_flow_id` (`^[A-Za-z0-9_-]{8,64}$`) is invalid. The code is exchanged with `exchangeCodeForSession(code, { flowId })`: the verifier is looked up only for that flow — no fallback to the latest verifier, so concurrent flows A/B each use their own verifier and a stale flow fails closed.
- A browser round trip completes only the flow it started (`expectation.flowId`); another flow's callback is refused before any exchange.
- The same code / token hash delivered twice (browser result and OS deep link) shares one in-flight promise and gets the real result (success or failure) — never an assumed success. Up to 32 outcomes are remembered.
- Operator gate: the redirect allow-list must accept `kabumori-social://auth-callback?sb_flow_id=…` (e.g. `kabumori-social://**`).

## 6. Identity linking

- Sign-in URLs must be `https://<project host>/auth/v1/authorize` (no userinfo/port). Link URLs returned by `linkIdentity` are the provider's own authorize URL: accepted only for that provider's host (Google `accounts.google.com`, X `x.com`/`twitter.com`, Apple `appleid.apple.com`), https without userinfo/port, and with exactly one `redirect_uri` equal to `https://<project host>/auth/v1/callback`. Anything else is never opened.
- Linking is explicit from **アカウント → ログイン方法** only, for the signed-in user. After the round trip, the result user and the current session user must both equal the user who started the link; otherwise the app signs out and shows `link_user_mismatch` — never continues as another user.
- Apple linking path: **iOS uses native** Sign in with Apple and `linkIdentity({ provider: 'apple', token, nonce })` (ID-token link with the user's own session; no Services ID). Other platforms use the browser OAuth link and require `apple_web`.
- Automatic linking remains Supabase's own verified-e-mail behavior. No merging by name/handle, no `user_metadata` (enforced by test). `identity_already_exists` ⇒ fixed message. Unlinking is not offered.

## 7. E-mail sign-up without enumeration

A new address and an already registered address give the same UX: when no session is returned (or Supabase answers `email_exists` / `user_already_exists` / `identity_already_exists`), the screen shows the single fixed message 「確認メールを送信しました。…届かない場合は、ログインまたはパスワード再設定をお試しください。」. Password reset always answers the same.

## 8. Password recovery binding

`PASSWORD_RECOVERY` binds recovery to `{ userId, sessionId }` (JWT `session_id`). Any other auth event whose session is not that exact user+session (another user's login, a new sign-in, sign-out) clears it. `completePasswordRecovery` re-reads `getSession()` and re-checks the binding immediately before `updateUser`; on mismatch it clears recovery and returns `recovery_context_lost` without changing any password.

## 9. New-account notice and user switch

The notice 「新しいアカウントを作成しました」 is shown while the user has exactly one non-email identity, no workspace, and has not acknowledged it — no time limit; it disappears only on explicit acknowledgment (per user). Onboarding state is kept with the user id it was loaded for; after a user switch the gate shows loading until the new user's state is read, so neither onboarding progress nor the acknowledgment carries over.

## 10. First workspace / onboarding continuation

Unchanged: login → (new-account notice) → onboarding gate → posting X connect (`begin_social_mobile_x_oauth_connection` creates the one `u_…` workspace + owner membership server-side) → verified handle → minimum settings → Home. No client-side privileged writes.

## 11. Remaining console / device gates (not executed)

1. Redirect allow-list accepts `kabumori-social://auth-callback?sb_flow_id=…`.
2. E-mail: "Confirm email", SMTP, PKCE templates; device test of confirmation and recovery links (including recovery A → login B).
3. X / Google: provider enablement and OAuth clients; device PKCE round trip with two concurrent attempts.
4. Apple: set `ios.bundleIdentifier`, register it as Client ID, dev-build test of sign-in and native linking.
5. "Manual linking" enabled; test linking, `identity_already_exists`, and a mismatching link user.
6. Per build, set `EXPO_PUBLIC_AUTH_PROVIDERS` only after the matching gate passes. `e2eVerified` stays false in code.
