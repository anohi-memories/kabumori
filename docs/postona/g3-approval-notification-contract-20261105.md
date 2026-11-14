# POSTONA X post approval + notifications: API contract for G1 (G3-02 #16)

Status: SOURCE CANDIDATE. Not deployed. The release gate `POSTONA_APPROVAL_API_ENABLED` is `false`, so the entry answers 503
`NOT_AVAILABLE`. SQL 018 is not applied anywhere. PRODUCTION_NO_GO. No push is sent by anything here.

Files: `supabase/candidates/postona_x_reservations/018_postona_x_resv_approvals.sql` (+ `_rollback.sql`),
`supabase/functions/_shared/postona_approvals/`, `supabase/functions/postona-x-approvals/`.

## 1. What it is

A **post candidate** is not a reservation. The person submits it, may revise it, and then approves or rejects it.

- **Approve**: creates exactly one reservation through the existing create path (`create_batch`), in the same transaction. Every rule of a
  normal create applies: person session, own personal workspace, X service active, G4 verdict and connection generation, time, text and
  slot rules.
- **Pending, rejected or failed approval**: no reservation exists, so the worker cannot send it.
- **Existing reservations**: made the existing way, they need no approval and are unchanged.

```
submit ──> pending_approval ──approve──> approved (reservationId set)
              │  ▲
              │  └─revise (revision + 1, new hash)
              └──reject──> rejected
```

## 2. Endpoint

`POST /functions/v1/postona-x-approvals`. Headers are the same as the reservation API: `Authorization: Bearer <access token>` and
`apikey: <publishable key>`. The body is `{ "action": ..., "payload": {...} }`, and unknown keys are refused (400 `REQUEST_INVALID`).

| action | payload | answer |
|---|---|---|
| `submit` | `socialAccountId`, `clientRequestId` (uuid, make one per user intent and keep it for retries), `body` (1–280 weighted chars), `scheduledAt` (ISO, 5 min – 90 days ahead) | `candidates: [one]` |
| `revise` | `candidateId`, `expectedRevision`, `body`, `scheduledAt` | `candidates: [one]` (revision + 1) |
| `approve` | `candidateId`, `expectedRevision`, `contentSha256` (the hash shown with the text the person approves) | `candidates: [one]` (`approved`, `reservationId`) |
| `reject` | `candidateId`, `expectedRevision` | `candidates: [one]` (`rejected`) |
| `list` | `socialAccountId` | `candidates: [...]` (own, newest first, at most 200) |
| `get` | `candidateId` | `candidates: [one]` |
| `notifications` | `limit?` (1–100, default 50) | `notifications: [...]` (own, newest first; first page only through the Edge today, see 5b) |
| `markRead` | `notificationId` | `notifications: [one]` |

**Candidate**: `candidateId`, `socialAccountId`, `body`, `contentSha256`, `scheduledAt`, `state`
(`pending_approval|approved|rejected`), `revision`, `reservationId|null`, `decidedAt|null`, `createdAt`.

**Notification**: `notificationId`, `kind`, `candidateId|null`, `reservationId|null`, `subjectRevision`, `state`, `scheduledAt|null`,
`createdAt`, `readAt|null`.

There is no post text, token or account handle in a notification.

## 3. Retries and races

- **`submit`**:
  - The same `clientRequestId` with the same payload returns the same candidate; nothing new is written.
  - The same id with another payload answers 409 `POSTONA_RESV_IDEMPOTENCY_CONFLICT`.
- **`approve` / `reject`**:
  - Retrying the same decision (the same `expectedRevision`, and for approve the same hash) returns the decided candidate; nothing new is written.
  - Measured locally: 5 concurrent approves gave one reservation. Approve and reject sent together gave exactly one winner (200 and 409).
- **Answers that cannot be trusted**: on 5xx `STORE_UNAVAILABLE`, a network error or a timeout, re-read with `get` before showing a result.

## 4. Errors

