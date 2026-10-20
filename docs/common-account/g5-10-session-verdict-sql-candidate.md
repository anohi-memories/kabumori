# G5-10: the session-only verdict — isolated SQL source candidate

Status: **SQL source candidate + local PG17 proofs. Not in `supabase/migrations/`; not applied to any managed or production database; not wired into
G3's 007, any Edge or any app; no grant at all (owner-only).** Production is **NO_GO**. A focused **Codex Sol (high)** security review of the SQL is
required next.

- TASK `common-account-g5-session-only-verdict-isolated-sql-source-candidate-20261021` (Issue #320, G5-01 generation, task 10, completion K5).
- Contract: PR #406 (`1d032e1ee7d91848118abe8d20f847fb78c3250a`), `docs/common-account/g5-09-session-verdict-interface.md` §4-§7 and its reference
  `sessionVerdict()` in `supabase/candidates/common_account_postona_authz/session_verdict.ts` (ACCEPT `PASS_OFFLINE_SESSION_VERDICT_IF_CONTRACT`).
- Stacked on PR #406 -> #399 (G5-08, the every-row-visible rules, H1 C1 `PASS_FOCUSED_SOURCE_REREVIEW`) -> #383 -> #375 -> #371 -> ... -> #303.
- New G5-owned files: `supabase/candidates/common_account_authorization_verdict/003_session_verdict.sql` (+ `003_session_verdict_rollback.sql`),
  `supabase/tests/common_account_session_verdict_{pg_run.sh,pg_test.ts,mutations.py}`, this document and
  `supabase/preflight/managed_disposable/g5_10_session_verdict_sql_doc_test.ts`. Edits to existing G5 files: the G5-09 doc test now allows the 003 candidate to name the function (still never a migration / Edge / app), and a
  status line in the G5-09 document. R0 / R1 / W1 / W2 and the model are unchanged.

Evidence labels: **[D]** derived by a test of this task, **[C]** a candidate in a Draft-PR stack, **[A]** assumption, **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| What exists now | `private.account_lifecycle_session_verdict() returns text`: STABLE, SECURITY DEFINER, `search_path = ''`, `row_security = off`, owned by the lifecycle owner, **EXECUTE for the owner only** (no grant), read-only, no parameter. Answers `active` / `AUTH_REQUIRED` / `SESSION_REVOKED` / `SESSION_EXPIRED`; an unreadable fact raises. |
| Does it answer what the contract says? | **Yes** [D]: for every world of the suite (both claim forms) the real function equals `sessionVerdict()` of PR #406 over the same facts; for P7's five cases it also equals the real R1's own code. |
| P7's five cases | signed out / an unknown session -> `SESSION_REVOKED`; expired -> `SESSION_EXPIRED`; my `sub` with another person's live session -> `SESSION_REVOKED`; anonymous (both forms) -> `AUTH_REQUIRED` [D]. |
| Not an entitlement check | ended, suspended, 退会 started, locked, no common account: still `active` (contract §5), while R1 `read_workspace` refuses each [D]. Whether a lock should hide receipts and the owner-change case stay **user / G1 decisions**. |
| The consumer interface | A TEST-ONLY consumer (not G3's code) that calls it first touches no reservation row unless it answered `active` (lock proof), changes nothing, and fails with SQLSTATE 42501 [D]. |
| Fail closed | an unreadable or RLS-filtered `auth.sessions` raises 42501, never `active`; without the `row_security` guard a hidden row could only read as "no session" (a refusal) [D]. |
| API delta vs PR #406 | **none** (name, no parameter, four codes, raise on unreadable, owner-only). G3's earlier notice (Issue #318 comment 6294869449) is not repeated. |

## 2. What the file does

- **Preconditions** (refuse otherwise): the owner is not a superuser; not already applied; the `private` schema is writable by the owner; `auth.uid()`
  is STABLE; PR #303's exposure check exists (STABLE, definer, empty search path, owner-owned) and is clean; `auth.users` and `auth.sessions` are
  tables (no view) the owner may SELECT whose EVERY row it sees — RLS off, BYPASSRLS, or the table owner's privileges (`pg_has_role(..., 'USAGE')`, an
  inheriting membership) with RLS not FORCED (G5-08's rule; `SESSION_VERDICT_PRECONDITION_RLS_HIDES_ROWS` / `_RLS_FORCED` / `_RELATION`); `auth.sessions`
  has `id uuid`, `user_id uuid`, `not_after timestamptz`.
- **The function**: (1) the subject from the claims only, the same lines as R1 (per-claim settings first, else `request.jwt.claims`; `sub` and
  `session_id` uuids; `role = authenticated`; `is_anonymous` absent / `false`; `sub = auth.uid()`) — no row is read before; (2) ONE statement: the login
  exists, and the `auth.sessions` row by id **and** `user_id` with `not_after` null or after `clock_timestamp()`. No account, entitlement or brand.
- **ACL and postconditions**: `revoke all ... from public, anon, authenticated, service_role`, no grant; the exact `proacl` (`owner=X/owner`); the shape
  (STABLE, definer, `{search_path="", row_security=off}`, no argument, owner); no API role (`anon`, `authenticated`, `service_role`, `authenticator`)
  is a MEMBER of a role that may EXECUTE it; no other non-superuser role may EXECUTE it unless it has the owner's privileges; the exposure check
  still clean. Default privileges that grant EXECUTE to the API roles are revoked by the install; to any other role, the exact-ACL postcondition
  refuses the install [D].
- **Rollback**: drops this function only (R0 / R1 stay) [D].

## 3. Invariants -> proofs (`common_account_session_verdict_pg_test.ts`)

| Invariant | Proof |
| --- | --- |
| S-1 owner-only, no parameter, exact shape | `install`: `proacl`, shape, no EXECUTE for `anon` / `authenticated` / `service_role` / `authenticator` / the test API role; calls refused; a third argument does not exist; a second install refused; rollback and re-install |
| S-2 the reference's answers | `the oracle, active` and `the oracle, refused`: both claim forms, every case equals `sessionVerdict()` |
| S-3 R1's subject rules | anonymous both forms, `is_anonymous` as the string `"false"`, role claims, a missing / malformed session claim, malformed / array / missing claims, a non-uuid `sub`, a disagreeing `auth.uid()`, a deleted login -> `AUTH_REQUIRED` |
| S-4 P7's cases equal R1's own codes | `the oracle, refused`: the real R1 answers the same code for C1-C5 |
| S-5 no entitlement / account input | `the entitlement and the account are not inputs` (R1 `read_workspace` refuses each state) |
| S-6 the consumer touches nothing unless `active` | `the consumer interface`: 42501 `POSTONA_RESV_AUTH_REQUIRED`, rows unchanged, the lock proof, another person's row = an unknown id, a retried cancel, the API role cannot call the verdict |
| S-7 one snapshot, nothing read first, no lifecycle lock | two calls in ONE statement agree across a concurrent sign-out; with `auth.users` / `auth.sessions` locked away, refusals (anonymous, role, no session claim, no claims) answer at once and a good caller waits; the verdict answers while the account / entitlement / brand / operation tables are locked |
| S-8 fail closed | unreadable `auth.sessions` and an RLS-filtered `auth.sessions` raise 42501 (the consumer aborts); without the guard a hidden row gives `SESSION_REVOKED`, never `active` |
| S-9 unsafe installs refused | hidden rows, a SET-only membership, FORCED RLS, a view, a missing `not_after`, an API role reaching the owner, another role's default EXECUTE; the inherited owner and BYPASSRLS layouts install |

## 4. The consumer interface for G3 (G3's 007 / Edge are not changed here)

```sql
-- first statement of a person-facing read / stop (e.g. 007 receipt / cancel), in a function owned by the lifecycle owner:
if private.account_lifecycle_session_verdict() is distinct from 'active' then
  raise exception 'POSTONA_RESV_AUTH_REQUIRED' using errcode = '42501';     -- 401 at the Edge; no reservation row read or written
end if;
```

- The consumer must be owned by the lifecycle owner (the candidate grants nothing); another owner would need a separately reviewed grant.
- Every non-`active` code is one 401 for the person; an exception from the verdict (unreadable) aborts the consumer's transaction (503 at the Edge).
- The Edge must put the verified token's `sub` **and** `session_id` into `request.jwt.claims` (PR #406 `edgeClaimsForDb`); without `session_id` the
  verdict is `AUTH_REQUIRED` for everyone [D: `the consumer interface`, `no session claim`].
- Unchanged: 404 sameness for another person's row and an unknown id, 503 `OUTCOME_UNKNOWN` read-back, sends independent of cancel / receipt.

## 5. Decisions still open (not made here)

- Reading receipts and stopping own pending reservations after a service ended: G5 recommends yes (PR #406 §5); the verdict allows it by design.
- Whether an operator lock should hide receipts, and what happens after a workspace owner change (G3's Q1): **user / G1 decisions**. If decided
  "hide", that is an extra check in G3's consumer, not a change to this verdict.

## 6. NOT_VERIFIED and limits

- Managed [U]: claim delivery, `auth.uid()`, `is_anonymous`, GoTrue's session rows and `not_after`, PostgREST / platform `verify_jwt`, real grants,
  default privileges, the owners of `auth.users` / `auth.sessions` and RLS on them. If a managed layout fails the visibility rule, the install refuses.
- The verdict is advisory to the consumer's transaction: a sign-out committed after its statement cannot stop that call (READ COMMITTED residual
  window, PR #406 §7); stopping inside that window only prevents a post.
- A role that owns the function or the tables can change them (L-6 class).

## 7. Tests and re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_session_verdict_pg_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 -B supabase/tests/common_account_session_verdict_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_10_session_verdict_sql_doc_test.ts
```

The runner creates the owner, a second table owner for the hostile layouts and a test API role (a stand-in for G3's `postona_resv_api`), and drops
them at the end; it refuses a host that is not a `/tmp` socket directory.

## 8. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-10` (a clean worktree stacked on PR #406) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed or production system, no credential, no
network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | the PG17 suite `common_account_session_verdict_pg_run.sh` | **9 tests** passed, 0 failed (three consecutive runs) |
| 2 | SQL mutation `common_account_session_verdict_mutations.py` | control PASS, **25/25 detected**, 0 invalid (the first run's one survivor -- the early `AUTH_REQUIRED` return removed, same answer because a null user is never found but rows read for a refused caller -- led to the "nothing read first" lock proof) |
| 3 | regression, PG17: R0 `common_account_bootstrap_verdict_pg_run.sh`, R1 `common_account_authorization_verdict_pg_run.sh`, `common_account_g5_01_authz_pg_run.sh`, `common_account_g5_02_rpc_preconditions_pg_run.sh`, `common_account_owner_epoch_run.sh` | R0 13, R1 15, G5-01 10, G5-02 5, owner epoch 19 — all passed |
| 4 | regression, pure: G5-01 (13) + G5-02 model (11) + G5-06 bootstrap (9) + G5-09 session model (9) | 42 passed |
| 5 | the whole harness incl. the document tests | **228 passed**, 0 failed (222 of PR #406 + 6 new) |
| 6 | type-check, lint, shell, whitespace | `deno check --no-config`: no error; `deno lint --no-config`: `Checked 57 files`, no problem; `bash -n`, the mutation script parses, `git diff --check`: clean |

Not run, on purpose: any managed access; applying the candidate anywhere but the throw-away database; changing G3's 007 / Edge or any app; the Codex
Sol (high) review (the next step).
