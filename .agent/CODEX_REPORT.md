# Codex Report

## Latest H1 result — AI Lab daily content plan selection focused fix (2026-09-18)

- task_id: `ai-lab-daily-content-plan-selection-fix-20260918`
- result: `review_required` — C1 blocker fixed in a source-only candidate; stop for C1 review. Production migration/deploy/configuration changes: **0**.
- source candidate: branch `codex/ai-lab-daily-content-plan-selection-fix-20260918`, commit `cdebdc861d9b6fb38645b640c3d48396ec72aee3` (rebased onto fresh GitHub `main` `ac158af65f385448c68e11b8336c51d52c20a7ed`).
- migration candidate remains `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`; it was not applied. No `supabase db push`, production RLS/grant/RPC/schema change, Cron change, or `x-test-post` deploy was performed.

### Focused fix

- `slot_no` is now optional/null in the structured plan item parser.
- Selection order is deterministic: exact explicit slot item first (priority, then id), then slot-less items assigned to the remaining scheduled slots in stable priority/id order. No consumed-state write is used; the same plan/date/slot resolves to the same item on retry.
- If an active plan has no safe item for a slot, the loader returns the normal fallback signal instead of stopping the scheduled post or inventing a topic from `day_theme` alone. The generator fallback is hardened toward a company-worker personal-development/side-business/AI-trial diary and explicitly rejects generic AI convenience tips, textbook how-to content, and fabricated progress/experience.
- Plan absence keeps the same hardened persona fallback. Explicit item generation, AI Lab-only wiring, target-date filtering, active-only filtering, and all OAuth/Vault/refresh/X publish/dedupe/completion boundaries remain unchanged. Kabumori, Mio, and market-report consumers remain untouched.

### Validation

- Focused plan/dispatcher/generator suites: **30 passed / 0 failed**.
- Full `supabase/functions/x-test-post` + `_shared/brand` regression: **469 passed / 0 failed**.
- Candidate helper modules `deno check --no-config`: passed.
- Candidate helper `deno fmt --check` and `git diff --check`: passed.
- The known unrelated full Edge `index.ts` type diagnostics remain outside this focused change; no new helper type error was introduced.

### Safety / next step

- Production DB/Vault/X/OAuth/Cron writes: **0**; no secrets/token values, manual/synthetic X post, retry/backfill, refresh, or OAuth action was performed.
- C1 should review the selection algorithm and the explicit safe fallback rule before any separate migration/deploy approval. No rollout is implied by this candidate.

## Latest H1 result — AI Lab daily content plan generation control Phase 1 (2026-09-17)

- task_id: `ai-lab-daily-content-plan-generation-control-phase1-20260917`
- result: `review_required` — source-only candidate completed; stop for C1 review. Production migration/deploy/configuration changes: **0**.
- source candidate: branch `codex/ai-lab-daily-content-plan-phase1-20260917`, commit `0a6f20c86603c5834876208e4c05ef711d036be4` (rebased onto fresh GitHub `main` `dacdb2f303e50eccbaced6273f8ebaa899b6f419`).
- migration candidate: `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`; created but **not applied**. No `supabase db push`, production RLS/grant/RPC/schema change, Cron change, or `x-test-post` deploy was performed.

### Implemented candidate

- Added brand-neutral `daily_content_plans` schema candidate with `brand_id`, JST `target_date`, version, `source`, draft/active/archived status, JSON plan payload, one-active-per-brand/date partial uniqueness, lookup index, RLS enabled, and service-role read grant only.
- Added structured plan parsing/selection for `day_theme`, `narrative_arc`, slot item `topic`, `context`, `tone_override`, `key_points`, `must_include`, `must_avoid`, `priority`. Active plans are queried for exact `ai_salaryman_lab` + target date + slot. Selection is deterministic by priority then item id; a missing slot fails closed. Retry does not consume/write plan state, so the same scheduled slot resolves to the same item.
- Wired only the AI Lab scheduled `brand_post` route to the plan loader. Plan present: generation prompt/input is constrained to the authored plan and explicitly rejects new themes, invented progress/emotion/results, and unrelated AI tips; persona is used only for expression. Plan absent: existing generator fallback remains unchanged. Kabumori, Mio, report consumers, OAuth/Vault/refresh, X publish, dedupe, completion, and retry boundaries were not changed.

### Changed source files

- `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql` (candidate only)
- `supabase/functions/_shared/brand/daily_content_plan.ts`
- `supabase/functions/_shared/brand/ai_lab_daily_content_plan_source.ts`
- `supabase/functions/_shared/brand/brand_post_generator.ts`
- `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post.ts`
- `supabase/functions/x-test-post/index.ts` (AI Lab-only loader wiring and schedule_date typing)
- matching plan/generator/dispatcher tests

### Validation

- Focused plan/generator/dispatcher suites: **27 passed / 0 failed**.
- Full `supabase/functions/x-test-post` + `_shared/brand` regression: **466 passed / 0 failed**.
- Candidate helper modules `deno check --no-config`: passed.
- `git diff --check`: passed. `x-test-post/index.ts` retains pre-existing formatter drift; it was not globally reformatted.
- Full `x-test-post/index.ts` type check still reports the repository's unrelated existing six diagnostics (AES-GCM/Blob `BufferSource` typing, morning greeting result typing, and lane timestamp precision typing); no new candidate helper type error was reported.

### Safety / next step

- Production DB/Vault/X/OAuth/Cron writes by this task: **0**; no secrets or token values were read or recorded; no manual/synthetic X post, retry, backfill, or refresh was run.
- C1 should review the candidate schema/selection rules and decide separately whether to apply the migration and deploy the AI Lab-only wiring. Phase 2 should add the approved plan-writer/UI path and production migration/rollout gates; no automatic rollout is implied by this candidate.

## Latest H1 result — AI Lab Vault refresh production deploy (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-production-deploy-20260917`
- result: `review_required` — the exact C1-approved candidate was deployed to **`x-test-post` only**. No other Function, DB/schema/RPC/grant, secret, OAuth, Cron, posting setting, or manual X action was changed.
- deploy source: approved candidate commit `a7ffba4930a9eff3885ab29254f9858b80e71170` from `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`.

### Deployment read-back

- Pre-deploy `x-test-post`: ACTIVE v112, `verify_jwt=false`, hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`.
- Post-deploy `x-test-post`: ACTIVE **v113**, `verify_jwt=false`, hash `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`.
- Runtime source read-back reported 43 files and contained the approved AI Lab markers: `publishAiLabWithRefresh`, `ai_lab_vault_token_persistence`, fixed `ai_salaryman_lab` / `ai_salaryman_lab_x` refs, `expectedRefreshToken`, and `AI_LAB_TOKEN_PERSIST_FAILED`. No candidate secret/token/Vault value was returned or recorded.
- All other Function versions, hashes, and timestamps matched the pre-deploy inventory (including `x-oauth-connect` v20); only `x-test-post` changed.

### Verification

- Focused AI Lab suites: **30 passed / 0 failed**.
- Full `x-test-post` + `_shared/brand` regression: **474 passed / 0 failed**.
- Candidate helper modules type-check. The remaining `x_oauth2_post.ts` AES-GCM `BufferSource` diagnostic is the existing baseline diagnostic; no candidate-specific type error was introduced.
- `deno fmt --check` passed for the 7 candidate helper/source files and `git diff --check` passed. `x-test-post/index.ts` remains not formatter-clean in both latest main and candidate (pre-existing formatting drift); it was not reformatted to avoid unrelated source changes.

### Natural-slot observation

- The latest AI Lab slot visible immediately after deploy was slot 10, scheduled `2026-09-17 13:22:09+00` and completed before deploy at `13:23:04+00` with the prior runtime's `X_REQUEST_FAILED:401`, `attempt_count=1`, no X post id, and no retry.
- At post-deploy read time there was no future AI Lab `brand_post` row available. No manual invocation, retry, backfill, synthetic post, manual refresh, or OAuth reauthorization was performed. Therefore a post-deploy natural success/refresh outcome is still pending and must be observed through the existing Cron path.
- No rollback was performed. If a confirmed runtime regression occurs, rollback is limited to `x-test-post` using the pre-deploy v112/hash above; no token/Vault rollback is authorized.

### Safety boundary

- DB write: 0; Vault write: 0; manual refresh: 0; OAuth action: 0; X post initiated by this task: 0; secret/token/Vault value output: 0. The deployed runtime may refresh only as part of the approved natural AI Lab path.


## Latest H1 result — AI Lab Vault refresh runtime preflight (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-runtime-preflight-20260917`
- result: `review_required` — the isolated no-write Edge runtime gate passed. The refresh integration candidate remains undeployed; a separate production deployment approval is still required.
- temporary probe: `ai-lab-db-preflight`, version **1**, `verify_jwt=true`, source read-back hash `061228a5993b3ab180b6a09889883c3ca3b142e1170ad8ba5b33610d1ed30a65`. The source read-back matched the local probe source. It was deleted immediately after the single successful GET probe, so no temporary Function remains in production.

### Runtime result

- Direct connection: **success** from the deployed Edge runtime using the existing `SUPABASE_DB_URL`; the response only reported non-secret metadata.
- `db_url_present`: `true` (the URL value was never logged, returned, or recorded).
- Effective `current_user`: `postgres`.
- `has_function_privilege(current_user, 'vault.update_secret(uuid,text,text,text,uuid)', 'EXECUTE')`: **true**.
- `server_version`: PostgreSQL **17.6**. The probe used one short-lived client (`max=1`, 5-second connect/idle timeouts, 10-second max lifetime); the connection completed without timeout. The earlier read-only DB metadata showed `max_connections=60`. IPv4/IPv6 was not separately forced, but the production endpoint was reachable through the runtime path.

### Scope and safety verification

- The probe executed only `current_user`, `has_function_privilege`, and `current_setting('server_version')`. It did not call `vault.update_secret`, read `vault.decrypted_secrets`, or read any token/ref/value.
- Existing production Function versions, hashes, and timestamps were unchanged before/after the probe. After cleanup, `ai-lab-db-preflight` is absent from the Function inventory.
- Production changes other than the temporary probe deploy/delete: **0**. DB write: 0; Vault write: 0; X write: 0; OAuth action: 0; secret/token/Vault value output: **0**.
- `x-test-post` candidate commit `a7ffba4930a9eff3885ab29254f9858b80e71170` was not deployed. No source commit or production configuration change was made for the probe.

