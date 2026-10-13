# Common account — Phase 8 (F5): X stop / deletion saga (F3) × Threads cleanup (F4) × the common lifecycle (F5), integrated

Status: **source candidates + executable proofs; nothing applied, nothing deployed, no managed Supabase touched, no real
OAuth / X / Threads / Meta call, no user created, no post.** Production NO_GO (section 12). Stacked on F5 PR #183
(Phase 7). No F3 (PR #189), F4 (PR #180), G4 (PR #124), H5, F1/F2 or app file was changed; their heads were only
read through `git archive` into a throw-away directory.

Phases 1–7 proved each stack against its own stand-ins. This phase puts the **real sources of all three stacks in one
disposable database and one Edge overlay** and asks what the pairs of them do to each other.

```bash
export CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser>
bash supabase/tests/common_account_phase8_integrated_run.sh          # world, e2e, regression, apply, rollback, acl (~4 min)
CAL_P8_SECTIONS=world,e2e bash supabase/tests/common_account_phase8_integrated_run.sh   # a subset
bash supabase/tests/common_account_service_reconciliation_run.sh      # the one new migration (own runner)
python3 supabase/tests/common_account_service_reconciliation_mutations.py                # 14 mutants
python3 supabase/tests/common_account_phase8_ts_mutations.py "$PWD"                      # 24 mutants of the TypeScript
python3 supabase/tests/common_account_phase8_integrated_mutations.py                     # 7 seam mutants of the assembly (~12 min)
```

## 1. What is assembled (and what is not)

| Stack | Source (pinned; `F3_SHA` / `F4_SHA` / `PR124_SHA` / `F5_P7_SHA` override) | Taken as |
| --- | --- | --- |
| F5 (G5) | this checkout: Phase 1, 2, 3a, 3b, 4, 5, 6 and the new Phase 8 migration; `account-delete` Edge function | working tree |
| F3 | PR #189 head `4fd7084d067d2a9f589fd7fecaee70720bc60812`: Stage 3B authority (real main migration), reservations 001–003, entitlement guard 001, saga stop 002, the saga's Edge function and TypeScript | `git archive` |
| F4 | PR #180 head `7c4f457834cddb42b72be6b74996e643b213e8c8`: publish stack, cleanup (**lease-bound**), disconnect, writer guards, `threads_provider_cleanup.ts`, the T13 helpers | `git archive` |
| G4 | PR #124 head `c30f246409a77080cbc03aef6c4cb72b5481e125`: two read-only files (OAuth/workspace candidate, its fixture) | `git archive` |
| F3 (additionally) | PR #192 head `9384818ec255b7879bfbef39418e8393b4c37db9` (F3's J3 V3 R1–R3 fixes, stacked on #189; opened while this phase ran): the same runner with `F3_SHA=<that head>` — **all 29 end-to-end tests and F3's own suites pass against it too** (section 3, F3-R1) | `git archive` |
| older F5 | PR #183 head `f2565cc0412f8127f95f00a728d16bf83af74667`: the Phase 7 Edge code, as "older code" in R2 | `git archive` |

Stand-ins, each a statement or a small file, **never inside a candidate**: the Data API = `psql` as `service_role`;
Auth `getUser` = a token check; Auth logout/admin delete = SQL; the X revoke endpoint = a recording fake (no X call is
ever made); Storage = accept; `postona_x_resv.g4_x_account_verified` = `true` **only** in the order database (F3's own
double); `threads_disconnect_gate_open` = `true` only where the lifecycle decision (not "disabled") must answer; the
release gate is opened by dropping its `blocked_only` check **only** in the order and whole-account worlds. One harness
adaptation: F3's `002` is applied without its `create role` where the cluster-wide role already exists (a three-line
diff, asserted).

## 2. The required cases and where they are proven

