# G5-07: the bootstrap verdict R0 — isolated SQL source candidate

Status: **SQL source candidate + local PG17 proofs. Not in `supabase/migrations/`; not applied to any managed or production database; not wired into
G4's Edge or any app; no grant outside the throw-away test database; no workspace or OAuth state is ever written by it.** Production is **NO_GO**.
A focused **Codex Sol (high)** security review of the SQL is required next.

- TASK `common-account-g5-brandless-oauth-r0-verdict-sql-source-candidate-20261020` (Issue #320, G5-01 generation, task 7, completion K5).
- Stacked on PR #375 (`c47cbed48ab410a34c6827a5d44fba2f4e928e1f`, the R0 contract `docs/common-account/g5-06-brandless-oauth-bootstrap.md` §4 and the
  reference `bootstrap.ts`) -> PR #371 (R1 / W1 / W2, H1 C1 source PASS) -> PR #358 -> PR #351 -> PR #303.
- New G5-owned paths: `supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql` (+ `002_bootstrap_verdict_rollback.sql`),
  `supabase/tests/common_account_bootstrap_verdict_{pg_run.sh,pg_test.ts,mutations.py}`, this document and
  `supabase/preflight/managed_disposable/g5_07_bootstrap_sql_doc_test.ts`. One edit to an existing G5 file: the G5-06 doc test now allows the
  proposal's SQL in these candidate files (still never in `supabase/migrations/`). R1 / W1 / W2 (001) are unchanged.

Evidence labels: **[D]** derived by a test of this task, **[M]** `origin/main` `0c42933c`, **[A]** assumption, **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| What exists now | **R0** `public.common_account_bootstrap_verdict(p_app text, p_feature text) -> jsonb`: STABLE, SECURITY DEFINER, `search_path = ''`, owned by the lifecycle owner, **EXECUTE to `authenticated` only**, read-only. Two parameters; no brand, no person. |
| Does the SQL answer what the contract says? | **Yes, byte for byte** [D]: for every world of the suite the real R0 (called as `authenticated` with the per-claim settings AND with `request.jwt.claims`) equals `bootstrapVerdict()` of PR #375 over the same facts. |
| Is it bootstrap-only? | Yes [D]: the answer has `scope.brand_slug = null` and `owner_epoch = null` always; the real R1 refuses the bootstrap features (`FEATURE_NOT_ENABLED`); no consumer accepts an R0 allow for another scope; the worker form has nothing to compare it with (`EXPECTED_OWNER_EPOCH_REQUIRED`). |
| Does it write? | No [D]: it runs inside a READ ONLY transaction; an allow creates no workspace. |
| The begin gap | Reproduced on the real main begin RPC [D]: with a workspace under the derived id owned by someone else, main's begin makes the caller a **second owner**. R0 refuses that case before any begin (`OWN_WORKSPACE_CONFLICT`), and R1 then answers `unknown` — but the fix belongs in the begin SQL (G4 / F3, §4). |

## 2. What the file does