### Decision / remaining approval

- The direct-DB gate is now evidenced: the existing Edge runtime secret is usable, the effective role is `postgres`, and it can execute the Vault writer function according to metadata without invoking it. No immediate connection/pooling blocker was observed in this bounded probe.
- This does **not** authorize candidate deployment. C1 should separately review/approve deploying only `x-test-post` from the exact candidate commit; `x-oauth-connect`, DB/schema/RPC/grants, secrets, Cron, Kabumori, Mio, scopes, and posting behavior remain out of scope.


## Latest H1 result — AI Lab Vault refresh production preflight (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-production-preflight-20260917`
- result: `review_required` — read-only production preflight completed. The candidate remains source-only; no production deploy, Vault/token mutation, refresh request, OAuth reauthorization, post, schema/RPC/grant, Cron, or secret-value read occurred.
- candidate: `a7ffba4930a9eff3885ab29254f9858b80e71170` on `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`.

### Confirmed production facts (values intentionally omitted)

- Supabase secret metadata lists `SUPABASE_DB_URL`, `X_CLIENT_ID`, and `X_CLIENT_SECRET` as present. No secret value was retrieved, logged, or written to this report. No additional environment name is required by the candidate beyond these existing names.
- `x-test-post` is still the pre-candidate production runtime: ACTIVE, `verify_jwt=false`, Supabase version **112**, aggregate hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`. A source read-back contains no `ai_lab_token_refresh` / `ai_lab_vault_token_persistence` wiring, proving the candidate was not deployed.
- `x-oauth-connect` is ACTIVE version **20**. Its deployed token-exchange source uses confidential-client HTTP Basic authentication and `grant_type=refresh_token` (with the client id in the form body), matching the candidate refresh request and the AI Lab OAuth configuration. No scope or OAuth setting was changed.
- Production DB is ACTIVE in `ap-northeast-1`, PostgreSQL 17.6. The read-only SQL preflight returned `max_connections=60`.
- `vault.update_secret(secret_id uuid, new_secret text, new_name text, new_description text, new_key_id uuid)` exists as `SECURITY DEFINER`, owner `supabase_admin`, with `search_path=''`. `has_function_privilege('service_role', ..., 'EXECUTE')` is true; `authenticated` and `anon` are false. No writer RPC or grant was added. The query only inspected metadata and did not call the function.

### Remaining gate / decision

- The SQL MCP path proves production DB reachability and the service-role privilege metadata, but it does **not** prove that the deployed Edge runtime can open the direct `SUPABASE_DB_URL` connection with the required effective role, nor does it establish production pooling/IPv4/IPv6/connection-count suitability for `npm:postgres`.
- Because retrieving or testing the secret value through an ad-hoc client would expose or risk using a production credential, this task did not perform that test. Therefore deployability is **not yet proven**. A safe next gate is a separately authorized, no-write runtime preflight that opens the existing connection without logging the URL/token and executes only metadata checks such as `current_user` and `has_function_privilege`; otherwise the adapter must be redesigned to use an already-approved server-side writer (which would require separate schema/grant review).
- Blast radius is limited: the candidate branch is unchanged and production remains on the current runtime, so AI Lab behavior is unchanged (including the known refresh gap); Kabumori/Mio and all other Functions are unaffected.

### Deploy / rollback plan (not executed)

- After the direct-connection gate and a separate deployment approval, deploy only `x-test-post` from candidate commit `a7ffba4930a9eff3885ab29254f9858b80e71170`; do not deploy `x-oauth-connect` or change DB/schema/secrets. Read back the Function version/source hash and verify no other Function changed.
- If rollback is required, restore the previously observed `x-test-post` v112 bundle/hash above (or the exact approved source that produced it), then read back the version/hash. No Vault/token rollback is implied because this preflight performed no mutation.

### Safety checks

- No `supabase functions deploy`, `supabase db push`, migration/RPC/RLS/grant change, Vault read/write, refresh-token call, OAuth authorization, manual/synthetic post, retry/backfill, Cron/window change, or secret-value output was performed.


## Latest H1 result — AI Lab Vault refresh integration candidate (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-integration-candidate-20260917`
- result: `review_required` — integrated the C1-approved AI Lab refresh helper into the candidate `x-test-post` path, added a transaction-guarded Vault persistence adapter, and preserved the existing AI Lab completion/idempotency boundary. This is source-only; production was not deployed or mutated.
- candidate_branch: `codex/x-ai-lab-vault-token-refresh-integration-candidate-20260917`
- candidate_head: `a7ffba4930a9eff3885ab29254f9858b80e71170`
- base_helper_commit: `5d3128d` (rebased equivalent of the approved refresh helper)
- focused_fix_commit: `b8712a9` (rebased fail-closed non-2xx fix)

### Changed files and call graph

- `supabase/functions/x-test-post/index.ts`
  - AI Lab `brand_post` loads the fixed `ai_salaryman_lab_x` Vault bundle and X OAuth client credentials, then attaches the AI Lab-only refresh boundary to `postToX`.
  - `postToX` selects `publishAiLabWithRefresh` before the legacy path only when the fixed AI Lab context is present. Kabumori/Mio and the legacy `oauth_token_store` path are unchanged.
  - The existing `dispatchAiLabScheduledBrandPost` generation, dedupe, length, X-call, and terminal completion guard remains the outer boundary. A confirmed X write followed by uncertain completion still cannot be resent.
- `supabase/functions/_shared/brand/ai_lab_vault_token_source.ts`
  - Returns opaque fixed access/refresh references together with the loaded token pair; the legacy wrapper remains compatible for existing callers.
- `supabase/functions/_shared/brand/ai_lab_vault_token_persistence.ts`
  - Uses the Edge runtime `SUPABASE_DB_URL` with a short-lived Postgres client and `vault.update_secret` inside one transaction.
  - Holds a database advisory transaction lock, re-reads the fixed refresh secret, and rejects a stale expected token before either ref is written. Access is always updated; refresh is updated only when X rotated it.
  - SQL/provider/secret failures are sanitized to stable error codes; token values, DB URL, Vault IDs, and provider bodies are not logged or returned.
- `supabase/functions/_shared/brand/ai_lab_token_refresh.ts`
  - Passes `expectedRefreshToken` to persistence and preserves the stale-write code while keeping the one-refresh/one-retry upper bound.
- Tests cover the helper, writer, source bundle, and static x-test-post wiring.

### Verification

- Focused AI Lab suites: **30 passed / 0 failed** (13 refresh, 4 persistence/concurrency, 5 Vault source, 8 scheduled-dispatch).
- Existing `x-test-post` + `_shared/brand` regression: **474 passed / 0 failed**.
- `deno check --no-config`: candidate modules pass; x-test-post reports the same six pre-existing diagnostics (AES-GCM BufferSource, image Blob/BodyInit, `retry_count`, timestamp precision), with no new candidate diagnostic.
- Focused `deno fmt` and `git diff --check`: pass.

### Production boundary and remaining review items

- Read-only production SQL confirmed `vault.update_secret(uuid,text,...)` exists and is service-role-only; no secret values were read. No public Vault writer RPC, migration, grant, schema, RLS, or RPC definition was added.
- No Edge Function deploy, Vault/token mutation, refresh-token call, OAuth reauthorization, manual/synthetic post, failed-row retry/backfill, Cron/window change, or Kabumori/Mio change occurred.
- C1 should review whether the production Edge runtime exposes `SUPABASE_DB_URL` with the required direct-Postgres connectivity and whether the service-role database role may call `vault.update_secret`; deploy/token mutation remains separately unauthorized.

## Latest H1 result — AI Lab refresh candidate focused fail-closed fix (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-candidate-20260917`
- result: `review_required` — addressed the C1 blocker in the candidate branch only. Initial publish now succeeds only for 2xx, refreshes only for 401, and fails immediately for every other non-2xx status. No production deploy or token/Vault mutation was performed.
- focused_fix_commit: `09a199a` (`Fail closed on initial AI Lab publish errors`, rebased candidate branch)

### Fix and tests

- `publishAiLabWithRefresh()` now classifies the first result in this order: 2xx → success; 401 → one refresh/persist and one retry; any other non-2xx → `AI_LAB_PUBLISH_FAILED:<status>` with no refresh and no retry; thrown publish → `AI_LAB_PUBLISH_UNCERTAIN`.
- Added mocked regression coverage for initial 400, 403, 429, and 500 responses, asserting exactly one publish and zero refresh requests for each.
- Focused candidate suite: **13 passed / 0 failed**.
- Existing `x-test-post` + `_shared/brand` regression suite: **469 passed / 0 failed**.
- `deno check --no-config`, `deno fmt --check`, and `git diff --check`: pass.

### Safety boundary

- Only `supabase/functions/_shared/brand/ai_lab_token_refresh.ts` and its test changed in this focused fix. The live AI Lab branch remains `allowRefresh=false`; no source wiring, deploy, Vault write, OAuth reauthorization, DB/RPC/schema/migration, Cron, post, retry/backfill, or secret read occurred.
- The full candidate remains on `codex/x-ai-lab-vault-token-refresh-candidate-20260917` for C1 review. Production integration still requires separate review of the Vault writer, rotation concurrency, and outer completion/idempotency guard.


## Latest H1 result — AI Lab Vault refresh/rotation candidate (2026-09-17)

- task_id: `x-ai-lab-vault-token-refresh-candidate-20260917`
- result: `review_required` — an AI Lab-only refresh/retry candidate and mocked tests were implemented and committed. Production `x-test-post` was not changed or deployed; no production token/Vault/OAuth/DB/Cron action was performed.
- implementation_commit: `f22e2ca` (`Add AI Lab Vault token refresh candidate`, rebased candidate branch)

### Changed files and call graph

- `supabase/functions/_shared/brand/ai_lab_token_refresh.ts`
  - `publishAiLabWithRefresh()` is the decision boundary: one initial publish, refresh only on the first HTTP 401, then one retry of the same publish. It throws on an uncertain publish, persistence failure, or a second non-2xx response; no third publish or second refresh is possible.
  - `refreshAiLabTokens()` is scoped to the fixed `ai_salaryman_lab` / `ai_salaryman_lab_x` / `kaishain_ai_lab` context and validates both opaque Vault reference shapes before calling `POST /2/oauth2/token`.
  - The refresh request uses the confidential-client Basic header and `grant_type=refresh_token`. A rotated refresh token replaces the old one; if X omits a new refresh token, the existing refresh token is preserved.
  - Persistence is an injected `PersistAiLabTokens` callback receiving the same AI Lab Vault reference pair. It runs before the X retry; any writer error is sanitized to `AI_LAB_TOKEN_PERSIST_FAILED` and blocks retry.
  - Errors contain only stable codes/statuses; token values, client secrets, Vault IDs, response bodies, and provider error text are never copied into thrown errors.
