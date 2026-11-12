# POSTONA Threads — the contract G1 (screens) and G3 (reservation worker) can build on (G4-02 #17, 2026-11-13)

task_id: `postona-g4-gen2-17-threads-manual-publish-local-integration-and-release-gates-20261113` (Issue #561).
Source of truth: the G4 stack up to this PR (PR #657 + #17). This document changes no G1 / G3 / G5 / H5 source; it states what
G4 provides and what each consumer must and must not do. Everything here is source-candidate and local-test evidence only
(e2e scenarios 1–35 on disposable PostgreSQL 17 with fake Threads / PostgREST / GoTrue). Production NO_GO.

## 1. For G1 (the app)

### 1.1 Connection (accounts screen)

| What | Where | Values the screen gets |
| --- | --- | --- |
| Start / callback | `use-threads-connect` → Edge `threads-oauth-connect-user` (H5 runtime + G4 owner bridge) | result `{ kind: 'connected' }`, `'canceled'`, `'expired'`, `{ kind: 'failed', code, reconcile }`, `{ kind: 'unavailable', code }` |
| A refused completion | H5 runtime | always `failed:COMPLETE_OUTCOME_UNKNOWN` (`reconcile: true` → re-read the accounts) — including "a post is still being settled" (§1.3) |
| The account row | `social_accounts.connection_status` | `identity_verified` → `connected`; anything else → `needs_attention` (card mode `reconnect`) |
| Disconnect | Edge `social-mobile-threads-disconnect` | `disconnected`, or `stopped` with `PUBLISH_IN_FLIGHT` (a post may exist: the account is kept until it is settled) |

### 1.2 Manual publish (the card)

Edge `social-mobile-threads-publish`, actions `publish` / `resume` / `reconcile` / `status` / `account_state` /
`set_permission`; every answer carries the attempt (`parseAttempt`). Card modes (`threadsCardMode`): `not_threads`,
`release_disabled`, `preview`, `reconnect`, `loading`, `unavailable`, `consent_required`, `busy` (an attempt is open), `ready`.

| Attempt status | What it means | What the screen may offer (`attemptDisplay`) |
| --- | --- | --- |
| `reserved` … `publishing` | in progress | continue / wait; never "posted" |
| `publish_returned` | Threads said yes; not read back yet | "confirming" (check), never success |
| `published` | read back with the provider's own post id and permalink | success, link, new post |
| `published_unidentified` | a post exists (the container is PUBLISHED) but **which post is not provable** — no id, no link (G4-02 #16) | "posted; the link could not be identified — check in Threads", new post |
| `uncertain` | a post may or may not exist | "check" (reconcile); **never** resend; new post blocked |
| `failed` | nothing was posted (code says why) | new post |

Refusals the card must expect (HTTP): 401 `AUTH_REQUIRED`; 400 `REQUEST_INVALID` / `TEXT_INVALID`; 403 `PUBLISH_FORBIDDEN` /
`SERVICE_NOT_ACTIVE`; 404 `ACCOUNT_NOT_FOUND` / `ATTEMPT_NOT_FOUND`; 409 `CONNECTION_NOT_VERIFIED`, `CREDENTIALS_MISSING`,
**`CREDENTIALS_EXPIRED`**, `MANUAL_PUBLISH_NOT_PERMITTED`, `PUBLISH_IN_PROGRESS`, `IDEMPOTENCY_CONFLICT`,
`WORKSPACE_INACTIVE`, `ACCOUNT_LIFECYCLE_BLOCKED`, `PLATFORM_NOT_SUPPORTED`; 503 when the static gate is closed.

### 1.3 The recovery the screen should explain (not built in G1 today)

`uncertain` + `CREDENTIALS_EXPIRED` on "check" means: the stored Threads credential expired while the outcome was unknown.
**The way out is a reconnect of the SAME Threads user.** The reconnect reads the post's container first (GET only) and:
- final evidence (PUBLISHED / ERROR / EXPIRED) → the post is settled (`published_unidentified` / `failed`), the account is
  connected again, a new post can begin;
- no final evidence yet (FINISHED, a failed read) → the reconnect is refused (`COMPLETE_OUTCOME_UNKNOWN`); nothing changed;
  try again later.

Requested G1 copy (G1-owned, not changed here): on `uncertain` + 409 `CREDENTIALS_EXPIRED`, "Threadsとの接続が切れたため確認
できません。同じThreadsアカウントで接続し直すと、投稿の状態を確かめてから接続を更新します。"; on a refused reconnect while a
post is open, "投稿の結果をThreadsで確認中です。しばらくしてから接続し直してください。" (today H5 shows its generic
`COMPLETE_OUTCOME_UNKNOWN`; a distinct code would need an H5 runtime change).

G1 must NOT: show `published_unidentified` or `uncertain` as success with a link; offer "resend"; enable
`THREADS_CONNECT_UI_ENABLED` / `THREADS_MANUAL_PUBLISH_UI_ENABLED` (both `false` in source) without the release gates (§3).

## 2. For G3 (the reservation worker)

G4's boundary for any automated (scheduled) Threads send — **not connected by G4, and not to be connected without central
approval**:
- The only credential reader is G4's verdict (`postona_g4_credential.threads_publish_credential_verdict(user, account)`:
  `verified`, `credential_generation`, `code`). A send must be released under the SAME generation it was begun with; a
  reconnect between begin and send makes the release refuse (`AUTHORIZATION_CHANGED`).
- The send fence (002) refuses any reconnect / re-bind while the account has an attempt in `publishing` or `uncertain`; no
  clock lifts it. A worker that sends must therefore record every outcome (`publish_returned` / `failed` / `uncertain`) or the
  account stays fenced until a final container status is read.
- Never resend after `uncertain`; settle read-only from the container status; never attribute a post id from a listing.
- The manual-publish attempt table and its release / record RPCs are the manual path; a reservation path needs its own
  reviewed ledger or an explicit contract to reuse this one (G3 + central decision; not designed here).

## 3. What is NOT_VERIFIED (both consumers)

Real Threads: a new grant's token reading a container made under the old grant; container status finality / truthfulness and
timing; whether any container → post link exists. Real GoTrue / PostgREST / Edge, managed Supabase, a device, the G3 worker.
