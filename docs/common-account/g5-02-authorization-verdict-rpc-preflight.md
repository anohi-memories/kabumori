# G5-02: the G5 authorization verdict RPC — security contract before any implementation (preflight, source-only)

Status: **design + models + offline proofs. No SQL function, view, grant or migration was created or applied anywhere; nothing is wired; no managed or
production system, credential, OAuth, real SNS or paid API was touched.** Production is **NO_GO**.

- TASK `common-account-g5-postona-authorization-verdict-rpc-preflight-20261019` (Issue #320, G5-01 generation, task 2, completion K5).
- Stacked on PR #340 (G5-01 contract, ACCEPT `PASS_OFFLINE_CONTRACT`), which is on PR #303 (owner-epoch fix, H1/C1 source PASS). Reuses G5-01's wire,
  `decide()` and `guardIrreversible()`; does not repeat G5-01's decision-matrix tests.
- New G5-owned paths only: this document, `supabase/candidates/common_account_postona_authz/rpc_preflight.ts` (model), the tests
  `supabase/tests/common_account_g5_02_rpc_preflight_{test.ts,mutations.py}`, `supabase/tests/common_account_g5_02_rpc_preconditions_pg_{run.sh,test.ts}`,
  `supabase/preflight/managed_disposable/g5_02_contract_doc_test.ts`.

Evidence labels: **[M]** `origin/main` `9802f590`, **[C]** F5 Draft-PR stack, **[D]** derived by a test of this task, **[A]** assumption, **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Can the RPC be built on what exists? | **Yes, as a read-only STABLE definer function of the lifecycle owner** [D]: every relation it needs is readable by that owner with no RLS forced; every helper it needs (`account_lifecycle_brand_owner`, the owner epoch getter and its coverage / exposure checks, `account_lifecycle_service_state_readonly`, P5's `common_account_brand_service_state`) is STABLE, definer, empty `search_path` (the private ones owner-only; P5's public one `service_role` only). The locking Phase 4 decision is VOLATILE and must not be used. |
| Why one RPC and not the person's own reads? | [D] RLS shows a person only their own rows; the owner, the other members, the owner epoch and `auth.sessions` are not theirs to read. A client-side or Edge-side assembly from several reads cannot be correct (section 3.6). |
| Why "one snapshot"? | [D] With a real concurrent owner change, two reads of the owner epoch in ONE statement agree, and two statements in one transaction do not. A model of a two-read implementation **allows the former owner** under the new owner's epoch. STABLE helpers inside one call share the calling statement's snapshot. |
| Who may call it? | R1 (the person's verdict): `authenticated` only, the subject from the JWT claims. W1 (in-SQL worker form): no API role. W2 (Edge worker form): `service_role` only. A person can never call a worker form [D: ACL model]. |
| The Threads posting service key (PR #337's `THREADS_POSTING_SERVICE_KEY`, "G5 decides") | **`x_autopost`** — POSTONA is one service for X and Threads; `service_entitlements.service_key` allows only `kabumori` and `x_autopost` [M]. Decided in this contract, not wired. |
| Ready to implement? | The next TASK can be issued with the acceptance criteria of section 6. It needs a Codex Sol (high) review of the SQL before any apply, and the PR #303 dependency (F3 / G3 revoke). |

## 2. Where each fact comes from, and who owns it

| Fact | Source | State | Owner |
| --- | --- | --- | --- |
| the person, role, session id | JWT claims (`request.jwt.claim.*` of an older PostgREST, else `request.jwt.claims`), `auth.uid()` — the same sources F5 P3b reads (`20261010051938`) | exists [M/C]; not read by any POSTONA server path | GoTrue / PostgREST (managed) [U] |
| the session is live | `auth.sessions` (`id`, `user_id`, `not_after`) | readable by the lifecycle owner [D]; no per-request check anywhere today | GoTrue writes it |
| common account, entitlement, lifecycle_version, activated_at | `public.common_accounts`, `public.service_entitlements`, `private.account_lifecycle_operations` | exists in main (P1) [M]; RLS own-row read only | G5 |
| the brand, the caller's role, the single owner | `public.brands`, `public.brand_memberships`, P5 `account_lifecycle_brand_owner` | tables in main [M]; P5 candidate [C] | membership writers: F3 / G3, G4, F4 |
| the owner epoch | `private.account_lifecycle_brand_owner_epoch` (PR #303) | candidate, not applied [C]; needs the F3 / G3 revoke first | G5 (object), F3 / G3 (the table's grants) |
| the feature list | `POSTONA_FEATURES` (G5-01 reference) | candidate [C] | G5 for the auth part; G6 for the AI plan rule |
| missing / unreadable | — | every missing fact is `unknown` (deny-by-default) | — |

## 3. R1 — the person's verdict RPC (permission contract)

`public.common_account_authorization_verdict(p_app text, p_feature text, p_brand_id text) returns jsonb`

1. **ACL.** `language plpgsql stable security definer set search_path = ''`, owned by the lifecycle owner. `revoke all ... from public, anon, authenticated,
   service_role; grant execute ... to authenticated`. Postcondition over the role graph (PR #303's rule): exactly `owner=X/owner` and `authenticated=X/owner`;
   no API role but `authenticated` reaches EXECUTE through any membership (INHERIT or not, SET or not, ADMIN-only); no API role reaches the owner or a
   superuser. `authenticator` reaching `authenticated` is PostgREST's role switch, not a violation (model `aclViolation`).
2. **No identity parameter.** There is no `p_user_id`. The function signature is the whole interface.
3. **The subject.** From the claims only (P3b's precedence: the per-claim settings, else the JSON claims): `sub` a uuid equal to `auth.uid()`, `role =
   authenticated`, `session_id` a uuid, `is_anonymous` not true. Otherwise `deny AUTH_REQUIRED` and nothing is read.
4. **Refused before any read.** `p_app <> 'postona'`, a feature not in the list (own keys only: `__proto__`, `toString` are not features), a brand id not
   matching `^[a-z][a-z0-9_-]{0,63}$` (length bound included).
5. **Anti-enumeration.** An unknown brand and a brand the caller is not a member of give the same answer (`BRAND_ACCESS_DENIED`), byte for byte. The answer
   never carries another person's id or role, the owner id, or a member count.
6. **One snapshot.** One `select` (or only STABLE helpers inside the STABLE function), so the owner, the owner epoch, the account and the entitlement come from
   the same snapshot. Never the VOLATILE locking decision (`account_lifecycle_service_state_refusal`), never a second statement after a wait.
7. **Rows read.** As the lifecycle owner (table owner: RLS does not apply to it; RLS is not FORCED [D]): the caller's `auth.users` row, the caller's
   `auth.sessions` row, the caller's account, entitlements and open operations, the brand row, the caller's membership row, the owner (P5) and the owner
   epoch. No other person's row is returned.
8. **Answer and errors.** The G5-01 wire **without** `issued_at_ms` / `expires_at_ms` (keys `decision, entitlements, owner_epoch, reason, scope, session,
   subject, v`). The Edge stamps the times with its own clock: an `allow` lives 60 s, a refusal is born expired. A database error is **not** caught into a
   value: the call fails. The Edge classifies: 401 / 403 -> `deny AUTH_REQUIRED`; 404 (not deployed) -> `unknown RPC_NOT_DEPLOYED`; any other non-200 ->
   `unknown RPC_FAILED`; a body that is not exactly the RPC shape for the scope asked -> `unknown RPC_SHAPE` / `SCOPE_MISMATCH`; a transport failure ->
   the consumer's `AUTH_UNAVAILABLE` (send 0). Nothing becomes `allow` by default.
9. **Never.** No write, no row lock, no table, no grant to anyone else, no call to Auth, Storage, Vault, a network or the provider. No caching across calls.

Invariants the implementation TASK must prove (each is a test of section 8 or an acceptance criterion of section 6):
**I-1** subject only from the JWT; **I-2** nothing read before 3 and 4 pass; **I-3** anti-enumeration; **I-4** one snapshot; **I-5** STABLE helpers only;
**I-6** ACL exactly authenticated, MEMBER-path checked; **I-7** no exception swallowed into an answer; **I-8** every missing fact is `unknown`;
**I-9** the answer is the exact RPC shape; **I-10** the owner-epoch token is `g5oe:<epoch>:<lifecycle_version>`.

## 4. W1 / W2 — the worker form (separate from R1, never callable by a person)

For jobs with no person session: the brand_post dispatcher, a Threads dispatcher, a credential statement.

- **W1** `private.account_lifecycle_worker_brand_verdict(p_brand_id text, p_service_key text, p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)
  returns text` — STABLE, definer, empty `search_path`, **owner-only** (no API role). For a reviewed SQL writer of another owner to call inside its own statement
  (G3's claim / store preflight, G4's credential statement).
- **W2** `public.common_account_worker_brand_verdict(...same...) returns text` — W1 with `EXECUTE` to **`service_role` only**, for an Edge worker's last check
  right before the provider.
- Answer: `'active'`, or P5's code (`WORKSPACE_OWNER_UNKNOWN`, `ACCOUNT_DELETION_IN_PROGRESS`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_NOT_ACTIVE`, ...), or
  `OWNER_EPOCH_UNAVAILABLE`, `OWNER_EPOCH_CHANGED`, `SERVICE_GENERATION_CHANGED`, `EXPECTED_OWNER_EPOCH_REQUIRED`, `EXPECTED_LIFECYCLE_VERSION_REQUIRED`,
  `ACCOUNT_LIFECYCLE_SERVICE_INVALID`, `SERVICE_STATE_UNKNOWN`, `FACTS_UNAVAILABLE`.
- **ABA for workers (revised by G5-04 after H1 C1 P2 on PR #351).** The reservation / attestation stores TWO monotonic counters taken from R1's allow
  token `g5oe:<epoch>:<lifecycle_version>`: the F5 owner epoch (a `bigint`, never PR #282's stand-in 0) and the owner's `lifecycle_version` -- the service
  GENERATION (F5 P1's row trigger moves it on every insert / update / delete of the owner's entitlements and on every account status change, and refuses a
  decrease [M: `20261001150000:410-477`]). At dispatch both must be EQUAL in one statement. The first design compared `activated_at` with a bind time; that
  is not a fence: the re-activation RPC writes `now()` = the transaction's START, so a long transaction or a bind -> end -> restart inside one transaction
  made an old reservation pass (reproduced on PG17 against PR #351: `active`). No clock is compared any more. Trade-off: any change of the owner's account
  (e.g. starting Kabumori) also moves the generation, so such reservations are refused (fail closed) and need a fresh confirmation (G3's UX).
- **Service key.** `x_autopost` for X and Threads posting (section 1). Any other key is `ACCOUNT_LIFECYCLE_SERVICE_INVALID`.

## 5. Consumers: where the recheck must sit (matched against the code paths)

| Consumer (owner) | Today's path | Form | Where | Gap today |
| --- | --- | --- | --- | --- |
| X brand_post dispatcher (G3 / F3) | `x-test-post` + `vault_account_brand_post.ts` points 1–3 (`:36-41`) [M] | W1 in `check_x_account_publish_authority`, the enabled setter and the `claim_due_post` planner; W2 right before the X create | every claim; again immediately before the create | no entitlement check; caller authentication question already sent to G3 (Issue #318, comment 6267545726) |
| Threads dispatcher (G3 / F3, PR #334) | `threads_dispatch.ts` store preflight "G5 + G4 decided in SQL" [C] | W1 inside the preflight statement, with the reservation's bound epoch and lifecycle_version | the LAST step before the provider | the G5 part is unwired |
| X OAuth connect (G4 / F4) | `x-oauth-connect-user`: the code is exchanged at `oauth_logic.ts:271` before the ownership recheck at `:279` [M] | R1 (`x_connect`) at begin; R1 again at the callback | **before** the code exchange | exchange before recheck; begin creates a workspace during a deletion |
| Threads OAuth / account binding (G4 / F4, PR #251 / #335, Issue #319 G4-03) | OAuth begin / callback, binding adapter [C] | R1 (`threads_connect`) at begin and right before the exchange; W1 in the binding writer | before the exchange; inside the binding statement | service key was undecided -> `x_autopost` |
| Threads credential / send port (G4 / F4, PR #337) | `ThreadsCredentialStatement(socialAccountId, serviceKey)` [C] | W1 inside the credential statement with `x_autopost` | per lookup | `THREADS_POSTING_SERVICE_KEY = null` until G4 adopts `x_autopost` |
| Common AI gateway (G6 / F6, PR #336, Issue #321) | `fetchVerdict` / `fetchRecheck` [C] | R1 via the Edge (`edgeStamp`) | verdict at request; recheck before each provider attempt | G6's own TASK; the wire is unchanged from G5-01 |
| POSTONA app (G1 / F1) | enrollment gate once per login [M] | R1 optional for UI hints only | — | the server must not rely on the app |

## 6. The next TASK: the R1 / W1 / W2 source candidate — scope and acceptance

**Minimal files (all new, G5-owned):** `supabase/candidates/common_account_authorization_verdict/001_authorization_verdict.sql` (+ `_rollback.sql`), a PG17
runner + test + mutation script under `supabase/tests/common_account_authorization_verdict_*`, a doc test, and a document update. **Not** in
`supabase/migrations/`, no Edge or app change, no change to any other owner's SQL. G3 / G4 / G6 adopt W1 / W2 / R1 in their own TASKs.

**Owner boundaries:** the functions are G5's; `brand_memberships` grants are F3 / G3's (the PR #303 revoke is a precondition and G5 does not perform it); the
consumers are G3 / G4 / G6 / G1.

**Acceptance criteria:**
1. Preconditions in the install (refuse otherwise): the ten F5 chain files and the PR #303 candidate installed; every helper of section 3.7 STABLE, definer,
   owner-only; no RLS forced on the relations read; the PR #303 exposure check null.
2. Postconditions: the ACL of section 3.1 on the role graph (direct, intermediate NOINHERIT, SET-only, ADMIN-only edges); `provolatile = 's'`; empty
   `search_path`; W1 no API role, W2 `service_role` only.
3. PG17 proofs on the real chain: every row of the G5-01 decision table through the real RPC with real claims (`set local request.jwt.claims` and the legacy
   per-claim form); I-1..I-10; the concurrency proof of this TASK repeated through the RPC; anonymous, `service_role` and `anon` callers refused; another
   person's brand and an unknown brand byte-identical; a mutation check covering each clause.
4. A disposable managed project (Phase 13 gates PG1..PG7, separately approved) for what PG17 cannot show: real claim names, `auth.uid()`, the GoTrue
   session row lifecycle, PostgREST's 401 / 403 / 404 bodies.
5. **Codex Sol (high) focused review of the SQL before any apply**; then the owner's explicit approval; apply as one reviewed file, never `db push`.

## 7. Notices to other owners (one time each)

- **G3 / F3 (`x-test-post` caller authentication):** already sent by the G5 担当ちゃ, Issue #318 comment 6267545726 (P1 candidate, production NOT_VERIFIED).
  Not re-sent.
- **G4 / F4 (re-authorization before the OAuth code exchange, service key `x_autopost`):** sent once by this TASK, Issue #319 comment 6267736897 (none existed before).

## 8. Tests (offline; exact results in section 11)

- **Model suite** `common_account_g5_02_rpc_preflight_test.ts` (no network permission): R1-3 subject from the claims only (a body user id, anonymous,
  non-authenticated roles, a mismatch with `auth.uid()`, missing session, malformed claims); R1-4 refusals before any read; R1-5 anti-enumeration; R1-6 the
  two-snapshot hazard; R1-8 the Edge's stamp and error classes; R1-1 / W2-1 the ACL model; W-3 the worker answer; three consumer flows with counting mocks
  (an OAuth code exchange, a scheduled post, an AI charge).
- **PG17 precondition suite** `common_account_g5_02_rpc_preconditions_pg_run.sh` -> `common_account_g5_02_rpc_preconditions_pg_test.ts`: row visibility and RLS, helper volatility and ACL, the
  real one-snapshot proof with two concurrent sessions, and that a person cannot assemble the facts. Creates nothing.
- **Mutation check** `common_account_g5_02_rpc_preflight_mutations.py` over the model.
- **Document test** `supabase/preflight/managed_disposable/g5_02_contract_doc_test.ts`.

NOT_VERIFIED: managed claim names and `auth.uid()`, GoTrue session revocation timing, PostgREST error bodies, the real RPC (not created), consumers' adoption.

## 9. Limits

- The verdict is advisory (no lock); the recheck narrows the TOCTOU window to recheck -> provider acceptance.
- Admin / member roles, organisation workspaces and Miseiro stay refused.
- The worker form trusts the binding the consumer recorded; it must come from an R1 allow token (or the same counters read in the reservation's own
  statement), never be re-read later. Any unrelated change of the owner's account refuses earlier reservations (fail closed).

## 10. Re-run

```bash
deno test --no-config --no-check supabase/tests/common_account_g5_02_rpc_preflight_test.ts
python3 supabase/tests/common_account_g5_02_rpc_preflight_mutations.py <repository root>
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_g5_02_rpc_preconditions_pg_run.sh
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/g5_02_contract_doc_test.ts
```

## 11. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-02` (a clean worktree stacked on PR #340) against a throw-away local PostgreSQL 17.11 (`listen_addresses`
empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed or production system, no credential, no network request, no SQL object
created (the PG17 suite only reads catalogs, calls existing functions and runs two concurrent sessions).

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | the model suite (no network permission) | `deno test --no-config --no-check supabase/tests/common_account_g5_02_rpc_preflight_test.ts` | **11 tests** passed, 0 failed |
| 2 | the PG17 precondition suite on the real F5 chain + the PR #303 candidate | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_g5_02_rpc_preconditions_pg_run.sh` | **5 tests** passed, 0 failed (three consecutive runs) |
| 3 | mutation check of the model | `python3 supabase/tests/common_account_g5_02_rpc_preflight_mutations.py <repository root>` | control PASS, **35/35 detected**, 0 invalid (32 at PR #344; 33 at PR #351; G5-04 rewrote the worker mutants for the generation pair) |
| 4 | regression of the stack | G5-01 pure (13) + PG17 (10); owner-epoch suite (19) | all passed |
| 5 | the whole harness incl. this document's test | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **194 passed**, 0 failed (189 of PR #340 + 5 new) |
| 6 | type-check, lint, shell | `deno check --no-config` on the model and the new tests; `deno lint --no-config` on them and the harness; `bash -n` on the runner | no error; `Checked 50 files`; syntax OK |

Not run, on purpose: creating or applying R1 / W1 / W2; any managed access; consumers' adoption; a Codex review (required at the SQL step, section 6).