- `supabase/functions/_shared/brand/ai_lab_token_refresh_test.ts`
  - 9 mocked tests cover valid-token/no-refresh, 401→one-refresh→one-retry, rotated refresh persistence, non-rotated refresh preservation, refresh failure, Vault persistence failure, second 401/no third publish, uncertain completion/no refresh, wrong brand/account rejection, and secret-safe errors.

### Verification

- Focused candidate suite: **9 passed / 0 failed**.
- Existing `x-test-post` + `_shared/brand` regression suite after the candidate: **465 passed / 0 failed**.
- `deno check --no-config supabase/functions/_shared/brand/ai_lab_token_refresh.ts`: pass.
- `deno fmt --check` on both changed files: pass.
- `git diff --check`: pass.

### Production boundary and remaining risks

- The live AI Lab branch remains unchanged with `allowRefresh=false`; this candidate is not wired into the deployed runtime yet. That is intentional: production currently has no approved Vault write adapter for updating the two existing secret destinations, and this task prohibits production token mutation.
- No Edge Function deploy, OAuth reauthorization, refresh-token call, Vault read/write, DB/RPC/schema/migration, Cron/window, manual post, failed-row retry, or backfill was performed.
- Before any production use, C1 must review the persistence adapter, Vault update mechanism, concurrency/rotation behavior, and whether the existing completion/idempotency guard remains the outermost boundary. A subsequent deploy/token mutation requires separate authorization.


## Latest H1 result — AI Lab recurring 401 read-only investigation (2026-09-17)

- task_id: `x-ai-lab-oauth-401-recovery-20260917`
- result: `review_required` — the recurring-401 cause was narrowed to an invalid/expired/revoked AI Lab access token that the current runtime intentionally does not refresh. No source, Function, database, Vault, OAuth, Cron, schedule, token, or posting mutation was performed.

### Fresh control and runtime evidence

- Fresh `origin/main` was fetched and used as the control base. At the final pre-report check it contained this task in `status: ready`; H2/G1/G2 have no OAuth/Vault/x-oauth-connect overlap.
- Production Edge Function inventory is unchanged for the relevant path: `x-test-post` is ACTIVE with the previously verified v110 bundle/hash (Supabase version counter currently reports 112), `verify_jwt=false`; `x-oauth-connect` is ACTIVE v20 with the previously verified v18 bundle/hash. No deploy occurred in this investigation.
- Read-back of the deployed `x-test-post` source shows the AI Lab branch loads only the fixed `ai_salaryman_lab_x` / `ai_salaryman_lab` / `kaishain_ai_lab` account, requires `identity_verified` and `publish_enabled=true`, reads both Vault references through `read_ai_salaryman_lab_x_vault_token`, and passes the loaded access token to the normal `POST /2/tweets` Bearer path.
- The AI Lab branch sets empty client credentials and `allowRefresh=false`; on a 401 it fails immediately as `X_REQUEST_FAILED:401`. It never falls back to `oauth_token_store`, and it never writes refreshed tokens.

### Success-versus-failure comparison

- Natural slot 6 (`2026-09-17 16:23 JST`) and slot 7 (`17:34 JST`) are the same AI Lab `brand_post` route. Each was claimed once (`attempt_count=1`) with one started log. Slot 6 has one succeeded log, one X post id, and one fingerprint; slot 7 has one failed log with `X_REQUEST_FAILED:401`, no HTTP status column value, no X post id, and no fingerprint. No retry/backfill occurred.
- At read time the non-secret account state was unchanged: brand `ai_salaryman_lab` is active/live; account `ai_salaryman_lab_x` is `identity_verified`, handle `kaishain_ai_lab`, `publish_enabled=true`, with both Vault refs present. The latest OAuth callback set the account and both named Vault secrets at `2026-09-17 05:47:20 UTC`; there is no later OAuth state or account mutation in the observed period.
- The only legacy `oauth_token_store` row is unrelated to the AI Lab path (it has no brand/account columns). Its presence does not affect AI Lab because the deployed dispatcher selects the Vault resolver before any legacy resolver.
- The Vault reader is a `SECURITY DEFINER` function with `search_path=''`; `information_schema.routine_privileges` shows EXECUTE only for `service_role` (and owner `postgres`), not `anon`/`authenticated`/PUBLIC. Function definition was read-only; no secret value or Vault id was read.

### Root-cause conclusion and remaining uncertainty

- Proven: this is not a slot-routing, duplicate, wrong-account, missing-ref, scope-string, or legacy-token selection problem. The same fixed Vault-backed account/ref path produced one success and then an X 401, while the application deliberately has no refresh path for AI Lab.
- Most likely cause: the access token stored by the OAuth callback became invalid/expired/revoked between the successful and failed calls. X’s OAuth 2.0 PKCE documentation states that `offline.access` supplies a refresh token and that a refresh request is the supported way to obtain a new access token; X’s error guidance describes invalid/expired credentials as an authorization failure. The runtime currently does neither refresh-on-401 nor expiry tracking for the Vault-backed AI Lab token.
- Not proven read-only: whether X expired the access token unusually early, revoked it, or rejected the token for an account/app permission condition. Production logs retain only `X_REQUEST_FAILED:401`; response headers/body are not persisted, so the specific X error subtype cannot be recovered from DB metadata.

### Required next fix / blast radius

- The next implementation must be separately reviewed by C1 before any mutation. It is limited to the AI Lab token lifecycle: refresh the Vault-backed refresh token on access-token expiry/401, persist any rotated access/refresh pair back to the same AI Lab Vault refs, and preserve fixed identity/account checks. It must not touch Kabumori/Mio, legacy `oauth_token_store`, scopes, schedules, Cron, schema/RPC definitions, or posting behavior.
- No future AI Lab slot was manually invoked, no failed row was retried, and no token refresh/re-authentication was attempted during this investigation.


## Latest H1 result — AI Lab OAuth 401 recovery (2026-09-17)

- task_id: `x-ai-lab-oauth-401-recovery-20260917`
- result: `review_required` — OAuth reauthorization succeeded for AI Lab only, the first natural post after restoration succeeded once, and the following natural slot returned 401 again. No retry, backfill, manual post, or media operation was performed.

### OAuth and account state

- User completed the X authorization in Safari. The first attempt returned `OAUTH_STATE_UNKNOWN`; a fresh state/PKCE authorization was generated through the existing `x-oauth-connect` start path and the second callback returned `success=true`, `connection_status=identity_verified`.
- Requested scopes were exactly `tweet.read users.read tweet.write offline.access`; no `media.write`, `like.write`, or `follows.write` was requested.
- Callback identity verification matched the exact expected username `kaishain_ai_lab` before credentials were accepted. Access/refresh Vault reference presence is true; token values and Vault IDs were never read or recorded.
- Non-secret post-callback state: `ai_salaryman_lab` is active/live, `ai_salaryman_lab_x` is `identity_verified`, handle `kaishain_ai_lab`, and `publish_enabled=true`. `enabled_post_types` remains `["brand_post"]`; all 10 AI Lab brand-post windows remain active.
- The OAuth begin/complete RPC temporarily forced AI Lab into dry-run/disabled mode. After explicit user approval, only AI Lab was restored to live/enabled with a guarded data update. Kabumori remains live/enabled with handle `yume_daka`; Mio was not touched.

### Natural-slot observation

- Slot 6, scheduled for 16:22:20 JST, was claimed once at 16:23:00 and completed at 16:23:05 with status `succeeded`. Terminal message: `AI Lab post completed; fingerprint persisted`; X post id `2100485677238677509`.
- Read-only fingerprint check shows exactly one AI Lab `brand_post` fingerprint and one distinct X post id for 2026-09-17.
- Slot 7, scheduled for 17:33:31 JST, was claimed once at 17:34:00 and failed at 17:34:05 with `X_REQUEST_FAILED:401`; no X post id and no second fingerprint were created. Future slots 8–10 remain pending.
- Earlier same-day rows remain historical evidence: slot 1 failed `UNSUPPORTED_POST_TYPE` before the dispatcher hotfix, and slots 2–5 failed 401 before OAuth restoration. No failed row was retried or backfilled.

### Safety and remaining issue

- No source or Edge Function deploy, schema/migration/RPC definition change, Cron/window change, OAuth scope expansion, Kabumori/Mio change, manual X post, candidate injection, OpenAI/X manual invocation, or media upload was performed in this recovery.
- The OAuth replacement is proven to permit one successful natural text post, but the next natural slot still returned 401. This indicates the 401 issue is not fully resolved; do not widen scope or add token refresh/fallback automatically. C1 should review the one-success/one-401 evidence and decide the next separately authorized investigation.

## Latest H1 result — AI Lab normal brand_post production hotfix (2026-09-17)

- task_id: `x-ai-lab-brand-post-production-hotfix-20260916`
- result: `review_required` — the missing normal `brand_post` route and Kabumori Admin brand-boundary leak are fixed and deployed/synced. The first post-fix natural slot reached the restored AI Lab X dispatch instead of `UNSUPPORTED_POST_TYPE`, but X rejected the current Vault-backed access token with HTTP 401. The row failed once without an X post or retry. OAuth/token changes were outside this task and were not attempted.

### Exact root cause and path difference

- The successful controlled `slot_no=0` post ran on production `x-test-post` v108, whose 39-file runtime included the AI Lab brand context, fixed Vault-token route, generator, dedupe, length guard, completion adapter, and canonical `dispatchAiLabScheduledBrandPost` branch.
- A later v109 deployment replaced that runtime with the then-current 27-file main source. Its index had no `brand_post` branch and no AI Lab brand modules, so normal slot 8/9/10/1 rows were claimed and fell through to `UNSUPPORTED_POST_TYPE:brand_post` before OpenAI/X.
- The hotfix reconciled the reviewed AI Lab runtime delta onto current main instead of replacing unrelated current code. All slot numbers, including controlled slot 0 and normal slots 1–10, now enter the same `dispatchAiLabScheduledBrandPost` implementation; there is no slot-0 special posting engine.

### Changed files