| # | Case | Evidence (all green) |
| --- | --- | --- |
| 1 | POSTONA-only end: X reservations, due claim and publish authority stop; Threads is removed only with a live lease; Kabumori and every other person unchanged | `I1` (the X revoke is observed **after** authority `revoked`, reservations `cancelled,cancelled`, Threads gone; bystander snapshot equal; Kabumori `active`), `I12` (every competing write refused while the end is open) |
| 2 | whole-account deletion refuses completion until X and Threads are settled; unknown is never success | `I13` (acknowledgement first, X and Threads settled before the login goes, the durable answer readable by the subject hash), `I5` (post in flight → typed `X_CLEANUP_BLOCKED [POSTING_IN_PROGRESS]`, retry ends), `I6` (X revoke unknown → `502 X_CLEANUP_FAILED [X_REVOKE_FAILED]`, nothing purged, never "revoked"), `I7` (**unconfirmed X post → `x_posts_unconfirmed` durable and re-readable**), `I8` (crash after the saga → the lease holds, takeover without a second revoke, remote-unverified still reported), `I9` (two identical requests), `I10` (lease lost during the saga), `I4` (grant missing → `RECONCILIATION_REQUIRED`, X untouched), `I3` (empty registry → `PROVIDER_ADAPTER_MISSING`, X untouched), `I2` (no consent → nothing changes), `I13a` (**shipped release gate** → `COMMON_ACCOUNT_DELETION_UNAVAILABLE` before X, Threads or the login is touched) |
| 3 | F3's non-X guard; F4's SECURITY DEFINER / T13 / ACL; F5's service-role / JWT boundary and strict owner inference; lock order, deadlock, timeout observed | `I11` + F3's own `saga_behavior.sql` (non-X account refused before any X call), `acl` section (8 checks × 2 worlds, section 6), `regression` (F3's `behavior.sql`, `saga_behavior.sql` and F4's `t13_behavior.sql` **unchanged** on the assembled world), `O0`–`O7` (section 5) |
| 4 | the POSTONA legacy deletion screen and the hand-off | section 9 |
| 5 | PR dependency / conflict / apply order, grants, registration gates, rollback + read-back, managed disposable checks, STOP reasons | `apply`, `rollback` sections (sections 7, 8), section 10 |

## 3. Findings

### Fixed in this PR (F5-owned)

1. **F5 read F3's saga as a bare word** (`done`/`blocked`/`failed`): the typed `reasons` (an in-flight post, a refresh
   in progress, `X_REVOKE_FAILED`, …) and the unconfirmed-post count were lost on the way. `xResultOf` now keeps them,
   and `I0` holds F5's mapper **equal to F3's `xServiceEndOutcomeOf` on every answer the saga can give**, including the
   two reason lists. A reason F5 does not know is a failure, never a retryable block.
2. **`x_posts_unconfirmed` lived in one request's memory.** A crash between the saga's answer and the end, or a retry
   that found the entitlement already ended, hid X posts whose result was never known behind an apparently clean
   completion (J3 V3 R1). Migration `20261013140000` adds `private.account_lifecycle_operations.reconciliation`
   (jsonb, shape-checked), `record_owned_service_deletion_reconciliation` (owner lease checked on the wall clock after
   the locks; **sticky at its maximum**: a saga that forgot cannot lower it) and `common_account_service_end_result`
   (read-back of status, provider results, which remote grants stay **unverified**, the acknowledgement, the facts).
   The code records the fact **before** X is recorded `done`, offers it three times, and when it cannot be made records
   X as `reconciliation_required` (the end cannot finish) and tells the person the count in that answer.
3. **Code ahead of the database fails closed before anything is touched.** An end first reads the record of an
   earlier end; an unreadable or malformed answer (the function is missing, rolled back, or something else answers)
   stops with `FAILED` before a provider, X or an acknowledgement is touched (`R1`). An `already_ended` answer is
   never "clean" out of a record that could not be read.
4. **Phase 8's rollback keeps its column and its data and a re-apply after it works** (same catalog as a fresh
   apply; a same-named column of another shape is refused, never adopted).

### Open, owned by another slot (hand-off bodies in section 11; not changed here)

