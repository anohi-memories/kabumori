# POSTONA X + Threads reservations: personal MVP rollout bundle (G3 source candidate)

G3-51, Issue #318. **Not applied anywhere, not deployed, PRODUCTION_NO_GO.** This bundle gathers G3's reservation SQL into one ordered, pinned, fail-closed install and rollback. It is for the personal MVP profile: G5's personal MVP plus G4's verified credential verdicts.

The runner refuses every host except a local `/tmp` socket directory. It has no managed or production mode. A real rollout needs, first:
- the reviewed plan;
- G4's and G5's adoption;
- the one batch security review;
- the user's approval.

## Files
| file | what it is |
|---|---|
| `MANIFEST.tsv` | Install order (15 steps) and the verified rollback order. Every file is pinned by sha256. |
| `preflight.sql` | Read-only checks, ending in `ROLLBACK`. Modes: `install` / `rollback` / `postcheck`. |
| `rollout.sh` | `preflight`, `install` (all-or-nothing) and `rollback` (pre-checked before any change). |
| `rollout_test_run.sh`, `smoke.sql` | Tests on G4's own personal world (local PG17, fake data). |

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
`preflight.sql rollback` must pass (G3 installed exactly). Then:
- **No live row.** X or Threads rows that are `planned`, `claimed` or `uncertain` are refused.
- **Finished rows stated exactly.** X's 001 rollback discards them, and Threads' 007 rollback drops its schema with every row:
  - `G3RO_X_DISCARD_ROWS=<reservations>:<batches>:<audit>`
  - `G3RO_THREADS_DISCARD_ROWS=<reservations>:<audit>`
- **Consumers stated exactly.** Functions outside G3's schemas that name `postona_x_resv` are listed in `G3RO_ACK_CONSUMERS`.
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
- **App permissions**: the permission ports are `PERMISSIONS_NOT_CONNECTED`. Create, reschedule and reconfirm answer 403 / 503 before the database. Only the owner's `cancel`, `get` and `list` reach SQL, each gated by G5's person session.

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

### X reservations (`postona-x-reservations`)
- Actions: `create`, `list`, `get`, `reschedule`, `reconfirm`, `cancel`.
- Today only the owner's `cancel`, `get` and `list` can succeed; the rest are permission-gated (deny).
- A row's `status`:
  - `planned`: waiting, or handed back unsent.
  - `claimed`: a worker holds it. It can no longer be cancelled (refused as too late).
  - `published`
  - `failed`: never sent.
  - `uncertain`: may have been sent and is never re-sent. Show "check X".
  - `cancelled` / `expired`
- A stale `revision` → 409. Re-read, then retry the cancel with the new revision.

### Threads reservations (`postona-threads-reservations`)
- Actions: `create`, `cancel`, `receipt`.
- `receipt(socialAccountId, clientRequestId)` answers the state and a fixed `outcomeCode`.
- An unknown outcome → 503 `STORE_UNAVAILABLE`: read the receipt again, never re-create.
- Create stays refused while U8 holds.

### Single X post (`postona-x-single-post`)
- One manual post, bound to the generation at begin and re-checked before send.
- An outcome that cannot be read → `uncertain`, never re-sent.

## Not verified here
The managed project, real GoTrue / Auth / RLS / Edge runtime, a real scheduler, G4's real token custody / Vault, real X / Threads, and the app / Simulator.
