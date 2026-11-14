# POSTONA push devices: registration, revocation and the delivery read (G5-02 task 9; task 10)

**G5-02 task 10** fixes H4 #331 task 24's three P2 on PR #667:
- **P2-1:** a stop and an in-flight registration share one fence (section 2a).
- **P2-2:** the client never re-sends a stale registration (section 3).
- **P2-3:** another person's live registration is never taken over by a matching identifier (section 3, "Takeover").

Each is reproduced on PR #667's own files, then passes (section 8).

**Source candidate. Nothing is applied anywhere. Production NO_GO.** It adds new SECURITY DEFINER RPCs over a new table that holds push tokens. An independent H review is required before any adoption; the local proof below is not that review. Nothing here sends a push, holds an APNs / FCM / Expo credential, or calls a provider.

The files:
- the candidate: `supabase/candidates/postona_push_devices/` (install, stop, rollback, `client.ts`);
- the proof: `supabase/tests/postona_push_devices_local_test.ts`, run by `supabase/tests/postona_personal_workspace_local_run.sh`.

## 1. The problem

G3's reservation / approval candidate (PR #644, #663) writes a notification and a `postona_x_resv.push_outbox` row, and nothing reads the outbox yet. POSTONA has no device registration at all: the app (apps/social-mobile) registers nothing, and no POSTONA table holds a token.

The KabuMori app (`src/`) has `public.device_push_tokens`. It cannot carry POSTONA's contract. Measured on the local stack, with its own migration (BEFORE):
1. **the token is readable with the person's JWT** (`select expo_push_token`): any leaked access token reads the secret;
2. **another person on the same phone cannot take the token over**: the upsert is refused by row security, so the token stays the first person's, and their notifications keep reaching the phone the second person now holds;
3. **sign-out** (when the app's best-effort delete does not reach the server) leaves the row deliverable;
4. **a service end** leaves it too: the table has no session, workspace or generation column.

It is another app's shared table, so this candidate leaves it unchanged and adds a POSTONA-only table.

## 2. The model

`private.postona_push_devices`: one row per app installation (`installation_id`, a random UUID the app keeps in secure storage). Owner-only, row security on with no policy; no API role reads or writes it.

| column | bound to |
| --- | --- |
| `device_secret_sha256` | (task 10) the SHA-256 of the installation's device secret: 32 random bytes the app keeps in secure storage, per phone, across sign-ins |
| `user_id` | the person (`auth.uid()` of the registering JWT) |
| `workspace_id` | the person's derived personal workspace (`'u_' || md5 prefix`), never a client value |
| `session_id` | the JWT's `session_id`: the auth session that registered it |
| `lifecycle_version` | `common_accounts.lifecycle_version`, read under T13's account lock |
| `push_token` | the secret; **only while active** (a revoked row keeps neither the token nor its hash) |
| `registration_version` | bumped by every change (compare-and-set) |
| `status` / `revoked_reason` | `active`, or `revoked` with `unregistered` / `taken_over` / `provider_rejected` / `session_ended` / `stale_generation` / `account_gone` / `stopped` |

A token is active on **one row only** (a partial unique index on its SHA-256).

### 2a. The stop fence (task 10, P2-1)

`private.postona_push_control`: one row, `enabled`. The install turns it on; `001_push_devices_stop.sql` turns it off.

| who | takes | so |
| --- | --- | --- |
| register | T13's account lock → the fence **FOR SHARE** (until COMMIT) → token / installation advisory locks → device rows | refuses `PUSH_DEVICES_STOPPED` while off |
| stop | the fence **FOR UPDATE** first (it waits for every registration holding it) → revoke EXECUTE → erase every active row (a new snapshot: sees what those registrations committed) | after it commits, no active row, no token, no target |
| delivery targets / list | read the fence | `PUSH_DEVICES_STOPPED`, no targets, while off |
| account deletion | T13's account lock (P1's lifecycle lock) | a registration in flight when the account turns `deleting` refuses `ACCOUNT_DELETION_IN_PROGRESS` |

