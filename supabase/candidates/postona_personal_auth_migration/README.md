# POSTONA personal auth: the entrypoint-only migration candidate (G5-42 — NOT applied, NOT in `supabase/migrations/`)

Production **NO_GO**.
- This directory is a **candidate**: nothing here has been, or may be, applied to a managed or production database by this work.
- Moving it into `supabase/migrations/` and applying it needs, in order:
  1. PR #457 accepted (P2 below);
  2. this candidate's own security review if its boundary changed (see §4);
  3. the managed read-only audit (G5-18 gates) with the user's approval;
  4. the owner's explicit production approval.

## 1. What ships (and what does not)

| File | What it is |
| --- | --- |
| `20261028090000_postona_personal_auth_install.sql` | The bundle's **`INSTALL_ALL.sql`** (PR #537, H2 focused PASS on F1 / F2), with **one** read-only block inserted after its single `begin;`: the machine-checked **prerequisites** (§2). One transaction: a failure, a refusal or an interruption leaves nothing, and no session sees a loose R1 / R0 before D1. |
| `ROLLBACK_20261028090000_postona_personal_auth.sql` | The bundle's **`ROLLBACK_ALL.sql`, byte for byte.** One transaction with a mandatory preflight: the exact installed state, no outside caller (lower-cased source), no recorded dependent, no superuser. Only then the drops. |

`supabase/tests/postona_personal_auth_migration_build.py --check` re-derives both files from the bundle byte for byte. It also fails if anything else is placed here.

**Not shipped:**
- the 14 part files;
- the standalone R10 / R20 / R30 drops;
- any per-step install.

Those stay only in `../postona_personal_auth_bundle/`, as the byte-for-byte evidence.

## 2. Prerequisites, checked by the install itself (`MIGRATION_PREREQ_*`, nothing created on failure)

| # | Prerequisite | Check | State |
| --- | --- | --- | --- |
| P1 | The G5 lifecycle chain `20261001150000` … `20261015120000` (the reviewed T13 `20261010051938` among them) | One function per migration must exist. T13's exact reviewed body is checked by its own part. | G5 Draft chain; only `20261001150000` is on main |
| P3 | G3's L-1 revoke on `public.brand_memberships` (PR #370) | No API role holds TRIGGER; anon / authenticated hold no TRUNCATE / REFERENCES. Checked before P2. | G3 |
| P2 | The brand owner epoch (PR #285 → #303 → #457): exposure check clean, history guard and `brand_owner_epoch` present | presence, and the exposure check returns NULL | **PR #457's independent review is NOT accepted (H3 stopped).** The check proves presence, not acceptance. |
| P4 | `auth.uid()` (STABLE), `auth.users`, `auth.sessions` | presence and volatility | The managed GoTrue / PostgREST claims themselves are **NOT_VERIFIED** |

Beyond these, each part keeps its own preconditions:
- owner, not a superuser;
- every row visible (G5-08);
- the exact reviewed bodies and attributes of what it replaces (G5-28 – G5-31).

## 3. Apply / withdraw (procedure)

- **Apply:** as the **lifecycle owner** (never a superuser), `psql -v ON_ERROR_STOP=1 -f 20261028090000_postona_personal_auth_install.sql` in one session.
  - A refusal names its cause (`MIGRATION_PREREQ_*`, a part's `*_PRECONDITION_*`, or `BUNDLE_INSTALL_POSTCONDITION_*`). Nothing is left behind.
  - A second run refuses (`AUTH_VERDICT_ALREADY_APPLIED`).
- **Wire the consumers** after the apply, per §4 of `docs/common-account/g5-42-postona-auth-migration-and-consumer-contract.md`.
- **Withdraw:**
  1. Remove the consumers first: G3 / G4 / G6 functions, their Edge paths and app calls.
  2. Run `ROLLBACK_20261028090000_postona_personal_auth.sql` as the lifecycle owner.
  3. If it refuses (`BUNDLE_ROLLBACK_CALLERS` / `_DEPENDENTS` / `_STATE_NOT_INSTALLED`), fix the named cause. **Never fall back to part files.**

## 4. Limits (not enforced here)

- **Callers it cannot see:** dynamic SQL (a name built at run time), other databases, and callers outside the database (Edge / app). Those are removed by procedure.
- **Concurrency:** no lock against concurrent DDL by the owner.
- **Supabase CLI:** the CLI's own migration transaction handling has not been tested with these explicit `begin;` / `commit;`. Apply with psql as above, or re-verify under the CLI before adopting it there.
- **Policies:** P-1 – P-5 are undecided, and F-1 (R1 allows a personal workspace with another member) belongs to P-1.

## 5. Evidence (throw-away PostgreSQL 17.11, local socket, fake data)

`supabase/tests/postona_personal_auth_migration_pg_run.sh`:
1. First `--check`.
2. Then four worlds: all prerequisites; the last chain migration missing; PR #457's owner epoch missing; L-1 drifted (TRIGGER granted back).
3. Then `postona_personal_auth_migration_pg_test.ts` (4 tests, ×3 PASS).

| Test | What it shows |
| --- | --- |
| prerequisites | each missing one refuses with its `MIGRATION_PREREQ_P1/P2/P3` code and creates nothing; a superuser run refuses |
| one transaction | cut before D1, or before the commit → nothing committed, R1 does not exist, so a missing `is_anonymous` is never allowed |
| install | the final state, D1 in force (a missing claim → `deny`); ACLs: R1 / R0 → `authenticated`, W2 → `service_role`, SV / S2-2 / S2-3 / W1 / T13 owner-only; a second run refuses |
| rollback | refuses under a PL/pgSQL consumer of R1 (nothing dropped); otherwise the **exact** pre-install catalog (bodies, ACLs, owners, attributes, settings); reinstall gives the same state |

The prerequisite checks were mutated in a scratch run through the builder: 3 / 3 detected.
