# X autopost Phase1E — exact-account credential resolver and one-request provider seam

Status: **source-only candidate**. Nothing is applied, deployed or wired into the live dispatcher. No X request was made.

Files:

- `supabase/migrations/20260924170000_x_autopost_phase1e_claim_bound_credential_reader.sql` — one new read-only RPC (requires Phase1B + Phase1D)
- `supabase/functions/_shared/x_v2_claim_credentials.ts` (+ `_test.ts`) — resolver
- `supabase/functions/_shared/x_v2_one_request_provider.ts` (+ `_test.ts`) — provider seam
- `supabase/functions/x-test-post/claim_bound_credential_reader_migration_test.ts` — static checks
- `supabase/tests/x_autopost_phase1e_fixture.sql`, `x_autopost_phase1e_behavior.sql`, `x_autopost_phase1e_run.sh` — disposable PostgreSQL proof

## 1. Exact-account invariant

> A v2 claimed post may use credentials only for exactly `claim.social_account_id`.

Enforced twice:

1. **Database (`read_x_publish_credential_for_claim_v2`)** — the authority is the open v2 attempt `(attempt_id, claim_token)`. It must be `phase = 'pre_x'`, its `social_account_id`/`brand_id` must equal the caller's, and its post must still be `running` and bound to that account. The account is then read **by primary key** from the attempt. Checks in order: exists → `platform = 'x'` → brand equals claim brand → `identity_verified` with non-blank `platform_user_id` → `publish_enabled` (unless the caller explicitly waives it) → the row's own `vault_access_token_secret_id` → the decrypted secret. No Vault reference is selected until every metadata check has passed. Only the access token is returned; refresh tokens and Vault references never leave the database. Errors are fixed codes (`P0001`); any other database error becomes `X_CREDENTIAL_UNAVAILABLE`. service_role-only, `SECURITY DEFINER`, empty `search_path`, read-only.
2. **TypeScript (`resolveXCredentialForClaim`)** — validates the claim shape before any request, requires exactly one returned row, and discards the credential unless the returned `social_account_id`/`brand_id` equal the claim. The token is held in a private field of `XAccountCredential`; `JSON.stringify`, `String()` and `Deno.inspect` are redacted; the only use is `bearerHeader()`.

Never used by the v2 path: brand-only lookup, `limit=1`/first row, account count, `oauth_token_store`, env tokens (`X_OAUTH2_*`), the hardcoded AI Lab account/RPC, or another account after a failure.

## 2. Credential-path audit (current source, fresh main)

| Caller | Credential helper | Input authority | Account selection | Refresh behavior | Safe for v2? | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| x-test-post scheduled dispatch, manual greeting/manual routes | `loadBrandContext` (`_shared/brand/brand_context.ts`) | `brand_id` | `social_accounts?brand_id=eq.&platform=eq.x&limit=1` → first row | n/a | **No** | brand-only + first-row account selection |
| x-test-post Kabumori dispatch + manual greeting | `loadBrandXTokens` → `loadXTokens` | brand must be `kabumori`, `oauth_client_ref='default'` | shared `oauth_token_store?provider=eq.x&limit=1`; **falls back to env `X_OAUTH2_*`** if the row is missing or undecryptable | via `postToX` | **No** | one shared store for the brand, not per account; silent env fallback |
| important-news-monitor publish | `loadXTokens` + env | none (global) | shared store `limit=1` + env fallback | `postToXWithRefresh` | **No** | global shared credential |
| x-test-post AI Lab `brand_post` | `loadAiLabVaultBackedXTokens` | brand must be `ai_salaryman_lab` | hardcoded `id=eq.ai_salaryman_lab_x`, handle `kaishain_ai_lab`; RPC `read_ai_salaryman_lab_x_vault_token` (production-only source, not on main) | `allowRefresh:false` | **No** | hardcoded account; not generic |
| (building block) | `loadVaultBackedXTokens` | caller-supplied Vault refs + `BrandContext.socialAccount` | whatever the caller passes; `socialAccount` comes from `loadBrandContext` (`limit=1`) | none | **No** (as wired) | refs chosen outside; no platform/verification checks |
| social-mobile history learning | `read_social_mobile_history_access_token` | owner user + account id | exact id, but requires exactly one X account per brand; history/read scope | none | **No** (different purpose) | not a publish credential; owner-scoped |
| x-test-post `postToX` / `postThreadToX` | own `refreshXTokens` + `saveXTokens` | `XAuthContext` | n/a | **401 → refresh → second create**; rotated tokens written to the shared `oauth_token_store` | **No** | hidden second create after provider start |
| `_shared/x_oauth2_post.ts` `postToXWithRefresh`, `requestXWithAuthRefresh` (important news; morning_greeting media + create) | `refreshXTokens` + `saveXTokens` | `XAuthContext` | n/a | **401 → refresh → same request again** | **No** | same |
| **new** `read_x_publish_credential_for_claim_v2` + `resolveXCredentialForClaim` | — | open pre-X v2 attempt + claim token | exact PK from the attempt; caller must match | **none** | **Yes** | §1 |
| **new** `createXTextPostOnceV2` / `publishClaimedXTextPostV2` | — | resolved `XAccountCredential` | — | **none**; at most one create | **Yes** (single text post) | §3 |