| HTTP | code | show |
|---|---|---|
| 401 | `AUTH_REQUIRED` / `POSTONA_RESV_AUTH_REQUIRED` | sign in again |
| 403 | `POSTONA_RESV_SERVICE_NOT_ACTIVE` | start the service |
| 403 | `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED` | reconnect X |
| 404 | `POSTONA_RESV_NOT_FOUND` / `POSTONA_RESV_ACCOUNT_NOT_FOUND` | not found (also another person's id; no other detail) |
| 409 | `POSTONA_RESV_STALE_REVISION` | re-read; someone changed it |
| 409 | `POSTONA_RESV_APPROVAL_NOT_PENDING` | already decided; re-read |
| 409 | `POSTONA_RESV_APPROVAL_GENERATION_CHANGED` | submitted before a service restart or an X reconnect; revise it (or submit again) under the current connection, then approve |
| 409 | `POSTONA_RESV_SLOT_CONFLICT` / `_DAILY_CAPACITY` / `_MONTHLY_CAPACITY` / `_APPROVAL_CAPACITY` | change the time / later |
| 422 | `POSTONA_RESV_CONSENT_REQUIRED` | the text changed since it was shown; show it again |
| 422 | `POSTONA_RESV_TEXT_INVALID` / `_TIME_OUT_OF_RANGE` / `_REQUEST_INVALID` | fix the input |
| 503 | `NOT_AVAILABLE` / `STORE_UNAVAILABLE` / `AUTH_UNAVAILABLE` / `POSTONA_RESV_SERVICE_BUSY` | try later; read back first |

## 5. Notifications

| kind | when | written |
|---|---|---|
| `approval_requested` | submit, and each revise (`subjectRevision`) | in that transaction |
| `approval_approved` | approve | in that transaction |
| `approval_rejected` | reject | in that transaction |
| `reservation_changed` | the approved candidate's reservation was rescheduled, sent (`published` / `failed` / `uncertain`), cancelled or expired (a send in progress, `claimed`, is not an event) | G3-02 #21: the change's own transaction (the worker's finish, the claim's close, the person's reschedule / cancel) records the event per revision; the person's next `notifications` call turns each recorded revision into one notification + outbox row |

- **No duplicates**: there is one row per event, so retries and races do not create a second one.
- **Nothing lost**: every revision of a reservation change is recorded in the change's own transaction (G3-02 #21), with no G5 lock, so the worker's result is never held up or rolled back by a notification. The next list turns each recorded revision into exactly one notification, and an event that cannot be written yet stays recorded for the next list. So version 2 and version 3 both appear, even when one was recorded while notifications could not be written.
- **Mark read**: `markRead` is idempotent; the first read time stays. Since G3-02 #20 (G2 #11) it is a write that needs the X service: after a service end it answers 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE` and `readAt` stays as it was. A service end committing at the same moment is waited for and then refuses (G5's writer gate). Reading (`notifications`, `list`, `get`) stays allowed.
- **Whose rows**: only the caller's notifications are returned, and only for a workspace the caller still owns. Nothing is written for a former owner: no notification, no outbox row (G3-02 #17). An ownership loss that is committing at the same time either commits first (then nothing is written) or waits for the write to commit (G3-02 #18 row locks).
  - A deleted workspace or X account takes its candidates and notifications with it. This is a foreign-key cascade, checked in the catalog only.
  - A person who no longer owns the workspace sees nothing and can change nothing.

## 5a. Decisions on G2 #9's P3 findings (G3-02 #19)

- **After a service end, `list` / `get` / `notifications` still answer 200** with the person's own rows. This is the contract and stays.
  - It follows G5's lifecycle contract (#589 6579654668): the same person may keep reading their own items and cancelling. Writes that can lead to a post stop (`submit` / `revise` / `approve`: 403 `SERVICE_NOT_ACTIVE`); `reject` stays allowed. `markRead` was allowed here until G3-02 #20; since G2 #11 it is refused as well (403 `SERVICE_NOT_ACTIVE`, `readAt` unchanged), because it is a write.
  - Measured: PG17 AP12, local L35.
  - Nothing of another person is ever returned. A former owner sees nothing (#17 / #18). G1 shows the answer as it is and adds the "start the service" way out from the 403.
- **Each submit and each revise writes one `approval_requested`**, keyed by `subjectRevision`. This is per revision by design, not a duplicate: a retry of the same request writes nothing more (measured: L38, three concurrent submits give 1 row).
  - Rows are immutable history, kept for push and audit.
  - G1 should group by `candidateId` and show only the newest `approval_requested` per candidate as unread. When the person opens it, G1 may mark the older ones of the same candidate read with `markRead`, one call each.
  - The server does not merge or hide them, so a push that already went out for revision 1 is never contradicted.

## 5b. History, paging and the list's time bound (G3-02 #22, H1 #47 P3)

- **Order and cursor (SQL)**: notifications have a stable order (`seq`, unique and increasing) and each row carries `cursor`.
  - `postona_x_resv.list_notifications(limit, before)` returns the rows older than `before`. Call it with the last row's `cursor` until a page comes back shorter than `limit`; every notification of the person is reached exactly once (measured: 230 rows created in the same instant, all reached in 3 pages).
  - Another person's rows never appear, whatever cursor is passed.
  - The first page (no cursor) is what the Edge's `notifications` action returns today.
- **Not yet wired in the Edge**: the HTTP API cannot page yet. It needs `before` in the `notifications` payload and `cursor` in the DTO (`supabase/functions/_shared/postona_approvals/api.ts`, `postgres_db.ts`, `api_test.ts`). Those files are outside G3-02 #22's paths, so G1 can show only the newest 100 for now.
- **Retention**: notifications are kept until the workspace (or the person's account) is deleted (cascade) or 018 is rolled back. There is no time-based expiry. Pending reservation events are kept only until they become notifications.
- **Time bound**: the list's drain stops at the first held lock (250 ms) and after 2 s in all. What is left stays recorded for the next list. Measured: 8 pending events under a 20 s account holder → the list answered in about 0.3 s; after the holder one list wrote all 8, once each.
- **Deletion and re-registration**: pending events and notifications go with the reservation / workspace (FK cascade, catalog checked). A person who registers again is a new user id with a new workspace, so nothing pending carries over. G5's real deletion saga over these tables is NOT_RUN.

## 6. Push (for a later, separately reviewed step)

Each new notification gets one `postona_x_resv.push_outbox` row (`state = 'pending'`). Nothing reads it in this candidate, and no role can.

A push worker needs its own review and approval. When it is built it must:
- send only to the person's own registered devices, and only for a workspace they still own;
- skip a notification already read;
- carry ids and kind only, never the post text;
- record its own delivery state outside this table, or in a later reviewed column.

Note: since G3-02 #21 the worker only records `reservation_changed` events (`postona_x_resv.reservation_events`, ids / states / times only); they become notifications + outbox rows when the person lists. A later push worker would drain the same records through its own reviewed entry, re-authorizing each one. G3-02 #20's same-transaction notification was withdrawn because it made the worker's result wait for G5 locks (H1 #46 P2).

## 7. Screen flow for G1

1. Composer "承認に回す": call `submit` with a new `clientRequestId`, then show the candidate as 「承認待ち」.
2. Approval view: show `body` and the time. 「承認」 sends `approve` with the shown `revision` and `contentSha256`. 「却下」 sends `reject`.
   - On 409 / 422, re-read with `get`; never retry with a new revision on your own.
3. After approval, the reservation is a normal reservation (`reservationId`). Use the reservation API's `get` / `list`, including
   `connectionGeneration`.
4. Notification list: `notifications`, then `markRead` on open. Badge = rows with `readAt == null`. After a service end, `markRead` answers 403 `SERVICE_NOT_ACTIVE`: keep the row unread, show the "start the service" way out, and do not retry.
5. Push: not until the separate push step exists. The app must not infer a push from these rows.

## 8. Rollback

`018_..._rollback.sql` runs first. It needs `postona_resv_approval_rollback.discard = '<candidates>:<notifications>'`, or
`G3RO_APPROVAL_DISCARD_ROWS` with `rollout.sh`. Reservations that approvals created stay as ordinary reservations.

## 9. Not verified

- A device / Simulator, and G1's screens.
- A hosted gateway and grants.
- G5's deletion saga over these tables; only the cascade is checked.
- A push provider.
- The real X.
- G5 PR #645's ownership-lock trigger outside a throw-away local database (G3-02 #19 applies it only there).
