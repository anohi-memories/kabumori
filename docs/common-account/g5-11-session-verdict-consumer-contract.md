# G5-11: the session verdict's consumer contract (snapshot and isolation) and the H1 P3 follow-ups

Status: **documentation + PG17 / offline tests only. `003_session_verdict.sql` is unchanged** (no SQL, RPC, migration or grant change; R0 / R1 / W1 /
W2 unchanged). G3's 007 and Edge are not touched: the consumer below is a TEST-ONLY fixture. Production is **NO_GO**.

- TASK `common-account-g5-pr408-session-verdict-p3-consumer-contract-tests-20261021` (Issue #320, G5-01 generation, task 11, completion K5).
- The review: H1 C1 on PR #408 (`ceb77ce45f0e79510ac7551849288b17991f81d2`), Issue #306 REPORT 6295813705 / ACCEPT 6295863864 —
  `PASS_FOCUSED_SOURCE_SECURITY_REVIEW`, P0 / P1 / P2 none, four non-blocking P3.
- Stacked on PR #408 (G5-10, the candidate) -> #406 (G5-09, the interface) -> #399 -> ... -> #303.
- Changed G5-owned files: this document, `supabase/tests/common_account_session_verdict_{pg_test.ts,mutations.py}` (the test-only consumer now follows
  the contract; four new tests; three new mutants), `supabase/preflight/managed_disposable/g5_11_consumer_contract_doc_test.ts` (new), the G5-10 doc test
  (its counts pinned as of G5-10) and a status line in the G5-10 document.

Evidence labels: **[D]** derived by a test of this task, **[C]** a candidate in a Draft-PR stack, **[S]** the public GoTrue source `supabase/auth`
`ce9a8eee` (read only), **[U]** NOT_VERIFIED.

## 1. Verdict

| P3 | What H1 found | What this task did |
| --- | --- | --- |
| P3-1 snapshot | The verdict is STABLE: inside a STABLE caller it sees the CALLING statement's snapshot, under REPEATABLE READ the transaction's — a sign-out that committed earlier can still read `active`. | Reproduced all three anti-patterns on PG17 and fixed the **consumer contract** (section 2): VOLATILE, READ COMMITTED only (else refuse), the verdict first, and the read / write **re-authorized inside its own statement**. The contract consumer refuses every case [D]. |
| P3-2 test gaps | No failing test for the superuser-owner refusal and the `auth.uid()` shape precondition. | Two tests + two mutants (section 3) [D]. |
| P3-3 expiry clock | No test catches `clock_timestamp()` -> `now()`. | A test with a session that expires inside one long transaction + a mutant (section 3) [D]. |
| P3-4 managed assumptions | banned / deleted users, JWT signature / `exp`, `auth.uid()`'s managed definition, the four fixed API role names. | Recorded in section 4; a test pins today's behaviour for a banned / deleted-flagged login [D]. The verdict still checks no entitlement; the locked / owner-change questions stay with the user / G1. |

## 2. P3-1: the consumer contract

### 2.1 The counterexamples (PG17, the test `P3-1 the consumer contract`)

| Anti-pattern (test-only function) | Scenario | Answer [D] |
| --- | --- | --- |
| `receipt_stable_anti` — a **STABLE** consumer | `select pg_sleep(2) \|\| consumer(id)`; the session is deleted during the sleep | returns the receipt (`planned`): the consumer's statements see the calling statement's snapshot |
| `receipt_noguard_anti` — VOLATILE, **no isolation guard** | `begin isolation level repeatable read; select 1; pg_sleep(2); consumer(id)`; deleted during the sleep | returns the receipt: every statement sees the transaction's first snapshot |
| `cancel_precheck_anti` — VOLATILE, READ COMMITTED, **first check only** | the session is deleted between the first check and the `update` (a test-only pause) | cancels: the write was authorized by an earlier statement's snapshot |
| the contract consumer (`receipt` / `cancel`) | each of the three | **refused** — 42501 `POSTONA_RESV_AUTH_REQUIRED` (or 0A000 `POSTONA_RESV_ISOLATION_UNSUPPORTED` under REPEATABLE READ / SERIALIZABLE), the row unchanged |

### 2.2 The contract a consumer of `private.account_lifecycle_session_verdict()` must keep

| # | Rule | Why |
| --- | --- | --- |
| C-1 | The consumer function is **VOLATILE** (never STABLE / IMMUTABLE), owned by the lifecycle owner. | A VOLATILE function takes a new snapshot for each of its statements under READ COMMITTED; a STABLE one reuses its caller's. |
| C-2 | Its first statement refuses any isolation other than **READ COMMITTED**: `if current_setting('transaction_isolation') <> 'read committed' then raise ... using errcode = '0A000'`. | Under REPEATABLE READ / SERIALIZABLE every statement sees the transaction's first snapshot. Fail closed: the Edge answers 503, nothing is read or written. (G3's X adapter already opens `BEGIN ISOLATION LEVEL READ COMMITTED` [C]; the guard keeps that true whoever calls.) |
| C-3 | Then the verdict, **before any reservation row**: `if private.account_lifecycle_session_verdict() is distinct from 'active' then raise 'POSTONA_RESV_AUTH_REQUIRED' using errcode = '42501'`. | A dead session learns nothing and changes nothing (G5-10 lock proof). |
| C-4 | The statement that reads or changes the row **re-authorizes in its own WHERE**: `... and private.account_lifecycle_session_verdict() = 'active'`; when it touches 0 rows, call the verdict again to tell 401 from 404 / 409. | The row and the session are then judged in ONE snapshot: a sign-out committed before that statement is seen [D]. |
| C-5 | Nothing else changes: 404 sameness for another person's row and an unknown id, 503 read-back, sends independent of receipt / cancel. | G3's existing contract (PR #392 / #390) [C]. |

**The residual window that stays:** a sign-out that commits after the write statement took its snapshot is not seen by that statement. Closing it
would need a lock on `auth.sessions` rows, which GoTrue owns — out of scope. Cancelling inside that window only prevents a post; a receipt read inside
it shows the person's own record.

Why not change the verdict instead: making `003` VOLATILE would not fix REPEATABLE READ (the transaction snapshot) and would not authorize the write's
own snapshot; the rule belongs to the consumer, and this TASK does not change SQL.

## 3. P3-2 / P3-3: the added tests and mutants

| Test (`common_account_session_verdict_pg_test.ts`) | Mutant (`common_account_session_verdict_mutations.py`) |
| --- | --- |
| `P3-2 ...`: the install run by the superuser is refused `SESSION_VERDICT_PRECONDITION_OWNER_IS_SUPERUSER`; a VOLATILE `auth.uid()` is refused `..._HELPER_SHAPE auth.uid()`; nothing is left | `a superuser owner is accepted`; `a VOLATILE auth.uid() is accepted` |
| `P3-3 ...`: a session with `not_after` 1.5 s ahead; ONE transaction calls the verdict, sleeps 2.2 s, calls again: `active`, then `SESSION_EXPIRED` | `not_after is compared with the transaction start (now())` |

## 4. P3-4: what the verdict assumes (all NOT_VERIFIED on managed)

| # | Assumption | Today |
| --- | --- | --- |
| A-1 | **banned / deleted users.** The verdict reads `auth.users` only for existence; it ignores `banned_until` / `deleted_at`. A banned or deleted-flagged login whose session row remains is `active` [D: test `P3-4 ...`]. GoTrue's `requireAuthentication` refuses a banned user (`User is banned`) [S] and the X Edge verifier refuses `banned_until` in the future and `deleted_at` [C]; whether GoTrue removes a banned user's sessions is [U]. | Kept as R1 does. Whether a person-facing read / stop must also refuse banned users at the database is a **user / G1 decision**; if yes, it is an extra consumer check (no send follows either action). |
| A-2 | **The JWT's signature and `exp` are verified upstream** (the Edge with GoTrue `/user`, or PostgREST). The verdict trusts `request.jwt.claim.*` / `request.jwt.claims` as delivered. A database login that can set those settings and call a consumer directly could claim anyone. | So a consumer must be EXECUTE-able only by an API role whose claims a verifying layer sets (G3's `postona_resv_api`, set by the Edge after GoTrue answered 200 for the very token, PR #406 `edgeClaimsForDb`) [C]. |
| A-3 | **`auth.uid()`'s definition.** It is an invoker function run with the owner's privileges inside the verdict; whoever can redefine it can make any `sub` "agree". The test world uses Supabase's published shape; the managed definition and its owner are [U]. | The same assumption as R1 / R0 (L-6 class: a privileged maintainer). |
| A-4 | **The API role names are fixed** (`anon`, `authenticated`, `service_role`, `authenticator`) in the postconditions. Another role (e.g. `postona_resv_api`) is caught only by "no non-superuser role may EXECUTE unless it has the owner's privileges": a role that is an INHERIT member of the owner gets EXECUTE by design. | G3's consumer role must never be a member of the lifecycle owner; any such grant is a separately reviewed change. |
| A-5 | **No entitlement / account input** (G5-09 §5, G5-10). | Kept. Receipts and stopping after a service ended: G5 recommends yes; **locked** and the **owner change** (G3 Q1): user / G1 decisions, open. |

Separate gates, unchanged: the time-of-check window of section 2.2, the real Edge's `session_id` hand-off, G3's 007 change and its Sol review, managed
Auth / GoTrue / PostgREST, G4 / F3 begin owner uniqueness, the R1 vs W1 asymmetry, PR #233, the F3 / G3 revoke, G1's draft storage, the old F5 archive
(DEFERRED_BY_USER).

## 5. The notice to G3

One COORDINATION on Issue #318 with the **difference** from the earlier one (6294869449): the consumer contract C-1..C-4 (VOLATILE, READ COMMITTED
guard, the verdict first, the re-authorization inside the read / write statement) and A-1 / A-2 / A-4. The interface itself is unchanged.