All legacy helpers above are **unchanged** and remain legacy-only.

## 3. One-request provider seam

`createXTextPostOnceV2({ credential, text, markProviderStarted })`:

1. **Pre-X identity check** — `GET /2/users/me` with the exact credential. `data.id` must equal the account's `platform_user_id` (proves the token belongs to exactly this account). `401` → `pre_x_retryable X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X`; `403` → `pre_x_terminal X_IDENTITY_CHECK_FORBIDDEN`; other id → `pre_x_terminal X_CREDENTIAL_IDENTITY_MISMATCH`; network/429/5xx → `pre_x_retryable X_IDENTITY_CHECK_UNAVAILABLE`. No create is sent and `markProviderStarted` is not called.
2. **Durable boundary** — awaits `markProviderStarted()` (the caller commits `mark_post_provider_started_v2`). If it throws → `pre_x_retryable X_PROVIDER_START_NOT_RECORDED`, nothing sent.
3. **Exactly one `POST /2/tweets`**, with a timeout. No refresh, no retry, no loop.
   - 2xx with `data.id` → `x_created`
   - 2xx without id / unparsable → `x_outcome_uncertain X_CREATE_RESPONSE_MISSING_POST_ID`
   - network error / timeout → `x_outcome_uncertain X_CREATE_NETWORK_UNCERTAIN`
   - 408 / 5xx → `x_outcome_uncertain X_CREATE_HTTP_<status>`
   - other 4xx, including 401 and 429 → `x_rejected X_CREATE_REJECTED_<status>` (X answered and did not create)

`publishClaimedXTextPostV2` composes resolver + seam; a resolver failure returns its pre-X outcome with zero X requests.

Mapping to the Phase1B ledger for a future dispatcher: `pre_x_*` → `settle_post_pre_x_v2`; `x_created` → `complete_post_x_confirmed_v2` (or `record_post_x_confirmed_incomplete_v2` if completion effects fail); `x_outcome_uncertain` → `record_post_x_uncertain_v2`. **`x_rejected` has no Phase1B outcome yet**: until one exists it must be recorded conservatively as uncertain (never auto-retried).

## 4. Where token refresh is allowed

- **Forbidden** anywhere on the v2 path after credential resolution, and always after `mark_post_provider_started_v2`. The seam contains no refresh code.
- **Allowed** only out of band, before a claim uses the token: a future per-account maintenance step that refreshes and writes back to that account's own Vault secrets. No such writer exists for arbitrary accounts yet (the only writers are social-mobile OAuth completion and the legacy shared-store `saveXTokens`); it is a separate prerequisite.
- **Legacy** helpers keep their existing refresh-and-retry behavior (unchanged, legacy-only).

## 5. Post types still blocked for v2

| Post type | Why |
| --- | --- |
| `tip` | thread = several creates with `in_reply_to`; needs a per-part provider-step ledger |
| `morning_greeting` | media upload + create (two X requests) plus `publish_claims`/receipt lifecycle |
| `interaction` | poll payload not in the text-only seam yet; completion effects not atomic |
| `morning_report`, `close_report`, `us_premarket_report`, `useful_tip`, `brand_post` | single text create fits the seam, but per-type completion effects are not atomic with the v2 ledger (Phase1C blocker 3) |

Kabumori today has no per-account Vault credential on its `social_accounts` row (its token lives in the shared `oauth_token_store`); the resolver fails closed (`X_CREDENTIAL_NOT_CONFIGURED`) until an operator moves it — no fallback.

## 6. Verification

```bash
PHASE1E_PGHOST=/private/tmp/<sock> PHASE1E_PGPORT=<port> PHASE1E_PGSUPER=<local superuser> \
  supabase/tests/x_autopost_phase1e_run.sh
```

Non-superuser owner, Supabase-style default grants, a fake `vault.decrypted_secrets`, a fake legacy `oauth_token_store` row and a fake AI Lab token. Proves: two X accounts in one brand each resolve only their own token; the caller cannot redirect a claim to a sibling, another brand, or the AI Lab account; bad/foreign claim tokens, provider-started and settled attempts fail closed; publish-disabled, unverified, blank identity, missing reference and missing secret fail with fixed codes and never fall back; errors contain no secret or reference; the reader changes no row; anon/authenticated are denied; service_role cannot read the vault directly.

## 7. Next prerequisite

Atomic per-post-type v2 completion and provider-step outcome model — including an `x_rejected` ledger outcome, tip threads and morning_greeting media/create — plus a per-account pre-X token refresh writer and the operator move of Kabumori's credential into its account's Vault secrets.