- **Preconditions** (refuse otherwise): the owner is not a superuser; not already applied; `private.account_lifecycle_owner_epoch_exposure()`
  exists, STABLE, definer, empty `search_path`, owned by this owner; `auth.uid()` STABLE; every relation read (`public.common_accounts`,
  `public.service_entitlements`, `public.brands`, `public.brand_memberships`, `private.account_lifecycle_operations`, `auth.users`, `auth.sessions`)
  readable by this owner with no FORCED RLS; `auth.sessions` has the expected columns; `public.social_mobile_account_deletion_workspace(uuid)` exists and
  derives exactly `'u_' || substr(md5(user), 1, 24)` (the rule main's begin inlines at `20260922003101:39` [M]); PR #303's exposure check is clean.
- **R0, in this order:** (1) the question — app `postona`, feature `x_connect_bootstrap` or `threads_connect_bootstrap` — before anything else;
  (2) the subject from the claims only, exactly as R1 (per-claim settings first, else `request.jwt.claims`; `sub` and `session_id` uuids,
  `role = authenticated`, not anonymous, `sub = auth.uid()`) — no row is read before (1) and (2) pass [D: lock proof]; (3) the own workspace id derived
  on the server from the verified subject (inline, the same expression the begin RPC uses); (4) ONE `select` of every fact; (5) R1's person checks in
  R1's order, then the own-workspace rule (absent -> allow; another kind -> `OWN_WORKSPACE_CONFLICT`; not exactly one owner -> `unknown
  WORKSPACE_OWNER_UNKNOWN`; owned by someone else or the caller not `owner` -> `OWN_WORKSPACE_CONFLICT`). No exception handler except around the claims
  JSON cast.
- **Answer:** the G5-01 8-key wire without times; `scope = {app, feature, brand_slug: null}`; `owner_epoch` null; allow: `session = {active, s:<hash>}`,
  `entitlements = ["postona:x_autopost"]`. The Edge stamps the times (allow 60 s, refusal born expired), as for R1.
- **ACL and postconditions:** `revoke all ... from public, anon, authenticated, service_role`; `grant execute ... to authenticated`; the exact `proacl`;
  STABLE / definer / empty `search_path` / owner; neither `anon` nor `service_role` is a MEMBER of a role holding EXECUTE (any membership edge);
  `authenticator` reaches only the API roles; the exposure check still clean.
- **Rollback:** drops R0 only (R1 / W1 / W2 stay).

## 3. Invariants -> proofs (`common_account_bootstrap_verdict_pg_test.ts`)

| Invariant | Proof |
| --- | --- |
| B-1 bootstrap features only, the question first | the oracle rows for `kabumori` / `miseiro`, R1's features, a newline-suffixed name, `__proto__`, a NULL feature |
| B-2 subject only from the JWT | `the subject is the JWT only` (anonymous both forms, role claims, missing / malformed session, malformed claims, a disagreeing `auth.uid()`); `install` (a third argument does not exist) |
| B-3 nothing read before B-1 / B-2 | the lock proof (refusals answer, a good question waits) |
| B-4 server-derived workspace, never joined | the oracle rows: pre-claimed, the caller as admin, two owners, another kind, an ownerless workspace; the install refuses another derivation |
| B-5 one snapshot | two R0 calls in ONE statement agree across a concurrent end of the service |
| B-6 bootstrap-only | `an R0 allow opens nothing else` (the real R1, consumer scope checks, the worker form) |
| B-7 read-only | a READ ONLY transaction; the brand count unchanged after an allow |
| B-8 ACL / role graph | `install`; `the install refuses ...` (TRIGGER exposure, forced RLS, anon in authenticated, hostile default privileges) |
| B-9 the flow | `the first connection` with main's real begin RPC + the real R1 + `guardIrreversible` + a counting exchange: one exchange; 退会 / service end / sign-out at the callback or before the exchange: zero |

## 4. Interface for G4 and the open items of other owners (no file of theirs is edited)

- **G4** (`XConnectAuthorizationPort`): phase `begin` -> `POST /rest/v1/rpc/common_account_bootstrap_verdict` with `{p_app: 'postona', p_feature:
  'x_connect_bootstrap' | 'threads_connect_bootstrap'}` and the caller's JWT; the 200 body is the 8 keys without times; 401 / 403 = deny, anything else
  non-200 = unreachable (G6's transport rules, PR #345). Phase `pre_exchange` stays the brand R1 + `guardIrreversible`. The API delta against the PR #375
  contract: none — the contract is now SQL. The earlier notice (Issue #319 comment 6287813812) is not repeated.
- **G4 / F3 begin and complete SQL** (unchanged here): P3b guard first; derive the id on the server; create idempotently; then owners == {caller} and
  the caller's role `owner`, else raise (the gap reproduced in §1); P3b in complete; optional state columns for the owner epoch / lifecycle_version.
- **Unchanged separate gates:** the R1 vs W1 / W2 coverage asymmetry and the privileged-maintenance history gap (G5-06 §5; L-6 class); PR #233; the
  F3 / G3 revoke of TRIGGER / TRUNCATE / REFERENCES on `public.brand_memberships`; managed Auth / ACL; G1's draft storage (a separate G5 Auth /
  Storage TASK candidate, not touched).

## 5. NOT_VERIFIED and limits

- Managed: claim names, `auth.uid()`, `is_anonymous` delivery, PostgREST error mapping, GoTrue session rows, real grants and default privileges.
- R0 is advisory (no lock): between R0 and the begin transaction a state can change; the begin's P3b guard (under locks) is what binds, and the
  callback's R1 + recheck guard the exchange.
- The derivation check samples one fixed uuid; a deliberately inconsistent function body would need the table owner (L-6 class).
- The brand-id refusal `BRAND_NOT_EXPECTED` of the reference has no SQL counterpart: R0 has no brand parameter, so a brand cannot be passed at all.

## 6. Tests (offline; exact results in section 8)

- **PG17 suite** `common_account_bootstrap_verdict_pg_run.sh` -> `common_account_bootstrap_verdict_pg_test.ts` (§3).
- **Mutation check** `common_account_bootstrap_verdict_mutations.py`: each rule of `002_bootstrap_verdict.sql` broken in a copy; the suite must fail.
- **Document test** `supabase/preflight/managed_disposable/g5_07_bootstrap_sql_doc_test.ts`.

## 7. Re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_bootstrap_verdict_pg_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_bootstrap_verdict_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_07_bootstrap_sql_doc_test.ts
```

## 8. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-07` (a clean worktree stacked on PR #375) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end; every runner refuses a host that is not a `/tmp` socket
directory). The candidate was installed only there. No managed or production system, no credential, no network request, no real OAuth.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the R0 PG17 suite (install, ACL, oracle, subject, nothing read first, one snapshot, bootstrap-only, the first connection with main's real begin + the real R1, unsafe installs) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_bootstrap_verdict_pg_run.sh` | **11 tests** passed, 0 failed (three consecutive runs) |
| 2 | mutation check of the SQL | `python3 supabase/tests/common_account_bootstrap_verdict_mutations.py <repository root>` | control PASS, **30/30 detected**, 0 invalid (the first run's one survivor -- the caller's role read from any member -- led to the "own workspace with a viewer and an admin" case) |
| 3 | regression, pure | G5-01 (13) + G5-02 model (11) + G5-06 bootstrap (9) | 33 passed |
| 4 | regression, PG17 | `common_account_authorization_verdict_pg_run.sh` (15), `common_account_g5_01_authz_pg_run.sh` (10), `common_account_g5_02_rpc_preconditions_pg_run.sh` (5), `common_account_owner_epoch_run.sh` (19) | all passed |
| 5 | the whole harness incl. the document tests | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **211 passed**, 0 failed (205 of PR #375 + 6 new) |
| 6 | type-check, lint, shell | `deno check --no-config` (the models, the suite, the harness); `deno lint --no-config`; `bash -n` on the runner | no error; `Checked 53 files`; syntax OK |

Not run, on purpose: any managed access; applying the candidate anywhere but the throw-away database; changing G4's Edge or the begin / complete SQL;
the Codex Sol (high) review (the next step).
