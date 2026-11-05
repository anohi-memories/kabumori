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
| `notifications` | `limit?` (1–100, default 50) | `notifications: [...]` (own, newest first) |
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
| `reservation_changed` | the approved candidate's reservation was rescheduled, sent (`published` / `failed` / `uncertain`), cancelled or expired | on the next `notifications` call, from the reservation's confirmed state |

- **No duplicates**: there is one row per event, so retries and races do not create a second one.
- **Nothing lost**: a reservation change that no one has listed yet is written by the next list. Only the latest state is guaranteed, so two reschedules between lists can show as one.
- **Mark read**: `markRead` is idempotent; the first read time stays.
- **Whose rows**: only the caller's notifications are returned, and only for a workspace the caller still owns. Nothing is written for a former owner: no notification, no outbox row (G3-02 #17).
  - A deleted workspace or X account takes its candidates and notifications with it. This is a foreign-key cascade, checked in the catalog only.
  - A person who no longer owns the workspace sees nothing and can change nothing.

## 6. Push (for a later, separately reviewed step)

Each new notification gets one `postona_x_resv.push_outbox` row (`state = 'pending'`). Nothing reads it in this candidate, and no role can.

A push worker needs its own review and approval. When it is built it must:
- send only to the person's own registered devices, and only for a workspace they still own;
- skip a notification already read;
- carry ids and kind only, never the post text;
- record its own delivery state outside this table, or in a later reviewed column.

Note: `reservation_changed` is written when the person lists notifications. Pushing it promptly therefore needs a scheduled reconcile, which is also a later step.

## 7. Screen flow for G1

1. Composer "承認に回す": call `submit` with a new `clientRequestId`, then show the candidate as 「承認待ち」.
2. Approval view: show `body` and the time. 「承認」 sends `approve` with the shown `revision` and `contentSha256`. 「却下」 sends `reject`.
   - On 409 / 422, re-read with `get`; never retry with a new revision on your own.
3. After approval, the reservation is a normal reservation (`reservationId`). Use the reservation API's `get` / `list`, including
   `connectionGeneration`.
4. Notification list: `notifications`, then `markRead` on open. Badge = rows with `readAt == null`.
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
