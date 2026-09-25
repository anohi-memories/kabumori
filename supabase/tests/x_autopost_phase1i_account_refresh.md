# X autopost Phase1I — exact-account pre-X token refresh

Status: **source-only**. Not applied, not deployed, not wired into the live dispatcher or any v2 entrypoint. No token endpoint call, no Vault read/write in production.

Restructured 2026-09-25 (universal refresh task): the refresh state table, `release_x_account_refresh_v2` and the account health mirror moved to the standalone core `20260925140000_x_account_credential_refresh_core.sql` (see `x_account_refresh_core.md`), which the live dispatcher uses for Vault-backed accounts. This file now adds only the `v2_attempt` lease kind on the same table, so there is one single-flight lease per account across both publish paths. `commit_x_account_refresh_v2` gained `p_expires_in` and a `SHARE ROW EXCLUSIVE` lock (plain `SHARE` could deadlock two commits whose health mirror updates `social_accounts`).

Files:

- `supabase/migrations/20260925150000_x_autopost_phase1i_account_refresh.sql` — attempt FK on the core table, `begin/commit_x_account_refresh_v2` (lease kind `v2_attempt`), provider-start/step guard
- `supabase/functions/_shared/x_v2_account_refresh.ts` (+ `_test.ts`) — one-request refresh helper, lease type, RPC adapter, client resolver
- `supabase/functions/x-test-post/v2_dispatcher.ts` — optional `refreshAccountPreX` port (Phase1H seam), `refreshRequests` counter
- tests: `v2_dispatcher_test.ts` (+4), `account_refresh_migration_test.ts`, `supabase/tests/x_autopost_phase1i_{fixture.sql,behavior.sql,run.sh}`

## 1. Authority

The only authority is an **open pre-X v2 attempt** (`attempt_id` + `claim_token`) for exactly one account. `begin_x_account_refresh_v2` locks the attempt, then the account row, and requires: attempt `pre_x` with no outcome; caller account/brand equal the attempt's; post `running` and bound to the same account/brand; account exists, `platform = 'x'`, same brand, `identity_verified` with a platform user id, `publish_enabled`, non-blank `oauth_client_ref`; both `vault_access_token_secret_id` and `vault_refresh_token_secret_id` present and distinct; **no other account references either secret** (`X_REFRESH_SECRET_REF_SHARED` — blocks both sides). No brand-first or first-row lookup, no hardcoded account, no env token, no `oauth_token_store`, no secret-id parameter anywhere in the API.

## 2. Secret boundary

- `begin` returns `lease_token`, `oauth_client_ref` and the refresh token — to the server refresh helper only (`XRefreshLease`, private field, redacted in JSON/String/inspect). The dispatcher receives only `{ postOutcome, code, tokenRequests }`.
- The access token and optional rotated refresh token are written by `commit` to the **same account's own** Vault secrets (`vault.update_secret`); no secret id is accepted from the caller. `begin` snapshots the exact brand, X user, OAuth client and both Vault refs; `commit` rechecks them, the still-open pre-X attempt/post, and exclusive ownership of both refs under a table lock before writing. Omitted `refresh_token` in X's response leaves the stored refresh token unchanged.
- Fixed error codes only. Vault read and write failures, including Vault's own `P0001`, are masked (`X_REFRESH_CREDENTIAL_UNAVAILABLE`, `X_REFRESH_PERSIST_FAILED`). Nothing logs tokens, bodies or ids (the helper has no `console.*`).
- ACL: begin/commit (here) and release (core) are service_role-only, `SECURITY DEFINER`, `search_path = ''`; the guard function has no API EXECUTE; `x_account_refresh_state_v2` is SELECT-only for service_role; API roles cannot write Vault.

## 3. One refresh request

Exactly one `POST https://api.x.com/2/oauth2/token` (`grant_type=refresh_token`, Basic client auth, `redirect: manual`, timeout). No retry, no second request, no X post/media call. Classification:

| X response | result | account state | post attempt |
| --- | --- | --- | --- |
| 2xx with `access_token` (optional non-empty `refresh_token`, `token_type` bearer if present) | commit → `refreshed` | idle, generation+1 | `pre_x_retryable` `X_ACCESS_TOKEN_REFRESHED_PRE_X` (re-entry) |
| 2xx malformed / not JSON | `uncertain` `X_REFRESH_RESPONSE_INVALID` | uncertain | `pre_x_terminal` |
| network / timeout / 3xx (not followed) / 408 / 5xx | `uncertain` | uncertain | `pre_x_terminal` |
| 429 | `not_rotated` `X_REFRESH_RATE_LIMITED` | idle | `pre_x_retryable` |
| 400 `invalid_grant` | `reauth_required` `X_REFRESH_GRANT_REJECTED` | reauth_required | `pre_x_terminal` |
| other 400 / 401 / 403 / other 4xx | `not_rotated` (`X_REFRESH_REQUEST_REJECTED_400`, `X_REFRESH_CLIENT_REJECTED_*`, `X_REFRESH_REJECTED_*`) | idle | `pre_x_terminal` |

Before any request: begin refusals (`X_REFRESH_IN_PROGRESS` / `X_REFRESH_UNAVAILABLE` → retryable; everything else → terminal) and an unknown `oauth_client_ref` (`X_REFRESH_CLIENT_NOT_CONFIGURED`, lease released unchanged) make **zero** token requests. Clients come from the server-side registry `xOAuthClientRegistryFromEnv` (`default` → `X_CLIENT_ID` / `X_CLIENT_SECRET`; approved ref `r` → `X_OAUTH_CLIENT_<R>_ID` / `_SECRET`).

## 4. Write ordering and partial failure

