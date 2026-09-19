# Phase 9 — X OAuth onboarding for general social-mobile users

Status: design + implementation candidate. Nothing in this document has been applied or deployed to
production. See the task Report for exact commit/push/read-back state.

**2026-09-19 K2 follow-up**: the first candidate had two real bugs, both now fixed on this same branch
(see the migration file's own header note and `oauth_logic.ts` for the exact fix commentary):
1. State was hashed twice on the round trip (the start step sent the already-hashed value to X as
   `state`, so hashing whatever X returned a second time at callback time never matched what was stored).
   Fixed: exactly one hash computation now happens, at callback time, over the one raw state value the
   client generates and X returns unchanged.
2. The state was marked "consumed" at lookup time, before the token exchange / identity read / Vault
   write — so any transient failure after that point permanently burned the state and made the attempt
   unretryable. Fixed: the lookup RPC is now read-only and repeatable; the one atomic, irreversible
   "consume" moment moved into the completion RPC itself (the same UPDATE that finalizes the connection),
   so retries are safe up until success, while replay after a real success and concurrent duplicate
   completions are both still denied.

## 1. Existing architecture (Phase A inventory)

Read-only inventory performed against both the current `main` branch and the actually-deployed production
Edge Function/RPC code (downloaded via `supabase functions download`, since `main`'s own migration
history is known to lag behind what is really applied in production — see
`.agent/CURRENT_STATE.md` `known_issue`).

### `x-oauth-connect` (existing, untouched by this phase)

A single Edge Function handling exactly **two hardcoded accounts**:

- `account_config.ts` defines `AI_LAB` and `KABUMORI` as literal constants (brand id, social account id,
  expected handle, scopes, RPC names). `resolveOAuthStartConfig(handle)` / `resolveOAuthCallbackConfig(...)`
  only ever match one of these two; anything else throws `OAUTH_HANDLE_NOT_ALLOWED` /
  `OAUTH_STATE_ACCOUNT_NOT_ALLOWED`.
- The `POST` (start) path is gated by `resolveAdminAuthorization` — **only a user in `admin_users` may
  start a connection**, plus a Supabase-Dashboard-secret-key bypass for the same admin-only Send Request
  console flow used throughout this project's other admin-only Functions.
- PKCE: `start_logic.ts` generates `state`/`code_verifier` **server-side**, hashes `state`, and stores the
  verifier in **Vault** via a per-account RPC (`begin_ai_salaryman_lab_oauth_connection` /
  `begin_kabumori_oauth_recovery`) alongside a `social_account_oauth_states` row.
- The callback is a `GET .../x-oauth-connect/callback` hit directly by X's browser redirect (this is a
  **web/admin-console** flow, not a mobile deep-link flow) — it looks up the state row, validates it via
  `assertOAuthCallbackState` (hash match, not consumed, not expired, has a verifier), exchanges the code
  via `POST https://api.x.com/2/oauth2/token` (Basic auth with `X_CLIENT_ID`/`X_CLIENT_SECRET`), verifies
  identity via `GET https://api.x.com/2/users/me`, and — critically — `verifyReadOnlyXIdentity` requires
  the resulting `username` to match a **pre-registered** `expectedHandle` already sitting on
  `social_accounts.handle`. This is the correct behavior for "we already know which brand this handle
  belongs to, an admin configured it ahead of time" but is the wrong shape for "a brand-new general user
  is connecting their own account for the first time and there is nothing to check against yet."
- Both `begin_*`/`complete_*`/`consume_*` RPCs for both accounts are **hardcoded to a literal
  `brand_id`/`social_account_id` string** (`'ai_salaryman_lab'`/`'ai_salaryman_lab_x'`,
  `'kabumori'`/`'kabumori_x'`) inside the SQL body itself, and contain **no `auth.uid()` reference
  anywhere** — because they are only ever called by the Edge Function using the **service role key**, with
  the admin-only gate above being the entire trust boundary. Calling any of them with a forwarded end-user
  JWT would not do anything different (they never consult it), and calling them from a context without
  `admin_users` membership at the Edge Function layer is impossible today by design.
- Token storage: `vault.create_secret` / `vault.update_secret` per account, referenced from
  `social_accounts.vault_access_token_secret_id` / `vault_refresh_token_secret_id`. `publish_enabled`
  stays `false` after a bare OAuth completion; a brand only becomes `live` through a separate, later,
  explicit change.

### Reusable pieces (technique-level, not code-level)

- OAuth2 + PKCE (S256) construction, `X-oauth2/token` exchange shape, `/2/users/me` identity read.
- Vault `create_secret`/`update_secret` for token storage; `social_accounts.vault_*_secret_id` columns.
- `social_account_oauth_states` table shape (state hash, expiry, one-time consumption).
- The overall "SECURITY DEFINER RPC is the only write path, `authenticated`/`anon` get no direct table
  grants" pattern already established by the Phase 5 social-mobile membership rollout
  (`brand_memberships` etc.) — Phase 9 follows this same pattern for its new tables/columns.