| # | Owner | Finding | Severity | Evidence |
| --- | --- | --- | --- | --- |
| **F3-L1** | F3 | **Three-way lock cycle on the legacy saga path.** `postona_x_resv.lock_own` (owner `cancel`/`reschedule`/`reconfirm`) and `pre_publish_check` lock the **reservation row first** and then take G5's locks; `create_batch` takes G5's locks first and then needs a key-share on `social_accounts` for its insert; the saga's `postona_x_stop_account_publishing` holds `social_accounts FOR UPDATE` and then updates the reservation rows. The database aborts one of the three (`deadlock detected`, SQLSTATE 40P01): fail-closed and retryable, but a user-visible 500 or a failed saga step. Only on the legacy path: through F5's flow the entitlement is already `deleting` when the saga runs, so a writer is refused at G5's decision before it reaches the row it would wait for. | medium (rare, transient, fail-closed) | `O6` reproduces it **deterministically** with three real functions and one holder (exactly one deadlock; victim: the create); `O5` saw one in some runs of the 30 seeded rounds, only in the legacy-saga rounds, **never in the F5 flow**; `O7` shows the one-statement repair (take G5's decision before the row lock) removes it |
| F3-R1 | F3 | **The saga forgot the unconfirmed count after the purge** (PR #189): a retried saga answered a plain `done`, so a failure to record it on the F5 side lost it. **F3 repaired this in PR #192** (a durable checkpoint keyed by the subject hash, repeated on every later stop/precheck answer, cleared only by `social_mobile_account_deletion_x_unconfirmed_ack(user, expected)`, "after the caller recorded it in its own durable state"). F5 now does exactly that: it records the fact (finding 2) and **then acknowledges the saga's checkpoint with the count it saw** — best effort, so PR #189 (no such function) and a changed count only mean the saga keeps over-reporting. | resolved by #192 + this PR | `I7` (against #192 the checkpoint rows of the person are 0 after the end; against #189 there is no table), `postona_end_test.ts` |
| F3-R2 | F3 | **A person with no Kabumori profile is "POSTONA-only" for the saga**: its scope is `social_and_login` and it deletes the login — the common account's login. F5 refuses (`X_CLEANUP_UNSUPPORTED`, nothing changes). The saga needs an explicit "keep the login" request (F5 already sends `expected_scope: 'social_only'`; the saga must accept it for any person when the caller is the common flow, and must never delete a login a `common_accounts` row exists for). | medium (blocks the POSTONA-only person from the common flow) | `I14` |
| F3-R3 | F3 | F3's R2 (the saga request must be a complete body: `action: 'delete'`) and R3 (lease re-checked on the wall clock after its locks) are in PR #192; F5 already sends the complete body (`I1` asserts the exact body the saga receives) and `I0` holds for both heads. | — | `I0`, `I1` |
| G4-1 | G4 / F3 | **The legacy POSTONA deletion screen is a second, uncoordinated path to a login deletion.** For a person with no Kabumori profile (scope `social_and_login`) the legacy saga revokes X, purges the workspace and **deletes the login; the common account row goes with it by cascade** (Phase 1's `auth_delete_guard` is `shadow`: it observes, it does not refuse). No session revocation step, no storage inventory, no `account_deletion` operation of the common flow, no Threads acknowledgement (a person with a Threads connection is instead stopped by `NON_X_ACCOUNT_PRESENT` and F4's disconnect gate is closed). Not a regression — this is today's production behaviour — but it must be retired by G4 (section 9). | medium (process, not data safety) | `I14b` (pinned observation) |
| G3-1 | G3 / F3 | **The X onboarding RPCs are not behind T13.** `begin_social_mobile_x_oauth_connection` succeeds while a POSTONA end is open (`I15`); the completion is refused by the end of the workspace in practice (`I16`: reconnect started mid-saga, the end still ended), but the begin is a write the lifecycle decision does not see. Wire `private.account_lifecycle_assert_active_service_write` into the three RPCs. | low–medium | `I15`, `I16` |
| G3-2 | G3 | The three X onboarding definers (`begin_/complete_/consume_social_mobile_x_oauth_*`) pin `search_path = public` (`public, vault`), not the empty path every other definer of the three stacks pins. Pre-existing on main; listed, not changed. | low | `acl` A1 |

F4's PR #180 fix (`threads_cleanup_authorized` delegating to `private.account_lifecycle_cleanup_authorized`, lease-bound)
was **verified** here: the Phase 6 overlay's negative reproduction of PR #169 still reproduces and PR #180's T13 suite
passes unchanged on the assembled world (`regression`).

## 4. The end, as it actually runs across the stacks (`I1`, `I13`)

```
POSTONA end (F5 account-delete)                        database / other stacks
------------------------------                        ------------------------------------------------------
read the record of an earlier end   ------------------> common_account_service_end_result        (F5 P8; must be readable)
begin_service_deletion              ------------------> entitlement ending (G5 order: login -> account -> entitlement)
claim_service_deletion (owner lease) -----------------> lease + fence                              (F5 P6)
acknowledge remote-unverified grants  ----------------> BEFORE any removal                         (F5 P6)
Threads cleanup (F4's adapter)       ------------------> cleanup_threads_provider_footprint        (F4, needs the live lease via F5's predicate)
X saga (F3's Edge function)          ------------------> acquire -> stop_x (authority revoked, planned reservations cancelled,
                                                        in-flight => typed block) -> X revoke (twice) -> stop_x -> purge -> finalize (social_only)
record unconfirmed X posts, then X   ------------------> record_owned_service_deletion_reconciliation, then provider result
finish_owned_service_deletion         -----------------> ended only if every answer is settled and acknowledged (read back)
```

Providers run **before** the saga because the saga treats every social account of the workspace as X material
(`NON_X_ACCOUNT_PRESENT`, `I11`); the saga has its own lease and tombstone and never uses F5's.

## 5. Lock order, deadlock, timeout — observed

G5's order is login `KEY SHARE` → `common_accounts FOR UPDATE` → `service_entitlements FOR UPDATE`, held to commit,
`lock_timeout` 3 s mapped to a typed busy code. What each stack takes, as read from the sources and **observed**:

| Function (stack) | Order | Observed |
| --- | --- | --- |
| `begin_service_deletion`, `claim_service_deletion`, `finish_owned_service_deletion`, Phase 8 `record_…` (F5) | G5 locks, then the operation row | `O1`: waits behind a writer that holds the account lock (observed in `pg_stat_activity`), then ends |
| reservation `create_batch`, `list_reservations` (F3 via `g5_x_autopost_allowed`) | G5 locks → advisory `postona_x_resv:<account>` → inserts (FK key-share on `social_accounts`) | `O2`: arrives while an end holds the lock → waits **3.03 s** → `POSTONA_RESV_SERVICE_BUSY` (typed, nothing written); after the commit `POSTONA_RESV_SERVICE_NOT_ACTIVE` |
| reservation `cancel`, `reschedule`, `reconfirm` (`lock_own`), worker `pre_publish_check` (F3) | **reservation row first**, then G5 locks | `O3`/`O4`: no deadlock against the end in either order; a claimed row is not publishable once the end is open (`NOT_PUBLISHABLE`) |
| saga `acquire` / `stop_x` / `purge` / `finalize` (F3) | advisory(deletion) → advisory(workspace) → deletion row → `brands`/`memberships`/`social_accounts FOR UPDATE` → authority → reservations; `finalize`: `auth.users FOR UPDATE` after the workspace is gone | `O6`: cycle with the two writers above (finding F3-L1) |
| Threads `begin_threads_manual_publish`, `disconnect_threads_account`, reconnect (F4/G4) | G5 locks (T13 `lock_timeout` 3 s), then rows | `O5` rounds B: no deadlock, no raw lock timeout |

`O5` (seed 20261013, 30 rounds; the five kinds A reservation writers, B Threads writers, C legacy saga, D whole account,
E worker, each writer holding its locks open a random 0–0.4 s): ~67 writer answers ok, ~29 typed refusals, 0 busy,
0 raw lock timeouts, **4 concurrent lock waiters at most** (the test fails if no lock wait happened at all), and the
database's own counter `pg_stat_database.deadlocks` rose by **0 or 1 depending on the run's timing — and every one of
them was in a legacy-saga round, none in the F5 flow** (the assertion). Every F5-flow round ended with the entitlement
`ended`, nothing planned or claimed, X revoked once each.

## 6. Privilege boundary of the assembled world (`acl`, both the granted and the not-granted world)

* every SECURITY DEFINER function of `public` / `private` / `postona_x_resv` pins `search_path = ''` (three
  pre-existing X onboarding RPCs pin `public`; G3-2), one owner, not a superuser, not BYPASSRLS;
* **exactly 15** definer functions are executable by `authenticated`, none by `anon`, none by PUBLIC, **none takes a
  user id** (the person is `auth.uid()`, read inside); nothing of `private` / `postona_x_resv` is reachable by an API role;
* F5's and F3's service functions are `service_role`-only; the internal predicates are reachable by nobody;
* F4's cleanup pair (`cleanup_threads_provider_footprint`, `threads_provider_connection_state`) is `service_role`-only
  **iff** F5's reviewed grant candidate was applied; never to anon / authenticated / PUBLIC;
* no API role writes the lifecycle, authority, reservation or deletion tables, and none reads the reconciliation column;
* `postona_resv_api` executes exactly the six owner actions, has no membership in another role, no table privilege on the lifecycle tables;
* the eleven writer-guard triggers (account root, entitlement identity, profile root fence, deletion guard on the workspace tables, provider guard) are present and enabled.

## 7. Apply order and dependencies (the database refuses the wrong order, `apply`)

| Candidate | Needs (refusal code when absent; nothing changes) |
| --- | --- |
| F5 Phase 6 | Phase 4, 5 (unchanged, Phase 7) |
| **F5 Phase 8** | Phase 6 (`COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PHASE6_MISSING`) |
| F3 reservations 003 (G5 binding) | F5 Phase 3b + 4 (`POSTONA_RESV_G5_BINDING_PRECONDITION_G5_MISSING`) |
| F3 entitlement guard 001 | **F5 Phase 5** (`X_PUBLISH_ENTITLEMENT_PRECONDITION_G5_MISSING`) |
| F3 saga stop 002 | F3 entitlement guard 001 (`X_SAGA_STOP_PRECONDITION_MISSING`) |
| G4 PR #124 OAuth/workspace | F5 Phase 3b / T13 (`POSTONA_THREADS_OAUTH_PRECONDITION_T13_MISSING`) |
| F4 cleanup | **F5 Phase 6** (`THREADS_CLEANUP_PRECONDITION_LIFECYCLE`) |
| F4 disconnect | F5 Phase 3b/4 (`THREADS_DISCONNECT_PRECONDITION_LIFECYCLE`) |
| F4 writer guards | F5 Phase 3b **and** 5 (`THREADS_GUARDS_PRECONDITION_G5`) |
| F5 grant candidate | F4 cleanup applied; the registry candidate: the grant + F4's module on the branch |

Every file of the three stacks (22) is refused again on the finished world with its own `…ALREADY_APPLIED` code and the
catalog is byte-identical afterwards. The order **commutes** where the dependencies allow: Phase 4 → F3 reservations →
Phase 5 → F3 entitlement guard + saga → Phase 6 → Phase 8 reaches the same 934-line catalog as Phase 4…8 → F3.

**Recommended order** (each step one reviewed file, never `db push`; the schema-first runner of
`common_account_lifecycle_rollout.md`): F5 1, 2, 3a, 3b, 4, 5, 6, 8 → F3 reservations 001, 002, **003** → F3 entitlement
guard 001 → F3 saga 002 → G4 PR #124 → F4 publish stack → F4 cleanup, disconnect → F4 guards → **EXECUTE grant** →
**provider registry** (code) → Edge deploys in the order of section 8. The migration is always before the code that
reads it; the code is always rolled back before the migration.

## 8. Rollback and read-back (`rollback`, `R1`, `R2`)

| Step | Observed |
| --- | --- |
| F3 saga 002 → F3 entitlement 001 → F3 binding 003 → F5 Phase 8 → 6 → 5 | the catalog returns to "Phase 4 + F3 reservations 001/002 + Stage 3B"; the only differences are the **documented additive remnants** of Phase 6 and 8 (`provider_results`, acknowledgement columns, `reconciliation` and their shape constraints: data survives); F3 ships no rollback for reservations 001/002 or Stage 3B, F4 ships none for any of its candidates |
| F5 alone rolled back (Phase 8 → 6 → 5 → 4) while F3 and F4 stay applied | F5's shared fence functions **stay** while F3's binding and F4's guards use them (`service_state_refusal`, `assert_*`); F3's decision keeps answering `true` for an active person; F4's cleanup authorization turns into an **error** ("function … does not exist") — it can never authorize; a Threads publish begin keeps answering through the kept guard functions |
| Phase 8 rolled back under the **Phase 8 code** (`R1`) | an end stops with `500 FAILED` **before** X, Threads or an acknowledgement is touched; X and Threads are intact; the lease is given back |
| Phase 8 rolled back under the **Phase 7 code** (`R2`) | the same flows work (`ended`, X revoked twice, Threads unverified); the old code never asks for what the rollback removed |

Rollback order is **code first, then migration**; the apply order is the opposite. A person whose end was cut off by a
rollback stays in `deleting` and is finished by a retry once the database and the code agree again.

## 9. The POSTONA deletion screen today, and the hand-off (case 4)

Verified in source: `apps/social-mobile/src/domain/account-deletion.ts` sets
`ACCOUNT_DELETION_FUNCTION = 'social-mobile-account-delete'`; the screen sends `action: 'delete'` to **F3's legacy saga**,
which knows nothing of the common lifecycle (no entitlement, no lease, no provider results, no acknowledgement), and for
a login used only by POSTONA it deletes **the login itself** (`social_and_login`). **No file of the app was changed.**
What G4 / the POSTONA owners need to adopt the common flow (a concrete contract; the texts are
`supabase/functions/account-delete/user_notices.ts`):

1. **Action.** `POST account-delete` `{ action: 'withdraw_postona', confirmation: 'END_POSTONA_SERVICE',
   acknowledged_remote_unverified: ['threads'] }` for "POSTONAの利用を終了"; `{ action: 'delete_common_account',
   confirmation: 'DELETE_COMMON_ACCOUNT', expected_lifecycle_version, acknowledged_remote_unverified }` only from the
   common-account settings (the login goes). The recent-authentication requirement is unchanged (`REAUTH_REQUIRED`).
   **Until the app switches the legacy call still deletes the login of a POSTONA-only person together with its common
   account row (`I14b`, finding G4-1).**
2. **Consent first.** Call `{ action: 'preview' }` (read-only); for every provider in `remote_unverified` show
   `REMOTE_UNVERIFIED.<provider>.local` and `.remote` as **two separate lines** and send the provider in
   `acknowledged_remote_unverified`. Without it the answer is `409 REMOTE_UNVERIFIED_ACK_REQUIRED {providers}` and
   **nothing was touched**; a retry may carry the consent.
3. **Error mapping.** Every code in `ERROR_NOTICES` (pinned by `common_account_phase7_notices_test.ts`), plus the typed
   `reasons` of `X_CLEANUP_BLOCKED` / `X_CLEANUP_FAILED` through `X_REASON_NOTICES` as one line under the code's notice.
   `X_CLEANUP_UNSUPPORTED` is the answer for a person the saga would delete the login of (F3-R2) — show the "contact
   us" text, do not fall back to the legacy call.
4. **Result lines.** `resultLines(body, kind)`: the local result, then one line per unverified provider, then
   `xPostsUnconfirmedLine(n)` when `x_posts_unconfirmed > 0` (also present on a later `already_ended` and on a
   `500 FAILED` that could not record it). The line says neither "posted" nor "not posted": it says where to look.
5. **Retry.** The request is idempotent by its owner lease: `DELETION_IN_PROGRESS` → wait and retry;
   `already_ended` is a success and carries the durable facts.
6. **What stays.** The legacy saga stays reachable only for the X-only transition until the app switches; once G4
   switches, F3 may refuse a login-deleting scope for any person with a `common_accounts` row (F3-R2).

## 10. Activation gates and STOP reasons (no gate was opened; none exists to open locally except in tests)

| Gate | Shipped state | Proven |
| --- | --- | --- |
| `managed_auth_delete` | `blocked` (`IDENTITY_CHANGE_FENCE_MISSING`), a table check forbids any other state | `I13a`, `apply` |
| provider registration | the registry registers nothing → `PROVIDER_ADAPTER_MISSING` before any change | `I3` |
| Threads cleanup EXECUTE | not granted → the database refuses the adapter → `RECONCILIATION_REQUIRED`, X untouched | `I4`, `acl` |
| Threads disconnect | `threads_disconnect_gate_open()` is `false` (F4's release gate) | `I12` (opened only to see the lifecycle answer) |
| POSTONA app | still calls the legacy saga | section 9 |

**STOP and ask** (managed disposable, section 8 of the Phase 7 document): any `RELEASE_PREFLIGHT|FAIL`; a chain file
refused with an unexpected code; an authenticated-executable definer set that differs from the 15 of section 6; a
deadlock that is **not** on the legacy saga path; any answer that says `ended` while a `reconciliation_required` or an
unacknowledged unverified grant is on record; a Threads answer that says "revoked"; the `reconciliation` column
missing while the Phase 8 code is deployed. Nothing is deployed from this branch.

## 11. Hand-offs (concrete)

* **F3 (PR #189)** — **L1**: in `postona_x_resv.lock_own` and `pre_publish_check`, take G5's decision
  (`assert_account_access` / `row_publishable` → `g5_x_autopost_allowed`) **before** `select … for update` on the
  reservation row, then re-verify the row under its lock. The exact body that passes `O7` is
  `supabase/tests/common_account_phase8_f3_lock_order_fix_proof.sql`. **R1**: done in PR #192; F5 acknowledges the checkpoint
  (verified against that head). **R2'** (was R2): accept `expected_scope: 'social_only'` for a person with no
  Kabumori profile when the common flow asks, and never delete a login a `common_accounts` row exists for. Never send
  a non-X credential to X (the guard `NON_X_ACCOUNT_PRESENT` already does; keep it). Keep the typed reasons.
* **F3 (PR #192)** — keep the checkpoint's acknowledgement signature (`(uuid, integer)`, compare-and-clear): F5 calls
  it by that name after it recorded the count.
* **F4 (PR #180)** — nothing new; the lease-bound authorization is verified. F4 ships no rollback for its candidates:
  a partial rollback of F5 leaves F4 failing closed (section 8), which is acceptable; add rollbacks if F4 wants an
  emergency path of its own.
* **G3** — wire T13 into the three X onboarding RPCs (G3-1); harden their `search_path` (G3-2).
* **G4 / POSTONA** — section 9.
* **G1/G2 (Kabumori)** — the Phase 7 list stands; additionally map `x_posts_unconfirmed` and the typed reasons.
* **Coordinator** — order and gates of section 7 and 10; one independent Sol (高) integrated review of
  F5 #183 + this PR + F3 #189 + F4 #180 after F3 fixes L1 / R1 / R2, **before** any release gate.

## 12. Not proven, and Production NO_GO

Not proven: managed Supabase behaviour (every item of the Phase 7 manual checklist); real GoTrue tokens and sessions;
the real PostgREST error mapping (the stand-in maps by message); the real X and Threads APIs (the revoke is a recording
fake; Threads has no revoke); the React rendering of any notice; anything under real load; the legacy saga with a real
Apple grant; F3's reservation **worker** (it has no EXECUTE for any role yet — `claim_due` / `pre_publish_check` were
called as the owner).

Production NO_GO: (1) PR #121, #152, #165, #178, #183 and this PR, F3 #189 and F4 #180 are unmerged Drafts; (2) F3-L1,
R1, R2 and G3-1 are open; (3) the apps still bypass `account-delete`; (4) managed behaviour is unproven and
`managed_auth_delete` / `IDP_PREPAUSE_BLOCKED` stay; (5) Phases 2 and 3a have no emergency rollback, F4 none at all.
