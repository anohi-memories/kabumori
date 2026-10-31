# POSTONA X / Threads connect — the real server entries, and the real local-stack QA (G4-02 #6, 2026-11-01)

task_id: `postona-g4-gen2-06-x-threads-oauth-server-edge-product-connection-20261031` (Issue #561). Stacked on PR #580.

**Status:**
- source and local QA only; nothing is applied or deployed;
- every gate is still closed in source;
- no managed project, no real provider;
- PRODUCTION_NO_GO.

## 1. What could not connect, and what changed

| # | Gap found in the product path | Fix (G4-owned) | Evidence |
| --- | --- | --- | --- |
| 1 | `threads-oauth-connect-user` had no `deno.json`. Past its gates, G4's composition could not resolve `@supabase/supabase-js` / `@db/postgres`, so the entry could only ever answer 503. The earlier tests used another config, which hid this. | `supabase/functions/threads-oauth-connect-user/deno.json` (the same versions the runtime is tested on; a test pins them equal) | R2: the entry's real default loader answers on the real Edge runtime |
| 2 | The product entry accepted `full`; the direction is personal. | `g4ProductAuthProfile`: `POSTONA_THREADS_G4_AUTH_PROFILE` must be `personal`. `full` / unset / anything else → 503. `full` stays a test-only path through `createG4ThreadsSourceServer`'s argument. | composition test; T7 |
| 3 | The X entry had no profile pin. | `POSTONA_X_AUTH_PROFILE` must be `personal`; otherwise 503 `X_CONNECT_PROFILE_UNAVAILABLE` before Auth, the database or X | X e2e; unit test |
| 4 | G5's MV codes raised through the personal generation helper fell into the X entry's generic error. | Added to its allow-list: `NOT_PERSONAL_WORKSPACE`, `WORKSPACE_ABSENT`, `SERVICE_GENERATION_UNAVAILABLE`, `SERVICE_STATE_UNKNOWN` → 409; `SERVICE_GENERATION_CHANGED` → 400 (start over) | unit test |
| 5 | X: after the code was sent, an unknown answer (network / 5xx) did not re-read the accounts, although the connect may have landed. | `use-x-connect.ts`: re-read, for the same person and session only, never claiming either outcome. A definite refusal changes nothing. | X e2e; unit test |

**Limit of the X pin.** It pins the configuration. That the database runs the same profile is enforced by the installs: each profile's X SQL refuses on the other. (Superseded by G4-02 #7: `x-connect-db-profile-fence-20261101.md`; the X entry now asks the database.) **At G4-02 #6 the X entry did not detect a mismatch:** on a full database it would run the full SQL, which does not bind the service generation. No new RPC was added to read the profile, so the install order is the control. (Threads does detect it: a bridge pinned to personal is refused on a full database.)

**Deploying the X entry.** `x-oauth-connect-user` from this stack without `POSTONA_X_AUTH_PROFILE=personal` turns X connect OFF (503). Set the secret in the same step, only at adoption.

## 2. The real local-stack QA

`bash supabase/tests/postona_g4_oauth_local_stack/run.sh` (project `g4ls`, ports 560xx). It needs podman, CLI 2.116 and `npm ci --ignore-scripts` in the app. **Run it alone:** the VM has 2 GiB, and other slots' stacks must not overlap.

- **Real:**
  - the app hooks, starter, runtimes and disconnect flows;
  - supabase-js;
  - Kong (verify_jwt);
  - the Edge runtime;
  - GoTrue (ES256 JWTs, sessions, sign-out, anonymous, refresh);
  - PostgREST;
  - PG 17.6 with the real auth / vault schemas;
  - G4's personal SQL and G5's MVP_INSTALL.
- **Faked:** X and Threads (in the twins' transport; anything else is refused), the system browser, the expo / React containers.
- **Test-only differences (the `g4ls-*` twins):**
  - the static gate is passed as open;
  - the database port is the local `db` container (no TLS);
  - GoTrue's `jwt_issuer` is set to H5's dummy project URL, because H5's strict config only accepts a managed-shaped URL.
- **SYNTHETIC, labelled:** G5's first-run W0 (`start_x_autopost_service` under real claims), a service end, a generation move.

**Measured: 17/17, node exits by itself (`G4LS_OAUTH_LOCAL_STACK_ALL_PASS`).**

| # | Scenario | Result |
| --- | --- | --- |
| R1 | real entries as in source | Threads connect and disconnect 503; the gateway refuses no apikey (401) and a tampered JWT (401) |
| R2 | the entry's real default loader + `deno.json` on the real Edge runtime | loads; `401 AUTH_REQUIRED` before any network |
| T1 | Threads connect | `verifying`, custody 1, verdict `VERIFIED`; the person reads their own row through real PostgREST + RLS (`identity_verified`) |
| T2 | reconnect + a real token refresh while at Threads | connected, a new generation |
| T3 | B signs in; A→B→A (a new real session) | `SESSION_CHANGED`, nothing forwarded, nothing bound |
| T4 | real anonymous; signed out (the JWT still verifies, the session row is gone); not started | `START_REFUSED`, no state |
| T5 | generation moved; service ended; Threads refuses the code; cancel | `COMPLETE_OUTCOME_UNKNOWN` + re-read; `CALLBACK_REFUSED`; `EXCHANGE_OUTCOME_UNCERTAIN`; `canceled`; nothing bound |
| T6 | the same callback twice at once | `200` and `409 CALLBACK_REFUSED` |
| T7 | no profile; `full` at the product entry | `THREADS_CONNECT_RUNTIME_UNAVAILABLE`, no browser, no state |
| T8 | disconnect through the app (SQL gate opened in this test world only) | rows gone, verdict `NOT_CONNECTED`; connect again = a new generation |
| X1 | X connect + reconnect | `connected`, verdict `VERIFIED`, a new generation |
| X2 | real anonymous; not started | `session_required`; `workspace_blocked` |
| X3 | B signs in while at X | `session_changed`, no exchange, no reload |
| X4 | a real token refresh while at X | `connected` |
| X5 | generation moved; service ended; X refuses the code | `terminal_error`; `workspace_blocked`; `retryable_error`; none connected |
| X6 | replay of the callback request | `400 OAUTH_STATE_NOT_CONSUMABLE`, generation unchanged |
| X7 | disconnect through the real RPC (gate opened in this test world) | `DISCONNECTED`, generation moved; connect again verified |

No provider token ever reached the app (every response was checked).

## 3. What G1 / G2 still provide (values; G4 does not change these files)

| Where | Value |
| --- | --- |
| `apps/social-mobile/app.json` `expo.extra.threadsConnectCallbackUrl` | the exact HTTPS callback registered at Meta (no query, hash or port) |
| `ios.associatedDomains` | `applinks:<that host>` (iOS 17.4+; older iOS answers `UNIVERSAL_LINK_UNSUPPORTED`) |
| `android.intentFilters` | `autoVerify: true`, action `VIEW`, `https`, host and path / pathPrefix of the callback |
| The callback host | serves the AASA / assetlinks files for this app |
| X | no change: the custom scheme `kabumori-social://oauth-callback`, registered at X |
| Screens | `src/app/accounts/index.tsx` and `[id].tsx` already mount G4's cards and `useXConnect(reload)`; nothing else is needed for connect, reconnect or disconnect |
| The release flag | `THREADS_CONNECT_UI_ENABLED` (`src/domain/threads-connect.ts`), at the release step only |

**App-side states:**
- X: `connected`, `retryable_error` (re-read after a sent code), `session_required`, `session_changed`, `workspace_blocked`, `terminal_error`, `cancelled`, `disconnected`.
- Threads: `running`, `verifying`, `done {failed {code, reconcile} | canceled | expired | unavailable}`.

## 4. Runtime configuration at adoption (values are the operator's; nothing here is set)

| Function | Secrets / settings |
| --- | --- |
| `threads-oauth-connect-user` | `THREADS_CONNECT_ENABLED=true`; `POSTONA_THREADS_G4_AUTH_PROFILE=personal`; `POSTONA_THREADS_PROJECT_URL`, `_PROJECT_REF`, `_PUBLISHABLE_KEY`; `_DB_HOST`, `_DB_PORT`, `_DB_NAME`, `_DB_OWNER`, `_DB_PASSWORD`, `_DB_CA_PEM`; `_APP_ID`, `_APP_SECRET`, `_CALLBACK`; `_ATTESTATION_KEY` (the same value as Vault's `postona_threads_connect_attestation_v1`); static `THREADS_CONNECT_EDGE_WIRED` |
| `x-oauth-connect-user` | `POSTONA_X_AUTH_PROFILE=personal`; `X_CLIENT_ID`, `X_CLIENT_SECRET` (`SUPABASE_URL` / `SUPABASE_ANON_KEY` are the platform's) |
| `social-mobile-threads-disconnect` | static `THREADS_DISCONNECT_SERVER_ENABLED`; SQL `threads_disconnect_gate_open()` |
| X disconnect | `postona_g4_x_oauth.set_x_disconnect_enabled(true)` |

**Not verified here (each one can change this table):**
- whether the Edge runtime can reach the direct DB host (the db host was IPv6-only when last checked), and with which CA;
- the deploy bundler on the entry's dynamic import (only `functions serve` was measured).

## 5. Adoption order (each step its own approval)

1. G5's MVP review and adoption.
2. **One focused review** (next section).
3. Non-production SQL, as the lifecycle owner (order in `docs/postona/x-oauth-personal-g5pv-20261030.md`).
4. Non-production Edge deploy + secrets.
5. G1 / G2 callback and app links; device check.
6. Real X / Threads, only after explicit approval.
7. The flags.

## 6. Review

**New in this PR:**
- an env-pin refusal at both entries (fail-closed only);
- a dependency map;
- an app re-read.

No new Auth / SQL / RPC / ACL boundary is added, so **no separate review of this PR is proposed**. The already-proposed single review (the generated personal X delta, its build script, and the verdict gate, together with G3's consumer change) stays as it was; add §1's X pin to its reading list. H1-29 / H4-15 are not repeated.

**NOT_VERIFIED:**
- managed Supabase;
- real X / Threads;
- `supabase functions deploy`;
- a real device, Universal Links;
- G5's real W0;
- production.