- `supabase/functions/x-test-post/index.ts`: restored brand-aware scheduled routing, fixed AI Lab Vault token source, no legacy Kabumori fallback/no refresh, canonical `brand_post` dispatcher, and completion-uncertainty no-retry guard.
- `supabase/functions/_shared/brand/`: restored 12 runtime helpers and their focused tests for brand/account gates, generation, <=280 code points, dedupe/fingerprints, Vault routing, and terminal completion safety.
- `supabase/functions/x-test-post/morning_greeting_payload_logic_test.ts` and `morning_greeting_publish_logic_test.ts`: updated assertions for deferred token loading after claim/brand resolution.
- `apps/admin/src/lib/brand-boundary.ts` plus `today-scheduled-posts.ts`, `post-history.ts`, `recent-failures.ts`, and `system-status.ts`: added server-side `brand_id='kabumori'` predicates to every touched `scheduled_posts`, `post_execution_logs`, and `posting_windows` query.
- `apps/admin/src/lib/brand-boundary.test.ts`: regression coverage for all touched Admin brand boundaries.

### Tests and source verification

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: **450 passed / 0 failed**. Coverage includes normal/reserved slot canonical routing, wrong-brand/account rejection, Kabumori isolation, 281-code-point pre-X rejection, duplicate blocking, confirmed completion once, uncertain completion no resend, unknown post type fail-closed, and the existing full x-test-post regression.
- `deno test --no-check --allow-read=. apps/admin/src/lib/brand-boundary.test.ts`: **5 passed / 0 failed**.
- Admin `npm run lint`: pass. Admin `npm run build`: pass, including TypeScript.
- `deno check --no-config supabase/functions/x-test-post/index.ts`: six diagnostics, exactly the same six as a clean latest-main comparison worktree (AES-GCM BufferSource, image BlobPart/BodyInit, `retry_count`, timestamp precision); no new hotfix diagnostic.
- `git diff --check`: pass.
- implementation commit/main source: `bed1cd513940fc7be03dd077d7fc5a9d2b998b34`. Push read-back matched `origin/main` before later non-overlapping slot commits advanced main.

### Production deploy/read-back

