# POSTONA personal-auth install bundle (G5 source candidate — NOT applied anywhere)

Status: **one unapplied source candidate**, for **one** independent Codex Sol (high) review.
- Not a migration. Not applied to any managed or production database (not even read-only).
- Production **NO_GO**. Applying it needs, in this order:
  1. the review;
  2. a migration-ised version (a separate TASK);
  3. the managed read-only audit (G5-18 gates) with the user's approval;
  4. the owner's explicit production approval.
- TASK `common-account-g5-postona-auth-integrated-install-migration-source-candidate-20261026` (Issue #320, G5-01 generation, task 40).

## 1. What is in it

`MANIFEST.tsv` lists every file with its source commit, path, PR and blob.
- **The copies:** 14 files are **byte-identical copies** of the candidates already reviewed one by one. `supabase/tests/postona_personal_auth_bundle_verify.py` proves it from git objects.
- **The new file:** `RG_base_rollback_guard.sql` is read-only (§4).

| Step | Install | Rollback | From |
| --- | --- | --- | --- |
| 10 | `10_r1_authorization_verdict.sql` (R1, W1, W2, GC) | `R10_…` | G5 stack `21a5cad4` (G5-03 … G5-08) |
| 20 | `20_r0_bootstrap_verdict.sql` (R0) | `R20_…` | `21a5cad4` (G5-07 / G5-08) |
| 30 | `30_sv_session_verdict.sql` (SV) | `R30_…` | `21a5cad4` (G5-10) |
| 40 | `40_d1_verdicts_anonymous_strict.sql` (D1: R1 / R0 / SV bodies) | `R40_…` | PR #494 `c9f726e9` |
| 50 | `50_s2_3_workspace_eligibility.sql` (S2-3 predicate + R0 body) | `R50_…` (**PR #521**, callers fence) | install PR #506 `bbc52a6b`; rollback `0b47b27c` |
| 60 | `60_s2_2_personal_session.sql` (S2-2 gate) | `R60_…` (**PR #525**, case-insensitive fence) | install PR #510 `6d59f3b6`; rollback `a4ce68ff` |
| 70 | `70_s2_1_t13_anonymous_refusal.sql` (T13 body) | `R70_…` | PR #489 `1c3b16a7` |
| — | — | `RG_base_rollback_guard.sql` (run before R30) | **new** in this bundle |

The fixed mutation drivers (PR #514 T13, PR #515 D1 / S2-3, PR #525 S2-2) are the evidence for each file's own suite. They are not part of
what would be applied.

## 2. Prerequisites (NOT in the bundle; each has its own owner and review)

| # | Prerequisite | State |
| --- | --- | --- |
| P1 | The G5 lifecycle migrations `20261001150000` … `20261015120000`, including the reviewed T13 (`20261010051938`, blob `da587631`). | The G5 Draft chain; only `20261001150000` is on main. |
| P2 | The brand owner epoch candidate `common_account_brand_owner_epoch/001` (PR #285 → #303 → #457). | **PR #457's independent review is still open (H3 stopped). R1 cannot install without its exposure helper, so this bundle is blocked on it.** |
| P3 | G3's L-1 revoke on `brand_memberships` (PR #370): the suites use a stand-in. | G3. |
| P4 | Managed `auth.uid()`, the GoTrue claims (`is_anonymous`, `session_id`) and PostgREST's claim settings. | NOT_VERIFIED. |

## 3. Install order (each step refuses unless the previous ones hold)

10 → 20 → 30 → 40 → 50 → 60 → 70.
- **Run as:** the lifecycle owner (never a superuser: every step refuses one), in READ COMMITTED, one file per transaction.
- **Ordering:** 40 needs 10–30, and 50 needs 40. 60 and 70 do not depend on 40 / 50, but the bundle installs them last, so that the gates exist before T13 changes.
- **Re-running a step refuses** with its `*_ALREADY_APPLIED` code and changes nothing. Running a step out of order refuses with its precondition code (D1 before R1, S2-3 before R0, …).
- **Privileges after install:**
  - R0 / R1 can be executed by `authenticated` only;
  - W2 can be executed by `service_role` (the Edge worker's entry);
  - SV, S2-2, S2-3, T13 and W1 are owner-only;
  - no API role is a member of the owner.

  Consumers that call the owner-only gates must be functions **owned by the lifecycle owner**. A grant to any other role is a separate,
  reviewed change, and this bundle grants nothing beyond the copied files.

## 4. Rollback order, and the guard

R70 → R60 → R50 → R40 → **RG** → R30 → R20 → R10. R60 / R50 do not depend on R70.
- R70 – R40 check their own preconditions and refuse otherwise.
- R60 and R50 refuse while any function body names their gate, or a dependency points at it.
- **R30 / R20 / R10 are unconditional `drop function if exists`** (as copied from `21a5cad4`). The bundle suite shows R10 dropping R1 under D1 / S2-x and breaking a consumer.

**RG** is read-only. It refuses unless all of these hold:
- no S2-2 and no S2-3 remain;
- T13 / R1 / R0 / SV have exactly their reviewed bodies;
- no other function's source names R1 / R0 / SV / W1 / W2;
- no recorded dependency points at them.

Limits:
- RG cannot see dynamic SQL, other databases, or callers outside the database.
- **It is a procedure step, not enforcement.** Folding it into new versions of R10 – R30 is a decision for the one review.

## 5. Evidence (throw-away PostgreSQL 17.11, local socket, fake data)

`supabase/tests/postona_personal_auth_bundle_pg_run.sh` builds the prerequisite world (P1 + P2 + the P3 stand-in, without R1 / R0 / SV) and runs
three suites from the bundle's own files, **×3, all PASS**:

| Suite | Result |
| --- | --- |
| the bundle suite (6 tests) | out-of-order installs refused; 10 → 70 with every body as stated; every re-run refused; privileges; out-of-order rollback refused; the guard refusing per layer (S2-2 present, T13 not reviewed, D1 still applied, a caller, a dependent); the reverse rollback giving back the **exact** pre-bundle catalog (body and ACL of every function in public / private / auth); the reinstall giving the same catalog; the unguarded R10 recorded |
| PR #518's integration suite (7 tests, from its head) | the G5-36 negative matrix through the fake consumers |
| PR #528's consumer-source suite (7 tests, from its head) | G3 / G4 / G6 code against the bundle |

The guard's own checks were mutated in a scratch run (5 mutants: S2-2 presence, T13, reviewed bodies, callers, dependents): **5 / 5 detected**
by the bundle suite.

## 6. Known gaps, NOT fixed here (owners)

| Gap | Owner |
| --- | --- |
| G3-1: the Edge passes a missing / string `is_anonymous` and hard-codes `false` into the DB claims (G5-39). | G3 |
| G4-1 / G4-2: G4's X path skips T13 / R1 (a stopped service or locked account passes) and binds only the bare owner epoch (G5-39). | G4 |
| F-1: R1 allows a personal workspace with another member (P-1). | user decision, then G5 / G3 |
| P-1 – P-5 | the user |
| PR #457's review | H3 / owner |
