# Universal exact-account X OAuth refresh (core + live integration)

Status: **source-only**. Nothing applied, deployed, refreshed or posted. Production mutation budget used: 0.

## 1. Root cause (read-only confirmed 2026-09-25)

- `x-test-post` loaded AI Lab tokens from its Vault refs but built the auth context with `allowRefresh: false`; `postToX` therefore threw `X_REQUEST_FAILED:401` on the first expired-access-token 401 without ever using the configured refresh token.
- Every AI Lab post since 2026-09-24 00:51 UTC failed with 401 (19 in a row by 09-25 13:24 UTC); the last success was 09-23 22:33 UTC — consistent with an access token that expired and was never refreshed.
- `social_accounts` still shows `identity_verified` with a null error code: nothing recorded the failure on the account. Each failed run also paid for content generation before the 401.
- Production has no v2 chain (Phase1B–1I are unapplied) and `scheduled_posts` has no `social_account_id`, so the reviewed Phase1I (v2-attempt lease) could not serve the live dispatcher on its own.

## 2. Architecture

Before: Kabumori → `oauth_token_store`/env + legacy refresh (writes the shared store); AI Lab → hardcoded Vault reader, no refresh (dead-end); future brands → no resolver.

After:

```
running scheduled post ── brand ──> the brand's only X account (DB re-checks = caller's account)
   └─ read_x_publish_credential_for_legacy_post  (refuses refreshing / uncertain / reauth, before generation)
        └─ X request ── 401 / near expiry ──> begin_x_account_refresh_legacy_post (single-flight lease, 1 per post attempt)
              └─ ONE POST https://api.x.com/2/oauth2/token (client from oauth_client_ref registry, manual redirect, timeout)
                    ├─ confirmed → commit_x_account_refresh_legacy_post → same account's own Vault secrets + lease release (1 tx)
                    │     └─ re-read via the reader → retry the exact X request once
                    └─ otherwise → release_x_account_refresh_v2 (not_rotated / reauth_required / uncertain)
```

- `20260925140000_x_account_credential_refresh_core.sql` — applies **alone on the current production baseline** (no Phase1B–1I). Owns the single per-account lease table `x_account_refresh_state_v2` (lease kinds `legacy_post` and `v2_attempt`), the generic release RPC, the health mirror and the reconnect reset.
- `20260925150000_x_autopost_phase1i_account_refresh.sql` (restructured) — now requires the core; adds only the `v2_attempt` begin/commit and the provider-start guard on the same table. One lease per account across both publish paths: a legacy refresh also blocks v2 provider start on that account, and vice versa.
- `_shared/x_v2_account_refresh.ts` — `runXTokenRefresh(port, resolveClient)` is the one refresh routine (one token request site); `refreshXAccountPreX` (v2) and the live port both use it. `xOAuthClientRegistryFromEnv` is the server-side client registry.
- `x-test-post/vault_account_auth.ts` — `VaultAccountXAuth` (one per publish attempt) + PostgREST adapter.
- `x-test-post/index.ts` — every brand except legacy Kabumori goes through `VaultAccountXAuth`; the AI Lab-only loader and its `allowRefresh:false` branch are gone. Kabumori's legacy path is unchanged. Content guards are unchanged (non-Kabumori brands still publish `brand_post` only, and only AI Lab has a content dispatcher).

### Exact-account authority on the legacy path

Production `scheduled_posts` has no account column, so the account is derived server-side: running post → `post.brand_id` → the brand's X account. `social_accounts` is `UNIQUE (brand_id, platform)` with `platform = 'x'` only, and every function re-counts (`X_ACCOUNT_NOT_UNIQUE_FOR_BRAND` if ≠ 1) and requires it to equal the caller's `social_account_id` (`X_CLAIM_ACCOUNT_MISMATCH`). This is a deterministic derivation, not a first-row pick. Phase1B-bound rows (`social_account_id` set) are refused here and belong to the v2 path. No API takes a secret id; tokens are never read from another account, the env, or `oauth_token_store`.

### OAuth client routing