1. `begin` (one DB transaction): validate, take the lease (`refreshing`), read the refresh token.
2. One token request (outside the DB).
3. `commit` (one DB transaction): lease still held; attempt still pre-X and post running; account identity, OAuth client, Vault refs and `updated_at` still match the lease; no other account shares either ref. A `SHARE` table lock serializes the shared-ref check with social-account writes. Then both Vault writes and the lease release. Vault is in the same Postgres, so secrets + state are atomic.

X refresh tokens are single-use, so step 2 → 3 is the one boundary that cannot be made atomic:

- `commit` fails (e.g. Vault write error) → the transaction rolls back, the helper releases the lease as `uncertain`; if that release also fails the lease stays `refreshing`. Either state blocks further refreshes and provider start on that account; the post attempt is `pre_x_terminal`. **Never reported as success.**
- `lease_lost` / `account_changed` (re-connected, ref mutation, or stale attempt during the refresh) → the new tokens are not stored; `account_changed` sets `uncertain`.
- Unknown X outcome → `uncertain`; no automatic replay (replaying a possibly-consumed refresh token is not assumed safe).

Operator recovery for `uncertain` / `reauth_required`: re-connect the account through its OAuth flow (writes fresh Vault secrets and stamps `verified_at`); the core's reconnect trigger resets the refresh state to `idle`. A stuck `refreshing` lease needs reviewed owner SQL. No API role can reset it. `reauth_required` also sets `connection_status = 'failed'` (core health mirror), so the account is refused before any generation.

## 5. Concurrency

- **Same account**: the lease (state row `FOR UPDATE`, account row `FOR UPDATE`) makes refresh single-flight; a second begin gets `X_REFRESH_IN_PROGRESS` (proved with two sessions, the first holding its transaction open).
- **Provider-start race**: triggers on `post_queue_attempts_v2` (pre_x → provider_started) and `post_provider_steps_v2` (insert) share-lock the account row and refuse with `X_REFRESH_IN_PROGRESS` while a lease is held; begin and mark lock attempt → account in the same order (proved concurrently).
- **Different accounts** refresh independently (proved concurrently).
- **Stale leases** cannot write or release (`lease_lost`), and a used lease cannot be replayed.
- An attempt settled during the external refresh, or a silent Vault-ref change without an `updated_at` bump, cannot commit; both leave the state `uncertain`. Shared refs are rechecked at commit, serialized against concurrent account DML.
- `uncertain` / `reauth_required` block refresh but not posting with a token that still passes the identity check.

## 6. Dispatcher contract (Phase1H seam, not wired)

`refreshAccountPreX(claim)` is optional. When X rejects the access token at the pre-X identity check (`X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X`) and the seam exists, the dispatcher calls it **once**, then settles the attempt with its `postOutcome`/`code`; the next run re-claims, re-resolves the (new) credential and re-verifies identity before any create (re-entry, no refresh + create in one block). Other identity failures never refresh. Resumed multi-step attempts are provider-started, so they never refresh (they stay `in_progress` until the account is refreshed by a pre-X attempt or re-connected). A future entrypoint wires it as `(claim) => refreshXAccountPreX({ claim, ledger: createXAccountRefreshRpcLedger(...), resolveClient: defaultXOAuthClientResolver(Deno.env.get) })`.

## 7. Activation prerequisites (add to Phase1H §6)

- Apply order: refresh core (may already be live for the legacy path) and 1B → 1D → 1E → 1F → 1G → 1H, then **1I**, each alone (explicit transactions).
- Live read-back before apply: `social_accounts` columns (`oauth_client_ref`, `updated_at`, both `vault_*_secret_id`), `vault.update_secret(uuid,text,text,text,uuid)` signature and owner privileges, Vault ACL (service_role must not write Vault directly), no two accounts sharing a secret id, `X_CLIENT_ID`/`X_CLIENT_SECRET` present for the Edge runtime.
- Provisioning: an account is refresh-ready only when its own access **and** refresh tokens are in its own Vault secrets, written by the social-mobile OAuth completion (or an equivalent reviewed owner step). **Kabumori is not ready** while its token lives in `oauth_token_store`/env; AI Lab needs its refresh secret id verified on its own row. Accounts without both refs get `X_REFRESH_CREDENTIAL_NOT_CONFIGURED` and never call X.
- Rollback: before any refresh, nothing to undo (gate OFF, seam unused). After a committed refresh, the old access/refresh tokens are gone at X — rollback means re-connecting, not restoring. An `uncertain` account stays blocked until an operator re-connects and resets it.
- Monitoring: accounts in `refreshing` for more than a few minutes, and any `uncertain` / `reauth_required`.

## 8. Verification

`supabase/tests/x_autopost_phase1i_run.sh` (disposable PostgreSQL, non-superuser owner, fake Vault with `update_secret` and a fault-injection trigger): ACL; rejections before any lease (bad token, account/brand mismatch both ways, provider-started attempt, shared secret ref, missing refresh ref, invalid input); disabled account never claimed; lease returns only that account's refresh token; same-account second lease, provider start and provider step refused while leased; other account independent; foreign/invalid/replayed commits refused; access-only and rotated commits touch only the owner's secrets; not_rotated / uncertain / reauth releases; stale lease cannot write/release; blocked states refuse new leases but not posting; Vault write failure rolls back both secrets and never commits; re-connect during refresh, silent cross-account Vault-ref swap, or settled attempt → `account_changed` / `uncertain`; API roles denied. Races: two concurrent leases on one account (one winner), concurrent provider start refused, cross-account lease in parallel. TS: helper 12 tests (fake transport, global `fetch` forbidden), dispatcher +4.
