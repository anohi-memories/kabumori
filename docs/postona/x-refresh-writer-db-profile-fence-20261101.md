# POSTONA X token refresh — a no-write fence, and who must wire it (G4-02 #8, 2026-11-01)

task_id: `postona-g4-gen2-08-x-refresh-worker-personal-db-profile-failclosed-no-write-20261101` (Issue #561). Stacked on PR #614.

**Status:** source and local QA only. Nothing is applied or deployed. Production stays NO_GO.

(Superseded where it differs by G4-02 #9, `x-refresh-writer-personal-precheck-wired-20261101.md`: the writer is wired in source, personal workspaces only, and XR5 now refuses.) **At G4-02 #8 the fence was built and proved, but NOT WIRED into the live writer.** Until its owner wires it, the risk this TASK names stays open on that path.

## 1. Who writes X credentials

| Writer | Entry | Owner | Fenced? |
| --- | --- | --- | --- |
| Connect / reconnect | `x-oauth-connect-user` | G4 | **Yes** (G4-02 #7) |
| Disconnect | `public.disconnect_social_mobile_x_connection` | G4 | No, on purpose (no provider, no credential stored) |
| **Token refresh, legacy path** | `supabase/functions/x-test-post/vault_account_auth.ts` L191 (`runXTokenRefresh`) → `begin_` / `commit_x_account_refresh_legacy_post` | **Not G4** (see below) | **No: open** |
| **Token refresh, v2 path** | `supabase/functions/_shared/x_v2_account_refresh.ts` (`refreshXAccountPreX`, `createXAccountRefreshRpcLedger`) → `begin_` / `commit_x_account_refresh_v2` | **Not G4** | **No: open** (the ledger has no production caller outside its test on this stack) |
| Any `service_role` client | calling those RPCs directly | operator | **No**: the RPC bodies are main's and were not changed |

**Why not G4's:**
- `docs/postona/multi-social-phase1.md` L321 lists "OAuth・Vault・refresh core・退会の状態機械（G5／稼働中）".
- `docs/postona/oauth-adoption-blockers-review-package-20261025.md` L43 says "token の更新の担当（G4 ではない）".
- `x-test-post` is the live X bot. No single slot is named as its current owner, so **the assignment is for 総合指令ちゃ**.

Per the TASK, G4 did not change these files.

## 2. What was built (G4-owned)

- **`supabase/candidates/postona_g4_x_oauth_personal_mvp/007_x_refresh_precheck.sql`** (+ rollback): `public.postona_x_refresh_precheck_v1(p_social_account_id text) returns text`.
  - `allow` only when 006 answers `personal` **and** G4's X verdict says verified for the account's single owner. Otherwise one fixed code. No token, secret id or generation.
  - It re-uses the two existing answers; no duplicate logic.
  - md5 of the body: `1d88e5630cb3c643ad44d9b1c9ebafb8`.
- **`supabase/functions/_shared/x_refresh_db_profile_fence.ts`** (not imported by any live path): `createXRefreshPrecheck` + `withXRefreshPrecheck(port, precheck, accountIdOf)`.
  - **Only `begin` is fenced.** X refresh tokens are single-use: after the provider call, the result must still reach commit / release, or the new tokens are lost.

| The precheck's result | The refresh routine |
| --- | --- |
| `allow` | runs as before |
| no function (full / not installed, 404), no privilege, drift, any other shape | `not_started X_REFRESH_DB_PROFILE_MISMATCH`, not retried |
| a fixed refusal (`SERVICE_NOT_ACTIVE`, `DISCONNECTED`, `CONNECT_PENDING`, `CONNECTION_ERROR`, …) | `not_started X_REFRESH_PRECHECK_<code>`, not retried |
| `REFRESH_IN_PROGRESS` | `not_started X_REFRESH_IN_PROGRESS`, retryable (the routine's existing code) |
| network failure, 5xx | `not_started X_REFRESH_UNAVAILABLE`, retryable (the routine's existing code) |

In every refusal: **no lease, no provider call, no write**.

## 3. New surface (for the single review already proposed)

**One STABLE SECURITY DEFINER function**, read-only, empty search_path; `EXECUTE` to **`service_role` only** (not anon, not authenticated). Definer is needed because the X verdict and G5's brand owner are owner-only.

Add it to the single review already proposed (the generated personal X delta, the build script, the verdict gate, the G4-02 #7 function, together with G3's consumer change). H1-29 / H4-15 are not repeated.

## 4. Measured (real local stack: real PostgREST as service_role, real Vault, the real refresh core, the real `runXTokenRefresh`; fake X)

`postona_g4_oauth_local_stack/run.sh`: **29/29, node exits by itself.** The port is the same RPC port as `vault_account_auth.ts`'s legacy path.

| # | Scenario | Result |
| --- | --- | --- |
| XR1 | correct personal database | `refreshed`; provider 1; tokens rotated in real Vault; refresh state idle; generation unchanged; a signed-in person cannot call the precheck |
| XR2 ×4 | full (owner epoch present); not installed (404); catalog drift (helper exposed); no privilege (service_role lost EXECUTE) | **PASS with the fence:** `not_started X_REFRESH_DB_PROFILE_MISMATCH`, provider 0, tokens / state / generation unchanged. **FAIL without it (same database, same routine):** `refreshed`, tokens rotated |
| XR3 | service ended; disconnected; connect pending; a second run during a refresh; after an unknown provider outcome | `..._SERVICE_NOT_ACTIVE`, `..._DISCONNECTED`, `..._CONNECT_PENDING`, `X_REFRESH_IN_PROGRESS` (one provider call in total), `..._CONNECTION_ERROR`: provider 0 each |
| XR4 | disconnect while the provider answers | the core refuses the stale write: `uncertain X_REFRESH_ACCOUNT_CHANGED`; nothing written |
| XR5 | generation moved (service end + restart), connection untouched | **`refreshed`** (measured, see §5) |

`G4T_VERDICT=1`: 007 refuses on the full profile, without 006, and twice; `service_role` only; rollback and install again. Offline: 12 refusal shapes around the real routine; `commit` / `release` never fenced.

**Regressions:**
- real stack start / callback scenarios (the previous 21) still pass;
- X e2e main / g4 / g4p 11/11 each, with the negative control;
- Threads 19/19 ×2; bridge flow, G4-43;
- app 326/326; Deno, `tsc`, `expo lint`.

## 5. Risks left open (not hidden)

1. **The live refresh path is not fenced** until its owner wires it (§6).
2. **The precheck is personal-workspace only.** Wired onto all of `x-test-post`, it would refuse every **existing brand / operator account** (`NOT_OWN_WORKSPACE`, `LINEAGE_UNKNOWN`) and stop their refresh: those accounts' posts would fail once their tokens expire. Wiring must be scoped (e.g. only accounts in a `u_…` workspace), and how the operator accounts live with a personal database is an open decision.
3. **On a database without the personal build it refuses everything,** so today's production must not get the wired code before adoption.
4. **XR5: a service end + restart does not stop a refresh.** The connection stays the same person's; G3's send still compares its own stored generation (MV). If the product wants a restart to require a reconnect, that is a separate decision (G5 / 担当ちゃ).
5. **Direct `service_role` calls to the core RPCs are not stopped** (main's bodies were not changed).

## 6. The owner's minimal IF

In `x-test-post/vault_account_auth.ts`, at the `runXTokenRefresh` call (L191), for personal-workspace accounts only:

```ts
const precheck = createXRefreshPrecheck({ supabaseUrl, serviceRoleKey });
// inside the port's begin, first:
await precheck(ref.socialAccountId); // throws a fixed code: the routine reports not_started, with no provider call
```

Or wrap a port with `withXRefreshPrecheck(port, precheck, accountIdOf)`. **Never fence commit / release.**

**Order:** personal SQL through 007 → the wired worker → verify on a signed-in test account → rollback in reverse (unwire first; 007 rollback under a wired worker refuses every refresh).

**Do not adopt if any of these holds:**
- the refresh worker runs unfenced on a database that answers `mismatch`, or whose X accounts are personal while the fence is absent;
- the wiring is not scoped away from operator accounts;
- G5's MVP or the single review has not passed.

**NOT_VERIFIED:**
- managed Supabase;
- real X;
- the v2 path against its real core (`20260925150000`: the local world has the legacy path's core only; the fence on the v2 ledger's `begin` is proved offline);
- the deploy;
- production.
