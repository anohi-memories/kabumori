# G5-03: the G5 authorization verdict — isolated SQL source candidate (R1 / W1 / W2)

Status: **SQL source candidate + local PG17 proofs. Not in `supabase/migrations/`; not applied to any managed or production database; not wired into
any Edge function or app; no grant outside the throw-away test database.** Production is **NO_GO**. Review: a focused **Codex Sol (high)** security
review of the SQL is required before anything else, then the G5 担当ちゃ's acceptance and the owner's explicit production approval.

- TASK `common-account-g5-postona-auth-verdict-rpc-sql-source-candidate-20261019` (Issue #320, G5-01 generation, task 3, completion K5).
- Stacked on PR #344 (G5-02 preflight, ACCEPT `PASS_RPC_PREFLIGHT_SOURCE_CONTRACT`) -> PR #340 (G5-01 contract) -> PR #303 (owner epoch).
- New G5-owned files: the candidate and its rollback, `supabase/tests/common_account_authorization_verdict_{pg_run.sh,pg_test.ts,mutations.py}`, this document and
  its doc test. Edits to existing G5-owned files only: the G5-02 model now also refuses a per-claim `is_anonymous` (so the SQL and the model agree), with
  its test, one mutant and the G5-02 document's count; the G5-02 doc test now allows the proposal's SQL in this candidate directory (still never in
  `supabase/migrations/`); and the four older harness mutation scripts copy the new directory (the harness reads it).
- The contract this implements: `docs/common-account/g5-02-authorization-verdict-rpc-preflight.md` §3-§6 (I-1..I-10), the wire of
  `docs/common-account/g5-01-postona-entitlement-auth-boundary.md` §4, and G6's 8-key reader (PR #345, `g5_rpc_transport.ts`).

Evidence labels: **[D]** derived by a test of this task, **[C]** candidate in the F5 / G5 Draft-PR stack, **[A]** assumption, **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| What exists now | `supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql` (+ `001_authorization_verdict_rollback.sql`): **R1** `public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) -> jsonb` (EXECUTE `authenticated` only), **W1** `private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_bound_at timestamptz) -> text` (no API role), **W2** `public.common_account_worker_brand_verdict(...)` (EXECUTE `service_role` only). All STABLE, SECURITY DEFINER, `search_path = ''`, owned by the lifecycle owner, read-only. |
| Does the SQL answer what the reference answers? | **Yes, byte for byte** [D]: for every world of the suite the real R1 (called as `authenticated` with the per-claim settings AND with `request.jwt.claims`) equals G5-01's `decide()` over the same facts; W2 equals G5-02's `workerBrandVerdict()`. |
| The invariants | I-1..I-10 each have a test (section 3). |
| Is it safe to install anywhere? | Only where the install's preconditions hold, and only after the Sol review. The install refuses (and leaves nothing) on an unsafe role graph, forced RLS, a non-STABLE helper or PR #303's exposure finding; on the real model world it needs the F3 / G3 revoke of TRIGGER / TRUNCATE / REFERENCES on `public.brand_memberships` first (PR #303 L-1). |

## 2. What the file does

- **Preconditions** (refuse otherwise): the owner is not a superuser; not already applied; the helpers `private.account_lifecycle_brand_owner(text)`,
  `private.account_lifecycle_brand_owner_epoch(text)`, `private.account_lifecycle_owner_epoch_exposure()`, `public.common_account_brand_service_state(text,text)`
  exist, are STABLE, definer, empty `search_path`, owned by this owner; `auth.uid()` exists and is STABLE; every relation read
  (`public.common_accounts`, `public.service_entitlements`, `public.brands`, `public.brand_memberships`, `private.account_lifecycle_operations`, `auth.users`,
  `auth.sessions`) is readable by this owner and has no FORCED RLS; `auth.sessions` has `id uuid`, `user_id uuid`, `not_after timestamptz`; PR #303's
  exposure check is clean (no API role reaches the owner, a superuser, TRIGGER, `SET session_replication_role`, or a membership write / TRUNCATE / REFERENCES).
- **R1** — in this order: (1) the subject from the claims only — the per-claim settings of an older PostgREST win, else `request.jwt.claims`; `sub` and
  `session_id` uuids, `role = authenticated`, `is_anonymous` absent / null / false (a per-claim text `false`), `sub` equal to `auth.uid()`; (2) the question —
  app `postona`, a listed feature, a brand id `^[a-z][a-z0-9_-]{0,63}$` — and only then (3) ONE `select` of every fact, then (4) the decision of G5-01 §4.
  Steps 1-2 read no row [D: with the facts table locked, refusals return at once]. The answer is the 8-key wire without times; the session reference is
  `s:` + 32 hex of `sha256('g5-session:' || session_id)`; the owner-epoch token is `g5oe:<epoch>:<lifecycle_version>`; `entitlements` is
  `["postona:x_autopost"]` on allow, `[]` otherwise. No exception handler except around the claims JSON cast (a malformed claim is `AUTH_REQUIRED`).
- **W1** — `x_autopost` only; expected owner epoch >= 1 and expected `lifecycle_version` >= 1 (the pair from R1's allow token); then ONE `select` of
  P5's state, the owner epoch and the owner's `lifecycle_version`; both must be EQUAL; answer `active` or a fixed code (G5-02 §4). No timestamp is taken
  or compared (section 10). **W2** — W1 for `service_role`.
- **ACL** — `revoke all ... from public, anon, authenticated, service_role`, then R1 to `authenticated`, W2 to `service_role`. **Postconditions**: the exact
  `proacl` strings, STABLE / definer / empty `search_path` / owner; no API role other than the allowed one is a MEMBER (direct or indirect, INHERIT or not,
  SET or not, ADMIN-only) of a role holding EXECUTE; `authenticator` may reach only the API roles; the exposure check still clean.
- **GC** (G5-05) — `private.account_lifecycle_generation_covered()`, owner-only: the P1 lifecycle triggers are exactly P1's (section 11).
- **Rollback** — drops the four functions (no data, nothing else).

## 3. Invariants -> tests (`common_account_authorization_verdict_pg_test.ts`)

| Invariant | Proof |
| --- | --- |
| I-1 subject only from the JWT | `the subject is the JWT only` (anonymous both forms, role claims, session missing / malformed, malformed claims, `auth.uid()` disagreeing, per-claim precedence) and `install` (a 4th argument does not exist) |
| I-2 nothing read before the question and the caller | `nothing is read before ...` (ACCESS EXCLUSIVE lock on `service_entitlements`: refusals answer, a good question waits) |
| I-3 anti-enumeration | `no leak` (unknown vs foreign brand identical; a two-owner brand of others; no owner id, no raw session id) and the oracle rows `foreign` / `unknown brand` |
| I-4 one snapshot | `one snapshot through the RPC` (two calls in one statement across a concurrent owner change) |
| I-5 STABLE helpers only | install precondition (a VOLATILE helper is refused, `the install refuses ...`) |
| I-6 ACL | `install` (exact `proacl`, anon / service_role / authenticated denied where they must be) and `the install refuses ...` (anon in authenticated, authenticated in service_role, hostile default privileges) |
| I-7 no exception swallowed | no handler in R1 / W1 except the claims cast (source); refused install leaves nothing |
| I-8 missing = unknown / deny | the oracle rows: no account, two owners, coverage broken, unknown states |
| I-9 exact shape | every oracle comparison asserts exactly the 8 keys |
| I-10 the token | `the oracle, allowed` (`g5oe:<epoch>:<lifecycle_version>`) and the A -> B -> A / restart token changes |

## 4. Test-world adjustments (allowed by the TASK; none is a managed fact)

- **[A] `auth.uid()`**: the model fixture reads only the per-claim setting; the runner replaces it with the definition Supabase publishes (the per-claim
  setting, else `request.jwt.claims ->> 'sub'`) so the JSON path is exercised. The managed definition is **NOT_VERIFIED** here.
- **PR #303 dependency stand-in**: the runner revokes TRIGGER (anon, authenticated, service_role) and TRUNCATE / REFERENCES (anon, authenticated) on
  `public.brand_memberships`, as `common_account_owner_epoch_run.sh` does; in the real world that is F3 / G3's change.
- **PostgREST status codes [A / U]**: a caller whose JWT PostgREST refuses never reaches the function (401); a role without EXECUTE gets `42501`, which
  PostgREST maps to 401 for `anon` and 403 otherwise. G6's transport (PR #345) treats 401 / 403 as deny and everything else non-200 as unreachable; the
  function itself never returns a non-wire 200.

## 5. Order of introduction and the other owners (no file of theirs is edited)

1. F3 / G3: the `brand_memberships` revoke (PR #303 L-1). 2. The ten F5 chain files (P1..P10), PR #303's candidate, then this file — each as one reviewed
   file, after the Sol review of each, never `db push`. 3. Consumers in their own TASKs:
   - **G6 / F6**: R1 through `g5_rpc_transport.ts` (PR #345) — same JWT for the recheck, 8 keys, 401 / 403 = deny.
   - **G4 / F4**: R1 `x_connect` / `threads_connect` at begin and right before the code exchange; W1 inside the binding / credential statement with
     `x_autopost` (notice: Issue #319 comment 6267736897).
   - **G3 / F3**: W1 inside `check_x_account_publish_authority`, the enabled setter, the claim planner and the Threads store preflight; W2 right before the
     provider (the `x-test-post` caller-authentication notice is Issue #318 comment 6267545726, not repeated).
   - **G1 / F1**: R1 only for UI hints; the server decides.

## 6. NOT_VERIFIED and limits

- Managed: claim names, `auth.uid()`, `is_anonymous` delivery, PostgREST error mapping, GoTrue session row lifecycle, real grants and default privileges.
- The verdict is advisory (no lock); W1 trusts the binding the consumer records (from an R1 allow token). An unrelated change of the owner's account
  (e.g. Kabumori started) refuses earlier reservations (fail closed). The generation relies on F5 P1's lifecycle triggers; disabling them needs the table
  owner or a superuser (the install checks they are enabled; a later disable is the owner-level L-6 class of PR #303).
- The postconditions run at install; a later grant or role edge made by the owner or a superuser is not re-checked at call time (the owner-epoch
  coverage, which R1 consults on every call, does catch the PR #303 exposure conditions).
- Admin / member roles, organisation workspaces and Miseiro stay refused.

## 7. Tests (offline; exact results in section 9)

- **PG17 suite** `common_account_authorization_verdict_pg_run.sh` -> `common_account_authorization_verdict_pg_test.ts`: install / ACL / rollback; the oracle
  (allowed: every feature; refused: no account, Kabumori only, ended, suspended, provisioning, service-end freeze, 退会, locked, signed out, expired, two
  owners, another workspace kind, foreign / unknown brand, admin, coverage broken, bad questions); the subject; nothing read first; no leak; one snapshot
  and ABA tokens; the worker forms against the reference; unsafe installs refused.
- **Mutation check** `common_account_authorization_verdict_mutations.py`: each rule of the SQL broken in a copy; the suite must fail.
- **G6 cross-check** (scratch, not committed): G6's PR #345 transport + port parsing the real RPC's answers.
- **Document test** `supabase/preflight/managed_disposable/g5_03_sql_candidate_doc_test.ts`.

## 8. Re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_authorization_verdict_pg_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_authorization_verdict_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_03_sql_candidate_doc_test.ts
```

## 9. What was executed for this document

Re-run by G5-05 (section 11) in `/Users/yuya/Developer/kabumori-g5-05` (a clean worktree stacked on PR #358); before that by G5-04 in `/Users/yuya/Developer/kabumori-g5-04` (stacked on PR #351); first run by G5-03 in `/Users/yuya/Developer/kabumori-g5-03` (stacked on PR #344) against a throw-away local PostgreSQL 17.11 (`listen_addresses`
empty, a Unix socket under `/private/tmp`, fake data, deleted at the end; every runner refuses a host that is not a `/tmp` socket directory). The candidate
was installed only there. No managed or production system, no credential, no network request.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the PG17 suite (install, ACL, oracle, subject, nothing read first, no leak, one snapshot, worker forms, unsafe installs) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_authorization_verdict_pg_run.sh` | **15 tests** passed, 0 failed (three consecutive runs; 10 at PR #351, 13 at PR #358) |
| 2 | mutation check of the SQL | `python3 supabase/tests/common_account_authorization_verdict_mutations.py <repository root>` | control PASS, **51/51 detected**, 0 invalid (36 at PR #351, 39 at PR #358; G5-05 added the generation-coverage mutants; the transition-table condition has no mutant -- see section 11) |
| 3 | G6 cross-check (scratch, not committed) | G6's `g5_rpc_transport.ts` + `authority_port.ts` from PR #345 (`529153f4ceab2a37a49fed82edd23102fe8d4293`) reading answers captured from the real R1 | 1 scratch test passed: allow accepted; foreign brand, suspended, revoked session refused at the recheck; the same answer keeps the generation |
| 4 | regression of the stack | G5-01 pure (13) + G5-02 model (11); G5-01 PG17 (10); G5-02 PG17 (5); owner-epoch suite (19) | all passed |
| 5 | the G5-02 model (per-claim `is_anonymous`; the generation pair) | `python3 supabase/tests/common_account_g5_02_rpc_preflight_mutations.py <repository root>` | control PASS, 37/37 detected |
| 6 | the whole harness incl. the document tests | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **200 passed**, 0 failed (194 of PR #344 + 6 new) |
| 7 | type-check, lint, shell | `deno check --no-config` (models, the new suite, the harness); `deno lint --no-config`; `bash -n` on the runner | no error; `Checked 51 files`; syntax OK |

Not run, on purpose: any managed access; applying the candidate anywhere but the throw-away database; wiring a consumer; the Codex Sol (high) review
(the next step).

## 10. G5-04: the H1 C1 P2 fix — the worker generation is a counter, not a clock

TASK `common-account-g5-pr351-worker-reactivation-aba-p2-source-fix-20261020` (Issue #320, task 4). Review: H1 #306 (C1, `CHANGES_REQUIRED / P2×1`) on
PR #351 head `59d3dff0ad23a492e9e397d8c6c5f379d0f120a9`.

- **Finding (confirmed).** W1 / W2 compared the entitlement's `activated_at` with a bind time. The re-activation RPC writes `activated_at = now()`, the
  START of its transaction, so a transaction that began before the bind and ended / re-started the service after it (or a bind -> end -> restart inside
  one transaction) left `activated_at <= bind time` and an old reservation was answered `active`. Reproduced on PG17 against the PR #351 SQL with the real
  `reactivate_x_autopost_service`: `active`.
- **Fix.** W1 / W2 take `p_expected_lifecycle_version bigint` instead of `p_bound_at timestamptz` and require, in ONE statement, the owner epoch AND the
  owner's `lifecycle_version` to EQUAL the bound pair (`SERVICE_GENERATION_CHANGED` otherwise; `EXPECTED_LIFECYCLE_VERSION_REQUIRED` for a missing / < 1
  value). `lifecycle_version` moves on every insert / update / delete of the owner's entitlements (row trigger, so an end and a restart inside one
  transaction move it twice) and on every account status change, and can never decrease (F5 P1). No timestamp is accepted or compared. The install
  now also refuses unless both P1 lifecycle triggers are present, enabled and bound to their functions (`AUTH_VERDICT_PRECONDITION_LIFECYCLE_TRIGGERS`).
  R1 is unchanged: its allow token `g5oe:<epoch>:<lifecycle_version>` already carries the same pair.
- **Binding wire for consumers (G3 reservations, G4 credential / binding).** Store both numbers from R1's ALLOW token at creation, as `bigint` (G4 already
  parses them as strings without JS numbers); pass them unchanged to W1 / W2. The reference helper `bindingFromAllow()` accepts only an allow with a
  well-formed token. Never re-read the counters at dispatch time to "refresh" a binding.
- **Trade-off (fail closed).** Any change of the owner's account — starting or ending Kabumori, a status change — also moves the generation, so a
  reservation made before it is refused and needs a fresh confirmation. A per-service generation would avoid that but needs a new trigger / table on a
  G5 table (a separate TASK if wanted).
- **Proofs added** (`common_account_authorization_verdict_pg_test.ts`): the review's exact case with a real long transaction (transaction start < bind <
  real restart; asserts `activated_at` is earlier than the bind, then `SERVICE_GENERATION_CHANGED`); bind -> end -> restart inside ONE transaction
  (`activated_at <= bind instant`, refused in that transaction); an old reservation bound from a real R1 allow token sends 0 after a real end and restart
  while an unchanged world sends once; owner A -> B -> A; an unrelated Kabumori start; a binding from the future; generation 0 / null; no timestamp
  parameter exists; a disabled lifecycle trigger refuses the install. The worker answer still equals the reference in every case.
- **Not in this fix.** G4's question (Issue #320 comment 6279536652): R1 needs `p_brand_id`, but the first X connection creates the workspace in its begin
  RPC, so there is no brand to name yet. Recommendation for a G5 decision in a later TASK: a brand-less person verdict for the connect features only
  (account, entitlement, deletion, freeze, session; no owner epoch), with the brand verdict required again at the callback once the workspace exists.

## 11. G5-05: the H1 C1 P2 fix on PR #358 — the generation triggers must be exactly F5 P1's

TASK `common-account-g5-pr358-lifecycle-trigger-authenticity-p2-source-fix-20261020` (Issue #320, task 5). Review: H1 #306 (C1, `CHANGES_REQUIRED /
P2×1`) on PR #358 head `4f4ece89af51a345c0e71cb3876278789a4f3896`.

- **Finding (confirmed).** The install checked the two P1 lifecycle triggers by name, enabled flag, function OID (and `tgtype` for one of them) only.
  A same-named trigger `... FOR EACH ROW WHEN (false) EXECUTE FUNCTION private.account_lifecycle_touch_entitlement()` passed. Reproduced on PG17
  against the PR #358 SQL: the install succeeded, the real end + `reactivate_x_autopost_service` left `lifecycle_version` unchanged, and W2 answered
  **`active`** for the old reservation.
- **Fix.** New owner-only STABLE definer `private.account_lifecycle_generation_covered()`: this session honours triggers; exactly two triggers count —
  `account_lifecycle_touch_entitlement` on `public.service_entitlements` with `tgtype = 29` (AFTER INSERT OR UPDATE OR DELETE, ROW) bound to
  `private.account_lifecycle_touch_entitlement()`, and `account_lifecycle_touch_account` on `public.common_accounts` with `tgtype = 19` (BEFORE UPDATE,
  ROW) bound to `private.account_lifecycle_touch_account()` — each enabled (`O` / `A`), not internal, `tgqual` NULL, no column list, `tgconstraint = 0`,
  not deferrable / initially deferred, no arguments, no transition tables, its function owned by the table's owner, definer, empty `search_path`; no
  other BEFORE UPDATE ROW trigger on `public.common_accounts` (one firing after P1's could put `lifecycle_version` back; any enabled state but `D`
  counts); no rule on either table. Used by the install precondition (`AUTH_VERDICT_PRECONDITION_LIFECYCLE_TRIGGERS`), the postcondition and **W1 on
  every call** (`SERVICE_GENERATION_UNAVAILABLE`, checked after the owner epoch's own coverage). R1 is unchanged.
- **Proofs added** (`common_account_authorization_verdict_pg_test.ts`, real PG17 fixtures): 20 drifts — WHEN (false), UPDATE OF, wrong timing, wrong
  events, statement level, deferred constraint trigger, non-deferrable constraint trigger (same `tgtype` 29), transition table, arguments, disabled,
  replica-only, another function, missing (entitlement side); WHEN (false), UPDATE OF, wrong timing, missing (account side); a reverting BEFORE UPDATE trigger; a rule on each table — each refuses the
  install and leaves nothing; the exact P1 triggers install. After the install each drift makes W1 / W2 answer `SERVICE_GENERATION_UNAVAILABLE` and the
  exact triggers restore `active`; the review's WHEN (false) attack end to end (bind, real end, real restart, counter unchanged) sends 0. The earlier
  P2 proofs (long transaction, same transaction, old reservation sends 0, owner A -> B -> A) still pass.
- **Transition tables.** PostgreSQL itself refuses a transition table on a trigger with more than one event and on a BEFORE trigger, so no trigger with
  `tgtype` 29 or 19 can carry one; the condition stays as defence, and its mutant is recorded as equivalent in the mutation script rather than run.
- **Limit (unchanged L-6 class).** A table owner or superuser can still change the function bodies or write with `session_replication_role = replica`;
  the coverage check sees catalog shape, not behaviour of a privileged writer. R1's token does not consult this coverage (W1 does).
