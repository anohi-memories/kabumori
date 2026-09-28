# Auth / X connect / onboarding — phase 1 (G3, 2026-09-28)

Source-only. No production OAuth, rollout, migration or X mutation.

## 1. Inventory (before this change)

| area | state | evidence |
| --- | --- | --- |
| sign in (email/password) | implemented and usable | `providers/auth-provider.tsx`, `components/auth-screen.tsx` (Supabase Auth, publishable key only) |
| sign up / account creation | **missing — product gate** | no UI/flow; who may register (open vs invite) and e-mail confirmation policy are not decided |
| password recovery | **missing — product gate** | no UI/flow; needs a redirect/deep-link contract for recovery links |
| session restore | implemented and usable | `getSession()` + `onAuthStateChange`, AsyncStorage persistence, AppState auto refresh |
| logout | implemented and usable | `SignOutButton` → `auth.signOut()`; all signed-in providers unmount |
| X account connection | partial | full PKCE flow existed only inside the Accounts screen; no refresh of app data after success |
| X OAuth callback / deep link | partial | parsing/validation in `lib/x-oauth-onboarding.ts` (in-app auth session); no route for `kabumori-social://oauth-callback` if the OS delivers the link |
| connected-account state | partial | Accounts list showed status; after connecting, data stayed stale; real-data errors fell back to **mock accounts** |
| reauth / reconnect | partial | backend reuses the user's account row on re-begin; UI said "別のXアカウントを接続" and had no reason text |
| onboarding progress | missing | signed-in users landed on Home directly |
| first-run settings | partial / blocked by backend | Settings tab can edit content settings, but `social_mobile_content_settings` is not deployed in production |
| error/loading/empty states | partial | auth errors all mapped to "check e-mail/password"; accounts had no empty/blocked state |

Backend used unchanged (live in production): Edge `x-oauth-connect-user` (start + callback, user JWT forwarded, no service role) and RPCs `begin_/consume_/complete_social_mobile_x_oauth_connection` (workspace `u_<md5(uid)>` + owner membership + one X account per user, unique X identity, tokens only in Vault).

## 2. First-run journey (implemented)

1. Launch → session restore (`AuthProvider`).
2. No session → sign in (`AuthScreen`). Sign-up / recovery: explicit "not available in this app yet" (gate).
3. Signed in, real-data mode → `OnboardingGate` derives the step from server state (`domain/onboarding.ts`):
   - no workspace / no X account / interrupted connection → **connect X** (existing flow via `useXConnect`)
   - `connection_status = 'failed'` → **reconnect X** with a fixed reason from `last_connection_error_code`
   - >1 owned workspace or >1 X account → **fail closed** (no guessing)
4. Connected (`identity_verified`) → **confirm** the verified handle.
5. **Minimum settings**: done when the brand has a content-settings row, or the user chooses "ホームへ進む（投稿の好みはあとで設定）" (per-user local flag). When the settings store is not deployed the step says so and still lets the user continue.
6. → Home (tabs). The local mock preview (`EXPO_PUBLIC_DATA_SOURCE=mock`) is never gated.

## 3. Changes

- `domain/onboarding.ts` (pure step derivation), `data/onboarding-repository.ts` (RLS reads: self-membership → that brand's X account non-secret columns → settings-row existence), `features/onboarding/onboarding-gate.tsx`, `features/x-connect/use-x-connect.ts` (the single connect/reconnect implementation, extracted unchanged from the Accounts screen), `app/oauth-callback.tsx` (redirect only, never parses/stores the link), `lib/auth-errors.ts`.
- `app/_layout.tsx`: session → gate → app; `app/accounts/index.tsx`: uses the hook, reloads data after connect, reconnect copy/state, empty/blocked states; `providers/data-provider.tsx`: additive `reload()`; `providers/active-account-provider.tsx`: mock accounts only in mock preview; `providers/auth-provider.tsx` + `components/auth-screen.tsx`: fixed error messages, honest copy.

## 4. Remaining gates / gaps

- Product: sign-up policy (open/invite, e-mail confirmation), password recovery link contract, multi-workspace UX.
- Backend: `social_mobile_content_settings` deploy (settings persistence; also Stage 3B consent store).
- Config: X Developer Portal redirect `kabumori-social://oauth-callback`; `EXPO_PUBLIC_DATA_SOURCE=supabase` + publishable key for real-data builds.
- UX (G4-owned Home): Home still shows a fixed "接続済み" pill for the selected account; it should read `connectionStatus`.
- Disconnect/revoke X account is not offered (backend has no revoke RPC).