### General-user gap

`x-oauth-connect`'s account model is a **static, admin-curated allowlist of exactly two accounts**. There
is no code path anywhere in it for "any authenticated user connects an account that does not already
exist and that no admin pre-configured a handle for." Reusing it as-is is not possible without either (a)
turning its account_config into a dynamic per-user lookup (which would touch the two existing hardcoded
accounts' code path and risk them) or (b) building a parallel, separate path. This document chooses (b).

### Ownership gap

None of the existing RPCs know or care which human is behind the service-role-authenticated call. General
users need every write bound to `auth.uid()`, verified by Postgres itself from the caller's own JWT — not
by an application-layer "trust me, I checked" assertion.

### Security gap

1. No DB constraint prevents the same X `platform_user_id` from being linked to two different
   `social_accounts` rows (two different brands/users). Today this is invisible because only two, entirely
   admin-managed accounts exist; it becomes a real collision risk the moment general users can connect
   arbitrary X accounts.
2. `verifyReadOnlyXIdentity`'s pre-registered-handle check has no "first connection, bind whatever comes
   back" mode, which general-user onboarding needs.

## 2. Chosen onboarding architecture (Phase B)

### Why a new, separate Edge Function + RPC set instead of extending `x-oauth-connect`

- `x-oauth-connect` is production-critical for two real, currently-live-or-near-live accounts (`kabumori`
  live posting, `ai_salaryman_lab` dry-run). Any edit to its shared code risks a regression on those.
- Its account model, auth gate, and RPCs are fundamentally shaped for "fixed, admin-curated accounts,"
  not "dynamic, user-owned accounts." Retrofitting both models into one file/config makes the security
  review harder, not easier.
- The established pattern throughout this project (`brand-post-dry-run` in the multibrand work, this
  Phase 9 candidate) is: when a new capability has a fundamentally different trust boundary, build it as a
  new, narrowly-scoped, independently-reviewable function rather than widening an existing one.
- Both functions share nothing but pure technique (PKCE math, token exchange, identity read) — reusing
  that as **small, freshly-written, self-contained helpers** costs little and keeps `x-oauth-connect`
  untouched (zero risk to `kabumori`/`ai_salaryman_lab`/`mio`).

### Auth / ownership model

- The new Edge Function (`x-oauth-connect-user`) requires a real, non-anonymous Supabase Auth session —
  **no `admin_users` check at all**; any signed-in user may connect their own account. It validates the
  caller's bearer token against `GET {SUPABASE_URL}/auth/v1/user` (the same technique
  `resolveAdminAuthorization` uses, minus the admin_users lookup).
- Every subsequent PostgREST call this function makes **forwards that same user JWT** (`apikey: anon`,
  `Authorization: Bearer <user JWT>`) — **never the service role key**. This is the single most
  important architectural decision in this design: it is what makes `auth.uid()` inside each
  `SECURITY DEFINER` RPC reflect the *real* connecting user, so "a user can never connect/update someone
  else's brand or account" is a database-enforced fact, not an application-trusted one. A regression that
  accidentally switched these calls to the service role key would make every RPC call fail closed with
  `SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED` (`auth.uid()` returns null under service_role) rather than silently
  behaving as some other user — a fail-closed failure mode, not a fail-open one.
- Callback query parameters are never trusted for identity: `code`/`state` only ever unlock a **specific,
  already-`auth.uid()`-owned** `social_account_oauth_states` row; the row's `brand_id`/`social_account_id`
  come from the database, not from the client's callback request.

### Workspace creation

- `begin_social_mobile_x_oauth_connection` (new RPC): on a user's first call, creates exactly one brand
  (`id = 'u_' || md5(auth.uid())[:24]`, deterministic and idempotent — a retried call finds the same
  brand via `on conflict do nothing` rather than creating a duplicate) and one `owner` membership, then
  one not-yet-connected `social_accounts` row (placeholder handle `'pending'`, `connection_status =
  'authorization_pending'`). A user who already owns exactly one brand reuses it. A user who
  (unexpectedly) owns more than one brand causes the RPC to fail closed
  (`SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED`) rather than guessing which one to use — this
  should never happen from this RPC's own logic, but guards against any future code path that could
  create a second owner membership out from under it.
- `code_profile_key` is set to a **placeholder** (`'social_mobile_user_v1'`) that does not yet exist in
  `_shared/brand/brand_profiles.ts`'s registry. This is deliberate: `resolveBrandCodeProfile()` /
  `loadBrandContext()` fail closed (`BRAND_CODE_PROFILE_NOT_FOUND`) for any unknown key, so a
  general-user brand this phase creates is **automatically unusable by the content-generation/dispatch
  pipeline** until a later, separate, deliberate phase adds that profile. Ownership and content
  generation are intentionally decoupled phases.
