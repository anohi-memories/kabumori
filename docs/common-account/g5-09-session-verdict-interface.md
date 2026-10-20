# G5-09: a session-only verdict for G3's reservation cancel and receipt (P7) — interface contract

Status: **design + pure reference model + offline tests only.** No SQL, no RPC, no migration, no grant, no change to R1 / W1 / W2, to G3's 007 or to any
Edge. The SQL this proposes is a later G5 TASK behind a focused **Codex Sol (high)** review; G3's fix is a later G3 TASK. Production is **NO_GO**.

> **G5-10 update (Issue #320 task 10):** the interface of section 4 now exists as an isolated SQL candidate,
> `supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql` (not applied, not wired), with its PG17 proofs in
> `docs/common-account/g5-10-session-verdict-sql-candidate.md`. The API is unchanged.

- TASK `common-account-g5-g3-cancel-receipt-session-verdict-interface-contract-20261021` (Issue #320, G5-01 generation, task 9, completion K5).
- The question: G3's COORDINATION on Issue #320 (comment 6292793871), from G3 PR #392 (head `f34aab9714f5d4f11388609262d5f64cdcce5ed9`, tests only):
  007's `cancel_reservation` and `receipt` decide the person with `auth.uid()` alone, so a signed-out, expired, another person's, unknown or
  anonymous session still reads its receipts and cancels its own reservations (P7). Three questions: which check to use (A / B / C), whether a person
  whose service ended may still read their receipts, and whether the real Edge verifier already refuses such tokens.
- Stacked on PR #399 (G5-08, H1 C1 `PASS_FOCUSED_SOURCE_REREVIEW`, Issue #306 ACCEPT 6294606412) -> #383 -> ... -> #303.
- New G5-owned files: this document, `supabase/candidates/common_account_postona_authz/session_verdict.ts` (the model),
  `supabase/tests/common_account_g5_09_session_verdict_{test.ts,mutations.py}` and
  `supabase/preflight/managed_disposable/g5_09_session_verdict_doc_test.ts`. No existing file is edited.

Evidence labels: **[D]** derived by a test of this task; **[M]** `origin/main` `0c42933c`; **[C]** a candidate in a Draft-PR stack (G3 PR #392 head, the F5
chain); **[S]** the public GoTrue source `supabase/auth` at commit `ce9a8eee0cc042be8c7a42981a7ddae631e41d91` (2026-09-22), read only, not the
deployed version; **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Q1: A, B or C? | **B** — a G5 session-only verdict, `private.account_lifecycle_session_verdict()`, whose rules are exactly R1's subject + session stages (proven equal to R1's reference over 80 cases [D]). A (R1 `read_workspace`) works but hides receipts and blocks stopping after a service ended, a suspension, a deletion or an owner change [D]; C does not fit (section 3). B does not exist yet: it is a later G5 SQL TASK. |
| Q2: receipts after the service ended? | **Yes, G5 recommends it**: a receipt is the person's own record of what was (or was not) posted for them; reading it sends nothing and writes nothing. Stopping one's own pending reservation stays allowed too (it can only prevent a post). The gate is the session, not the entitlement (section 5). |
| Q3: does the real Edge already refuse those tokens? | **No reservation Edge is deployed** [M]. The candidates differ: X's (`postona-x-reservations`, gate OFF) asks GoTrue `GET /auth/v1/user` per request [C]; Threads has only a test fixture with a MOCK verifier [C]. By GoTrue's source [S], `/user` refuses a signed-out or unknown session (403 `session_not_found`) but **not** an expired session (`not_after`), not an anonymous user (the X verifier refuses that itself [C]) and not a token without a `session_id`. And neither candidate hands the session to the database [C]. So P7 is **not** only defence in depth: the database check is needed (section 6). Managed behaviour stays NOT_VERIFIED. |
| What G3 changes later | 007's cancel / receipt call the session verdict first (a refusal = `POSTONA_RESV_AUTH_REQUIRED`, 401, before any row is read); the Edge hands the database the verified token's `sub` **and** `session_id` (`edgeClaimsForDb`). Both after B exists and after Sol. |

## 2. What exists today

| Item | Fact |
| --- | --- |
| 007 cancel / receipt | `postona_x_resv.caller()` = `auth.uid()`; claims' `session_id`, `role`, `is_anonymous` are not read; rows by `r.user_id = caller()`; callable only by `postona_resv_api` (G3 PR #392 doc §1, I1) [C] |
| 007 create | already calls G5's R1 (session checked) [C] |
| X reservations Edge | `supabase/functions/postona-x-reservations/index.ts`: "NOT deployed; release gate OFF"; verifier `supabase_auth.ts` calls `GET /auth/v1/user` with the caller's token on every request and refuses `is_anonymous`, banned, deleted users; it returns only `{ userId }` [C] |
| X DB adapter | `postgres_db.ts` sets `request.jwt.claims = {sub, role}` — **no `session_id`** [C]. R1, P3b and the proposed B all need it: through this adapter they refuse everyone with `AUTH_REQUIRED` [D: `today's X reservation adapter ...`] |
| Threads HTTP | `fixture/threads_reservation_http_fixture.ts`: a TEST FIXTURE; `verify` is a MOCK ("the real verifier is G5's"); its PG port sets `{sub, role, session_id}` [C] |
| main | no reservation function under `supabase/functions/` [M] |
| GoTrue `/user` | `requireAuthentication` -> `parseJWTClaims` (signature, `exp` by the library) -> `maybeLoadUserOrSession` (`internal/api/auth.go:118-170`): user by `sub` (missing -> 403); session by `session_id` **only when the claim is present** (missing row -> 403 `session_not_found`); no `not_after` check, no `session.user_id = sub` check; anonymous refused only by routes with `requireNotAnonymous`, and `/user` is not one (`api.go:281`) [S] |

## 3. Q1 — the three options

| | A: R1 `read_workspace` | **B: session-only verdict (recommended)** | C1: `assert_active_service_write` | C2: `enrollment_fence(uid, true)` |
| --- | --- | --- | --- | --- |
| exists | yes, candidate (#351 / #371 / #399); `read_workspace` is a real R1 feature [C] | no — proposed here | F5 chain P3b [C] | F5 chain P9 [C] |
| checks the session | yes | yes, R1's exact rules | yes | yes (live row, owner, not_after) |
| also demands | the `x_autopost` entitlement **active**, the account active, the brand id, the caller its **single owner** | nothing else | account active, entitlement active | nothing else |
| receipt after service end / suspension / deletion / owner change | **refused** (`SERVICE_NOT_ACTIVE`, `SERVICE_SUSPENDED`, `SERVICE_DELETION_IN_PROGRESS`, `BRAND_ACCESS_DENIED`) [D] | allowed (session live) [D] | refused | allowed |
| side effects | none (STABLE) | none (STABLE) | **locks** (login KEY SHARE, account and entitlement `FOR UPDATE`, lock order I1) — a read would queue behind lifecycle work | none, but VOLATILE and raises |
| subject rules = R1 | yes | yes (one reference model, `sessionVerdict`) | its own | differs: no `role = authenticated` check, anonymous refused only for `true`/`t`/`1` (R1 refuses anything but `false`), user id passed in, a `p_require_live_session = false` mode that skips the session |
| answer shape | the 8-key wire (needs a brand id) | one text code | an exception | an exception |
| coupling | a read path tied to the brand / entitlement policy of writes | its own contract | the writers' fence; changes for writers would change reads | the enrollment contract; changes for enrollment would change reservations |
| new Auth SQL | none | one STABLE function, owner-only | none | none |
| fail closed | yes | yes (unreadable -> error) | yes | yes |

B is the only option whose contract is exactly "a live, non-anonymous session of this person" and nothing else. A is acceptable only as a stricter
stop-gap with its costs written down (receipts hidden and stopping blocked after a service ended; the owner-change case G3 recorded as Q1 refused). C is
not recommended: C1 locks and demands an active service; C2 is close but its subject rules are weaker than R1's and it belongs to another contract.

## 4. The interface (B) — specified here, created by a later TASK

```
private.account_lifecycle_session_verdict() returns text
  STABLE, SECURITY DEFINER, set search_path = '', set row_security = off, owned by the lifecycle owner
  EXECUTE: the owner only (no API role, no grant); a consumer must be a function owned by the same owner, or get a separately reviewed grant
  -> 'active' | 'AUTH_REQUIRED' | 'SESSION_REVOKED' | 'SESSION_EXPIRED'      (an unreadable fact raises; the model's SESSION_UNKNOWN)
```

- **Subject**: R1's claim rules, unchanged — the per-claim settings first, else `request.jwt.claims`; `sub` and `session_id` uuids; `role =
  'authenticated'`; `is_anonymous` absent / `false` (anything else, both forms, is `AUTH_REQUIRED`); `sub = auth.uid()`. No parameter.
- **Facts, one statement**: the login exists; the `auth.sessions` row by id **and** `user_id` (another person's row is no row: `SESSION_REVOKED`);
  `not_after` null or after `clock_timestamp()` (else `SESSION_EXPIRED`).
- **Install**: the G5-08 rules (every relation read — `auth.users`, `auth.sessions` — shows the owner every row; no view; `row_security = off`), exact
  `proacl` (owner only), MEMBER-path check that no API role reaches it, PR #303's exposure clean.
- **Reference**: `sessionVerdict()` in `session_verdict.ts`; the test `the session verdict IS R1's subject + session stages` proves it answers `active`
  exactly when R1 (everything else allowed) allows, and R1's own code otherwise, over 80 combinations [D].

## 5. Q2 — what a live session may still do, by account state

| State (R1's answer) | receipt | cancel own pending | why |
| --- | --- | --- | --- |
| active | yes | yes | — |
| service ended (`SERVICE_NOT_ACTIVE`), suspended, service deletion, never registered | **yes** | **yes** | reading sends nothing; stopping only prevents a post |
| account deletion in progress | yes, until the deletion removes the rows | yes | the same; the deletion saga ends the rows anyway |
| account locked (operator) | yes (G5 recommendation) | yes | no send, no write beyond stopping; if the owner wants a lock to hide receipts, that is an extra 007 check (a product decision for the user / G1), not a security need |
| workspace owner changed (G3 Q1) | rows stay the creator's (`r.user_id`) | the creator may stop them | a G3 / G1 decision; the session verdict does not decide it |
| session refused (any of P7's five cases) | **no: 401** before any row is read | **no: 401**, nothing changes | [D] |

The consumer rule is `reservationPersonGate()`: the session verdict first (an unknown fact = 503 `AUTH_UNAVAILABLE`, a refusal = 401 `AUTH_REQUIRED`,
the row never read); then the row by id only when it is the caller's (another person's and an unknown id answer the same 404); cancel only from a
cancellable status (409 otherwise). The entitlement is deliberately not an input [D].

## 6. Q3 — the Edge, and why the database must check anyway

| P7 case | GoTrue `/user` [S] | X verifier (`supabase_auth.ts`) [C] | Threads | The database with B [D] |
| --- | --- | --- | --- | --- |
| C1 signed out (row deleted) | 403 `session_not_found` | refused (non-200) | MOCK | `SESSION_REVOKED` |
| C2 expired (`not_after` past, row present) | **not checked** (only the JWT `exp`) | passes until `exp` | MOCK | `SESSION_EXPIRED` |
| C3 my `sub` + another person's session | not compared; a genuine token cannot carry this pair (the signature binds it) | — | MOCK | `SESSION_REVOKED` |
| C4 unknown session id | 403 `session_not_found` | refused | MOCK | `SESSION_REVOKED` |
| C5 anonymous | **allowed** | refused (`is_anonymous`) | MOCK | `AUTH_REQUIRED` |
| a token without `session_id` | **allowed** (no session lookup) | passes | MOCK | `AUTH_REQUIRED` |
| sign-out between the Auth call and the database call | the Auth call already passed | passes | MOCK | seen if it committed before the statement |

Hence: (1) the database must check the session itself (C2, the token without a session, and the window after the Auth call are not covered by `/user`);
(2) the Edge must hand it the session — `edgeClaimsForDb(token, userBody)`: the exact bearer string GoTrue just answered 200 for, its payload's `sub` equal
to the body's `id`, a uuid `session_id`, `role = authenticated`, `is_anonymous` false in both; else 401. The payload is trusted only because GoTrue
verified that very string. Today's X adapter passes `{sub, role}` only and must change with G3's fix [D]. Whether the deployed GoTrue matches this
source, whether access-token `exp` is clamped to `not_after`, and PostgREST / platform `verify_jwt` behaviour are NOT_VERIFIED [U].

## 7. Races and retries

- The verdict and the action run in ONE transaction (READ COMMITTED; each statement its own snapshot). A sign-out committed before the verdict's
  statement is seen; one committed after it cannot stop that call — the same residual window as R1's (G5-01 §5). Cancelling inside that window only
  stops a post.
- A retry is a new request: a retry after sign-out is 401 and changes nothing [D]; a retried cancel of a row already cancelled is G3's own answer (409
  `NOT_CANCELLABLE` in the model) [D]; G3's 503 `OUTCOME_UNKNOWN` read-back rule is unchanged.
- The verdict takes no lock and writes nothing; it cannot deadlock with lifecycle work (unlike C1).

## 8. Follow-up gates (none started here)

| # | Owner | What | Gate |
| --- | --- | --- | --- |
| 1 | G5 | the SQL of B as an isolated candidate + PG17 proofs (the G5-08 install rules, the model as the oracle, mutation) | a G5 TASK, then Codex Sol (high) |
| 2 | G3 | 007 cancel / receipt: call B first; map every non-`active` code to `POSTONA_RESV_AUTH_REQUIRED` (401); keep 404 sameness and 503 read-back; PR #392's D1-D5 turn green | after #1 and its review; Sol for the 007 change |
| 3 | G3 / F3 | the Edge adapters hand the verified token's `sub` + `session_id` (+ `is_anonymous: false`) to the database (`edgeClaimsForDb`); the Threads Edge uses a real verifier (GoTrue `/user` + the same hand-off) | with #2 |
| 4 | G1 | 401 on receipt / cancel = sign in again; receipts stay visible after a service ended (section 5) | with #2 |
| 5 | user | whether an operator lock should hide receipts; G3 Q1 (owner change) | a product decision |

Unchanged separate gates: managed Auth / ACL / PostgREST (NOT_VERIFIED), G4 / F3 begin owner uniqueness (G5-07 / G5-08), the R1 vs W1 coverage
asymmetry, PR #233, the F3 / G3 revoke, G1's draft storage, the old F5 archive (DEFERRED_BY_USER).

## 9. Tests (offline)

- `supabase/tests/common_account_g5_09_session_verdict_test.ts`: G3's five cases refused with 401 before any row is read and nothing changed; R1's claim
  rules; fail closed on unreadable facts; equality with R1's reference stages over 80 combinations; the entitlement is not an input while option A
  refuses five states; no existence oracle, cancellable states, retries; the Edge hand-off and the tokens GoTrue would still accept; today's X adapter
  claims refused; no network.
- `supabase/tests/common_account_g5_09_session_verdict_mutations.py`: each rule of `session_verdict.ts` broken in a copy; the suite must fail.
- `supabase/preflight/managed_disposable/g5_09_session_verdict_doc_test.ts`.

## 10. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-09` (a clean worktree stacked on PR #399). No database, no managed or production system, no
credential, no network request from the tests. The GoTrue source was read with `gh api` at the pinned commit (a public repository; nothing sent).

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the model's tests (type-checked) | `deno test --no-config --allow-read --allow-env supabase/tests/common_account_g5_09_session_verdict_test.ts` | **9 passed**, 0 failed |
| 2 | mutation of the model | `python3 -B supabase/tests/common_account_g5_09_session_verdict_mutations.py <repository root>` | control PASS, **20/20 detected**, 0 invalid |
| 3 | regression, pure: G5-01 (13) + G5-02 model (11) + G5-06 bootstrap (9) | `deno test --no-config --allow-read --allow-env <the three files>` | 33 passed |
| 4 | the whole harness incl. the document tests | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **222 passed**, 0 failed (217 of PR #399 + 5 new) |
| 5 | type-check, lint, whitespace | `deno check --no-config`, `deno lint --no-config`, `python3 -m py_compile`, `git diff --check` | no error; `Checked 56 files`, no problem; syntax OK; clean |

Not run, on purpose: any SQL (B does not exist yet), any Edge, any managed access, any change to G3's 007 or Edge.