`oauth_client_ref` selects a server-side client: `default` → `X_CLIENT_ID`/`X_CLIENT_SECRET`; any other approved ref `r` → `X_OAUTH_CLIENT_<R>_ID`/`_SECRET` in the Edge runtime (ref must match `^[a-z][a-z0-9_]{0,39}$`). Unknown/malformed/half-configured → `X_REFRESH_CLIENT_NOT_CONFIGURED`, zero token requests (DB refuses a blank ref before any Vault read). The token endpoint is a constant. Adding a client needs Edge secrets only, no account-specific code.

## 3. Refresh and retry semantics (per publish attempt)

| situation | action |
| --- | --- |
| stored `access_expires_at` within 5 min | proactive refresh before the X request |
| X 401, no refresh yet, no accepted X write in this attempt, gate on | refresh once, re-read the stored token, retry the exact request once |
| 401 after a refresh in this attempt | `record_x_account_rejected_after_refresh` → `reauth_required`; `X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH` |
| 401 with gate off / refresh already used / after an accepted write | no token request; `record_x_account_access_unauthorized`; `X_ACCESS_TOKEN_UNAUTHORIZED` |
| token endpoint 2xx with access token | commit (access; refresh only if X returned one; `expires_in` stored for the next proactive refresh) |
| 400 `invalid_grant` | `reauth_required` (`X_REFRESH_GRANT_REJECTED`) |
| network / timeout / 3xx (not followed) / 408 / 5xx / malformed 2xx | `uncertain`, never replayed |
| 429 / other 4xx | not rotated (`X_REFRESH_RATE_LIMITED`, `X_REFRESH_REJECTED_*`, `X_REFRESH_CLIENT_REJECTED_*`) |
| Vault write fails / lease lost / account changed during refresh | `X_REFRESH_PERSIST_FAILED` / `X_REFRESH_LEASE_LOST` / `X_REFRESH_ACCOUNT_CHANGED`, account `uncertain`, no retry |

At most one refresh per post attempt is enforced in the DB (`X_REFRESH_ALREADY_USED_FOR_ATTEMPT`, keyed by post id + `attempt_count`), not only in memory. Every failure ends the attempt through the existing `fail_scheduled_post` (terminal) — no retry loop. A 401 means X did not accept the create, so the single retry cannot duplicate a post; once any X write in the attempt was accepted (threads), no refresh happens.

Gate: refresh runs only with Edge env `X_VAULT_ACCOUNT_REFRESH=enabled`. Gate off still uses the new exact-account reader and records 401s truthfully, with zero token requests.

## 4. Account health model

| state (`x_account_refresh_state_v2.status`) | `social_accounts` | publish |
| --- | --- | --- |
| `idle`, error null | `identity_verified`, code null | allowed |
| `idle` + 401 recorded | `identity_verified`, `X_ACCESS_TOKEN_UNAUTHORIZED` | allowed (refresh may fix it) |
| `idle` after not-rotated | `identity_verified`, e.g. `X_REFRESH_RATE_LIMITED` | allowed |
| `refreshing` | unchanged | reader/begin refuse `X_REFRESH_IN_PROGRESS` |
| `uncertain` | `identity_verified`, fixed code | reader/begin refuse `X_REFRESH_BLOCKED_UNCERTAIN` (before generation) |
| `reauth_required` | **`failed`** + code | reader/begin/v2 claim refuse `X_ACCOUNT_NOT_VERIFIED` (before generation) |

- A committed refresh clears the code; `verified_at` is never touched by a refresh (it is not an identity verification). `updated_at` changes only with `connection_status`, so health writes never invalidate another lease's snapshot.
- Re-connection (an OAuth completion that sets `identity_verified` and stamps `verified_at`) automatically resets `uncertain`/`reauth_required` to `idle`. A lease still `refreshing` is left to its commit, which sees the account change. Stuck `refreshing` (process died) needs reviewed owner SQL.
- `connection_status` keeps the production CHECK set; no new values.

## 5. Safety proof

