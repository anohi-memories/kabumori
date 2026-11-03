# POSTONA X token refresh — the personal precheck wired into the real writer (G4-02 #9, 2026-11-01)

task_id: `postona-g4-gen2-09-x-personal-refresh-live-writer-begin-only-precheck-integration-20261101` (Issue #561). Stacked on PR #615. Owner assignment: #299 comment 6559191501 (G4 as the single owner of the non-production source integration of these paths).

**Status:** source and local QA only. Nothing is applied or deployed. Production stays NO_GO. **This is not production protection until it is adopted (§5).**

## 1. The writers, as measured in source

| Writer | Runs? | This PR |
| --- | --- | --- |
| `x-test-post/vault_account_auth.ts` `#refresh` (`runXTokenRefresh`), from `x-test-post/index.ts` L4005–4016 | **Yes**, under the env gate `X_VAULT_ACCOUNT_REFRESH=enabled` and the per-account `x_account_refresh_rollout` | **Wired**, personal workspaces only |
| `_shared/x_v2_account_refresh.ts` (`refreshXAccountPreX`, `createXAccountRefreshRpcLedger`) | **No caller on this stack**: `v2_dispatcher.ts`'s `refreshAccountPreX` port is optional and nothing supplies it | **Not changed** (the TASK allows it only with a confirmed caller). If one appears it must use `withXRefreshPrecheck` |
| `service_role` calling the core RPCs directly | operator | **Not stopped**: main's RPC bodies are not changed |

**Conflict check, right before writing:** all 425 open PRs, including the 5 with more than 100 files, change neither path. Main's last change to them: `3c5f80a6` (PR #76).

## 2. The change

- **`vault_account_auth.ts`:** in the port's `begin`, before the lease and the provider: `if (isPersonalXWorkspaceId(ref.brandId)) await rpc.precheckPersonalRefresh(ref)`. Commit and release are untouched.
- **Who counts as personal:** exactly `u_` + 24 lowercase hex, the id G5's S2-3 and G4's SQL derive. **Everything else never asks: its RPC calls are exactly as before.**
- **`007`:** on top of G4-02 #8, it now also asks **G5's MV for the generation recorded when this connection was made** (the consumed state's binding). A service end + restart since then refuses (`SERVICE_GENERATION_CHANGED`). That is G5's own rule for work done for a person. A new connect records the current generation; **no new reconnect policy was added**. No single recorded generation → `GENERATION_UNKNOWN`. md5 of the body: `d1dc5883450182ad32e2746d4516e951`.

## 3. Measured (real local stack)

Real `VaultAccountXAuth` + its real RPC adapter, real PostgREST as `service_role`, the real refresh core, publish permission, rollout authority and Vault; real GoTrue JWTs for the people. Only X is faked. **32/32, node exits by itself.**

| # | Scenario | Result |
| --- | --- | --- |
| XR1 | correct personal database | sent; provider 1; tokens rotated in real Vault; generation unchanged; a person cannot call the precheck |
| XR2 ×5 | full (owner epoch); missing 007 (404); missing 006; catalog drift; `service_role` lost EXECUTE | **guard off (FAIL before):** rotates and writes. **guard on (PASS after):** `X_REFRESH_DB_PROFILE_MISMATCH`, provider 0, Vault write 0, no lease |
| XR3 | service ended; disconnected; connect pending | `X_REFRESH_PRECHECK_SERVICE_NOT_ACTIVE`; `X_ACCOUNT_NOT_VERIFIED` (the core's read, first); `X_REFRESH_PRECHECK_CONNECT_PENDING`: provider 0 |
| XR4 | concurrent writer; lease lost (SYNTHETIC); disconnect while X answers; unknown X result, then again | second writer `X_REFRESH_IN_PROGRESS`, provider 0; `X_REFRESH_LEASE_LOST`; `X_REFRESH_ACCOUNT_CHANGED`; `X_REFRESH_HTTP_502` then `X_REFRESH_BLOCKED_UNCERTAIN`, provider 0. No stale write |
| XR5 | service end + restart (generation moved) | **guard on: `X_REFRESH_PRECHECK_SERVICE_GENERATION_CHANGED`, provider 0. Guard off: rotates (FAIL before).** A new connect: sent |
| XR6 | the database stops being personal while X answers | the single-use result **is committed** (only begin is fenced) |
| XR7 | operator account (non-`u_`), on a database the guard would refuse | **never asks; refreshes as before**; rollout `off` still refuses (`X_REFRESH_ROLLOUT_OFF`, provider 0) |

**Regressions:**
- `x-test-post` suite 539/539;
- Vault writer, fence, v2 and X Edge units 100/100 (with type check);
- X e2e 11/11 ×3 with the negative control;
- Threads 19/19 ×2; bridge flow, verdict, G4-43;
- app 326/326; Deno, `tsc`, `expo lint`, `deno lint`.

## 4. Review

**New surface:** the 007 SECURITY DEFINER function (service_role only), now also reading the connection's binding and G5's MV; and the writer's call. Add this to the **one unfinished functional review** (the personal X delta, build script, verdict gate, the G4-02 #7 function, 007, together with G3's consumer). H1-29 / H4-15 are not repeated.

## 5. Risks left open (not hidden)

1. **Deploying `x-test-post` from this stack before the personal SQL stops every `u_` account's refresh** (404 → refused). Whether production has `u_` X accounts in the refresh rollout was **not checked** (read-only access to production is forbidden here). Find out first. `x-test-post` deploys also bundle every merged change (a known rule of this repo): do not ship this by accident.
2. **External state not verified, so NO_GO:** the Edge env `X_VAULT_ACCOUNT_REFRESH` and the `x_account_refresh_rollout` rows in production. The rollout migration file also says "do not apply until a separately reviewed activation", though the live state of that is unknown here.
3. **A refreshed-denied person sees only a failed post.** After a service restart, the account still shows connected and G4's verdict still says VERIFIED (it does not read the generation; G3's send compares its own stored one), but refresh is refused until a new connect. No screen says "connect again": **that is a product decision for G1 / G5**, deliberately not invented here.
4. **What else moves the generation.** Any `lifecycle_version` change (G5: only P1's two triggers) refuses refresh until a new connect. Whether every such move should is G5's contract; this follows MV.
5. **A still-valid access token on a mismatched database is still used.** This fence covers refresh only; the send path's checks are G3's verdict + MV and the permission check.
6. **Direct `service_role` calls to the core RPCs, and any future v2 caller,** are not fenced.

## 6. Adoption and rollback order (each step its own approval)

1. G5 MVP → PR #124 + custody → Threads g5pv + stack → personal X 001–005 → 006 → verdicts → **007**
2. X Edge, with `POSTONA_X_AUTH_PROFILE=personal`
3. **`x-test-post` with this change**, after confirming §5.1–2
4. Check one signed-in test account

**Rollback:** `x-test-post` first (or unset `X_VAULT_ACCOUNT_REFRESH`) → X Edge → 007 → verdicts → 006 → X. Rolling 007 back under the wired writer refuses every `u_` refresh (fail-closed).

**Do not adopt if any of these holds:**
- §5.1–2 are unanswered;
- the database answers `mismatch`;
- G5's MVP or the single review has not passed;
- the operator accounts' refresh has not been confirmed unchanged after the deploy.

**NOT_VERIFIED:**
- managed Supabase;
- real X;
- production rollout state;
- the real W0;
- the deploy;
- the v2 path's real core (no caller).