- **Lock order:** account → fence → advisory → rows. The stop takes no account lock, and takes rows only after the fence, so there is no cycle.
- **Lock timeout:** every register waits at most 5 s for a lock (`lock_timeout` on the function). It then answers `PUSH_BUSY`, and nothing of the call is kept.
- **Restart:** run the install again. It turns the fence on and grants EXECUTE again.

## 3. The app's API (G1)

Three RPCs, `authenticated` only (the only SECURITY DEFINER functions this adds). The person is the JWT's; the app never sends a user, workspace or session id. No answer ever carries a token.

| RPC | gates | answers |
| --- | --- | --- |
| `postona_push_device_register(installation_id, device_secret, platform, push_token, expected_version)` | S2-2 session `active` → T13 (account lock; account active, x_autopost active, no deletion, session live after the lock) → the stop fence → S2-3 `own` | `registered` / `unchanged` + the device; `STALE_REGISTRATION` (+ the person's own row version, or null); `DEVICE_IN_USE`; `DEVICE_LIMIT`; `PUSH_DEVICES_STOPPED`; `PUSH_BUSY`; `INVALID_INPUT`; the gates' refusals |
| `postona_push_device_unregister(installation_id)` | S2-2 only (works after a service end, a lock or an owner loss) | `unregistered` (idempotent) / `not_registered` (none, or another person's: the same answer) |
| `postona_push_device_list()` | S2-2 only | the person's devices (no token), `delivery` (what the worker would be told now), `deliverable` / `this_session` per device |

**Register rules:**
- **Compare-and-set.** The person's own row moves only from the `registration_version` they last saw. A new row, or another person's, moves only from `null`. A replayed or older request is `STALE_REGISTRATION`.
- **The same registration again is `unchanged`.** That means the same token, session, generation, platform and workspace (a retry whose answer was lost).
- **Takeover (task 10, P2-3): refused by default.**
  - **The installation row is the phone.** It moves, to the same person or another, only with that installation's **device secret**. That is the same phone signed in to another account: an authenticated handover. A leaked installation id alone answers `DEVICE_IN_USE`, gives no version, and changes nothing, whatever state the row is in.
  - **A token held by another person's live registration** (active, its auth session live) is refused: `DEVICE_IN_USE`. A leaked token moves nothing.
  - **A token moves only:**
    - from a registration whose session has ended (signed out or expired: the phone changed hands after the old account signed out);
    - from the person's own other installation (a reinstall).
    The earlier row is then revoked `taken_over`.
  - **No oracle any more.** `DEVICE_IN_USE` says that the identifier the caller already holds is in use; it reveals nothing else.
- **At most 10 deliverable devices.**
- **Serialization:**
  - the person's own registrations: T13's account lock;
  - one token: a transaction advisory lock on its hash;
  - one installation: a transaction advisory lock on its id;
  - rows are locked in `installation_id` order.

**App lifecycle (the contract; also in `client.ts`):**

| when | call |
| --- | --- |
| once per installation | an installation id and a device secret (`newDeviceSecret`), kept in secure storage **across sign-ins** (they identify the phone, not the person) |
| after every sign-in, and on every app start while signed in | `syncPushDevice(client, readCurrent)`: `readCurrent()` reads, at that moment, notifications on / off, the OS token, the version stored **for this person**; store the answered version per person |
| the OS gives a new token | the same |
| `STALE_REGISTRATION` | **never re-sent** (task 10, P2-2). `recoverStaleRegistration(client, readCurrent)` is a new operation: it reads the server's row, then the app's state again. It does nothing when notifications are off now, or when the person removed this phone (revoked `unregistered`); otherwise it registers the **current** token from the server's version |
| `DEVICE_IN_USE` | never retried. Token case: the other account signs out on this phone first. Installation case: a new installation id and device secret, then sync once |
| sign-out | `unregisterPushDevice` **before** `auth.signOut()`; a failure must not block the sign-out (the server stops delivery to a device whose session is gone anyway); clear the stored version |
| notifications off / on in the app | off: the local flag off **first**, then `unregisterPushDevice`; on: the flag on, then `syncPushDevice` |
| account deletion | `unregisterPushDevice`, then the deletion |
| never | queue a register request for later; build a new one from the current token |

## 4. The delivery read (G3's push worker)

`private.postona_push_delivery_targets(user_id, brand_id) → {verdict, lifecycle_version, targets[{installation_id, platform, push_token, registration_version}]}`

It is owner-only and SECURITY INVOKER: no grant to any API role, `service_role` included. A G3 delivery function owned by the same owner calls it, with the outbox row's `user_id` and the notification's `brand_id`. It runs in one STABLE snapshot, takes no lock and writes nothing.

**It re-authorizes on every call.** A token is answered only while all of these hold:
1. G5's MV `private.postona_personal_worker_verdict(user, brand, 'x_autopost', CURRENT lifecycle_version) = 'active'`:
   - the derived personal workspace;
   - S2-3 `own` (no owner loss, no second member or owner, no other owned brand);
   - the account active and not being deleted, x_autopost active, the generation triggers P1's.
   Otherwise the verdict is MV's reason (`SERVICE_NOT_ACTIVE`, `ACCOUNT_LOCKED`, `ACCOUNT_DELETION_IN_PROGRESS`, `WORKSPACE_OWNER_UNKNOWN`, `OWN_WORKSPACE_CONFLICT`, `NOT_PERSONAL_WORKSPACE`, …) and there are no targets.
2. The row is active, that person's, that workspace's, and registered under the **current** generation. A service end, restart, lock or deletion bumps the generation: every earlier registration stays silent until the app registers again.
3. The row's auth session still exists for that person and has not expired. **Sign-out deletes it, so delivery stops even if the app's unregister never arrived.**

**Rules for the worker:**
- **Read right before each send; never cache.** A send already read may still go out once after a revoke; the next read sees the revoke. That window is the time between the read and the provider call.
- **The tokens are secrets.** Do not log them, put them in an outbox / error row, or return them to any client.
- **Dead tokens.** When the provider answers that a token is dead (Expo `DeviceNotRegistered`), call `private.postona_push_device_invalidate(installation_id, registration_version)` with the version from the read. A newer registration (the app registered again since the read) is left alone.
- **Clean-up.** `private.postona_push_devices_purge()` erases the tokens of rows that can never deliver again (session ended, older generation, account gone or being deleted). Delivery already refuses them; this removes the secret. It is not scheduled by this candidate (a later cron, a separate step). The account-deletion saga can call it too.

## 5. The remaining push worker design (not built here; G3 / central)

1. Claim pending `push_outbox` rows (G3's table: a claim state, attempts, `FOR UPDATE SKIP LOCKED`). This needs G3's 018 to allow states other than `pending`.
2. For each row:
   - G3 re-checks its own predicate (the notification still relevant; service-end semantics are G3's);
   - then it reads `postona_push_delivery_targets(user_id, brand_id)`.
3. Not `active`, or no targets: mark the row skipped with the verdict (no token anywhere).
4. Send from an Edge function that holds the provider credential (Expo access token, with Expo "enhanced push security" on). Credentials are a separate secrets gate. Real sends need the user's explicit approval.
5. Receipts: `DeviceNotRegistered` → invalidate (above); retryable errors → back off; never retry with a token read earlier.
6. Rate and size limits per person; no notification body beyond what the app's notification view already shows.

## 6. Not covered

- **The time between the read and the send** (section 4). That is G3's worker contract: re-authorize right before each send. A stop that commits after a read cannot recall a send already read. The next read answers `PUSH_DEVICES_STOPPED`.
- **A token the attacker already knows (task 10).**
  - Through Expo: anyone holding a person's token can send to that phone unless enhanced push security is on (item 4 above).
  - Here: a leaked token or installation id no longer moves a live registration (P2-3).
  - **Residual:**
    1. The victim's registration has ended (signed out on that phone, or the session expired), and an attacker registers the leaked token first.
    2. The attacker's POSTONA notifications then reach the victim's phone, and the victim's next registration of that token answers `DEVICE_IN_USE` until the attacker's session ends.
  - Proving control of a token needs the provider: a push-delivered nonce the phone echoes back. That is a later step with real sends, not this candidate.
- **`service_role`** cannot read the table or call the worker side. A superuser or the owner can read everything.
- **Push notification content and the outbox** are G3's.
- **The KabuMori app's `public.device_push_tokens`** (section 1) is unchanged.

## 7. Install / stop / rollback

`001_push_devices.sql` runs as the lifecycle owner (not a superuser), with `ON_ERROR_STOP`, in one transaction.

Refusals (each changes nothing):
- `PUSH_SUPERUSER`;
- `PUSH_PREREQUISITE_MISSING`;
- `PUSH_GATE_CHANGED` (S2-2 `a5d4d71c…`, S2-3 `fa462360…`, T13 `1f8cd9c7…`, MV `066b958a…`, by body md5 and owner);
- `PUSH_OWNER_FILTERED`;
- `PUSH_TAKEN`;
- `PUSH_POSTCONDITION_*`: the table's ACL and row security; exactly 11 functions; only the 3 public ones definers; their ACL `owner + authenticated`; no API role reaching the private ones.

A re-run changes nothing.

- **Stop:** EXECUTE off and every token erased; the install starts it again.
- **Rollback:** refuses while a device is active (`PUSH_ACTIVE_DEVICES`), or while another function names the worker side (`PUSH_IN_USE`).

## 8. Tests

Real local Supabase stack: PG 17.6, GoTrue ES256 JWTs with real sessions (sign-out deletes the session row), PostgREST, Kong. The person's calls go through `client.ts` over supabase-js; the worker side is called as the owner.

Tokens:
- fake, made at run time (`ExponentPushToken[g5ptok…]`);
- tests compare SHA-256 hashes only, and every answer is checked to carry no token;
- the runner scans every container log and the Edge serve log for the marker afterwards (any hit fails the run).

| part | what |
| --- | --- |
| BEFORE | no POSTONA API; `public.device_push_tokens` as built: FAIL 1–4 of section 1 reproduced |
| BEFORE (PR #667 files, task 10) | P2-1: a registration in flight commits after the stop and is a delivery target. P2-2: #667's client re-sends over "off" (the phone revived) and over a newer token (overwritten). P2-3: a leaked installation id and a leaked token take over a live registration of another person |
| P2-1 / P2-2 after | in-flight registration vs stop → `PUSH_DEVICES_STOPPED`, 0 active; a stop waits for a registration holding the fence, then erases it; deletion vs in-flight registration; the fence off → no targets; a 7 s lock → `PUSH_BUSY` at 5 s; the client never re-sends (off, removed, newer token) |
| install | superuser, changed gate, squatted table, foreign-owned function, failing postcondition: refused, catalog unchanged (no partial state); idempotent; ACL / definers (devices and fence tables); `service_role` and anon refused |
| flow | register → unchanged → stale → update → list → unregister (idempotent, token erased) → stale replay → register again; bad input; the device limit |
| isolation (P2-3 after) | leaked token / installation id → `DEVICE_IN_USE` (also after a restart, also a signed-out row); handover with the device secret; a token moves after the holder's sign-out; reinstall; another's unregister / list / probe |
| lifecycle | old JWT after sign-out, expired session, sign-out without unregister, new session re-binds, service end / restart, lock / unlock, owner loss, second member, foreign workspace, deletion in progress, no workspace, anonymous sign-in |
| races (live lock holders, API calls queued) | same installation from one version; one token from two people; register vs service end; register vs unregister |
| worker | stale provider receipt; purge |
| stop / rollback | active / in-use refusals; stop erases tokens and EXECUTE; re-install; install + stop + rollback restores the catalog |
| deny-net | no connection to Expo / APNs / FCM possible from the test process |
| mutants | 18: each guard removed is noticed by its check (task 10 adds: register / targets ignore the fence, no device-secret check, a live holder gives its token up, no lock timeout) |
