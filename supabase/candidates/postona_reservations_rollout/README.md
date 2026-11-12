# POSTONA X + Threads reservations: personal MVP rollout bundle (G3 source candidate)

G3-51, Issue #318. **Not applied anywhere, not deployed, PRODUCTION_NO_GO.** This bundle gathers G3's reservation SQL into one ordered, pinned, fail-closed install and rollback. It is for the personal MVP profile: G5's personal MVP plus G4's verified credential verdicts.

The runner refuses every host except a local `/tmp` socket directory and `127.0.0.1`. G3-02 #1 added `127.0.0.1` because the local Supabase stack's database is reached only through its loopback TCP port; the password comes from the caller's `PGPASSWORD` / `.pgpass`. It has no managed or production mode.

**Attestation (G3-02 #4, H4-16 P2).** A host name proves nothing: a socket or `127.0.0.1` can be forwarded to another server.
- Whoever creates the throw-away database marks it: `alter database <db> set g3ro.throwaway_attestation = 'g3ro-throwaway-<32 hex>'` (random per database).
- The operator passes the same value in `G3RO_DB_ATTESTATION`.
- `rollout.sh` reads the mark back before anything else, and every later session re-checks it as its first statement.
- A missing, malformed or different mark stops with `G3_ROLLOUT_ATTESTATION_REQUIRED / MISSING / MISMATCH` before any change.

A real rollout needs, first:
- the reviewed plan;
- G4's and G5's adoption;
- the one batch security review;
- the user's approval.

## Files
| file | what it is |
|---|---|
| `MANIFEST.tsv` | Install order (17 steps) and the verified rollback order. Every file is pinned by sha256. |
| `preflight.sql` | Read-only checks, ending in `ROLLBACK`. Modes: `install` / `rollback` / `postcheck`. |
| `rollout.sh` | `preflight`, `install` (all-or-nothing) and `rollback` (pre-checked before any change). |
| `rollout_test_run.sh`, `smoke.sql` | Tests on G4's own personal world (local PG17, fake data). |
| `local_stack/` | G3-02 #1: the same bundle and the real Edge handlers on the real local Supabase runtime (`run.sh`; see below). Test only. |

## Install order (each file is its own transaction)
X 001 → 002 → 003 → 004 → 005 → 006 → 008 → 010 → 012, then Threads 007 → 009 → 011 → 013, then X 014 → 015.

## Rollback order (verified)
015, 014, 013, then Threads 009, 011, 007, then X 008, 006, 005, 004, 003, 012, 002, 010, 001.

## Gates

### Before anything is written (`rollout.sh install`)
1. The host must be a local `/tmp` socket.
2. Every manifest file is present with its sha256.
3. `preflight.sql install` passes:
   - **Caller**: not a superuser (also when the owner itself is one), and has `CREATEROLE` (002 and 004 create the NOLOGIN API and worker roles).
   - **G5**: `private.postona_personal_session()`, `postona_personal_worker_verdict(uuid,text,text,bigint)`, `account_lifecycle_brand_owner(text)`, `account_lifecycle_service_state_refusal(uuid,text)`, `account_lifecycle_assert_active_service_write(uuid,text)` and `public.common_account_authorization_verdict(text,text,text)`:
     - present and SECURITY DEFINER;
     - owned by the caller;
     - EXECUTE for the caller only.
     - `auth.uid()` must be present too.
   - **G4**: `postona_g4_credential.x_publish_credential_verdict` (md5 `46643d50…`) and `threads_publish_credential_verdict` (md5 `fb93a0ad…`), from G4 head c6df19cc:
     - exact return shape;
     - SECURITY DEFINER;
     - owned by the caller, owner-only ACL.
   - **U8**: the CHECK `social_accounts_meta_publish_disabled` is present and validated. G3 never installs over a dropped CHECK; its owner decides.
   - **Tables**: the tables G3 reads are present and readable.
   - **Default privileges**: no default privilege of the caller (global or on G3's schemas) grants anything to another role.
   - **Roles**: `anon`, `authenticated` and `service_role` exist.
   - **G3 state**: fresh — no G3 schema and no API or worker role.

### During the install
If a step fails, every step already applied is rolled back in the manifest's rollback order. G3's catalog fingerprint (schemas, functions, relations, columns, triggers, roles, memberships, outside consumers) must then equal the one before the install. Otherwise the runner answers `G3_ROLLOUT_INSTALL_PARTIAL`: operator action is needed, and nothing is opened.

### After the install (`preflight.sql postcheck`)
- Nothing in G3's schemas is reachable by PUBLIC, `anon`, `authenticated` or `service_role`.
- The API and worker roles are NOLOGIN and unprivileged, and the owner is their only member.
- G3 is installed exactly.

### Before any rollback step
`preflight.sql rollback` must pass:
- G3 is installed exactly.
- **G3-02 #4 (H4-16 P1)**: no catalog dependency from outside G3's two schemas on anything inside them — a view, a foreign key, a column / argument / return type, a default, a SQL-body function (`G3_ROLLOUT_PREFLIGHT_EXTERNAL_DEPENDENTS`).
  - Before this, Threads 007's `DROP SCHEMA ... CASCADE` dropped such an object silently.
  - X 001's RESTRICT drops refused only as the last step, after 14 steps had rolled back.
  - 007's rollback now drops its own functions, tables and schema with RESTRICT, so on its own it refuses too (`POSTONA_THREADS_RESV_ROLLBACK_FOREIGN_DEPENDENTS`).

Then:
- **No live row.** X or Threads rows that are `planned`, `claimed` or `uncertain` are refused.
- **Finished rows stated exactly.** X's 001 rollback discards them, and Threads' 007 rollback drops its schema with every row:
  - `G3RO_X_DISCARD_ROWS=<reservations>:<batches>:<audit>`
  - `G3RO_THREADS_DISCARD_ROWS=<reservations>:<audit>`
- **Consumers stated exactly.** Functions outside G3's schemas that name `postona_x_resv` are listed in `G3RO_ACK_CONSUMERS`. Those that name `postona_threads_resv` are listed in `G3RO_ACK_THREADS_CONSUMERS` (G3-02 #4).
- **No login or option on the API / worker roles.** The owner may only hold its implicit ADMIN-only membership.

A refusal of a later step (an unforeseen reason) stops there. Each step is atomic, and the steps before it stay rolled back.

## What stays closed after an install
- **Edge entries**: `postona-x-reservations`, `postona-threads-reservations`, `postona-x-single-post` and `postona-x-reservation-worker` all have their release gate OFF in source (503 `NOT_AVAILABLE`).
- **X send**: the X reservation worker runs only the generation-bound delivery (`x_bound_delivery.ts` + 015).
  - Its credential source defaults to `X_GENERATION_CREDENTIALS_NOT_CONNECTED` (deny: claim 0, connection 0, X 0).
  - G4's real X token read does not exist yet. G4 delivers `{ token, generation }` read in one snapshot, where `generation = sha256('g3x1|' || G4 credential_generation)`, or the raw value through `xGenerationSourceFromG4Raw`.
- **Threads**:
  - The credential port stays unavailable until G4's ONE-statement credential read exists. That statement must answer `postona_threads_resv.threads_credential_generation(account)`.
  - Create stays refused by U8 (`POSTONA_THREADS_RESV_PUBLISH_DISABLED`).
- **App permissions** (G3-02 #2): the entries' permission ports are `PERMISSIONS_DECIDED_IN_DATABASE` / `THREADS_PERMISSIONS_DECIDED_IN_DATABASE`. There is no TS pre-check and no mock allow: the owner function decides in the write's own transaction with the real sources. Those are G5's person session (S2-2), the brand owner + personal profile, G5's x_autopost service state / R1 verdict, and G4's account verdict; for Threads also `publish_enabled` (U8). Every refusal is a fixed code. A row created this way is never sent while G4's token read is NOT_CONNECTED.

## HTTP contract for the app (G1 / G2 own the stores and screens; G3 does not edit them)

### Common to every entry
- `Authorization: Bearer <user JWT>`. The JWT must be a non-anonymous person session carrying `session_id`.
- Errors are `{ ok: false, code }` with these codes:
  - 400 `REQUEST_INVALID`
  - 401 `AUTH_REQUIRED`
  - 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE` / `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED` / `POSTONA_THREADS_RESV_SERVICE_NOT_ACTIVE`
  - 405 `METHOD_NOT_ALLOWED`
  - 413 `REQUEST_TOO_LARGE`
  - 503 `NOT_AVAILABLE` (gate OFF) / `AUTH_UNAVAILABLE` / `PERMISSION_UNAVAILABLE` / `STORE_UNAVAILABLE`
  - 500 `INTERNAL`
- Safe defaults: treat every 503 as "not available now", never as success. Never retry a create blindly; the client request id makes a repeat idempotent.
- **401 comes from two places.** The gateway answers a missing apikey or a malformed JWT with its own body, `{code, message}`, not `{ok, code}`. The handler answers `AUTH_REQUIRED` for:
  - no bearer token;
  - an anonymous sign-in;
  - a signed-out session.

  Treat both as "sign in again".
- An unexpected database error is 500 `INTERNAL`. It is never a result.

### X reservations (`postona-x-reservations`)
- Actions: `create`, `list`, `get`, `reschedule`, `reconfirm`, `cancel`.
- Each action is decided in the database (G3-02 #2):
  - `create` / `reschedule` / `reconfirm` need G5's live person session, the caller's own workspace (G5 W0), the x_autopost service active and G4's verdict VERIFIED.
  - `cancel` / `get` / `list` need the session and row ownership only, so they still work after a service end or an X disconnect.
- Codes seen on the real local runtime (`local_stack/`):
  - 404 `POSTONA_RESV_ACCOUNT_NOT_FOUND`: create on an account that is not the caller's (no oracle).
  - 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE`: the service ended or never started.
  - 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`: X is disconnected. Offer reconnect; after the reconnect, create works again.
  - 409 `POSTONA_RESV_IDEMPOTENCY_CONFLICT`: the same `clientBatchId` with another body. The same id with the same body answers the same rows, so a retry is safe.
  - 409 `POSTONA_RESV_SLOT_CONFLICT`: one of the operation's times is within 60 minutes of another active row, or of another time in the same batch. Two existing rows close to each other never block an operation that is clear of both (G3-02 #6).
  - 409 `POSTONA_RESV_NOT_PLANNED`: reschedule of a row that is no longer planned (for example `uncertain`), or of a "send now" row (G3-02 #7).
  - 422 `POSTONA_RESV_CONSENT_REQUIRED`: a reconfirm hash that does not match the body.
  - 422 `POSTONA_RESV_ITEM_INVALID`: an item without a draft id / time, or a draft id in the reserved `single:` namespace (G3-02 #8).
- After `reschedule`, `consentState` is `needs_reconfirm`. Send `reconfirm` with the body's SHA-256 before the row can be sent.
- A row's `status`:
  - `planned`: waiting, or handed back unsent.
  - `claimed`: a worker holds it. It can no longer be cancelled (refused as too late).
  - `published`
  - `failed`: never sent.
  - `uncertain`: may have been sent and is never re-sent. Show "check X".
  - `cancelled` / `expired`
- A stale `revision` → 409. Re-read, then retry the cancel with the new revision.
- A row that is already final (`cancelled`, `uncertain`, …) → 409 `POSTONA_RESV_ALREADY_FINAL`. Show the row; never retry.
- `list` for an account that is not the caller's answers 200 with an empty list. `get` / `cancel` of another person's row answers 404 `POSTONA_RESV_NOT_FOUND`.
- A person whose service has ended can still read and cancel their own planned rows.

### Threads reservations (`postona-threads-reservations`)
- Actions: `create`, `cancel`, `receipt`.
- `receipt(socialAccountId, clientRequestId)` answers the state and a fixed `outcomeCode`.
- An unknown outcome → 503 `STORE_UNAVAILABLE`: read the receipt again, never re-create.
- Create is decided in the database (G3-02 #2). While U8 holds it answers 403 `POSTONA_THREADS_RESV_PUBLISH_DISABLED`; another person's account answers 404 `POSTONA_THREADS_RESV_ACCOUNT_NOT_FOUND`.

### Single X post (`postona-x-single-post`)
- One manual post, bound to the generation at begin and re-checked before send.
- An outcome that cannot be read → `uncertain`, never re-sent.

## On the real local Supabase runtime (G3-02 #1, `local_stack/run.sh`)
A throw-away local project (`supabase start`, project id `g3ls`, ports 559xx; never pulls images) runs:
- G4's personal world, as G4's runner builds it at c6df19cc, applied as `postgres` (the image's own non-superuser owner);
- `rollout.sh preflight` and `install` over `127.0.0.1`;
- the real Edge handlers behind the real Kong / GoTrue, through test-only twins under `local_stack/`. A twin passes the release gate as enabled and swaps only the local transport (Auth via `kong:8000`, the `db` container without TLS). Its permission ports and the X credential source are not overridden (deny);
- `local_test.ts` (real user JWTs), then `rollout.sh rollback`.

What it showed, for the operator:
- **Owner role.** The owner (`postgres`, PG 17) cannot `SET ROLE` to the API or worker role: since PG 16 the creator holds an ADMIN-only membership. The Edge entries need a LOGIN role that is a member with `SET` (and `INHERIT FALSE`). That is a separate, approved rollout step that this bundle does not do.
- **Rollback.** A rollback refuses while such a member exists (`G3_ROLLOUT_ROLLBACK_ROLE_MEMBERS`). Drop or revoke the logins first.
- **Unreachable database.** When the API login cannot connect, the entry answers 503 `STORE_UNAVAILABLE`, and a create writes nothing.
- **First run (G3-02 #2).** With G5's accepted W0 (PR #590) applied unchanged, the person's own PostgREST calls work as follows:
  - `start_x_autopost_service`, then `postona_ensure_my_personal_workspace`, give `{status: ready, created: true}`, then `created: false`;
  - a person who has not started the service gets no workspace.

  The app then creates over HTTP, and nothing is sent.

## App client (G3-02 #5; G3's files in `apps/social-mobile/src/features/schedule/`, gates OFF)
**Stores**
- **X**: `createReservationStore(gate, live)` (reservation-store.ts) → `createLiveReservationStore({ supabaseUrl, session, publishableKey })`. Methods: `save` / `list` / `get` / `reschedule` / `reconfirm` / `cancel`.
- **Threads**: `createThreadsReservationStore(gate, live)` (remote-threads-reservation-store.ts). Methods: `create` / `cancel` / `receipt`.
- **Gate constants**: `POSTONA_RESERVATION_PERSISTENCE_ENABLED` and `POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED` are both `false`. With either one false, the factory returns the disabled store: no network.

**Truth**: always a separate read-back — `list` / `get` for X, `receipt` for Threads. The write's own answer never decides.

**Definite vs unknown**
- **Definite** (nothing written, no read-back needed):
  - 401 (the gateway's own body, or ours) → `AUTH_REQUIRED`;
  - 429 → `RATE_LIMITED`;
  - another 4xx with a fixed code;
  - 503 `NOT_AVAILABLE` / `NOT_CONFIGURED` / `AUTH_UNAVAILABLE` / `PERMISSION_UNAVAILABLE` / `POSTONA_RESV_SERVICE_BUSY`.
- **Unknown** (`UNCERTAIN`): 503 `STORE_UNAVAILABLE`, 500, a network error, a malformed answer. Read again; never re-send blindly. A retry with the same `clientBatchId` / `clientRequestId` is idempotent.

**Screen actions**: `reservationErrorAction(code)` (reservation-error-actions.ts) maps each code to one of `sign_in`, `start_service`, `reconnect_x`, `reconnect_threads`, `not_available` (incl. U8 `PUBLISH_DISABLED`), `reload`, `final`, `not_found`, `fix_input`, `retry_later`, `check`.

**Transport**
- HTTPS only; plain http only with `allowLoopbackHttpForTests` and a 127.0.0.1 / localhost URL.
- The `apikey` header carries the project's PUBLIC key only (`sb_publishable_…` or an `anon` JWT; anything else is refused).
- The local gateway answered without `apikey` too (measured); hosted is not verified, so the key is sent.

**Proof**: `local_stack/` L13 / L14 run these stores over the real runtime.

**Gap scope** (fixed in G3-02 #6; the G3-02 #5 observation):
- **Before**: the 60-minute rule compared every pair of an account's active rows. Two existing rows closer than 60 minutes made every later create / reschedule on that account answer `SLOT_CONFLICT`, however far away it was.
- **How such a pair arises**: a "post now" (005 / 006 insert it without the gap check) next to a planned reservation. Published rows stay in the check, so the account stayed blocked for good.
- **Now** (`assert_slots_free`, 001): only the operation's own times are checked, each against every other active row and against each other.
- **Unchanged**: the 60-minute gap (exactly 60 is fine), the day / month caps, the active states, the row's own exclusion on reschedule, the per-account advisory lock.
- **Proof**: PG17 `postona_x_reservations/run.sh` M7 (+ C1-C3 races); `local_stack/` L16 over the real runtime and the app store.

**Send now next to reservations** (G3-02 #7):
- **One row, two flows**: a "send now" (005 / 006, draft `single:...`) is one reservations row, created `claimed` with `expires_at` = its own time, so the delivery worker never claims it. Its retry is `post_now_begin` with the same request id (a never-sent row is re-armed).
- **Fixed**: a send now handed back before any send (`planned`: SERVICE_BUSY, lease too short or expired before the send) could be moved by `reschedule`. That reset `expires_at`, so after `reconfirm` the delivery worker claimed it, against 005's contract. `reschedule` now answers `POSTONA_RESV_NOT_PLANNED` for it and changes nothing. The worker's sweep closes it as `expired` (never sent), and its own retry still re-arms it.
- **Unchanged, measured** (a product decision is pending):
  - a send now is not held to the 60-minute gap (a send now 30 minutes before a reservation is accepted);
  - a NEW reservation within 60 minutes of an active send now (claimed / published / uncertain) is refused `SLOT_CONFLICT`.
- **Proof**: PG17 `single_post_live_fence_run.sh` L10; `local_stack/` L17 (the app store's reschedule → `final`).
- **Reserved namespace** (G3-02 #8): a reservation draft id starting `single:` is refused `POSTONA_RESV_ITEM_INVALID` (422 → `fix_input`; the whole batch, nothing written), so no client can make a reservation look like a send now. Only the exact, case-sensitive prefix is reserved (`x_single:1`, `Single:2`, `single_3` are ordinary). The check runs on new items only: a batch stored earlier still replays as itself, and no row is changed. Proof: PG17 `run.sh` M8; `local_stack/` L18.

**Delivery end to end** (G3-02 #9, `local_stack/` L19-L24, one throw-away runtime):
- **The path**: a person's HTTP create (real GoTrue JWT, G5 W0, G4's real verdict SQL) → SYNTHETIC clock (due) → the worker entry over HTTP (scheduler secret) → `claim_due` (014 pins the generation) → ONE `credentialFor` → `pre_publish_check_bound` (015) → one X create → `finish` → the person's read-back.
- **TEST ONLY** (twin `postona-x-reservation-worker-e2etest`):
  - `credentialFor` answers a FAKE snapshot `{ token, generation }` that the test writes;
  - X is a fake that records each call and answers ok / 401 / a broken connection.
  - Neither is G4's token read. The production entry keeps `X_GENERATION_CREDENTIALS_NOT_CONNECTED` (claim 0, send 0; L19 re-checks it with a due row).
- **Reached**:
  - one send with the snapshot's token and the stored text → `published` (provider id stored), read back by the app store; another person gets 404; a second run sends nothing (L19);
  - a reconnect after the snapshot → claimed, never sent, `CREDENTIAL_GENERATION_CHANGED` (L20);
  - no claim while disconnected or after the service ended; a cancel before the run is never sent (L21);
  - an unknown answer → `uncertain`, never re-sent, cancel → `final` (L22);
  - X 401 → failed before send `X_REJECTED_401`, never retried (L23);
  - two workers at once → three due rows, three sends, each once (L24);
  - a wrong scheduler secret → 401 before anything (L19).
- **NOT_VERIFIED here**:
  - G4's real token + generation snapshot (not delivered);
  - the real X API;
  - a lease running out mid-run, and a cancel racing a claim inside one run (covered by PG17 `dispatch_run.sh` and `x_bound_delivery_test.ts`, not here);
  - an owner change A → B → A (PG17 EP / W1);
  - the hosted gateway, Cron.

**A service restart and the old X connection** (G3-02 #14):
- **The contract** (G5, Issue #561 6560219373): `lifecycle_version` is the generation authority. After a service end + restart, an older X connection fails closed until an explicit reconnect, and VERIFIED alone is no assurance. G3 owns the scheduled-send protection.
- **Measured before** (real local runtime, lifecycle 2 → 4; the connection and G4's verdict still read verified): create, reschedule and reconfirm were accepted, and a new row was sent over the old connection (TEST ONLY snapshot, fake X). A pre-restart row's edits were accepted although it can never be sent.
- **Now**:
  - `g4_x_account_verified` (014) also needs G4's `public.postona_x_refresh_precheck_v1(account) = 'allow'` (G4 PR #617 `1d020c40`, read only, md5 pinned, same owner). So every write and send check refuses the old connection: `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED` → `reconnect_x`; at send time `NOT_PUBLISHABLE_AT_SEND`.
  - `reschedule` / `reconfirm` (001) refuse a row of an earlier generation: `POSTONA_RESV_NOT_PLANNED` → `final`.
  - Unchanged: list, get, cancel; another person's 404; 401; claim closing an earlier generation's row (`SERVICE_GENERATION_CHANGED`).
- **Rollout dependency**: G4's 006 + 007 must be installed first. 014 and `preflight.sql` refuse otherwise.
- **Still open**: the app cannot read "this connection is stale" before a write is refused (G1's request; no read port exists). A row's generation is answered by 017, below.
- **Proof**: `local_stack/` L32–L33, L8, L21, `g1_screen_integration.test.mjs` (service restart); PG17 `g4_verdict_run.sh`, `rollout_test_run.sh`.

**A row's generation on list / get** (G3-02 #15, `017`):
- `connectionGeneration` on each row of `list` and `get`:
  - `earlier`: G5's MV answers `SERVICE_GENERATION_CHANGED` for the row's generation. It will not be sent, even after a reconnect; it can still be cancelled.
  - `current`: G5's MV answers `active` for the row, and `g4_x_account_verified` is true. It does not promise a send (consent, the due time and the send itself still decide).
  - `unknown`: anything else, such as an unbound row, a service not active, a disconnected account, a missing G4 / G5 function, or any exception. The read still answers.
- **Absent**: HTTP write answers keep `reservation_view` and have no field, and a database without 017 has none. The API maps any other value to `unknown`. Read an absent field as not proven, never as `current`. The app store's reschedule / reconfirm / cancel return their read-back row, which has the field.
- **Boundary**: the same two functions, signatures, API role and row filters. A function's result type cannot be replaced, so 017 drops and re-creates both in one transaction with a new result type (`reservation_read_view`) and the same ACL (compared before and after). `connection_generation_of` is not a definer and is granted to nobody.
- **Rollback**: `017` first. It restores 012's bytes and the ACL; no row is touched.
- **Proof**: `local_stack/` L32–L34; PG17 `g4_verdict_run.sh` phase VG (`g4_verdict/connection_generation.sql`); `api_test.ts`; `remote-reservation-store.test.mjs`.
- **Threads** has no such field (U8 keeps it off).

**Post approval + notifications** (G3-02 #16, `018`, Edge `postona-x-approvals`):
- A candidate is not a reservation. Only `approve_candidate` makes one, through `create_batch` in the same transaction, so a candidate that is not approved never reaches the worker. Reservations made the existing way are unchanged.
- **New**: 3 tables (owner only), 2 result types, 8 SECURITY DEFINER functions with EXECUTE to `postona_resv_api` only, and 9 internal helpers granted to nobody. No existing object is replaced.
- **G3-02 #17 (H1 #37)**:
  - P2-1: a candidate records G4's credential generation at submit / revise; approve refuses `APPROVAL_GENERATION_CHANGED` when it moved (checked before and after `create_batch`).
  - P2-2: every notification / outbox write needs the workspace to be the caller's own personal one, checked in the INSERT itself.
  - P3: `rollout.sh` checks that 018's tables exist in a separate statement before counting.
- **G3-02 #18 (H1 #38)**:
  - P2 race: `notify()` takes FOR SHARE locks on the account row, then the workspace's brands row, then the owner membership row, held until COMMIT, before its INSERT.
    - A loss already in flight makes the write wait, then write nothing.
    - A loss that starts later waits for the write.
    - A concurrent INSERT of another membership row is not covered: that needs a G5-side lock contract.
  - P3: `rollout.sh rollback` refuses before any step when the database and the manifest disagree on 017 / 018 (installed but not listed, listed but not installed, or partly present), or when the manifest's install and rollback steps differ.
- **G3-02 #19 (with G5 PR #645)**:
  - The local stack (`local_stack/run.sh`) and PG17 (`g4_verdict_run.sh` phase VG5) apply G5's pinned ownership-lock trigger (a4d6c0eb, blob f434be5a) in their throw-away databases only, and roll it back after G3's rollback. `G3LS_MUTANT=no_g5_lock` = the state before.
  - With it, a second member joining, owning another workspace, or a role change waits for a notification write. While the workspace is not personal, the list writes nothing.
  - L38 runs submit (3 concurrent replays) → approve with a lost answer → read back → retry → one reservation → the worker sends once; the gated real entry answers 503 with 0 writes.
  - The G2 #9 P3 decisions are in the G1 contract doc, section 5a. No SQL / Edge change.
- **G3-02 #20 (G2 #11)**:
  - `mark_notification_read` now needs the X service (the G5 writer gate first): 403 `SERVICE_NOT_ACTIVE` after a service end, with `read_at` unchanged.
  - A new trigger `reservations_changed_notify` (not a definer, granted to nobody) enqueues `reservation_changed` and its outbox row in the transaction that changed the reservation (the worker's finish, the claim's close, a reschedule / cancel). `claimed` is not an event; any notification error is skipped, never failing the change, and the next list writes it.
  - Proof: PG17 AP21–AP23 and VM20 (markRead vs a committing service end); local L39 (published / uncertain enqueued by the worker run, the markRead gate, the earlier generation's close).
- **Notifications** are one row per event key. `reservation_changed` is derived on the next list. Each new notification gets a `push_outbox` row, which nothing reads or sends.
- **Rollback**: `018` first, with `G3RO_APPROVAL_DISCARD_ROWS` stated.
- **Contract for G1**: `docs/postona/g3-approval-notification-contract-20261105.md`.
- **Proof**: `local_stack/` L35 (`G3LS_MUTANT=no_018` = the state before); PG17 `g4_verdict_run.sh` phase VA (`g4_verdict/approvals.sql`, `G3V_018` takes a mutated copy); `_shared/postona_approvals/api_test.ts`; `postona-x-approvals/http_test.ts`.

**The reservations screen on this runtime** (G3-02 #13; `local_stack/g1_screen_integration.test.mjs`):
- **Real here**: G1's screen and view rules (PR #606, pinned, read only), G3's stores and error actions, GoTrue JWTs, Kong, the Edge handlers, Postgres, G5 W0, G4's connect / disconnect SQL and verdict.
- **Reached, pressed in order**:
  - X: list → change the time → 「再確認が必要」 → reconfirm → 「予約済み」 → cancel (asked twice);
  - 409 stale: re-read, never re-sent; 422 and slot conflict: the form stays;
  - an expired token and a signed-out session: sign in; another person: nothing shown, a spoofed account refused by the server, a foreign workspace refused before any request;
  - service ended: writes off with the way out, back after a read; G4 disconnect → reconnect the same way;
  - 503 store: "check", one attempt; the gate-OFF real entry: not available; an uncertain row: "check X", no edit;
  - a released send-now row: listed, its reschedule refused as final;
  - Threads: U8 → not available, 0 rows, writes off.
- **Not real**:
  - React / RN are stubs, as in G1's harness (no device, no layout);
  - the composer is not rendered (rows are saved through the store it uses);
  - the localtest twins pass the gates as enabled;
  - 429 is INJECTED at the fetch boundary;
  - the service end and the Threads binding are SYNTHETIC.
  - This is not a finished product link: G1's `use-reservation-ports.ts` is still the disabled ports, and both stacks are unmerged.
- **G1 + G3 together** (scratch merge, not pushed): one import line conflicts in `schedule-composer.tsx` (keep G1's line). The wiring proposed to G1 type-checks. The app suite passes, 774 / 774 before the wiring; after it, G1's boundary test fails by design.

**Scheduler call** (G3-02 #10, repaired in #11 after H4-17; `postona_x_reservations/016_*`; candidates NOT in this bundle's MANIFEST: a later, separately approved step):
- **What it is**:
  - `tick_delivery_worker()` makes one `net.http_post` to the worker entry and leaves one `worker_ticks` row (outcome, request id, nonce hash; no secret, no URL).
  - `worker_tick_health(since)` reads the answers from pg_net.
  - `016_postona_x_resv_worker_tick_schedule.sql` is the every-minute pg_cron job. Each file has its rollback.
- **H4-17 P1 → no reusable secret in pg_net's queue**:
  - pg_net keeps a request's headers in `net.http_request_queue` until it is sent, and other roles may read that table. So the tick sends only a one-use ticket: `x-postona-worker-tick: v1.<ref>.<unix s>.<nonce>.<HMAC-SHA256>`. The key is `postona_resv_worker_secret` from Vault, which equals the worker's `POSTONA_RESV_WORKER_SECRET`.
  - The worker (`postona-x-reservation-worker/http.ts`) accepts the ticket only when all of these hold:
    - the HMAC matches (constant time);
    - `<ref>` is its own project (from `SUPABASE_URL`);
    - the time is within 120 s;
    - `consume_worker_tick(nonce)` answers true. That is once, for a nonce a tick issued less than 120 s ago; only the nonce's SHA-256 is stored.
  - A queue reader gets at most that one ticket: one worker run, the one the scheduler asked for, and never the secret.
  - The `x-postona-worker-secret` header stays for an operator's manual call; the tick never sends it.
- **H4-17 P2 → the target is pinned, not read**:
  - Vault holds no URL. The owner writes this project's ref once, in the reviewed rollout: `insert into postona_x_resv.worker_target (project_ref) values ('<ref>')` (one row, `^[a-z0-9]{20}$`).
  - `worker_url(ref)` builds `https://<ref>.supabase.co/functions/v1/postona-x-reservation-worker` from it. No pin → no call.
  - The ticket names the pinned ref, so another project's worker refuses it.
- **H4-17 P2 → no dangling job**:
  - 016's rollback refuses, and drops nothing, while any job the owner can see calls the tick under any name or spelling (`SCHEDULE_PRESENT: <job names>`), while a function outside 016 names it (`TICK_REFERENCED`), or while the job list cannot be read (`CRON_CATALOG_UNREADABLE`). It unschedules nothing itself.
  - **Hidden jobs** (G3-02 #12, H4-18 P2): pg_cron's row-level security shows a caller without BYPASSRLS only its own jobs, and a superuser's job may run the tick whatever its ACL says.
    - When the owner cannot see every job, the rollback also needs an administrator's read-back from the last 15 minutes, else `CRON_JOBS_NOT_ALL_VISIBLE`.
    - The read-back is `016_postona_x_resv_worker_tick_rollback_admin_check.sql`, run by a superuser / BYPASSRLS role. It names every job of any owner calling the tick and refuses (`JOBS_PRESENT: <job>@<owner>`), or records `postona_x_resv.worker_tick_rollback_check = '<unix s>:<jobs seen>'` on the database when there is none. A record that is stale, malformed, or counts fewer jobs than the owner sees is refused.
    - Nobody's job is unscheduled by either file.
    - **Measured**: the local Supabase image gives `postgres` BYPASSRLS (it saw the superuser's job, and the rollback answered `SCHEDULE_PRESENT`). Hosted is NOT_VERIFIED. If hosted gives the owner neither a full view nor an administrator to run the read-back, the rollback stays refused (fail closed): stop every job calling the tick, then have the platform's administrator run the read-back, then roll back within 15 minutes.
    - **Trust**: the record guards against an operator's mistake, not against the schema owner. An owner who owns the database could write the record, or drop the functions by hand, in any case.
- **No call when**: `TICK_BUSY` (another tick holds the lock), `PREVIOUS_IN_FLIGHT` (the previous call has no answer and is < 70 s old), `NOT_CONFIGURED` (no pin, or the key is missing / < 32 characters). Re-sending is never the tick's business: the worker claims under row locks and never re-sends an uncertain row.
- **Privileges**: owner only, except `consume_worker_tick` (SECURITY DEFINER, EXECUTE for `postona_resv_worker` only). No table privilege for PUBLIC, anon, authenticated, service_role or the API / worker roles.
- **Proof**:
  - **PG17** `postona_x_reservations/worker_tick_run.sh`, on fake pg_net / Vault / pg_cron with the queue readable by PUBLIC, as H4-17 measured:
    - before: PR #609's 016 reproduces all three counterexamples;
    - after: T1–T6, BUSY and the rollback refusals (canonical / alias / quoted / cased / unqualified job, wrapper function, unreadable catalog) pass.
  - **Real local Supabase** `local_stack/` L25–L31, then run.sh's cron step:
    - no call without a pin or key (L25);
    - the real queue holds the ticket, never the key; the gate-OFF entry → 503 (L26);
    - another key / another project's ref → 401 (L27);
    - one send, one-use ticket (replay → `WORKER_TICK_REJECTED`; tampered / stale / foreign → `WORKER_AUTH_REQUIRED`); the next tick sends nothing (L28);
    - unknown never re-sent (L29); in-flight / busy (L30); an unreachable host shows in the health read (L31);
    - the real pg_cron job runs the tick; an alias job (real pg_cron) refuses 016's rollback; then unschedule and rollback.
  - The target is replaced TEST ONLY on that stack: no `https://<ref>.supabase.co` there.
- **Measured**: a call without a user JWT to a function deployed with `verify_jwt = true` is stopped by the gateway with 401 `UNAUTHORIZED_NO_AUTH_HEADER`. The worker must be deployed with JWT verification off; it checks the ticket / its secret itself.
- **Production steps** (each only after its own approval; none done here):
  1. the worker's release gate and G4's generation-bound credential source;
  2. deploy `postona-x-reservation-worker` with `--no-verify-jwt` and `POSTONA_RESV_WORKER_SECRET` (≥ 32) / `POSTONA_RESV_WORKER_DATABASE_URL` (a login member of `postona_resv_worker`, never service_role);
  3. Vault: `postona_resv_worker_secret` (the same secret; no URL entry);
  4. apply 016 as the schema owner, pin the project's ref, run one tick by hand, read `worker_tick_health()`;
  5. apply the schedule and watch the health read;
  6. to stop: the schedule's rollback, remove any other job calling the tick (each by its owner), the administrator's read-back when the owner cannot see every job, then 016's rollback within 15 minutes.
- **NOT_VERIFIED**:
  - hosted pg_net / pg_cron / Vault / pgcrypto behaviour and permissions, pg_net's hosted retention;
  - the hosted `SUPABASE_URL` form;
  - the hosted gateway;
  - the real X and the G4 source.

## Not verified here
The managed project, a deployed Edge function, a real scheduler, G4's real token custody, real X / Threads, and the app / Simulator. The real local GoTrue / Kong / Edge runtime / Postgres are covered by `local_stack/run.sh` (G3-02 #1), with fake data only. The local Vault holds only fake tokens.