- No client-side INSERT anywhere: `authenticated` has no direct grant on `brands`/`social_accounts`/
  `brand_memberships`/`social_account_oauth_states` (matching the existing Phase 5 pattern); the RPC is
  the only path, and it is `SECURITY DEFINER` specifically so it *can* write despite that.

### X account connection

- The PKCE `code_verifier` is generated and held by **the mobile client itself** (e.g. via
  `expo-crypto`), never sent to or stored in this database at all — unlike `x-oauth-connect`'s
  Vault-backed verifier storage, which exists there only because an admin's *browser* and the *server*
  are different processes needing to share state across a full-page redirect. A mobile app doing its own
  OAuth via `expo-web-browser` + a deep link back into itself is the same process across that round trip,
  so it can simply keep the verifier in memory. This removes one moving part (a Vault secret + RPC
  parameter) entirely for the new flow.
- `state` is also generated client-side; only its SHA-256 hash is ever sent to or stored by the server
  (matching `x-oauth-connect`'s existing `hashOAuthState` convention) — a value found in a DB read (by
  anyone with sufficient access) is never independently usable to spoof a callback.
- First connection has no pre-registered handle to check against: `complete_social_mobile_x_oauth_connection`
  simply **binds** whatever verified X identity comes back (`platform_user_id`, `username`) to the
  caller's own `social_accounts` row — there is nothing to compare it to, so nothing is compared.
- Duplicate/hijack prevention: a new **partial unique index**
  `social_accounts (platform, platform_user_id) where platform_user_id is not null` makes "this X account
  is already connected to a different brand" a real, atomic, database-level failure
  (`unique_violation`, mapped to `X_ACCOUNT_ALREADY_CONNECTED`) rather than a check-then-act race that a
  concurrent request could slip past.
- `connection_status` transitions: `authorization_pending` (begin) → `identity_verified` (complete
  success) → `failed` (complete failure, e.g. collision). `publish_enabled` is **never** set `true` by
  OAuth success alone, matching every existing account in this project — going live remains a
  deliberately separate, later action.
- Reconnect: calling `begin_*` again for a user who already owns a brand/account reuses that account row
  (resets it to `authorization_pending`), so a user can retry a failed or expired connection attempt
  without creating duplicate rows. Revoke (disconnecting an account entirely) is **out of scope for this
  phase** — flagged as a remaining gap in the Report.

### Secrets

- `X_CLIENT_ID`/`X_CLIENT_SECRET` live only in the new Edge Function's own environment (Supabase Function
  secrets), never in the mobile bundle.
- Access/refresh tokens go straight from the X token-exchange response into
  `complete_social_mobile_x_oauth_connection`'s `vault.create_secret`/`update_secret` calls; the Edge
  Function's own response to the mobile client never includes them (proven by
  `oauth_logic_test.ts`'s "never returns a token in its result" test, which asserts on the actual
  serialized response object).
- `service_role` is never used by this new function at all — every DB call it makes uses the anon key +
  the forwarded user JWT.

### Mobile UX (specified, not implemented this phase — see §4)

Minimum flow: Accounts screen → "Xアカウントを接続" button → app generates state/verifier locally →
`POST x-oauth-connect-user` (start) → `expo-web-browser` opens the returned `authorization_url` → X
redirects to the app's own deep link (`kabumori-social-mobile://oauth-callback?code=...&state=...`) → app
extracts `code`/`state`, compares `state` against what it generated → `POST
x-oauth-connect-user/callback` with `code`/`state`/`code_verifier`/`redirect_uri` → on success, show
`connected` + the returned `handle`; on failure, show a specific, non-secret-leaking error and allow
retry; a cancel from the X consent screen returns the user to the Accounts screen unchanged
(`authorization_pending` row simply expires and is safely reusable on the next attempt).

## 3. Migration/RPC/function candidate (this commit)

- `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql` — additive only; see the
  file's own header comment for the full preflight/rollout discipline this project has followed
  throughout (verify against real production schema, never blind `db push`, never repair migration
  history). **Not applied.**
- `supabase/functions/x-oauth-connect-user/{index.ts,oauth_logic.ts,oauth_logic_test.ts}` — **not
  deployed.**

## 4. Explicitly deferred to a follow-up (not built this phase)

- The actual `apps/social-mobile` UI (Accounts screen, connect button, deep-link route handler,
  connecting/connected/error/reconnect states). This phase focused on getting the security-critical
  backend design and candidate right first; the mobile UI is additive on top of it and carries
  comparatively little risk once the backend contract above is reviewed. Flagged as the immediate next
  step in the Report.
- Wiring a `social_mobile_user_v1` code profile into `_shared/brand/brand_profiles.ts` (required before
  any general-user brand could ever be used for content generation — deliberately not done yet).
- Revoke/disconnect flow.
- `posting_windows`/publish-enablement design for general users (out of scope: OAuth/ownership only).