## 6. Tests and re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_session_verdict_pg_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 -B supabase/tests/common_account_session_verdict_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_11_consumer_contract_doc_test.ts
```

## 7. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-11` (a clean worktree stacked on PR #408) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed or production system, no credential, no
network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | the PG17 suite `common_account_session_verdict_pg_run.sh` | **13 tests** passed, 0 failed (three consecutive runs; 9 of G5-10 + 4 new) |
| 2 | SQL mutation `common_account_session_verdict_mutations.py` | control PASS, **28/28 detected**, 0 invalid (25 of G5-10 + the 3 of section 3) |
| 3 | regression, PG17: R0, R1, G5-01, G5-02, owner epoch | R0 13, R1 15, G5-01 10, G5-02 5, owner epoch 19 — all passed |
| 4 | regression, pure: G5-01 (13) + G5-02 model (11) + G5-06 bootstrap (9) + G5-09 session model (9) | 42 passed |
| 5 | the whole harness incl. the document tests | **233 passed**, 0 failed (228 of PR #408 + 5 new) |
| 6 | type-check, lint, shell, whitespace; `003_session_verdict.sql` unchanged | `deno check --no-config`: no error; `deno lint --no-config`: `Checked 58 files`, no problem; the mutation script parses; `git diff --check`: clean; `git diff ceb77ce4 -- supabase/candidates`: empty |

Not run, on purpose: any SQL change; any managed access; G3's 007 / Edge; the real Edge propagation.