- Deployed **only** `x-test-post`; no DB/schema/migration/RPC/RLS, Cron/window, OAuth/token, Kabumori/Mio, media, or other Function change.
- Immediately after deploy: ACTIVE v110, `verify_jwt=false`, aggregate runtime hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`.
- Download/read-back contained exactly 39 runtime files. Byte comparison against the fixed candidate passed **39/39**, no mismatch; deterministic per-file aggregate SHA-256 `50f3f60eddf952cf41abe1b86a7e714f944d7a9f23fc9dd3b1607f563d5f5ca2`.
- Immediate pre/post Function inventory showed only `x-test-post` advancing (v109 -> v110); all other observed Function versions and timestamps were unchanged.
- At the later natural observation, Supabase's listing reported version counter 112, while `updated_at`, bundle hash, entrypoint path (v110 bundle), 39-file set, and restored dispatcher content remained unchanged. No different runtime source was observed.
- Admin source was pushed through the existing main-linked path; hosting/project settings were not changed. Local production build passed. A separate hosting deployment read-back was not available in this task.

### Natural Cron observation and safety stop

- No manual Function invocation, candidate injection, backfill, failed-row retry, OpenAI/X/Push call, or manual X post was made.
- Natural slot 2 (`scheduled_posts.id=45ee2e6f-ae78-4d9e-92dd-5595cb675177`, scheduled 09:48:36 JST) was claimed by the existing Cron at 09:49:00 JST and finished at 09:49:04 JST.
- Result: `failed`, `attempt_count=1`, terminal message `X_REQUEST_FAILED:401`. Crucially, `UNSUPPORTED_POST_TYPE:brand_post` did **not** recur, proving the normal scheduled row reached the restored AI Lab route and X dispatch boundary.
- Logs are exactly one `started` plus one `failed` record for the row; succeeded logs=0, logs with `x_post_id`=0, and unsupported-post-type logs=0. Fingerprints created since the attempt=0. The canonical dispatcher made one X API attempt, which received 401; confirmed X posts=0, media writes=0, duplicate sends=0, and automatic retries=0.
- Read-only account state remains fixed to `ai_salaryman_lab_x` / `kaishain_ai_lab`, `identity_verified`, publish enabled, with both Vault references present; brand remains active/live. No secret, token, or Vault reference value was read.

### Remaining blocker / C1 decision

- The dispatcher regression is repaired, but ordinary publishing remains blocked by the current AI Lab access token returning 401. Refresh is intentionally disabled on the AI Lab path to prevent legacy-token fallback or unapproved token mutation.
- Do not retry failed rows. A separately authorized AI Lab OAuth reauthorization/token replacement is required before a later natural slot can confirm successful X delivery. This task made no OAuth/token change and stops for C1.

## Latest H1 result — Phase 3K AI Lab first live rollout (2026-09-16)

- task_id: `x-multibrand-phase3k-ai-lab-first-live-test-20260916`
- result: `review_required` — Phase A/B/C completed. AI Lab write OAuth was deployed and reauthorized, one controlled text-only post succeeded once, and the existing ten posting windows were activated only after that success.
- authorization boundaries: only AI Lab was changed. No media scope/upload, Kabumori/Mio change, Cron change, schema/RPC/migration change, `supabase db push`, token refresh, or unrelated Function deploy was performed.

### Phase A — deploy and OAuth

- deployed only `x-oauth-connect` from exact approved commit `a469dcc50acc443efd65ebb933d527d3b21f5dca`.
- production read-back: ACTIVE v18, `verify_jwt=false`, 12/12 runtime files byte-identical to the approved candidate, no missing/extra files; aggregate source hash `96a5d3ea5a938a1f972e1a74aa6013f6a18934926ffcd30c2b4fb0f1746b7f98`.
- exact requested OAuth scopes: `tweet.read users.read tweet.write offline.access`; `media.write`, `like.write`, and `follows.write` were absent.
- user completed X authorization while signed in as `@kaishain_ai_lab`. Callback consumed the fresh state and completed identity verification at 2026-09-16 18:48:19 JST.
- `/2/users/me` verified username: `kaishain_ai_lab`. Only after this check were Vault-backed access/refresh references accepted. No token/secret/ref value was read or recorded.
- after callback: `ai_salaryman_lab_x` remained `identity_verified`, fixed handle `kaishain_ai_lab`, with both Vault references present; publishing was still disabled until Phase B.

### Phase B — controlled first real post

- preconditions: all ten existing AI Lab `brand_post` windows remained inactive; no same-day/future AI Lab `brand_post` schedule, fingerprint, or execution log existed.
- atomically changed AI Lab only: `publish_mode=dry_run → live`, `publish_enabled=false → true`, and `enabled_post_types=[] → [\"brand_post\"]`; inserted one controlled same-day row using reserved test `slot_no=0`, scheduled three minutes ahead. No window was activated at this point.
- execution: the existing every-minute natural Cron claimed the row at 18:58:00 JST and completed at 18:58:05 JST. Status `succeeded`, `attempt_count=1`, no error, no retry.
- first real post: X post id `2100162295930511602`, published 2026-09-16 18:58:05 JST, 115 Unicode code points, text only. It was visually confirmed on `@kaishain_ai_lab` at the matching status URL.
- completion safety: one succeeded execution log and one matching `published_content_fingerprints` row were persisted at the terminal completion timestamp. Observed AI Lab X text writes=1; media writes/uploads=0.

### Phase C — prospective ten-slot activation

- after explicit user confirmation of the recurring-production blast radius, exactly the existing ten AI Lab `brand_post` rows were changed from inactive to active in one guarded transaction.
- read-back matched all approved values unchanged: slots 1–10, `Asia/Tokyo`, daily probability 1.0, and the original windows 07:30–08:30 through 22:00–23:00. Active count changed 0 → 10; no time, slot, probability, or Cron cadence was changed.
- production `plan_daily_posts` definition was read before activation. For the current JST date it skips windows whose end time has passed and, for an in-progress window, starts no earlier than current time +1 minute.
- natural Cron at 19:14 JST produced only the prospective remaining rows: slot 8 at 19:52:05, slot 9 at 21:09:06, and slot 10 at 22:57:39 JST, all pending with `attempt_count=0`. Backfill count for expired slots 1–7 was 0.
- naturally executed rows observed during this rollout: the controlled slot 0 row completed once; the newly planned slots 8–10 were future pending at final read-back and were not manually invoked.

### Final state and isolation

- AI Lab: brand active/live; account identity verified and publish enabled; enabled post type `[\"brand_post\"]`; ten windows active; one succeeded controlled row and three future pending rows.
- Kabumori final read-back: brand active/live; `kabumori_x` handle `yume_daka`, identity verified, publish enabled; its brand/account timestamps and seven existing posting-window active states were not modified by this work.
- Mio final read-back: brand inactive/disabled and no social-account/window row observed; unchanged by this work.
- Function isolation: `x-test-post` remained v108 with its previously verified source hash. Only `x-oauth-connect` was deployed by H1. The independently updated `important-news-monitor` belongs to another slot and was not touched here.
- automatic stop conditions observed: none. No wrong account, duplicate, over-280 dispatch, token routing/refresh anomaly, uncertain completion, generation loop, media call, multi-post per slot, or scheduler/backfill anomaly occurred.
- source/tests: no new application source was edited in this continuation. The deployed candidate retained its prior 25/25 tests, changed-file type checks, format checks, and `git diff --check` evidence from C1.
- remaining observation: slot 8–10 are scheduled for later natural execution. Their delivery outcome is not claimed here; no manual execution or backfill was used.

## Latest H1 result — Phase 3K AI Lab text-write OAuth candidate (2026-09-16)

- task_id: `x-multibrand-phase3k-ai-lab-first-live-test-20260916`
- result: `review_required` — production `x-oauth-connect` needs a source change before AI Lab can request `tweet.write`, so the task stopped at the mandatory C1 gate before deploy or reauthorization.
- user approval: after the write-capable-token risk was stated explicitly, the user approved the code-only scope change, tests, candidate push, and C1 report. This approval did not execute a production deployment or OAuth flow.
- production baseline: `x-oauth-connect` ACTIVE v17 / `verify_jwt=false`. Its 12 runtime files were read back and matched commit `13cb948684785cdd189882b7434b981fabf96385` byte-for-byte (12/12), so that exact commit was used as the implementation base rather than the unrelated current `origin/main` source state.
- candidate: branch `codex/ai-lab-write-scope-20260916`, commit `a469dcc50acc443efd65ebb933d527d3b21f5dca` (`Add AI Lab text-write OAuth scope`).
- source change: AI Lab only changes from `tweet.read users.read offline.access` to `tweet.read users.read tweet.write offline.access`. `media.write`, `like.write`, and `follows.write` remain absent. Kabumori's existing scope string is unchanged.
- safety retained: fixed `ai_salaryman_lab_x` / `kaishain_ai_lab` routing, Vault destination, callback `/2/users/me` identity verification before token completion, `publish_mode=dry_run`, and `publish_enabled=false` are unchanged. The runtime still contains no X post or media-upload endpoint.
- changed files:
  - `supabase/functions/x-oauth-connect/account_config.ts`
  - `supabase/functions/x-oauth-connect/account_config_test.ts`
  - `supabase/functions/x-oauth-connect/rpc_test.ts`
  - `supabase/functions/_shared/brand/oauth_connection_test.ts`
- tests: `deno test --no-check --allow-read=. supabase/functions/x-oauth-connect supabase/functions/_shared/brand` passed 25/25. `deno check --no-config` on all four changed files passed. `deno fmt --check` passed on the three already-formatted x-oauth-connect files; the shared test has pre-existing whole-file formatting drift and was not reformatted beyond the touched assertions. `git diff --check` passed.
- production fresh-check before implementation: AI Lab brand remained active in `dry_run`; account `ai_salaryman_lab_x` / `kaishain_ai_lab` remained `identity_verified` with `publish_enabled=false` and Vault refs present; all ten AI Lab `brand_post` windows remained inactive; no unexpected scheduled AI Lab `brand_post` or published fingerprint was observed. No secret/ref value was read.
- production changes: 0. No Function deploy, OAuth start/callback, reauthorization, token save/refresh, DB/schema/RPC/migration/Cron/window/flag change, planner invocation, X post, or media upload occurred. Text-write calls=0; media-write calls=0. Kabumori and Mio were not changed.
- next gate: C1 must review exact commit `a469dcc50acc443efd65ebb933d527d3b21f5dca`. Only after a separate approved deployment may the AI Lab OAuth reauthorization be started; the callback must verify `/2/users/me` username exactly `kaishain_ai_lab` before any new Vault-backed token refs are accepted. Phase B/C were not entered.

## Latest H1 result — Phase 3J AI Lab posting schedule (2026-09-14)

- task_id: `x-multibrand-phase3j-ai-lab-posting-schedule-20260914`
- result: `review_required` — the approved schedule values are stored for AI Lab only, with all ten rows inactive. Publishing remains disabled and in dry-run mode.
- production writes: exactly 10 `INSERT` rows in `public.posting_windows`; no updates/deletes, schema/migration/RPC changes, or source changes.
- schedule rows read back exactly:

| Slot | JST window | Probability | Active |
|---:|:---|---:|:---:|
| 1 | 07:30–08:30 | 1.0 | No |
| 2 | 09:00–10:00 | 1.0 | No |
| 3 | 10:30–11:30 | 1.0 | No |
| 4 | 12:00–13:00 | 1.0 | No |
| 5 | 13:30–14:30 | 1.0 | No |
| 6 | 15:30–16:30 | 1.0 | No |
| 7 | 17:30–18:30 | 1.0 | No |
| 8 | 19:00–20:00 | 1.0 | No |
| 9 | 20:30–21:30 | 1.0 | No |
| 10 | 22:00–23:00 | 1.0 | No |

- every row is `brand_id='ai_salaryman_lab'`, `post_type='brand_post'`, `timezone='Asia/Tokyo'`, `daily_probability=1.0`, `is_active=false`.
- planner semantics read from production `public.plan_daily_posts(date)`: it ignores rows unless the window is active, the brand is active, and `publish_mode` is dry_run/live. Probability 1.0 passes the deterministic per-date gate; execution time is randomized within each window using the row timezone. No planner invocation was made by this task.
- safety preflight: before insert, no `brand_post` posting windows existed for any brand and no `brand_post` scheduled rows existed for the next ten days. `posting_windows` has no triggers. After insert, exact read-back showed ten inactive AI Lab rows; all existing non-AI-Lab rows were unchanged (the nine existing rows belong to Kabumori; no Mio row existed); upcoming `brand_post` scheduled-post count remains 0.
- constraints caveat: both `posting_windows` and `scheduled_posts` also have brand-agnostic uniqueness (`(post_type, slot_no)` and `(schedule_date, post_type, slot_no)`). No current competing `brand_post` row exists, so these ten inactive settings fit safely; future same-type/same-slot scheduling for another brand needs separate schema/planner review.
- runtime state after read-back: AI Lab brand `is_active=true`, `publish_mode='dry_run'`; account `ai_salaryman_lab_x` / `kaishain_ai_lab` remains `identity_verified`, `publish_enabled=false`.
- unchanged systems: existing `dispatch-scheduled-posts` Cron remains active every minute and was not edited; no OAuth, scope, token, publish flag, Function, migration, or schema operation was performed. No planner or `x-test-post` invocation was triggered manually for this task; this task made no direct X API or media-write call. No real/test post was attempted.
- tests/verification: production catalog/schema and planner definition inspected read-only; SQL INSERT RETURNING and subsequent full row read-back matched the ten requested slots. Upcoming scheduled-post side effect count=0. No application source code changed, so no code test suite was run.
- commit/push: control/report metadata only. Implementation-code commit/deploy: none.
- next gate: keep rows inactive. OAuth write-scope readiness and any later activation/live publishing require separate task/authorization; this result does not authorize a first post.

## Latest H1 result — Phase 3I deployment gate (2026-09-14)

- task_id: `x-multibrand-phase3i-runtime-reconciliation-deploy-20260914`
- result: `review_required` — exact approved candidate deployed, byte-verified, and non-posting smoke check completed. No first/live post was authorized or attempted.
- authorization: user directly approved only deployment of `x-test-post` from exact commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`, retaining `verify_jwt=false`, followed by source read-back/byte verification and non-posting dry-run verification.
- candidate: branch `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`, exact deployed commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`.
- deployment: production `x-test-post` ACTIVE v108, `verify_jwt=false`. Read-back contained 39 runtime files, aggregate SHA-256 `5d26b55b0d9474807b152e59461866b52d146fe26a4284dd2f1657abe61f4fef`; byte comparison against the exact candidate passed 39/39, with no missing, mismatched, or extra files.
- function isolation: pre/post version comparison showed only `x-test-post` changed (v107 → v108). Other observed Functions remained at their pre-deploy versions.
- non-posting smoke: one explicit synthetic voice-preview call returned HTTP 200, `mode=dry_run`, `published=false`. It took the synthetic Kabumori preview branch and returned `voiceEvaluation.passed=false`; no DB claim, token, X POST, or media-upload path was reached. This was not an AI Lab scheduled-brand invocation.
- AI Lab state: immediately-after read-only check remained brand `is_active=true`, `publish_mode=dry_run`; account `ai_salaryman_lab_x`, handle `kaishain_ai_lab`, `connection_status=identity_verified`, `publish_enabled=false`. Fingerprint count was 0 before and 0 after the smoke call. No token value was read.
- runtime safeguards: exact deployed source is the C1-reviewed candidate, whose 448/448 relevant tests passed. It retains the AI Lab 280-code-point pre-dispatch guard, fixed Vault-backed account routing, no Kabumori legacy-token fallback, and refresh disabled. This turn did not separately exercise the AI Lab route in production.
- mutations excluded: no migration/DB write, other Function deploy, OAuth/scope/token change, Cron/posting-window change, publish flag change, real X post, or media upload. X POST calls=0; media-upload calls=0.
- cleanup: temporary candidate `supabase/config.toml` and CLI version marker were removed. No implementation source changed during deployment.
- next_owner: ChatGPT review. Remaining before any first live AI Lab post: separately authorize scope changes if needed, verify exact posting-window requirements, and obtain distinct approval for publish enablement and the first real post. No such action is covered here.

- task_id: `x-multibrand-phase3i-runtime-reconciliation-20260914`
- result: `review_required` — source reconciliation passed local tests and was pushed for C1 review. Production remains on `x-test-post` v107; no deploy or new DB operation was performed.
- model_used: GPT-5.6 Sol
- production_source_base: `25998fc8927d8bd45a89478b1fec8b4bc5ba782b` (recorded v107 source, independently proven below)
- control_base: fresh `origin/main` `97c624267ab9d2ecb0b03487d5c5cdacdc5ab8dd`
- reviewed_source: Phase 3H commits `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b` and `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
- candidate_branch: `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`
- candidate_commit: `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`
- push: candidate branch pushed to `origin` for C1 review; no force push.
- production_project: `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`), ACTIVE_HEALTHY, Postgres 17.6, `ap-northeast-1`.

## Latest H1 result — Phase 3I runtime reconciliation

### Proven v107 baseline

- `supabase_get_edge_function(x-test-post)` returned ACTIVE version 107, `verify_jwt=false`, 27 runtime files, aggregate SHA-256 `54e8dae698415305185bb6e59f0cf4b1d12c0ca1df9750d44ff6d9772364fc71`.
- Each of the 27 API-returned file contents was compared directly with commit `25998fc8927d8bd45a89478b1fec8b4bc5ba782b`; all 27/27 were byte-identical. The deployed API entrypoint also pointed to this recorded source checkout.
- A second read-only function read after the candidate push still returned version 107 and the same aggregate hash; all 27/27 files matched the pre-work read exactly.
- v107 runtime file list:
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/functions/x-test-post/morning_report_logic.ts`
  - `supabase/functions/x-test-post/us_session_date_logic.ts`
  - `supabase/functions/x-test-post/close_report_logic.ts`
  - `supabase/functions/x-test-post/fixed_hashtags_logic.ts`
  - `supabase/functions/x-test-post/voice_retry_logic.ts`
  - `supabase/functions/x-test-post/close_report_data_logic.ts`
  - `supabase/functions/x-test-post/report_voice_rewrite_logic.ts`
  - `supabase/functions/x-test-post/us_premarket_logic.ts`
  - `supabase/functions/x-test-post/interaction_quality_logic.ts`
  - `supabase/functions/x-test-post/tip_voice_logic.ts`
  - `supabase/functions/_shared/kabumori_voice.ts`
  - `supabase/functions/x-test-post/voice_evaluation_logic.ts`
  - `supabase/functions/x-test-post/report_material_logic.ts`
  - `supabase/functions/x-test-post/morning_candidate_logic.ts`
  - `supabase/functions/x-test-post/morning_lane_response_logic.ts`
  - `supabase/functions/x-test-post/morning_report_retry_logic.ts`
  - `supabase/functions/x-test-post/admin_auth_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_image_logic.ts`
  - `supabase/functions/x-test-post/yume_reference_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_payload_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_scene_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
  - `supabase/functions/x-test-post/publish_claim_logic.ts`
  - `supabase/functions/_shared/x_oauth2_post.ts`
  - `supabase/functions/x-test-post/useful_tip_generation_logic.ts`

### Reconciliation and three-way diff

- v107 → candidate: only `x-test-post/index.ts` changes among the 27 existing runtime files; the other 26 remain byte-identical. Twelve imported brand runtime modules were added for brand context, guarded token routing, AI Lab generation/dispatch, length enforcement, fingerprints, and dedupe.
- Phase 3H `406b53c` → candidate: the three unrelated files `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts` remain at the proven v107 bytes. The unrelated TOPIX/report prompt and live-close selection hunks in `index.ts` were also restored to v107. The approved AI Lab Vault-backed dispatch and completion safeguards remain.
- Non-imported brand context dry-run routing and unrelated standalone OAuth/Vault metadata helper modules/tests from `406b53c` were not carried into this deploy candidate. This keeps the runtime candidate limited to modules imported by the reconciled `x-test-post` path. The two migration files are included unchanged from `406b53c` for source traceability/static security testing; they were not executed in this task.
- Existing-file edits are limited to `x-test-post/index.ts` and two tests whose ordering assertions now match deferred X-auth construction after scheduled-row brand selection. The close-report and hashtag source files and tests are unchanged from v107.

### Changed files

- Runtime entry: `supabase/functions/x-test-post/index.ts`.
- New runtime modules under `supabase/functions/_shared/brand/`: `ai_lab_brand_post_store.ts`, `ai_lab_scheduled_brand_post.ts`, `ai_lab_vault_token_source.ts`, `brand_context.ts`, `brand_post_dispatch_guard.ts`, `brand_post_generator.ts`, `brand_profiles.ts`, `cross_brand_dedupe.ts`, `kabumori_recent_fingerprints.ts`, `post_length_policy.ts`, `publish_guard.ts`, `token_loader.ts`.
- New/updated tests under the same directory: `ai_lab_brand_post_store_test.ts`, `ai_lab_scheduled_brand_post_test.ts`, `ai_lab_vault_token_source_test.ts`, `brand_context_test.ts`, `brand_post_dispatch_guard_test.ts`, `brand_post_generator_test.ts`, `brand_profiles_test.ts`, `cross_brand_dedupe_test.ts`, `dispatch_gate_test.ts`, `kabumori_recent_fingerprints_test.ts`, `post_length_policy_test.ts`, `publish_guard_test.ts`, `token_loader_test.ts`.
- Updated tests in `supabase/functions/x-test-post/`: `morning_greeting_payload_logic_test.ts`, `morning_greeting_publish_logic_test.ts`.
- Included exact, unchanged source files for the migrations already applied in the prior authorized task: `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`, `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`.

### Tests and safety

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 448 passed / 0 failed. Includes 279/280 pass, 281 blocked, dry-run no X callback, fixed AI Lab Vault routing/no legacy fallback/no refresh, duplicate blocking, confirmed-success completion and uncertain-completion duplicate-resend protection, plus Kabumori, close-report, TOPIX-source, and fixed-hashtag regressions.
- `deno check --no-config supabase/functions/x-test-post/index.ts`: six diagnostics, exactly the same six as clean v107 baseline `25998fc` (AES-GCM `Uint8Array/BufferSource`, image `BlobPart/BodyInit`, `retry_count`, timestamp precision). No new diagnostic from reconciliation.
- `deno fmt --check` on the ten core Phase 3H helper/test files: pass. A broader check of the curated 25-file brand directory still reports 10 files from the reviewed source as unformatted; no formatting-only edits were made.
- `git diff --check`: pass.
- Production read-back after work: `x-test-post` still ACTIVE v107, `verify_jwt=false`, same 27 files/hash. No Function deploy, runtime invocation, SQL/migration execution, DB write, migration history edit, Cron/settings/OAuth/token change, X post, or media upload. X/media writes: 0.

### Remaining gate

Candidate awaits C1 review. Stop before any Edge Function deploy; a separate explicit deploy authorization is required after C1. The two pre-existing Phase 3I migrations remain applied and must not be reapplied or replaced.

## Previous task metadata — Phase 3I pre-live rollout

- task_id: `x-multibrand-phase3i-ai-lab-production-prelive-rollout-20260914`
- result: `review_required` — both explicitly authorized migrations were applied and read back successfully. Stopped before Function deploy after discovering material differences between current production `x-test-post` and the exact reviewed commit that would replace non-Phase-3H code.
- model_used: GPT-5.6 Sol
- source_commit: `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`; fresh fetch of `origin/codex/ai-lab-prelive-safeguards-20260913` confirmed the exact remote HEAD. Both reviewed migration files exist in that commit; SHA-256: `342119d0ae523f0eb93a5d6b233395e9f326d7ce79c172f2e61b518e6f205ce6` (`20260913123509_ai_lab_prelive_safeguards.sql`), `88316c9e57f69c719db503fe184ab8cc806d04ebce1c08a70b04f8d544d34317` (`20260913151428_read_ai_lab_x_vault_token.sql`).
- control_base: `6c4a05a9e6aa583d5a7336aac7e41b3ca7af54fb`.
- production_project: `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`), ACTIVE_HEALTHY, Postgres 17.6, `ap-northeast-1`.

## Previous Phase 3I preflight and rollout results

- migrations_applied: only `20260913123509_ai_lab_prelive_safeguards.sql` and `20260913151428_read_ai_lab_x_vault_token.sql`, both read from exact commit `406b53c2...`. Supabase recorded `20260913230852` / `ai_lab_prelive_safeguards` and `20260913231013` / `read_ai_lab_x_vault_token`. No other SQL/migration applied.
- migration_readback: `complete_ai_salaryman_lab_brand_post(uuid,text,text)` and `read_ai_salaryman_lab_x_vault_token(uuid)` are present, both `SECURITY DEFINER`, empty `search_path`, service_role EXECUTE true and anon/authenticated false. Function bodies match the reviewed fixed brand/account/type/handle/identity/ref guards; completion marks only a matching running AI Lab `brand_post` row succeeded after confirmed success and handles fingerprint/log failure without repost eligibility. Partial unique `(social_account_id,x_post_id) WHERE x_post_id IS NOT NULL` index exists. Vault reader was not invoked.
- grants_and_policies: RLS is enabled but not forced on the five checked tables. There are no listed policies on `brands`, `social_accounts`, or `published_content_fingerprints`; `scheduled_posts` and `post_execution_logs` each have an authenticated SELECT policy. Catalog grants also show existing `anon`/`authenticated` REFERENCES, TRIGGER, and TRUNCATE privileges on `scheduled_posts` / `post_execution_logs`, plus authenticated SELECT; this task did not change them. These existing grants need owner review and are not treated as authorization to broaden or repair production permissions here.
- preflight: AI Lab brand is active and `dry_run`; account is `ai_salaryman_lab_x`, handle `kaishain_ai_lab`, `identity_verified`; `publish_enabled=false`. Vault reference presence was checked only as booleans; no reference identifiers or token values were read. `x-test-post` remains v107 ACTIVE / `verify_jwt=false`.
- x_test_post_deploy: none. Production remains v107 ACTIVE / `verify_jwt=false`.
- deployed_source_verification: before deployment, downloaded v107 runtime comparison showed 27 production files vs 40 source-commit modules; 23 were byte-identical, 13 target brand helpers are new, and four existing files differ. `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts` are unchanged by Phase 3H but differ from current production; `index.ts` also differs. Deploying the exact reviewed commit would replace the three non-Phase-3H files, so deployment was stopped to avoid a potential regression of other post types.
- non_posting_runtime_verification: no runtime invocation; X POST/media calls: 0.
- ai_lab_length_guard_result: production runtime not exercised. Reviewed source test suite passed 460/460.
- vault_route_result: fixed AI Lab account metadata still matches `ai_salaryman_lab_x` / `kaishain_ai_lab` / `identity_verified`, publish disabled, both ref columns present; reader ACL/body verified. No token/ref value was read and no token was refreshed.
- fingerprint_dry_run_result: dry-run not invoked; unique index exists; no fingerprint rows were inserted by this task.
- posting_window_status: no AI Lab posting window was present in the prior read-only state; none was created or changed. Exact schedule values remain unsupplied.
- write_scope_status: no OAuth scope change; AI Lab remains read-only (`tweet.read users.read offline.access`).
- tests: `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460/460 pass. Changed-file `deno check --no-config` returns six diagnostics; running the same check at clean base `341e5dc` produces the same six (Uint8Array/BufferSource, Blob/BodyInit, `retry_count`, timestamp precision), so no new type diagnostic. `git diff --check` on reviewed source: pass. Supabase security advisor returned no findings for the two new RPCs; unrelated existing warnings remain.
- production_changes: exactly the two approved migrations (recorded versions above). No Edge Function deploy, runtime invocation, X/media call, Cron/posting-window, OAuth, token, publish flag, or unrelated service change.
- unchanged_components: `important-news-monitor`, other Edge Functions, Cron, OAuth scopes/secrets, Kabumori, Mio, publish flags, and X posting.
- blocker: current production `x-test-post` contains existing code absent from the exact reviewed source commit. The migration layer is complete, but deploy is paused because replacing three unchanged-by-Phase-3H files could regress other post types.
- exact_steps_before_first_live_post: reconcile the production-source drift with a fresh reviewed commit or an explicit decision that the identified existing runtime files may be replaced; deploy/read-back only after that gate; separately supply posting-window values; separately authorize `tweet.write` reauthorization and verify `/2/users/me`; separately approve any publish enablement and first real post. No live/posting step is authorized here.
- safety_checks: only the two explicitly approved migration files changed production schema. No secrets/token values or Vault identifiers were read or recorded; no data rows, Edge Function runtime, publish flags, OAuth scopes, Cron, X post, or media upload were changed.
- next_recommendation: keep v107 deployed until the user resolves the exact-source regression risk; then re-review/deploy only the chosen `x-test-post` source. Do not reapply the two migrations.

---

## Phase 3H implementation details (previous report, carried forward)

## Length policy

- length_policy_design: shared discriminated union: finite `{mode: "limited", maxChars: positive integer}` or explicit `{mode: "unlimited", maxChars: null}`. Suitable for future app settings; no magic large maximum.
- Character counting uses JavaScript Unicode code points (`Array.from(text).length`): Japanese code points count one each and a surrogate-pair emoji such as 😀 counts one. This is not claimed to match X weighted-length rules.
- ai_lab_280_char_result: AI Lab profile sets 280. The generation prompt requests the limit; post-generation validation fails closed above 280 without truncation or retry. Tests cover 279/280 pass and 281 rejection, including Japanese and surrogate-pair emoji cases.
- unlimited_mode_design: tested explicitly; removes only the finite count limit. Brand, post type, and publish gates remain separate.
- Kabumori regression: its profile remains without a finite policy and retains the previous 200–400-character prompt; no live Kabumori dispatch code changed.
- dispatch_length_guard_result: wired into the AI Lab scheduled `brand_post` path and independently rejects over-limit text immediately before X dispatch. Wrong brand/type fails closed. No live post was made.

## Fingerprints / dispatch

- fingerprint_persistence_result: after a confirmed X success, `x-test-post` calls `complete_ai_salaryman_lab_brand_post`, which inserts the normalized-content fingerprint under a unique `(social_account_id, x_post_id)` key and marks the scheduled row terminal. Fingerprint insert failure is reported while terminal completion prevents automatic repost. If completion confirmation itself is uncertain after X success, a dedicated error path skips generic scheduled-post failure/retry handling to avoid duplicate resend. Dry-run does not call this live completion path; regression-tested.
- vault_dispatch_routing_result: AI Lab scheduled `brand_post` routes only through the fixed `ai_salaryman_lab_x` account, expected handle `kaishain_ai_lab`, `identity_verified` state, and that row's Vault token reference. A new local SQL RPC returns only the referenced token for that fixed account and is executable by `service_role` only. AI Lab has no fallback to Kabumori `oauth_token_store`; refresh is disabled. No token value was read or logged.
- posting_window_status: no AI Lab/`brand_post` posting-window row was present in the prior read-only check; none was added. Exact source-of-truth values still needed: post type confirmation, local start/end time(s), timezone, slot count/slot numbers, and `daily_probability` per slot.
- write_scope_readiness: no OAuth scope change or reauthorization. Existing AI Lab scopes remain read-only (`tweet.read users.read offline.access`); text posting requires separately approved `tweet.write`. `media.write` is only needed for a future media-upload flow. Before enabling publishing, separately reauthorize and verify `/2/users/me` still returns `kaishain_ai_lab`. No scope is authorized by this task.

## Files and database code

- changed_files:
  - `supabase/functions/_shared/brand/ai_lab_scheduled_brand_post.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/ai_lab_vault_token_source.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/post_length_policy.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_profiles.ts`
  - `supabase/functions/_shared/brand/brand_post_generator.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_post_dispatch_guard.ts` / `_test.ts`
  - `supabase/functions/_shared/brand/brand_post_dry_run_test.ts`
  - `supabase/functions/_shared/brand/kabumori_recent_fingerprints.ts` / `_test.ts` (optional strict failure mode for future live dedupe; existing default fail-safe behavior unchanged)
  - `supabase/functions/_shared/brand/ai_lab_brand_post_store.ts` / `_test.ts`
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/migrations/20260913123509_ai_lab_prelive_safeguards.sql`
  - `supabase/migrations/20260913151428_read_ai_lab_x_vault_token.sql`
- migrations/rpcs/functions_changed: two **local, unapplied** migrations. The first adds fingerprint idempotency and `complete_ai_salaryman_lab_brand_post`; the second adds fixed-account `read_ai_salaryman_lab_x_vault_token` (`SECURITY DEFINER`, empty `search_path`, `service_role` EXECUTE only). `x-test-post` is the only Edge Function source changed; it is not deployed.

## Tests

- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460 passed / 0 failed, including AI Lab routing/guard/completion and Kabumori regression tests.
- `deno check --no-config` for the changed helpers and `x-test-post/index.ts` reports the same six pre-existing diagnostics as a clean source-base checkout. They concern AES-GCM `Uint8Array`/`BufferSource`, `Uint8Array` Blob/body typing, missing `retry_count`, and unknown timestamp precision. No new type issue was identified versus baseline.
- `deno fmt --check` on the five new helper/test/migration files: pass. `git diff --check`: pass. The existing ~4.5k-line `x-test-post/index.ts` was not reformatted wholesale.
- Test files ran with `--no-check` because this worktree has no installed `npm:@types/node`; changed non-test modules were separately type-checked. SQL was not applied or executed in a local Postgres instance; `psql`/Docker were unavailable.

## Production, blocker, and next steps

- production_changes: 0. This code-only continuation did not access production. The prior read-only state remains the last verified state: AI Lab `publish_mode=dry_run`, `publish_enabled=false`; no token values were read. No production DDL/data/RPC write occurred.
- deploy_status: none; no Edge Function deployed. X POST/media calls: 0. Cron, OAuth scopes, secrets, account settings, Kabumori, and Mio were not changed.
- remaining_issues: C1 review. Separately, static/review and exact approval are needed before applying either local migration; production deploy/read-back; confirmed schedule data; separately approved `tweet.write` reauthorization and identity check; separate approval before changing live flags or sending a first post. iOS is not relevant to this Edge Function task.
- exact steps before first AI Lab live post: (1) C1 review this code and both migrations; (2) obtain separate exact approval before applying the two migrations, then read back function definition/ACL and verify the fixed account/token reference guard; (3) obtain separate approval before deploying only `x-test-post`, then verify deployed source/version; (4) confirm exact AI Lab posting-window values from its source of truth (do not invent or change Cron); (5) separately approve OAuth reauthorization adding `tweet.write` while retaining current read scopes, then use read-only `/2/users/me` to verify `kaishain_ai_lab`; (6) only after separate explicit approval may publishing flags be changed and a first real X text post be sent. No step beyond local implementation/testing is authorized here.
- safety_checks: no live mode/publish enablement, DB change, deploy, X post, media upload, token refresh, OAuth scope change, Cron/posting-window change, Kabumori token/path change, or Mio change. AI Lab routing has no legacy fallback and does not refresh. Secret/token values were not emitted to logs, responses, Git, or this report.
- next_recommendation: C1 review the pushed branch/diff and commit integrity. Stop here; do not apply migrations, deploy, change OAuth scopes or publishing flags, or send an X post without their separate explicit approvals.

---

## Previous Codex report — broad-news-display-and-notification-presets-phase3-20260913

- task_id: `broad-news-display-and-notification-presets-phase3-20260913`
- result: `review_required` — Phase 3のアプリ表示・通知プリセットをローカル実装し、回帰テストまで完了。本番変更は0件
- model_used: GPT-5.6 Sol
- source_base: `origin/main` `2c7e3745885d659af0b67af1261587af3ed39eff`
- implementation_branch: `codex/broad-news-presets-phase3-20260913`
- commit_hash: `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`
- next_owner: chatgpt

## App visibility

- current_app_visibility: 本番RPCは、登録銘柄の既存companyニュースと、登録銘柄の業種に関連するmarket-wide critical/highを表示する。market mediumは対象外で、登録銘柄0件ならアプリ側がRPCを呼ばず空表示だった。
- new_app_visibility: companyは既存の保有/監視紐付けを維持してmedium以上を表示。market-wideは関連業種があるmedium/high/criticalを表示し、emergencyは登録銘柄・業種一致なしでも表示。lowは収集・分類に残すが一覧には出さない。登録銘柄0件でもRPCを呼ぶ。表示用app copyはFact-passedだけを返し、emergencyは元見出しが日本語でも独立したFact check済みcopyを要求する。
- category_labels: list/detailの両方に16カテゴリの日本語チップを追加（地政学、災害、金融政策、為替、金利、原油・エネルギー、コモディティ、海運・物流、半導体、AI・テック、米国市場、日本市場、政策・規制、企業、決算、金融システム）。
- severity_labels: `emergency=緊急`, `critical=最重要`, `high=重要`, `medium=注目`。

## Notification policy

- current_notification_logic: companyはX publish後の個別producer、market criticalは既存market producerが対象判定し、dispatcher/claim RPCが配信直前に `push_enabled` / `important_news` / `market_critical_news` を再確認する。
- proposed_or_implemented_presets:
  - `quiet / 静かめ`: company critical以上、market emergencyのみ。
  - `standard / 標準`: company high以上、market critical以上。
  - `many / 多め`: company medium以上、market high以上。
  - `all_useful / かなり多め`: company/marketともmedium以上。
  - lowは全プリセットでPushしない。
- legacy_settings_compatibility: 既存行はmigration時に新2列をNULLのまま残す。producer上のNULL presetは既存company相当のstandard、NULL emergencyはOFF。既存 `market_critical_news` はdispatcher互換ゲートとして維持し、保存RPCが同一トランザクションで同期する。UIは既存rowのmarket=trueをstandard、falseをquietとして表示する。既存false rowは保存するまでcompany thresholdが従来どおりstandardで、保存後に明示したquietへ移行する。新規rowだけstandard/emergency ONがdefault。
- emergency_behavior: Fact-passed日本語copy、freshness、exact/cross-source event dedupe、push_enabled、important_news、emergency_alertsを必須化。market emergencyはtracked stock/sector一致不要で、通知行の `tracked_stock_id` もNULL。
- category_setting_behavior: `alert_category_settings(user_id, category, enabled)` の行形式。RLSは本人のみ。設定行なし・候補カテゴリなしは有効扱い。複数カテゴリ候補は1つでもONなら対象。

## Database / producer

- schema_changes: `alert_settings.notification_preset` / `emergency_alerts` を既存行safeなnullable追加（新規rowのみdefault）。owner-only RLS付き `alert_category_settings`、atomic保存RPC、NULL-stock market通知のpartial unique index、更新版app-copy selector/feed RPC、service-role専用統一producer RPCを追加するmigrationを作成。
- producer_changes: `important-news-monitor` の実runでapp copy完了後、およびpublish成功後に統一producer RPCを呼ぶ。eligibilityはSQL producerが決定し、既存notifications queueへだけenqueue。dry-runでは呼ばない。
- dispatcher_changes: none。`send-push-notifications` と `claim_pending_push_notifications` は変更なし。

## Read-only production estimate (2026-09-13 JST)

- 7day_notification_volume_estimate:
  - 母数: profiles 1、alert_settings 1、Push/important_news有効1、market_critical_news有効1、tracked user 1、Push token user 1。
  - 現在の実ユーザー・実候補へFact-passed日本語/対象条件を当てた見込み: quiet 0、standard 1、many 3、all_useful 3。
  - 7日窓ではcompany対象0、market対象はstandard 1 / many 3 / all_useful 3。
  - 実送信、candidate注入、settings変更はしていない。
- medium_feed_volume_estimate: effective severityはemergency 0、critical 1、high 7、medium 8、low 40。現行critical/high相当8件からmedium以上16件へ最大+8件の見込み。
- emergency_false_positive_review: 7日窓のemergency候補0件。誤検出0件で誤検出クラスなし。ただし実例母数0のため自然データ監視が必要。

## Tests

- important-news-monitor全runtime suite: 395 passed / 0 failed。
- dispatcher + personalized report regression: 48 passed / 0 failed。
- app presentation/label tests: 27 passed / 0 failed。
- 変更Expoアプリファイル限定TypeScript strict check: pass。
- iOS Expo export: pass（1,638 modules、Hermes bundle 4.3 MB）。
- `git diff --check`: pass。
- `deno check supabase/functions/important-news-monitor/index.ts`: 変更外の既知エラー `supabase/functions/_shared/x_oauth2_post.ts:66`（Uint8Array/BufferSource型差）で停止。変更ファイル由来の新規エラーは検出されていない。
- migrationはC1前の本番適用禁止を守り、PostgreSQL実行パーサでは未実行。静的契約テストとproduction schema read-only監査まで。

## Production / deployment

- production_changes: 0件。DB row/schema/RPC/user settings、Push、candidate、Cron、X、secretを変更していない。
- deploy_status: 未deploy。C1承認待ち。
- production_read_only_audit: schema/RLS/grants/RPC、migration履歴乖離、直近7日候補と現在audienceだけをread-only確認。通常の `supabase db push` / `--include-all` は未使用。

## Changed files

- `docs/news-coverage/REDESIGN.md`
- `src/app/news/[id].tsx`
- `src/app/news/index.tsx`
- `src/components/important-news-alert-settings.tsx`
- `src/lib/alert-settings.ts`
- `src/lib/important-news.ts`
- `src/lib/news-labels.ts`
- `supabase/functions/important-news-monitor/app_copy_logic.ts`
- `supabase/functions/important-news-monitor/app_copy_logic_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/market_critical_sql_static_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_wiring_test.ts`
- `supabase/functions/important-news-monitor/notification_presets_sql_static_test.ts`
- `supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`
- `tests/app/news-labels_test.ts`

## Remaining issues

- iOS simulator/Development Buildの実画面操作は未実施。未適用schema/RPCへ接続すると設定画面が失敗するため、C1後にexact migration適用とFunction deployを行ってから確認する。
- 新migrationの本番SQL実行、Function deploy、自然Cronでのenqueue/Push到達は未実施。
- 7日窓にemergency実例がなく、false-positive評価は自然候補で継続が必要。
- repository全体のtyped Deno suiteには上記の変更外型エラーがある。runtime suiteは全通過。

## Safety checks

- isolated clean worktreeを使用し、元worktreeの未コミット変更へ未接触。
- 最新 `origin/main` へrebase済み。競合なし。
- dispatcher/claim RPC、他Edge Function、他migration、Cron、X投稿、secrets、OAuth、他post_typeは変更なし。
- service roleはproducer RPCだけ。アプリはauthenticated/RLS経路だけを使用。
- synthetic/manual Push 0、synthetic candidate 0、production write 0。

## Push

- push: implementation commit `f7c17b915c551ba81b1dfc62a0731fd3eba6f008` と本completion control情報を `origin/main` / `origin/codex/broad-news-presets-phase3-20260913` へfast-forward同期済み。

## Next recommendation

`C1` でmigration SQL、legacy互換、通知量試算、app UI、producer境界をレビューする。承認後も一括db pushは使わず、exact migration適用 → 関数/ACL/RLS read-back → `important-news-monitor` のみdeploy → iOS Simulator/Development Build → 自然Cron監視の順で進める。

---

## Previous report — kabumori-x-oauth-recovery-20260913

- task_id: kabumori-x-oauth-recovery-20260913
- result: review_required — Kabumori本人OAuth再認証、暗号化token置換、refresh-only proof、本番read-backまで完了
- next_owner: chatgpt
- implementation_branch: `codex/kabumori-x-oauth-recovery-20260913`
- commit_hashes: `ed4c8c038e88274e59460997fa75e3f4721dfbf7`, `13cb948`
- push: `origin/codex/kabumori-x-oauth-recovery-20260913` へpush済み
- production_deploy: `x-oauth-connect` v13 ACTIVE / `verify_jwt=false`; 12 runtime filesをdeploy後にread-backし完全一致
- production_migrations:
  - repo `20260912232914_add_kabumori_oauth_recovery_rpc.sql` / production history `20260912235802`
  - repo `20260913000926_correct_kabumori_x_handle.sql` / production history `20260913010947`

## Root cause

- 2026-09-13 `morning_greeting` は既存refresh tokenでX token endpointがHTTP 400を返し、`X_TOKEN_REFRESH_FAILED:400` で失敗した。
- 本番開始probeでlegacy token storeは現行 `X_CLIENT_SECRET` 由来鍵により復号可能だった。このため「client secret変更 → legacy復号失敗 → server-secret fallback」の第一仮説は否定された。
- 旧refresh失敗のX response bodyは既存実装が保存していないため、`invalid_grant` 等の厳密なsubtypeは未確定。事実として確認できる範囲では、保存済みrefresh tokenがX側で無効だった。
- 初回再認証ではDBの誤登録handle `kabumori` と実アカウントが一致せず、token保存前に `X_IDENTITY_HANDLE_MISMATCH` で安全停止した。ユーザー確認で実X handleは `yume_daka` と判明し、固定allowlist・DB row・Kabumori専用RPCを訂正した。

## Changed files

- `supabase/functions/x-oauth-connect/index.ts`
- `supabase/functions/x-oauth-connect/start_logic.ts`
- `supabase/functions/x-oauth-connect/account_config.ts`
- `supabase/functions/x-oauth-connect/legacy_token_store.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery.ts`
- `supabase/functions/x-oauth-connect/rpc_test.ts`
- `supabase/functions/x-oauth-connect/account_config_test.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery_test.ts`
- `supabase/functions/_shared/brand/oauth_connection_test.ts`
- `supabase/migrations/20260912232914_add_kabumori_oauth_recovery_rpc.sql`
- `supabase/migrations/20260913000926_correct_kabumori_x_handle.sql`

## Implementation

- OAuth開始は既存admin JWTまたはDashboard secret-keyのPOST開始専用経路のみ。
- Kabumori/AI Labを固定allowlistで分離。AI Labは既存read-only scope、dry_run、Vault保存を維持。
- KabumoriはPKCE、random state、expiry、一回限りconsume、`GET /2/users/me` のhandle照合を通過してからlegacy token storeへAES-GCM暗号化保存。
- fresh refresh tokenを即時に一度rotateし、同じ保存先から再読込・復号後に `GET /2/users/me` で同一本人を再確認。
- Kabumori専用RPC 3件は `SECURITY DEFINER`、空の `search_path`、service roleのみEXECUTE。brand/account/handleを固定し、publish設定を変更しない。
- OAuth Function runtimeにはX投稿・media upload endpointを実装していない。

## Tests

- 対象テスト: 15 passed / 0 failed。
- Supabase Edge Function全テスト: 705 passed / 0 failed。
- `deno check --config supabase/functions/x-oauth-connect/deno.json supabase/functions/x-oauth-connect/index.ts`: pass。
- `git diff --check`: pass。
- 2つのmigrationをローカルPostgresのBEGIN/ROLLBACK内で検証。handle guard、state consume、本人完了、RPC ACL、空search_pathを確認し、永続テストデータ0件。
- Supabase advisors: 今回追加した3関数はmutable search_path / anon / authenticated SECURITY DEFINER警告の対象外。既存の別オブジェクトに関する警告は本タスクで変更していない。

## Production proof

- callback: success / `connection_status=identity_verified`。
- refresh-only proof:
  - X token endpoint 2xx
  - rotated tokenを暗号化保存
  - 同じruntimeで再読込・復号成功
  - `GET /2/users/me` で `yume_daka` 本人を再確認
  - X post API 0 call
  - media upload API 0 call
- `oauth_token_store` は2026-09-13 10:15 JST頃に更新され、有効期限は同日12:15 JST頃。暗号文と16文字base64 IVのみ保存されていることをread-only確認。
- `kabumori_x`: handle=`yume_daka`、`identity_verified`、platform user id設定済み、既存publish_enabled=trueを維持、Vault token refsなし。
- OAuth stateは2回ともconsume済み、unconsumed 0。初回handle mismatchではtoken metadata不変。
- publish claimsは開始前後ともtotal 11 / published 4。最新の9/13 morning_greeting claimは従来のfailedのままで、人工retryや新規投稿は行っていない。
- `ai_salaryman_lab_x` のidentity、Vault refs、`publish_enabled=false`、brand `dry_run` は開始前後で不変。
- Cron、scheduler、`x-test-post`、他Edge Function、他ブランド、Push領域は変更なし。

## Remaining issues

- 旧refresh tokenがX側で無効になった厳密な理由は、旧400 response bodyが記録されていないため確定不能。
- 自然Cron経路での次回投稿到達はまだ発生していない。手動投稿は禁止のため実施していないが、同じrefresh・保存・復号経路はrefresh-only proofで検証済み。

## Safety checks

- 手動X投稿0件、手動candidate/scheduled row注入0件、Cron変更0件。
- AI Lab token/Vault row変更0件、live化0件、publish有効化0件。
- secret/token/code/verifier値はGit・Report・DB平文列・Function responseへ記録していない。Dashboard secret keyはPOST開始専用の組み込み操作だけで使用。
- 本番DDLは上記2migrationのみ。通常の一括db push、`--include-all`、migration history修復は未実施。

## Next recommendation

`C1` で本報告と実装branchをレビューする。次回の自然投稿でpublish到達を確認し、旧9/13 failed rowは人工再実行しない。
