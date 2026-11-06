# POSTONA Threads — Meta deauthorize / data deletion callbacks: the delta, and the NEXT_ACTIONS contract (G4-02 #10, 2026-11-06)

task_id: `postona-g4-gen2-10-threads-meta-deauth-data-deletion-callback-edge-disabled-local-20261106` (Issue #561). Stacked on PR #617.

**Status:** source and local HTTP only. Nothing is deployed, registered with Meta or applied. The gate stays `false`. Production stays NO_GO.

## 1. What already existed: no duplicate

| Item | State |
| --- | --- |
| Old #328 (callback TASK) | CLOSED, 0 REPORT: nothing was delivered under it |
| **PR #335 (G4-01, Issue #319, in this stack)** | **Already built the Edge:** `_shared/social/threads_meta_callback.ts`, `threads-meta-callbacks/{http,index}.ts`, contract M1–M7. Gate `false`, no store |
| Other branches | The scan of all 453 open PRs (including the 6 with more than 100 files, read through `pulls/N/files`) finds only #327 and #335 touching these paths. Both are G4's and both are ancestors of this branch |

So this TASK **does not rebuild the Edge.** It adds only what #335 lacked (§3). See `threads-meta-callback-edge-candidate-20261019.md` for the base design.

## 2. The provider contract, re-read on 2026-11-06 (no API called)

| Point | State | Source |
| --- | --- | --- |
| Both URLs exist in a Threads app ("Deauthorize callback URL", "Data Deletion Requests URL"); Meta "pings" them | **VERIFIED** | Threads, get-started / create-an-app |
| POST with one `signed_request` = base64url(HMAC-SHA256 of the **encoded** payload, key = app secret) `.` base64url(JSON) | **VERIFIED**, generic Meta page | App Dashboard, Data Deletion Request Callback |
| Payload `algorithm` = "HMAC-SHA256", `issued_at`, `user_id`; the example also has `expires` | **VERIFIED**, generic page | same |
| The data deletion answer is JSON `{ url, confirmation_code }`; the url is a status page; the callback must start deleting | **VERIFIED**, generic page | same |
| The status page must be **human-readable** and explain the state, including any reason for refusing | **VERIFIED**, generic page → **gap N2b** | same |
| Threads sends the same signed request, form-encoded | **ASSUMED** | not documented for Threads |
| `user_id` = the Threads user id stored as `social_accounts.platform_user_id` | **ASSUMED** | not documented |
| The deauthorize answer (we send 204), retries, how long Meta keeps retrying | **NOT VERIFIED** | not documented |
| A challenge / handshake | **None documented** for these two callbacks. `hub.challenge` belongs to Webhooks, and Threads Webhooks has no deauthorize or deletion topic (replies, delete, mentions, publish only) | Threads webhooks |
| `expires` | Meta's signed requests use it for the **token's** expiry (0 can mean "does not expire"). So it is **ignored**, not a refusal, and refusing on it could drop a person's deletion request | design decision |

**Real provider compatibility is not claimed.** N3 must check it on a non-production Meta app.

## 3. The delta (G4-owned files only)

- **Typed events.**
  - `ThreadsDeauthorizationEvent` and `ThreadsDataDeletionRequestEvent` share `{ kind, providerUserId, issuedAt, eventKey }`.
  - `eventKey` = SHA-256 hex of the encoded payload as sent. Meta's retry, or a replay of the same signed request, has the same key.
  - Both are passed to the store port. The extra parameters keep the M1–M7 `CallbackStore` compatible.
- **A data deletion request stops the bound account first** (`markDeauthorized`, the same idempotent stop), then records the request.
  - If the stop fails, nothing is recorded and the answer is 503.
  - If recording fails, the answer is 503 too. The stop stays, and Meta's retry is idempotent.
  - Before this, a deletion request left publishing on.
- **The store contract is stated:** a store may not report what it has not recorded; recording is not deleting (the status stays `received` until G5 T10 reports progress); nothing is revoked at Meta.
- **Local HTTP:**
  - `threads-meta-callbacks/local_http_test.ts` uses loopback only, and every other host is denied by Deno's permissions.
  - `supabase/tests/postona_threads_meta_callbacks_local_http_run.sh` starts the real `index.ts` as its own process with **no `--allow-env`**.

Not changed: SQL, RLS, grants, Vault, OAuth, the token refresh path, the Threads writer, G5's deletion saga, other slots' files.

## 4. Measured

| Suite | Result |
| --- | --- |
| Unit + Edge + contract (`--allow-read=.` only, no net, no env) | **37/37** (was 32; +5 new: typed events, replay, cross-account / cross-brand, stop-before-record, no log / no fetch on every path) |
| Local HTTP (`--allow-net=127.0.0.1`) | **10/10**:<br>– Meta / Threads hosts denied (`NotCapable`);<br>– the deployable entry answers 503 DISABLED on every route, without reading the env;<br>– gate lifted with a **non-durable test store**: deauthorize 204 with an empty body; deletion `{url, confirmation_code}`, the same answer on a replay; the unknown person looks the same; status `received` only, never completed;<br>– 400 / 413 / 415 / 405 / 404 fixed codes, nothing recorded;<br>– store down: 503, no detail |
| Real `index.ts` process (unchanged file; no env permission; `DENO_SERVE_ADDRESS` = 127.0.0.1:18471, the only net permission) | **6/6**: 503 DISABLED ×4 routes, `no-store`, prints nothing but Deno's "Listening on" line |
| Negative control (gate forced on) | process part **4 FAIL** as expected; restored, clean rerun exit 0 |
| Mutants on the core (6) | **all killed**:<br>– no stop before deletion;<br>– key over the whole request;<br>– constant key;<br>– wrong event kind;<br>– record before stop;<br>– gate on |
| Threads regression (offline) | **194/194** in 16 suites: binding, connect contract / edge / entry (8, with `threads-oauth-connect-user/deno.json`) / entry composition (6, same config) / publish integration / RPC contract, connect-to-send, disconnect, manual publish, provider cleanup, publish contract, send port, token refresh, `social-mobile-threads-disconnect`, `social-mobile-threads-publish` |
| `deno lint` (7 files), `deno check` | clean |

**NOT_RUN / NOT_VERIFIED:**
- a real Meta call;
- managed Supabase;
- a durable store (none exists);
- the deploy;
- `verify_jwt` settings;
- a human-readable status page;
- the app.

## 5. NEXT_ACTIONS contract (each step is its own approval, in this order)

| # | Unit | Owner | What it must do | STOP / precondition |
| --- | --- | --- | --- | --- |
| **N1** | **Durable store** behind the 4 port methods | **central decision** (needs a new table and functions, grants, and a state on the shared `social_accounts`) | <ul><li>`accountByProviderUser`: the row by UNIQUE (platform, platform_user_id).</li><li>`markDeauthorized`: one statement that moves `connection_status` off `identity_verified` (for example `reauth_required` + `last_connection_error_code = 'THREADS_DEAUTHORIZED'`), idempotent per `eventKey`, never deleting the credential by itself.</li><li>`requestDeletion`: a request row keyed by account or unknown person, code from the database (≥ 8 alphanumeric), event keys kept, status `received`.</li><li>`deletionStatus`: reads it.</li><li>`service_role` only, SECURITY DEFINER with empty `search_path`.</li></ul> | **TASK item 5: G4 STOPS here.** Schema / grants / a shared identity state are not G4-alone. Before reading `issued_at` against `connected_at`, decide whether an old deauthorize may stop a newer connection. Today: it stops, the safe side (worst case: reconnect) |
| N2a | Deploy settings | ops, after N1 | `verify_jwt = false` for **this function only** (Meta sends no Supabase JWT; the signature is the authentication); `THREADS_APP_SECRET` (the connect app's); `THREADS_META_DELETION_STATUS_URL` | deploy approval |
| **N2b** | **Human-readable status page** | G1 / web (product copy) | Meta requires a page a person can read. `deletion-status` answers JSON only. A page must show `received` / `in_progress` / `completed` / reasons, from the store only | product decision |
| N3 | **Real Meta check on a non-production Meta app** | user-approved G4 TASK | <ul><li>Remove the test app in Threads.</li><li>Confirm the format, that `user_id` equals the stored `platform_user_id` (connect stores `p_platform_user_id` = provider user id, `threads_connect_rpc_contract.ts` L91), the deauthorize answer and retries.</li><li>Only then lift the gate in a reviewed change.</li></ul> | real Meta = explicit approval |
| N4 | App (connect / disconnect screens) | G1 / G2 | After a stop, Threads shows "connect again". Disconnect's remote line stays `not_revoked_by_app` until N3 shows what the callback proves | none from G4 |
| N5 | G3 reservation / Worker | G3 | **No new IF if N1 moves `connection_status`:** G4's Threads credential verdict (`001_threads_publish_credential_verdict.sql`, `connection_status = 'identity_verified'` check) refuses, so dispatch refuses. The manual publish candidate checks the same state (`postona_threads_publish/threads_manual_publish_candidate.sql` L228). **Residual:** the `beforePublish` hook re-asks G5's worker verdict, not the credential verdict, so a stop between the container and the publish is not seen there (Meta has invalidated the token by then, so the publish fails at the provider) | G3's choice whether the hook also reads the credential verdict |
| N6 | G5 personal workspace / deletion | G5 | <ul><li>The callback has **no person session**: the store resolves only by `platform_user_id`, never takes a workspace or brand from the request, and works for `u_` and brand workspaces alike.</li><li>G5 T10 consumes `requestDeletion` rows: what to delete, and whether data made after a later reconnect is in scope (`issuedAt` is passed for that).</li><li>"completed" may only come from T10.</li></ul> | G5 T10 contract |
| N7 | G4 Threads refresh | G4, later | The refresh store's `begin` must refuse an account that is not `identity_verified`, so a stopped account is not refreshed or retried as uncertain | with the refresh store task |
| N8 | Connect after a stop (PR #251 path) | G4 / H5 | Connect's complete must overwrite the stopped state (the same row). The stop must not block a new connect | with N1 |

**Adoption order:** N1 → N6 agreed → N2a + N2b → N3 (gate still off for production) → reviewed gate change → N4 / N5.

**Rollback:** unset the URLs in the Meta app (or gate back to `false`) first, then the function, then N1. Recorded requests are kept: they are a person's deletion requests.

**Do not adopt if:**
- N1 has no reviewed store;
- N3 has not confirmed the user id;
- the status page is not human-readable;
- G5 T10 cannot consume the requests.

## 6. Risks left open

1. **The Threads format and user id are assumptions** (§2). A wrong guess means signatures fail (fail-closed, 400) or ids never match. In the second case deauthorize stops nothing, and deletion records an "unknown person" request.
2. **There is no durable store.** With the gate lifted today, everything answers 503 `STORE_UNAVAILABLE` (nothing is acknowledged).
3. **Meta's 21-day deletion alert and its downloadable id list** (generic page FAQ) are not handled by any code. That is operator work, to be named in N1 / N6.
4. **Replayed old deauthorize** after a reconnect stops the new connection (the safe side; it needs a captured signed request).
5. The direct `service_role` route to whatever N1 builds is not fenced by this Edge.