- Disposable PostgreSQL 17, non-superuser owner, production-shaped fixture (`x_account_refresh_core_fixture.sql`: production columns/constraints, service_role Vault privileges as in production), core applied **alone**: `x_account_refresh_core_run.sh` → ACL, reader/begin refusals (wrong account, brand, unknown/pending post, legacy no-ref Kabumori, disabled, shared ref both sides, equal refs, blank client), client-ref routing, commit (foreign/other/replayed lease, invalid input, access-only and rotated, expiry), one refresh per attempt, releases, rejected-after-refresh, uncertain blocking, operator/automatic recovery, 401 recording, Vault write failure rollback, eight mid-refresh mutations (reconnect, silent ref swap, client change, publish disabled, identity change, post finished, post re-claimed, foreign account takes the ref) → `account_changed`, API-role denial, re-apply refused; races: one lease per account, parallel commits on two accounts with health mirrors (no deadlock).
- Mutation check: removing the attempt check, the one-per-attempt check, the commit shared-ref/uniqueness checks, the reauth → `failed` mirror, or using `SHARE` instead of `SHARE ROW EXCLUSIVE` (real deadlock) each fails the proof.
- Stacked: Phase1D/E/F/G/H/I proofs rerun; Phase1I now applies core → 1I.

## 6. Rollout plan (not executed; requires ChatGPT K3 + Codex review)

**Stage 0 — read-back (read-only)**
- `social_accounts` columns incl. `verified_at`, `last_connection_error_code`, `oauth_client_ref`, `updated_at`; `UNIQUE (brand_id, platform)`; `platform = 'x'` CHECK; `connection_status` CHECK set; no triggers on `social_accounts`.
- `vault.update_secret(uuid,text,text,text,uuid)` exists; migration owner can read/write Vault.
- AI Lab: both refs present and distinct, `oauth_client_ref = 'default'`, `shared_refs = 0` across all accounts (2026-09-25: true / 0). Never select secret values.
- `X_CLIENT_ID`/`X_CLIENT_SECRET` present in the Edge runtime (names only).
- Finding to decide separately: `service_role` can `SELECT vault.decrypted_secrets` and `EXECUTE vault.update_secret` directly; revoking is a separate reviewed hardening.

**Stage 1 — apply + deploy, gate off**
- Apply `20260925140000_x_account_credential_refresh_core.sql` alone (explicit transaction; not re-runnable). Do not apply Phase1B–1I.
- Deploy the exact reviewed `x-test-post` source; byte-verify the deployed bundle (worktree deploys can ship the shared checkout). `X_VAULT_ACCOUNT_REFRESH` unset.
- Expected: AI Lab still fails (401) but as `X_ACCESS_TOKEN_UNAUTHORIZED` with the account code set; Kabumori unaffected.
- Optional containment before Stage 1 (owner decision, not done here): `update public.social_accounts set publish_enabled = false, updated_at = now() where id = 'ai_salaryman_lab_x';` stops the hourly paid generation that ends in 401. Re-enable in Stage 2.

**Stage 2 — AI Lab recovery**
- Set `X_VAULT_ACCOUNT_REFRESH=enabled`; ensure AI Lab `publish_enabled = true` just before one due slot; observe one run.
- Expect exactly one token request, `commit … = committed`, one retried create (201), `x_account_refresh_state_v2` AI Lab row `idle`, generation 1, `access_expires_at` ≈ +2h, code null.
- Prove only AI Lab changed: `vault.secrets.updated_at` moved only for AI Lab's two ids (metadata only), both refs unchanged on the row, Kabumori `oauth_token_store.updated_at` unchanged, other accounts' refs unchanged.
- If `invalid_grant`: account becomes `failed`/`X_REFRESH_GRANT_REJECTED`; set `publish_enabled = false`, re-connect via `complete_ai_salaryman_lab_oauth_connection` (the reset trigger clears the state), then re-enable.
- If `uncertain`: stop; do not replay; re-connect.

**Stage 3 — future-account path proof**
- Disposable/staging only: a synthetic brand + account with its own Vault refs and `oauth_client_ref` (e.g. a second approved client) through the same RPCs; no real X write.

**Stage 4 — generic enablement and monitoring**
- Keep the gate on for all Vault-backed accounts. Monitor: `status = 'refreshing'` older than a few minutes, any `uncertain` / `reauth_required`, `last_connection_error_code` distribution, refresh generation counts.
- Rollback: unset `X_VAULT_ACCOUNT_REFRESH` (no more token requests) and/or redeploy the previous Edge version. Committed rotations cannot be undone (old tokens are dead at X); recovery is re-connection. The core tables/functions are inert without callers.
