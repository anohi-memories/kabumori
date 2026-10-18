# M1 (F5): the authorization chain of POSTONA's first manual X post — the common-account contract for F3 / G3 and G4

Status: **source-only contract, tests and a decision on Issue #267. Nothing here was run against a managed or production system, nothing was
applied, no real X / Threads / OAuth call was made, no token was read.** Production is **NO_GO**; every release gate stays OFF;
`managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay BLOCKED; `POSTONA_END_SOURCE_ENABLED` is untouched.

TASK `postona-f5-m1-x-first-manual-publish-auth-entitlement-t13-contract-20261018` (priority source: POSTONA 総合指令室, Issue #269). It
stacks on PR #265 (D-3) and adds only this document, one pinned provenance file, an F5-owned synthetic test harness and its runner. It does not
change F3 / G3 (X OAuth, reservations, publishing), G4 (verified X identity, credentials), F4 (Threads), F1 (the post screen), F6 (common AI),
H5, any migration, RLS, Auth or Edge function.

Evidence labels: **[O]** observed in a pinned file (the commit and blob are in `m1-manual-x-publish-provenance.json`, re-checked by
`supabase/tests/common_account_m1_provenance_check.py`), **[D]** derived by a test of this task (section 8), **[R]** recorded in a coordination
file, **[A]** assumption, **[U]** unknown, never inferred. A *source candidate* is code on a PR branch that is not in `supabase/migrations/`.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Can F5's existing functions satisfy F3's call chain for one manual X post? | **Yes, for every boundary F5 owns.** No F5 production code or migration needs to change. |
| What must F3 add on its side? | One call to F5's workspace-state read in the pre-send check of the manual-post path (finding M1-F1), and an honest after-freeze flag on the stored result (M1-F3). |
| Are F3's existing source candidates compatible with the current F5 chain (P1..P10)? | **Yes** (section 8): F3's own four proofs (OAuth T13, publish-enabled T13, publish entitlement, reservation G5 binding) pass unmodified against it. |
| Does a harness PASS mean a real post is authorized? | **No.** G4's verified X identity and credential port are doubles here, the X transport is a counter, and a stored result is `SIMULATED`. |
| Issue #267 (F4's PR #263) | **ACK_WITH_CONDITIONS** — section 7. |
| Managed / production | **NOT_VERIFIED.** No gate of the Phase 13 plan (PG1 to PG7) is opened by anything here. |

## 2. The chain, boundary by boundary

Order of checks (nothing after a refusal runs, and the X transport is never reached): **B1 login → B2 live session → B3 common account and POSTONA
entitlement (T13) → B4 workspace owner → B5 verified X owner and credential owner → B6 publish switch → B7 pre-send fresh read → X call → B8 result and read-back.**

| # | Boundary | Owner | Raw known contract (source) | Input → output / refusal | Lock / ordering | Status |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | the person's login | Supabase Auth (managed) | Edge `verify_jwt`; `/auth/v1/user` (`docs/common-account/phase13-postona-disposable-supabase-architecture.md` §8.3) | access token → subject | — | managed-only: token expiry and signature are checked by Auth / PostgREST **before** SQL [A] |
| B2 | the login session is still live | **F5** | `private.account_lifecycle_assert_active_service_write(uuid, text) → void` (P3b `20261010051938`); reads `request.jwt.claim.sub/role/session_id` (or `request.jwt.claims`) and `auth.sessions(id, user_id, not_after)` | claims → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` for no subject, a role other than `authenticated`, no `session_id`, a subject other than the asked person, a session that is gone or expired | the session is read **after** the locks, never locked | source candidate; model-proven (§8) |
| B3 | common account active + POSTONA entitlement `x_autopost` active | **F5** | the same function; for a caller with no session: `private.account_lifecycle_service_state_refusal(uuid, text) → text` (P4 `20261012130000`), `private.account_lifecycle_service_state_readonly(uuid, text) → text` and `public.common_account_brand_service_state(text, text default 'x_autopost') → text` (P5 `20261012230000`) | codes: `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`, `ACCOUNT_DELETION_IN_PROGRESS`, `ACCOUNT_LOCKED`, `SERVICE_NOT_REGISTERED`, `SERVICE_DELETION_IN_PROGRESS`, `SERVICE_NOT_ACTIVE`, `ACCOUNT_LIFECYCLE_SERVICE_INVALID`, `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE`, `ACCOUNT_LIFECYCLE_BUSY` (55P03, retryable), `WORKSPACE_OWNER_UNKNOWN` | **I1**: login row KEY SHARE → common account FOR UPDATE → entitlement FOR UPDATE, held to COMMIT (guard, refusal); the readonly forms take no lock | source candidate; model-proven |
| B4 | the workspace belongs to this person | **F5** (rule) + **F3** (membership role) | `private.account_lifecycle_brand_owner(text) → uuid` (P5): only a user workspace (`code_profile_key = 'social_mobile_user_v1'`) with exactly one `owner` membership; zero, several or another kind → null (a refusal, never a guess) | brand → owner | plain stable read | source candidate; model-proven |
| B5 | the X identity is verified for this person and the credential is theirs | **G4** | `postona_x_resv.g4_x_account_verified(uuid, text) → boolean` (shipped as a DENY stub, PR #224); `XPostingCredentialSource.accessTokenFor(socialAccountId) → string \| null` with `available` (PR #224 `x_publisher.ts`, contract C1 to C5 in PR #257 `x_credential_contract.ts`) | (user, account) → true / false; account → token or null | evaluated **after** B3 in the same transaction (F3's wrappers) | **not delivered** (stub = DENY, `available` = false): real only after G4 |
| B6 | publishing is switched on for this account | **F3** | `public.set_social_account_publish_enabled(text, boolean, boolean)` + the ON wrapper of PR #262 (T13 → owner → G4 predicate → unchanged switch); send-time `public.assert_x_publish_permission_for_legacy_post(uuid, text, text)` (main, `20261003090000`) and `public.check_x_account_publish_authority(uuid, text, text)` wrapped by PR #182 | account → `authorized` or a typed refusal | T13 locks first, workspace rows after (F5's order) | PR #262 / #182 are source candidates; `20261003090000` is live source |
| B7 | the last check before the X call | **F3** (reads F5's state) | F5 side: `public.common_account_brand_service_state(brand, 'x_autopost') = 'active'` (service_role) — what PR #182 uses inside `check_x_account_publish_authority` | fresh reads → send or refuse | advisory; **no lock spans the call to X** | see M1-F1, M1-F3 |
| B8 | the result | **F3** | stored result + an independent read-back | — | — | F3's TASK; always `SIMULATED` while X is a mock |

Who may call what (proven by `who may call what` in section 8): the T13 guard, the locking state decision and the owner rule are **owner-only**
(callable by no API role, directly or through a membership); `common_account_brand_service_state` is **service_role only**; a person's token
cannot read a workspace's state. F3's wrappers are `SECURITY DEFINER` functions owned by the same owner, which is how they reach the private ones.

## 3. Which F5 call at which point (the minimal API F3 / G3 needs)

| Where in F3's chain | Caller | F5 call | Why this one |
| --- | --- | --- | --- |
| the person submits the post (user JWT, authenticated) | an F3 `SECURITY DEFINER` wrapper, **first statement of its transaction** | `private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')` | needs the person's own live session; takes the I1 locks and keeps them to COMMIT, so a freeze and this write are totally ordered; `lock_not_available` → map to a retryable busy |
| the worker / Edge finishing the send (service_role, **no session**) | a service_role predicate or definer function | `public.common_account_brand_service_state(brand, 'x_autopost')` must be `'active'`; for a writer that must be ordered with a freeze (a claim, setting `enabled`) `private.account_lifecycle_assert_brand_service_active(brand, 'x_autopost')` | the guard cannot serve a worker (it needs a JWT); the read is advisory and never blocks; the ordering variant resolves the owner and takes the same locks |
| a transport that already knows the person (H5 / owner connection) | the owner connection | `private.account_lifecycle_service_state_refusal(user, 'x_autopost')` with the person resolved **before** the call | the explicit-person form F4 uses |

Refusal mapping F3 already uses (PR #262, tested against the live Edge parser): signed out → `auth_required`; deletion in progress or a lock wait → `busy`;
not active / not registered / locked / not the owner → `forbidden`; X identity not verified → `blocked` with `CONNECTION_NOT_VERIFIED`; anything else → the live
`PUBLISH_SETTING_UNAVAILABLE`. F5 recommends the same table for the manual post. A refusal is a **value or an error code, never a success**.

## 4. Findings (each with an owner; none is fixed here)

| # | Finding | Evidence | Owner / consequence |
| --- | --- | --- | --- |
| **M1-F1** | **The live send-time permission does not ask F5.** `assert_x_publish_permission_for_legacy_post` checks the post, brand, switch, verified account, credential references, an account deletion in progress and the refresh state — and nothing about the owner's `x_autopost` entitlement or the common account. Only `check_x_account_publish_authority` (wrapped by PR #182) and the reservation worker (PR #224 `003_postona_x_resv_g5_binding.sql`) ask F5. A manual single post that relies on the legacy permission alone would be sent for a person who ended POSTONA, if the JWT-side check has since expired or been bypassed. | [O] provenance `LIVE-SEND-TIME-PERMISSION` (re-checked: the function body names neither `service_entitlements`, `account_lifecycle` nor `common_account`) and `F3-PUBLISH-ENTITLEMENT` | **F3.** The manual-post path must call `common_account_brand_service_state(brand, 'x_autopost')` in its pre-send step (or route through `check_x_account_publish_authority`). Test: `RACE` in section 8 shows the read refusing every state change. |
| **M1-F2** | The T13 guard needs a person's session; a worker has none. | [O] P3b: no subject → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | F3: user path = T13; worker path = the state read. Test: `the caller must be the person`. |
| **M1-F3** | **No database lock spans the call to X.** A freeze that commits between the pre-send read and the X create lets that one in-flight post complete. F5 does not and cannot stop it; the result must be recorded as it happened. | [O] F5 `phase5-app-integration.md` §4 "Honest limit"; PR #182 header; [D] `KNOWN LIMIT` test | **F3** records the result truthfully and flags `after_freeze` from a fresh F5 read at record time; the end-of-service saga reports in-flight work (PR #182 `postona_x_stop_*`). |
| **M1-F4** | The access token's own expiry is Auth / PostgREST's. SQL sees only the session row (`not_after`) and the claims. | [O] P3b | managed-only: confirm PostgREST rejects an expired token before SQL (Phase 13 M-steps); F5 does not claim it. |
| **M1-F5** | G4's side is not delivered: the verified predicate is a DENY stub, `XPostingCredentialSource.available` is false by default. Everything beyond B4 is a double in these tests. | [O] provenance `G4-VERIFIED-PREDICATE-STUB`, `G4-CREDENTIAL-SOURCE-PORT` | **G4** (Issue #131). Requirements F5 states in section 6. |
| **M1-F6** | `x_autopost` is POSTONA's entitlement for the **whole app**, not X only: a Threads (or later Instagram) connection is gated by the same key. F5 knows exactly two service keys (`kabumori`, `x_autopost`); anything else answers `ACCOUNT_LIFECYCLE_SERVICE_INVALID`. | [O] `docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md` (common premise 1); P1 footprint counts **any** `social_accounts` row of the workspace; P6 records provider results for every platform in the workspace | none; basis of the Issue #267 answer. |
| **M1-F7** | R2′ is unchanged: ending POSTONA for a person with no Kabumori profile still goes through the legacy saga scope `social_and_login`. It concerns **ending**, not posting, so it is not on the M1 critical path. | `phase13-d2-x-saga-standin.md` | F3 (not fixed here). |

## 5. What F5 guarantees, and what it does not (so that nobody relies on more)

**Guarantees** (at the moment a lock is taken, `READ COMMITTED` only; anything unknown fails closed): the person's live session; the account is `active` with no
deletion open; the `x_autopost` entitlement exists, is `active` and has no service deletion open; a freeze and a write that took the I1 locks are totally ordered;
the workspace owner is the single `owner` of a user workspace or nobody; the fixed refusal codes above; the callers of each function (owner-only / service_role-only).

**Does not guarantee:** that the X API call can be stopped once started (M1-F3); who owns a social account or whether a verified X identity exists (G4); that a
credential is current (G4 / F3: the generation check in section 6); that the access token has not expired (Auth); that a workspace membership will not change right after the read
(F3 re-reads the owner just before sending); anything about managed Supabase, PostgREST's SQLSTATE mapping or GoTrue session behaviour (managed-only).

## 6. What F5 asks of the other owners (single owner per path; F5 changes none of it)

| To | Request | Reason |
| --- | --- | --- |
| **F3 / G3** | (1) T13 first in the person's transaction; (2) in the pre-send step read `common_account_brand_service_state(brand, 'x_autopost')` and refuse unless `'active'` (M1-F1); (3) re-read the workspace owner, the G4 verification, the credential owner **and the credential generation** just before sending and refuse on any change; (4) store at most one transition per request id; an unknown outcome is `uncertain`, never re-sent by the same request id; (5) store `after_freeze`; (6) a result produced by a mock must stay marked simulated and is never evidence of a real post | each is proven on a model in section 8 |
| **G4** | the verified predicate must bind (user, account) and the credential owner to the same person; the credential must carry a generation that changes on refresh, reconnect or owner change, so that F3's pre-send read sees it; `accessTokenFor` answers `null`, not a token, for an unknown or disconnected account (C3) | F5 only orders the checks; it holds no tokens |
| **F1** | none from F5; the UI only reflects F3's typed answers | UI is F1's |
| **F4** | see section 7 | |

## 7. Issue #267 — F4's PR #263 (Threads credential rotation, head `a1cc77e4cb3b09b0775a7e60c2c76fecd18f3705`): decision **ACK_WITH_CONDITIONS**

| Question of the Issue | Decision and evidence |
| --- | --- |
| 1. May F4 / H5 use `private.account_lifecycle_service_state_refusal(user, service)` and `private.account_lifecycle_brand_owner(brand)` as stable internal contracts? | **Yes, with conditions.** Shapes: `(uuid, text) → text` (volatile, `SECURITY DEFINER`, empty search path, `lock_timeout` 3 s, returns null or a fixed code, `ACCOUNT_LIFECYCLE_BUSY` as a value) and `(text) → uuid` (stable, definer). Both owner-only, reachable by no API role (P4 `revoke all … from public, anon, authenticated, service_role`; P5 asserts the exact ACL). PR #263's own precondition block checks owner, definer-ness and absence of API-role reach at apply time — the same properties. |
| 2. Is `'x_autopost'` the right service key for Threads, or X-only? | **Right.** `x_autopost` is POSTONA's entitlement for the whole app (M1-F6): the 2026-10-10 shared contract fixes it, F5 has no other key, and the P1 footprint and P6 provider results count every platform in the workspace. A `threads` key must not be added. |
| 3. Agree with the lock order lifecycle → workspace advisory lock → membership → account → custody → lease, and with deciding the person before the lock and comparing under it? | **Yes.** F5's order is I1 (login → common account → entitlement) first; **no F5 function takes a workspace row lock, an advisory lock or a table lock** (every `for update` / `for share` / `for key share` of P1 to P10 targets a lifecycle table — `auth.users`, `common_accounts`, `service_entitlements`, the operation and settings tables — checked by `m1_contract_doc_test.ts`), so F4's order cannot form a cycle with F5's. F4's `brand_owner` read is a plain read before the decision; the checked-owner comparison under the membership lock is F4's, and F5 gives no ownership guarantee beyond the call-time rule. |
| 4. Scope of F5's guarantees: owner change / ABA, service end and restart, workspace move, cleanup cascade | F5 guarantees only the state decision for the **explicit person** at lock time (section 5). It does not guarantee that the person is still the owner (F4's checked-owner binding does), does not revoke a lease when a service ends (the provider cleanup port of the end flow does; F5's finish refuses while a workspace footprint remains), and has no "workspace move": a person's workspace is the deterministic one, any other membership is `x_foreign` and blocks deletion. **Contract changes are notified:** any change to the two signatures, their return values, their ACL or the service-key set needs an F5 TASK and a notice to F3 / F4 / G4 before it ships; apply-time preconditions in PR #263 / #257 / #262 / #182 would refuse a drifted shape anyway. |
| 5. Does PR #263 match the current F5 definitions? | **Yes for what it uses.** F4's own proof pins F5 PR #178 `83334a09`; the P3b, P4 and P5 files are **byte-identical** to the current ones, P6 differs only by added preflight checks and one added answer field (`acknowledged`). F4's proof, run unmodified in a scratch checkout against the local PostgreSQL 17: 33 PASS lines, 0 FAIL, exit 0 (section 8). Not run with P7 to P10 applied; they are additive. |

**Conditions:** (C1) callers stay owned by the lifecycle owner and unreachable by API roles — F5 will not grant `service_role` EXECUTE on the locking decision; a service_role worker uses the advisory read only
(`common_account_brand_service_state`); (C2) F4 keeps the person resolved **before** the decision and compares under the membership lock; (C3) no `threads` service key; (C4) the managed legs stay NOT_VERIFIED:
PostgREST's mapping of `55P03`, H5's owner transport (connecting as the owner role is a broad privilege, F4 / H5 / G4 own that design), Vault, Meta.
The review PASS of J2 is not this ACK, and this ACK is not a review or a managed validation.

## 8. What was run (offline; exact commands and results in section 10)

* **F5's M1 chain suite** — `common_account_m1_manual_x_publish_run.sh` runs `common_account_m1_manual_x_publish_test.ts` over `common_account_m1_manual_x_publish_fixture.sql`: 13 tests on a throw-away local PostgreSQL 17 (Phase 11 model baseline + the real P1 to P10) with a model of F3's wrappers, a G4 double and a counting X mock:
  the whole chain (SIMULATED, read back on another connection); T13 refusals for an ended / suspended entitlement, a service deletion in progress, a locked and a deleting account, a logged-out, an expired and
  another person's session; Kabumori-only person; caller must be the person (no claims, anon, service_role, another subject, wrong role, no session id, a service key F5 does not know); another person's workspace, two owners,
  a non-user workspace; G4 unverified / credential owner mismatch / switch off; **RACE** (9 changes after authorize, all caught pre-send, transport 0); double submit, replay after the send, replay after the service ended, an unknown outcome not re-sent;
  **KNOWN LIMIT**; **T13 busy** (a freeze holding the lifecycle rows → busy after about 3 s, nothing stored, a later retry passes); freeze ordered with the writer; who may call what; isolation (no entitlement, account, Vault or X row changed).
* **Mutation check** — `common_account_m1_manual_x_publish_mutations.py`: each rule of F5's real SQL and of the model is broken in a copy; the suite must fail.
* **F3's four proofs against the current F5 chain**, unmodified, from scratch checkouts of PR #262 / #182: `postona_x_oauth_t13_guard/run.sh`, `postona_x_publish_enabled_t13_guard/run.sh`, `postona_x_publish_entitlement/run.sh`, `postona_x_reservations/g5_binding_run.sh`. F3's dispatch and saga proofs need a TCP listener and were not run.
* **F4's PR #263 proof**, unmodified, from a scratch checkout.
* **Provenance** — `common_account_m1_provenance_check.py`: every external source is still the pinned blob and still contains the quoted contract names.

Source versus managed: everything above is *source / local model*. Managed-only and NOT_VERIFIED: GoTrue's `session_id`, `amr` and refresh behaviour, PostgREST's role / claim settings and SQLSTATE mapping, the real Edge `verify_jwt` behaviour, Vault, the real X API.

## 9. NOT_VERIFIED, and who owns what remains

| Item | Owner | Next step |
| --- | --- | --- |
| a real X post, a real verified X identity, a real credential | G4 (Issue #131), F3 | not authorized; separate approval |
| F3's real single-post orchestrator against F5's chain | F3 (M1 TASK) | F3 runs its E2E with the contract of sections 3 and 6; F5 re-runs its suite on request |
| managed behaviour of every boundary (B1, B2) | F5 + owner | Phase 13 gates PG1 to PG7 (unchanged; none is opened here); the **PR #233 limited P2×4 recheck stays a separate gate before any managed apply** |
| the proofs of F3's dispatch / saga (TCP listener) | F3 | not run here |
| H5's owner transport for Threads rotation | F4 / H5 / G4 | outside F5 |
| AI erasure (Issue #266) | F6 / F5 later | not a prerequisite of the first manual X post |
| R2′ | F3 | unchanged |

## 10. Re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_m1_manual_x_publish_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_m1_manual_x_publish_mutations.py <repository root>
python3 -I supabase/tests/common_account_m1_provenance_check.py
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/m1_contract_doc_test.ts
```

## 11. What was executed for this document (offline; exact commands and results)

All commands ran in `/Users/yuya/Developer/kabumori-f5-m1` (a clean worktree stacked on PR #265), in scratch detached checkouts of F3's and F4's PR heads (read-only; their files were
never changed), or against a throw-away local PostgreSQL 17.11 (`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end; every runner refuses a host that is
not a `/tmp` socket directory). No managed or production system, no credential, no network request of any kind, no real X.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | **F5's M1 chain suite** on the real P1 to P10 (section 8) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_m1_manual_x_publish_run.sh` | **13 passed**, 0 failed |
| 2 | mutation check of F5's real SQL and of the model (31 mutants; the pairs the guard deliberately doubles are removed together) | `python3 supabase/tests/common_account_m1_manual_x_publish_mutations.py <repository root>` | control PASS, **31/31 detected**, 0 invalid |
| 3 | F3's four proofs, unmodified, against the current F5 chain (`RESV_G5_SOURCE_DIR` = this worktree) | `RESV_PGHOST=… RESV_PGPORT=… RESV_PGSUPER=… RESV_G5_SOURCE_DIR=<this worktree> bash <scratch PR #262 checkout>/supabase/candidates/{postona_x_oauth_t13_guard/run.sh, postona_x_publish_enabled_t13_guard/run.sh, postona_x_publish_entitlement/run.sh, postona_x_reservations/g5_binding_run.sh}` | exit 0 each: `POSTONA_X_OAUTH_T13_ALL_PASS`, `POSTONA_PUBLISH_ENABLED_T13_ALL_PASS`, `X_PUBLISH_ENTITLEMENT_ALL_PASS`, `POSTONA_RESV_G5_BINDING_ALL_PASS` (12 s, 13 s, 16 s, 11 s) |
| 4 | F4's PR #263 proof, unmodified, from a scratch checkout of `a1cc77e4…` | `THREADS_PGHOST=… THREADS_PGPORT=… THREADS_PGSUPER=… bash supabase/tests/postona_threads_rotation_run.sh` | exit 0, `ALL PASS`, 33 `PASS` lines, 0 `FAIL` (it pins F5 PR #178; P3b / P4 / P5 are byte-identical to the current files, P6 is additive) |
| 5 | the cited sources are the pinned blobs and still contain the quoted names | `python3 -I supabase/tests/common_account_m1_provenance_check.py` | `M1_PROVENANCE\|ALL\|PASS` (10 sources) |
| 6 | this document's claims (functions and codes exist, F5 takes lifecycle locks only, sources pinned, the test count is real, the model is test-only, nothing secret-shaped) | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/m1_contract_doc_test.ts` | **6 passed**, 0 failed |
| 7 | the whole harness suite, earlier tests included | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **171 passed**, 0 failed (165 before + 6) |
| 8 | the production Edge function's own tests, unchanged | `deno test --no-config --no-check --allow-read --allow-env supabase/functions/account-delete/` | **143 passed**, 0 failed |
| 9 | type-check and lint | `deno check --no-config supabase/preflight/managed_disposable/*.ts supabase/preflight/managed_disposable/x_saga_standin/*.ts supabase/tests/common_account_m1_manual_x_publish_test.ts`; `deno lint --no-config supabase/preflight/managed_disposable/ supabase/tests/common_account_m1_manual_x_publish_test.ts` | no error; `Checked 43 files`, no problem |
| 10 | scope and hygiene | `git diff --cached --name-only`; `git diff --cached --check`; scan of the staged diff for key shapes, connection strings with a password and the one production ref; `git merge-tree --write-tree origin/main HEAD`; open PRs touching these paths | 8 files, +1192 lines; nothing under `supabase/functions/`, `supabase/migrations/`, `supabase/candidates/`, `apps/` or `.agent*`; clean; 0 key shapes; 0 passworded connection strings; 0 production-ref hits; no conflict with `origin/main`; no open PR touches these paths; the heads of PRs #182, #224, #233, #243, #250, #254, #257, #259, #262, #263 and #265 are unchanged |

Not run, on purpose: any managed or production access; F3's dispatch and saga proofs (they need a TCP listener); a real X call; a real credential; the F3 single-post orchestrator (F3's TASK); the PR #233
limited recheck; any change to another owner's file.
