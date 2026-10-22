# Common account: the brand OWNER EPOCH — a monotonic, rollback-safe, ABA-resistant source candidate

Status: **source candidate + local tests. Nothing here was applied to any database, no managed or production system was touched, no API role was granted anything, no real X / Threads /
OAuth / token / paid API was used.** Production is **NO_GO**; `managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay BLOCKED; `POSTONA_END_SOURCE_ENABLED` is untouched; the AI Option B RPC and
G6's consult handler stay on HOLD (not part of this task).

TASK `common-account-f5-shared-owner-epoch-monotonic-source-candidate-20261019` (priority source: POSTONA 総合指令室, Issue #269 comment 6251536852: `F5_SHARED_OWNER_EPOCH_SOURCE_CANDIDATE_GO / NEW_MANAGED_APPLY_NO_GO`).
It stacks on PR #279 (M2) and adds only: the candidate `supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql` (+ its rollback), this document, one pinned provenance file and an F5-owned local test
harness. It edits **no** writer of `public.brand_memberships` and no file of F3 / G3, G4, F4, F1, F6, H5.

**J1 V1 limited fix (R1–R3, PR #285 review comment 6257083935).** This revision changes only F5-owned files on a new branch stacked on PR #285:
**R1** a rollback and every (re-)install now move **every** recorded number, so no number issued before a rollback is ever valid after the re-install (an A→B→A or a re-created
workspace made while uninstalled, and an untouched workspace, all refuse an earlier attestation); **R2** the coverage check accepts only the **exact** triggers of the candidate
(function OID, event and timing bits, no WHEN clause, no column list, not a constraint trigger, no arguments, enabled) and refuses while an API role can reach the TRIGGER privilege
(which lets a role replace the fence trigger by name — shown in the suite), TRUNCATE / REFERENCES / a write (anon, authenticated) or `SET session_replication_role`; **R3** every
role an API role is a **member** of — directly or through intermediate roles, with or without INHERIT or SET, ADMIN-only edges included — is examined with its own privileges, so a
NOINHERIT path that can still `SET ROLE` to the owner or a superuser is refused. The bump also locks the epoch row **before** it reads the owners. **Dependency (F3 / G3, not edited
here):** the install now refuses while an API role holds TRIGGER, or anon / authenticated hold TRUNCATE / REFERENCES, on `public.brand_memberships` (L-1); the local runner stands in
for that revoke.

Evidence labels: **[O]** observed in a pinned file (`brand-owner-epoch-provenance.json`, re-checked by `supabase/tests/common_account_owner_epoch_provenance_check.py`), **[D]** derived by a test of
this task (section 8), **[R]** recorded in a coordination file, **[A]** assumption, **[U]** unknown, never inferred.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Is there a durable owner-change counter in F5 today? | **No.** `private.account_lifecycle_brand_owner(brand)` says who the owner is *now*; nothing says whether the owner changed in between. G4's `private.account_lifecycle_brand_owner_epoch` is a **TEST-ONLY stand-in** (PR #282), not a contract. |
| What this candidate provides | `private.account_lifecycle_brand_owner_epoch(p_brand_id text) → bigint`, owner-only, `STABLE`, `SECURITY DEFINER`, empty `search_path`: the epoch (≥ 1) of a workspace with **exactly one owner**, **NULL = unknown, refuse** otherwise. It moves on **every committed write that touches an owner membership row** and never goes back. |
| Is it ABA-resistant? | Yes, on the local PostgreSQL 17 (**[D]**): A→B→A through delete + insert, through role swaps, and owner→admin→owner are three different numbers; an attestation made at the first is refused at the last although the owner is the same person. |
| Is it rollback-safe? | Yes: a rolled-back transaction, a rolled-back savepoint, a handled exception and a failed statement move nothing (the number lives in the same transaction as the membership write). |
| Does it cover every membership writer? | It covers every writer **without editing any**: the row trigger fires for the X onboarding RPC, F4's Threads provisioner, the deletion saga's brand delete (cascade), the service key and manual SQL; a statement trigger covers TRUNCATE. A write that bypasses the triggers (disabled trigger, `session_replication_role = replica`) is **detected** and the getter refuses until the resync. |
| Can a rollback + re-install make an earlier number valid again? (R1) | **No.** The rollback moves every recorded number on before it drops the triggers, and every install moves every recorded number (and every owner workspace) on again, whatever happened meanwhile. |
| Can a same-named trigger pass the coverage check? (R2) | **No.** Only the exact triggers count; eleven fake variants are refused (test `J1 V1 R2: a same-named trigger…`). |
| Can an API role reach something that defeats the fence? (R2, R3) | The getter answers NULL and the install refuses while any API role can reach — through any membership, INHERIT / SET / ADMIN-only — the table owner, a superuser, `SET session_replication_role`, TRIGGER, or (anon / authenticated) a write / TRUNCATE / REFERENCES on the table. |
| Applied anywhere? | **No.** Apply needs the independent focused Codex Sol (high) review of this file, the PR #233 limited recheck, and the owner's explicit approval. |

## 2. Who writes `public.brand_memberships` today (owner path evidence)

| Operation | Writer | Where | Owner | Edited by this task? |
| --- | --- | --- | --- | --- |
| INSERT owner (workspace + owner on first X connection) | `public.begin_social_mobile_x_oauth_connection` | `20260919120000…`, reconnect version `20260922003101…` (main) [O] | F3 / G3 + G4 (wrapped by F3's T13 guard, PR #257) | no — the trigger fires for it (test `the real X onboarding RPC keeps working`) |
| INSERT owner (Threads-only person's personal workspace) | F4's workspace provisioner | `supabase/candidates/postona_threads_oauth_workspace_candidate.sql` (PR #263 and the stack below) [O] | F4 / G4 | no — same trigger |
| DELETE (cascade) at the end of a deletion | the account-deletion saga's last statement `delete from public.brands where id = v_workspace;` ("Cascades brand_memberships") | `20260928160000…` (main) [O] | F3 / G3 | no — the cascade fires the row trigger (test `the history only goes up…`) |
| INSERT / UPDATE guard (refuses creation while a deletion is open) | `public.social_mobile_account_deletion_guard`, `before insert or update` | same file [O] | F3 / G3 | no — it is a BEFORE trigger; the new triggers are AFTER |
| UPDATE (role change, owner transfer) | **none in the repository** | — | — | no writer exists: a transfer today is manual SQL or the service key |
| Any end-user API write | **none**: `revoke insert, update, delete on table public.brand_memberships from anon, authenticated` | `20260918120000…` (main) [O] | — | the install **refuses** if that ever changes |
| TRIGGER (all API roles), TRUNCATE / REFERENCES (anon, authenticated) | **not revoked** by that migration (no `revoke truncate`, no `revoke trigger`) [O]; the default grants of a new table give them [A] | `20260918120000…` (main) | **F3 / G3** | no — the install **refuses** while they are there (L-1, dependency) |

Exact owner for the new objects: **F5** (a new trigger on a shared table, plus private objects; no path of another slot is edited; the candidate lives under a new F5-only directory, not in `supabase/migrations/`).
No open PR touches that directory or the names `common_account_owner_epoch*`; the only neighbouring file is G4's test-only `supabase/tests/postona_x_owner_epoch_f5_stand_in.sql` (PR #282), which is a different path.

## 3. The contract

| Function | Shape | Caller | Answer |
| --- | --- | --- | --- |
| `private.account_lifecycle_brand_owner_epoch(p_brand_id text)` | `→ bigint`, `STABLE`, `SECURITY DEFINER`, `set search_path = ''` | **owner only** (EXECUTE for no API role, directly or through a membership; the install asserts the exact ACL) | the epoch (≥ 1) when **all** hold: the argument is not NULL; the two write triggers are **exactly** the candidate's and enabled, no API role can reach anything that defeats them, and **this** session honours triggers (`private.account_lifecycle_brand_owner_epoch_covered()`); the workspace has a recorded epoch; it has **exactly one** owner row; and that owner is the one the last bump recorded. **Otherwise NULL.** |
| `private.account_lifecycle_brand_owner_epoch_covered()` | `→ boolean` | owner only | the coverage check the getter uses: `session_replication_role = origin`; `private.account_lifecycle_owner_epoch_exposure()` is NULL; and exactly two triggers named `account_lifecycle_owner_epoch_row` (`tgtype = 29`: row, AFTER, INSERT / DELETE / UPDATE, `tgfoid` = `_record()`) and `account_lifecycle_owner_epoch_truncate` (`tgtype = 32`: statement, AFTER, TRUNCATE, `tgfoid` = `_truncated()`), each enabled (`O` / `A`), not internal, no `WHEN` (`tgqual` NULL), no column list, not a constraint trigger, no arguments, no transition tables, its function owned by the table owner, definer, empty `search_path` |
| `private.account_lifecycle_owner_epoch_exposure()` | `→ text` | owner only | NULL, or the first of `API_ROLE_CAN_BECOME_SUPERUSER`, `API_ROLE_CAN_BECOME_OWNER`, `API_ROLE_CAN_SKIP_TRIGGERS`, `API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS`, `API_ROLE_CAN_WRITE_MEMBERSHIPS`, evaluated for every role that `anon`, `authenticated`, `service_role` or `authenticator` is a **member** of (`pg_has_role(…, 'MEMBER')`: direct or indirect, INHERIT or not, SET or not) with that role's own privileges |
| `private.account_lifecycle_brand_owner_epoch_resync(p_brand_id text)` | `→ bigint`, `VOLATILE` | owner only (an operator step) | records the actual owners again and moves the number by one: it treats "unknown" as a change. Refused while the coverage is broken. |
| `private.account_lifecycle_owner_epoch_bump / _record / _truncated / _history_guard` | internal | owner only | not an interface |

NULL means **refuse**, never "no change yet": the stand-in returned 0 for an unknown workspace; this candidate never does. The first recorded state of a workspace is **1**.

**Callers' rule (for G4 / F3):** store the epoch you read **in the same statement or transaction** that reads the owner (`brand_owner` and the epoch are two reads; read them under the membership `FOR SHARE` lock F4 already takes or in one statement),
require it NOT NULL when recording, and compare with `=` (a NULL on either side fails closed); do not compare with `IS NOT DISTINCT FROM`, which would treat unknown = unknown as equal. G4's candidate already declares `owner_epoch bigint not null` and compares with `=` / `is distinct from` against a stored non-null value, which is safe.

## 4. Design, and why each choice

* **A counter in the same transaction as the write.** The number is a row of `private.account_lifecycle_brand_owner_epochs` updated by an AFTER row trigger, so it commits or rolls back with the membership change. It is **not** inferred from the owner id, a hash, `max(updated_at)`, `now()`, `xmin` or a sequence.
* **Initial generation = 1.** The first time an owner state is recorded the number is 1. The install is a **re-start fence** (R1): every workspace that has an owner row, and every already recorded one, is bumped **unconditionally** (or created at 1). Comparing the recorded owner with the actual one (the PR #285 head's reconciliation) was not enough: an A→B→A made while the triggers were absent ends with the recorded owner and would have kept its old number.
* **Never back.** A guard trigger on the epoch table refuses a decrease, a re-key, a delete and a truncate — for its owner too. The row has **no foreign key** to `brands`: the row of a deleted workspace stays, and a re-created workspace of the same id continues from its old number (test `the history only goes up…`).
* **Which writes bump.** Per row: INSERT of an owner row; DELETE of an owner row; UPDATE that changes `(brand_id, user_id, role)` when the old or the new row is an owner (one bump per workspace touched; an owner row that moves between workspaces bumps both). An update that changes none of the three, and any write to a non-owner row, moves nothing. TRUNCATE is a change of **every** recorded workspace.
* **Owner states the getter vouches for.** Exactly one owner row *and* the recorded owner equals it. With two owners, no owner, or a record that disagrees with the table, the answer is NULL.
* **Bypass is detected, not assumed away.** A disabled or dropped trigger, or a session that does not fire triggers, makes the getter NULL for the session or for everyone; a write made without the trigger leaves the recorded owner different from the actual one, which the getter detects (an A→B→A made entirely without triggers is **not** detectable; that needs the coverage guarantee, i.e. the review and the object ownership).
* **Concurrency.** The bump takes one row of the epoch table inside the AFTER trigger, and reads the owner rows only **after** it holds that row lock (a new statement, a fresh snapshot): a bump that waited for another membership row's bump records the owners that one committed (test `concurrency (lock before read)`). Concurrent owner changes of a workspace serialize and each moves the number once (test `concurrency`). Readers take no lock and see only committed numbers. The one cycle this adds: two transactions that each touch two owner rows of the same workspace in opposite orders may deadlock; PostgreSQL aborts one (`40P01`), nothing is written, nothing regresses.
* **Rollback and re-install are a durable generation change (R1).** The rollback file first moves **every** recorded number on, then removes the triggers and the functions (so the getter disappears and a caller that needs it refuses), and **keeps** the table, its guard trigger and function. A re-install moves every recorded number on again. The numbers are durable rows guarded against a decrease, so this survives any number of cycles (tests `install`, `J1 V1 R1: …`).
* **The exact triggers, not their names (R2).** A same-named trigger with another function, a `WHEN` clause, a column list, fewer events, BEFORE timing, statement level, a constraint trigger, arguments or replica-only firing does not count. The suite shows why it matters: with only the TRIGGER privilege, `CREATE OR REPLACE TRIGGER account_lifecycle_owner_epoch_row …` by an end-user role **replaces** the fence trigger.
* **Every membership path, not only inherited privileges (R3).** `pg_has_role(…, 'USAGE')` misses a NOINHERIT grant that still allows `SET ROLE`, and `'SET'` misses an ADMIN-only edge (which lets the holder grant itself the role). The candidate follows `'MEMBER'`, which includes all of them, and checks each reached role with its own privileges. In the model world the owner is itself a member of the API roles, so an API role → owner edge would be a cycle; the suite takes that edge away for the R3 test.
* **Lock order.** Writer's own rows → one epoch row (inside the trigger). It sits after F5's I1 (login → common account → entitlement) and after F4's workspace locks, and F5's own functions take no membership lock (M1, `m1_contract_doc_test.ts`).

## 5. What it does not guarantee

A superuser or the table owner can still drop the history guard or the triggers; the getter and the install checks detect most of it, the review and the object ownership cover the rest. In particular, a trigger that the **owner** disabled or replaced and later restored exactly counts again, and a write made in that window that ended with the recorded owner is not detectable (L-6): after any such maintenance the operator runs the rollback file and the install (which moves every number), not only the restore. It says nothing about *who* the owner should be (that is `brand_owner`'s user-workspace rule), about the X identity (G4) or about the AI plan. It does not stop a call already in flight (no database lock spans an HTTP call; M1-F3).
It is not applied anywhere; managed Supabase behaviour (the real roles, `session_replication_role` handling, the platform's default privileges) is NOT_VERIFIED.

## 6. Findings (each with an owner; none is fixed here)

| # | Finding | Evidence | Owner / consequence |
| --- | --- | --- | --- |
| **L-1** | **Install dependency (R2).** The API roles keep **TRIGGER** (and anon / authenticated **TRUNCATE, REFERENCES**) on `public.brand_memberships`: the membership migration revokes only insert / update / delete; the default grants of a new table cover the rest. TRIGGER alone lets a role replace the fence trigger by name (shown in the suite). The candidate therefore **refuses to install** (`OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS` / `…_CAN_WRITE_MEMBERSHIPS`) and the getter answers NULL while any of them is there. | [O] provenance `MEMBERSHIPS-TABLE-GRANTS` (no `revoke truncate`, no `revoke trigger`); [D] the model world has them, the runner revokes them as a TEST-WORLD stand-in; managed grants NOT_VERIFIED | **F3 / G3** (the table's migration): `revoke trigger on public.brand_memberships from anon, authenticated, service_role; revoke truncate, references on public.brand_memberships from anon, authenticated` — **not** edited here; required before any apply. |
| **L-2** | **PR #282's stand-in does not match this contract**: it returns **0** for an unknown workspace (this candidate returns NULL); it has no owner cross-check, no coverage check, no TRUNCATE trigger, no history guard, no reconciliation and no resync; it is installed by a test file. | [O] provenance `G4-OWNER-EPOCH-STAND-IN` | **G4**: treat NULL as "unknown, refuse"; do not rely on 0; replace the stand-in by this candidate in the local proofs. G4's own checks (`getter exists`, returns `int8`, owner-owned, no API-role EXECUTE) match the shape. |
| **L-3** | The history row of a deleted workspace stays (it is what keeps the number from repeating). It holds a workspace id (a hash-derived slug), a counter and a user uuid of the last owner; the uuid is replaced at the next bump and nulled by the truncate path or whenever the workspace has no single owner. | the candidate | **owner decision** (privacy): whether the last owner uuid may stay after the account is erased; if not, the resync / a deletion hook can null it without lowering the number. Not implemented. |
| **L-4** | Install takes `lock table public.brand_memberships in share row exclusive mode` (writers wait, readers do not) and `lock_timeout` 5 s. | the candidate | apply-time note. |
| **L-6** | Owner-level trigger maintenance (disable / replace, then restore) re-validates the numbers it did not see. | the candidate; test `J1 V1 R2: a same-named trigger…` restores and reads the same number | **operator rule**: after any such maintenance run the rollback file and the install (every number moves). Only the table owner or a superuser can do it (the exposure check keeps every API role out). |
| **L-5** | Review status: PR #282's J2 re-review (`postona-j2-pr282-r1-r2-atomic-credential-focused-rereview-20261018`) is **ready, not done**; no independent PASS exists for this candidate or for G4's use of it. | [R] `.agent_v2/ACTIVE_TASK.md` | **J2 / Sol (high)**; nothing here claims a PASS. |

## 7. Apply dependencies and order (all NO_GO today)

0. **F3 / G3 revoke TRIGGER (anon, authenticated, service_role) and TRUNCATE / REFERENCES (anon, authenticated) on `public.brand_memberships`** (L-1); the install refuses before that.
1. Independent focused Codex Sol (high) review of `001_brand_owner_epoch.sql` (trigger, definer functions, ACL, install lock) — **required before any apply**; J-slot allocation only after the slot checks.
2. The PR #233 limited P2×4 recheck (separate gate before any managed apply) and the Phase 13 gates (PG1 to PG7) — none is opened by this task.
3. The owner's explicit approval; apply as a **single reviewed file**, never `db push`; first on a disposable project (Phase 13 plan), compare the postconditions.
4. Order with the others: this file has no dependency on P3b to P10; G4's PR #126 candidate and G4's 001 **refuse to apply without the getter** (their preconditions), so this file goes first. Rollback: `001_brand_owner_epoch_rollback.sql` (history kept).

## 8. What was run (offline; exact commands and results in section 10)

* **The owner-epoch suite** — `common_account_owner_epoch_run.sh` runs `common_account_owner_epoch_test.ts`: 19 tests on a throw-away local PostgreSQL 17 (the Phase 11 model baseline, the **real** membership migration `20260918120000`, the **real** X onboarding RPC, the ten F5 chain files, then the candidate): install and re-install moving every number (including the refused install when an end-user role could write); R1 rollback / re-install with A→B→A, a same-id re-created workspace and an untouched one, each refusing the earlier attestation with the mock transport not called; R2 eleven fake same-named triggers, TRIGGER really replacing the fence, TRIGGER / DELETE through a NOINHERIT role, TRUNCATE, REFERENCES and `SET session_replication_role`; R3 a direct NOINHERIT + SET edge to the owner, an indirect SET chain to a superuser and an ADMIN-only edge, each with `USAGE` false; lock-before-read concurrency; ACL; the write matrix; A→B→A / owner→admin→owner / delete + insert; two owners and recovery; rollback, savepoint, handled exception, failing statement; concurrency (uncommitted invisible, serialization, abort); history guard, deleted and re-created workspace, person deletion; bypass detection (disabled trigger, dropped trigger, replica role, changed owner) and the resync; isolation (other workspaces, entitlements, accounts, Vault, X rows); the real onboarding RPC; a stale attestation sends nothing (a counting mock, SIMULATED); TRUNCATE.
* **Mutation check** — `common_account_owner_epoch_mutations.py`: each recorded write event, the lock-before-read bump, each getter refusal, each exact-trigger condition, each exposure branch and the `MEMBER` path (against `USAGE` and `SET`), the history guard, the re-start fence of the install and the rollback, and the ACL is broken in a copy; the suite must fail.
* **Provenance** and the **document test** `owner_epoch_doc_test.ts`.

## 9. NOT_VERIFIED, owners and next steps

| Item | Owner | Next step |
| --- | --- | --- |
| managed Supabase behaviour (roles, default privileges, `session_replication_role` for the platform's own jobs, replication) | owner | Phase 13 gates, not opened |
| independent security review of the candidate and of G4's use | J2 / Sol (high) | allocate after the slot checks |
| G4's / F3's use of the number in their proofs (replace the stand-in) | G4, F3 | direct ACK of this contract (section 3) |
| the F4 Threads provisioner and any future writer | F4 / owner | the trigger covers them; re-run this suite when a new writer lands |
| L-1 revoke (install dependency), L-3 privacy, L-6 operator rule | F3 / G3, owner | L-1 before any apply; decisions |
| Option B AI RPC, G6 consult handler | — | HOLD, unchanged |

## 10. Re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_owner_epoch_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_owner_epoch_mutations.py <repository root>
python3 -I supabase/tests/common_account_owner_epoch_provenance_check.py
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/owner_epoch_doc_test.ts
```

## 11. What was executed for this document (offline; exact commands and results)

All commands of this revision (J1 V1 R1–R3) ran in `/Users/yuya/Developer/kabumori-f5-oe2` (a clean worktree stacked on PR #285) against a throw-away local PostgreSQL 17.11 (`listen_addresses`
empty, a Unix socket under `/private/tmp`, fake data, deleted at the end; every runner refuses a host that is not a `/tmp` socket directory). No managed or production system, no credential,
no network request of any kind, no real X / AI.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | **the owner-epoch suite** (section 8) | `CAL_PGHOST=<tmp socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_owner_epoch_run.sh` | **19 passed**, 0 failed (three consecutive runs) |
| 2 | mutation check (write events, lock-before-read, getter refusals, exact-trigger conditions, exposure branches, `MEMBER` against `USAGE` / `SET`, history guard, re-start fence of install and rollback, ACL) | `python3 supabase/tests/common_account_owner_epoch_mutations.py <repository root>` | control PASS, **44/44 detected**, 0 invalid |
| 3 | the cited sources are the pinned blobs and contain the quoted names; the missing TRUNCATE and TRIGGER revokes are pinned as absences | `python3 -I supabase/tests/common_account_owner_epoch_provenance_check.py` | `OE_PROVENANCE\|ALL\|PASS` (9 sources) |
| 4 | this document's claims and the candidate's shape, including the R1–R3 source checks | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/owner_epoch_doc_test.ts` | **7 passed**, 0 failed |
| 5 | the whole harness suite, earlier tests included | `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **184 passed**, 0 failed (183 before + 1) |
| 6 | type-check and lint | `deno check --no-config supabase/preflight/managed_disposable/*.ts supabase/preflight/managed_disposable/x_saga_standin/*.ts supabase/tests/common_account_owner_epoch_test.ts`; `deno lint --no-config supabase/preflight/managed_disposable/ supabase/tests/common_account_owner_epoch_test.ts` | no error; `Checked 45 files`, no problem |
| 7 | scope and hygiene | `git diff --name-only`; `git diff --check`; scan of the diff for key shapes, connection strings with a password and project hosts; `git merge-tree --write-tree origin/main HEAD`; open PRs touching these paths | 8 files, all F5-owned files of PR #285; nothing under `supabase/functions/`, `supabase/migrations/`, `apps/` or `.agent*`; clean; 0 key shapes; 0 passworded connection strings; 0 project hosts; no conflict with `origin/main`; PR #287 (G4/F4) pins PR #285 at `3a5eef3d` and is not changed; the heads of PRs #233, #263, #265, #275, #276, #278, #279, #282 and #285 are unchanged |

Not run, on purpose: any managed or production access; applying the candidate anywhere but the throw-away database; F3's revoke (L-1, not edited here); G4's / F4's proofs (PR #287) against this
revision; the independent Sol (high) re-review; the PR #233 limited recheck.

## 12. G5-20 revision: column / system-column ACLs and every privilege on the history

TASK `common-account-g5-l1-brand-memberships-column-acl-exposure-source-candidate-20261022` (Issue #320, G5-01 generation, task 20, completion K5).
It implements G5-19's Q1 / Q2 proposals (PR #441, `docs/common-account/g5-19-brand-memberships-column-acl-answers.md`) in this candidate. Stacked on
PR #441. **Source candidate only:**
- it changes no migration, no G3 / G4 / G6 file and no existing grant;
- it is not applied anywhere;
- it needs the independent focused Codex Sol (high) review before it counts.

Production stays **NO_GO**. G3's PR #370 race (system-column ACL between its last check and COMMIT) and the A1 / A2 / B risk decision are **not** part of this
revision and are not treated as decided.

| Finding before G5-20 | [D] evidence | What the exposure check now refuses (code) |
| --- | --- | --- |
| A **column-level** INSERT / UPDATE / REFERENCES of anon / authenticated was invisible: `has_table_privilege` ignores column ACLs; a REFERENCES on `(brand_id, user_id)` alone gives an FK onto memberships (existence probe past RLS, the deletion cascade blocked) | G5-19 suite rows 3-4 | `API_ROLE_CAN_WRITE_MEMBERSHIPS_BY_COLUMN` (via `has_any_column_privilege`, for every role anon / authenticated reach) |
| Column ACLs of other API roles / PUBLIC, and **system-column** ACLs (`ctid`, `xmin`, …: `has_any_column_privilege` ignores them), were invisible | G5-19 suite row 6 | `API_ROLE_HAS_MEMBERSHIP_COLUMN_ACL`: the column-ACL allowlist of `public.brand_memberships` is **empty**. No `attacl` item, on a user or system column, for PUBLIC or any role anon / authenticated / service_role / authenticator reach. |
| The **history** `private.account_lifecycle_brand_owner_epochs` was checked only at install, and only for SELECT .. TRUNCATE. TRIGGER / REFERENCES / MAINTAIN / column grants, grants to a reached role other than the four API roles (a global or schema default privilege), and anything granted later went unseen. A reached role with TRIGGER on it runs **its own code as the owner** inside every bump. | this revision's suite: "why the history matters" | `API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY`: no privilege of any kind (table, column, system column, TRIGGER, REFERENCES, MAINTAIN) for PUBLIC or any reached role |

### How the revision behaves

- **Same mechanics as before.** The three checks are in `private.account_lifecycle_owner_epoch_exposure()`, after the earlier findings, which keep
  their codes and order. Like the rest of the coverage they run on **every read** of the getter: a grant committed by another session is refused by
  the next statement of an open READ COMMITTED transaction [D].
- **At install time:**
  - a finding present before the install refuses it (`OWNER_EPOCH_PRECONDITION_<code>`), and nothing is left;
  - a default privilege that would hand the new history to a reached role makes it refuse at the postcondition
    (`OWNER_EPOCH_POSTCONDITION_EXPOSURE`, or the older `…_TABLE_ACL` for SELECT .. TRUNCATE);
  - a default to PUBLIC or to the four API roles is removed by the install's own `revoke all`.
- **After a rollback:** the history stays; a grant on it while uninstalled refuses the re-install
  (`OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_REACH_OWNER_EPOCH_HISTORY`); after the revoke, the re-install moves every number on.
- **Not findings:**
  - the contract grants (`authenticated` table SELECT, `service_role` table DML);
  - grants to roles no API role reaches;
  - grants to a role that is a member **of** an API role;
  - an owner → owner system-column entry (G3's A1 leaves none).
- **Effect to accept:** a stray column or history grant makes every epoch consumer refuse until it is revoked. This is fail closed on availability.
- **Not covered (and not claimed):**
  - MAINTAIN on `public.brand_memberships` (G3's open MAINTAIN item; it does not let a role replace the fence or write);
  - other tables;
  - a role-graph or ACL change between a read and the statement that uses it (the consumer contract of G5-11 keeps verdict and use in one
    statement);
  - G3's system-column race in its own revoke file;
  - managed / production (NOT_VERIFIED).

### Tests of this revision ([D], throw-away PG17 17.11)

| Suite | What |
| --- | --- |
| `supabase/tests/common_account_owner_epoch_acl_pg_run.sh` (13 tests) | the deny-net: column write paths (5); column ACL allowlist (6); system columns (6); NOINHERIT / SET-false / two-hop memberships; non-findings; the history (8 grant shapes); the owner-run trigger proof; install preconditions; global / schema default privileges; rollback + re-install; per-read under READ COMMITTED; code order |
| `supabase/tests/common_account_owner_epoch_acl_mutations.py` | 16 mutants of the new rules; the deny-net must fail each one |
| `supabase/tests/common_account_owner_epoch_run.sh` and its mutation script | the 19 earlier tests and their mutants, unchanged |
| `supabase/tests/common_account_bm_column_acl_pg_run.sh` (G5-19) | its gap assertions flipped: the candidate now sees the grants G5-19 showed invisible |

**Before any apply:**
- the independent focused Codex Sol (high) review of this revision (the G5 担当ちゃ registers it on a free H slot after accepting this source REPORT);
- G3's L-1 revoke;
- the PR #233 limited recheck;
- the user's explicit approval of a production mutation window with a read-back.

## 13. G5-21 revision: a trigger left on the history

TASK `common-account-g5-owner-epoch-history-stale-trigger-p2-source-fix-20261022` (Issue #320, G5-01 generation, task 21, completion K5).
- Finding: H3 proxy review R1 on PR #446 (Issue #330 comment 6332954454, by Claude as a proxy, **not** the independent Codex review; accepted as a
  finding only, comment 6332985063).
- Stacked on PR #446. **Source candidate only:**
  - not applied anywhere;
  - no migration, no G3 / G4 / G6 file, no existing grant changed;
  - still needs the independent focused Codex Sol (high) review.
- Production stays **NO_GO**.

**The finding [D].** A role that held TRIGGER on `private.account_lifecycle_brand_owner_epochs` could create a trigger there. That trigger:
- **survived the revoke**;
- ran **as the owner** inside every bump;
- as a BEFORE UPDATE trigger that sets `new.epoch := old.epoch`, held the number still (owner → admin → owner left it at 1). The getter answered
  again (exposure `NONE`) as soon as the privilege was gone;
- survived the rollback and the re-install, and held the re-start fence still too.

The G5-20 check looked only at the privilege, never at the triggers it left behind.

**The fix.**

| Where | What | Code |
| --- | --- | --- |
| `private.account_lifecycle_owner_epoch_history_triggers()` (new, owner-only) | The history's **non-internal** triggers must be exactly its two guards. A guard is checked by name, `tgfoid` = the guard function, `tgtype` (27 row BEFORE UPDATE+DELETE / 34 statement BEFORE TRUNCATE), enabled, no WHEN, no column list, not a constraint trigger, no arguments, no transition tables; the function is owned by the table owner, SECURITY DEFINER, empty `search_path`. | `HISTORY_FOREIGN_TRIGGER` (any other name), `HISTORY_GUARD_TRIGGER_NOT_EXACT`, `HISTORY_MISSING`; NULL = exact |
| coverage (`…_covered()`) — every read | also requires the function above to be NULL | the getter answers NULL; the resync raises `OWNER_EPOCH_COVERAGE_BROKEN` |
| every bump, and the truncate path | refuse **before** writing the history, so no foreign code runs as the owner; the owner-membership write fails as a whole | `OWNER_EPOCH_HISTORY_TRIGGERS_NOT_EXACT` |
| every bump, and the truncate path, after writing | the row as stored must be exactly the one written (number +1, the owner fields). This catches a trigger committed while the bump waited for the history lock, which the check before writing could not see. | `OWNER_EPOCH_BUMP_NOT_RECORDED` |
| install, re-install over a kept history | refuse while the kept history has a foreign or inexact trigger (nothing is dropped, nothing is left) | `OWNER_EPOCH_PRECONDITION_HISTORY_FOREIGN_TRIGGER`, `OWNER_EPOCH_PRECONDITION_HISTORY_GUARD_TRIGGER_NOT_EXACT` |
| install, after | exact again (defence in depth: during the install the history is locked against a new trigger) | `OWNER_EPOCH_POSTCONDITION_HISTORY_TRIGGERS` |
| rollback file | refuse while a foreign trigger is there; each kept number must move by exactly one | `OWNER_EPOCH_ROLLBACK_HISTORY_FOREIGN_TRIGGER`, `OWNER_EPOCH_ROLLBACK_BUMP_NOT_RECORDED` |

**Behaviour, and what stays out of scope:**
- **Internal triggers are not counted.** An FK onto the history needs REFERENCES, which the exposure check refuses, and the history key never
  changes.
- **No file here drops a trigger it did not create.** Removing a left trigger is the owner's decision. Until then, every owner change is refused,
  so no ABA can happen in the meantime, and the number the getter answers afterwards is still right [D].
- **Owner-level maintenance of the guards** (disable, re-create, alter the function) stays the operator rule of L-6: run the rollback file and the
  install.

**`public.brand_memberships` (PR #303 scope, not changed here) — read-only assessment [D].**
- The coverage there matches its two epoch triggers by identity, but does not require that **no other** trigger exists.
- A trigger left by a role that once held TRIGGER keeps the coverage true. The **numbers stay right**: the AFTER row trigger sees the final row.
  But the left trigger's code runs as the writer (the owner through the definer RPCs, or `service_role`).
- Other features own legitimate triggers on this table: G3's `social_mobile_account_deletion_guard` (BEFORE INSERT / UPDATE). So a blanket refusal
  would break them.
- Proposal [P], for a separate G5 TASK agreed with G3 (the table's owner):
  - an allowlist of the table's triggers, matched by function identity and owner (this file's two plus G3's deletion guard, and whatever else G3
    lists);
  - a fixed refusal code;
  - the same "refuse before write" for the epoch path only;
  - an independent Sol (high) review.
- Nothing is decided or changed here.

**Still not covered:**
- MAINTAIN on `public.brand_memberships`;
- other tables;
- role-graph changes between two reads;
- G3's PR #370 system-column race and the A1 / A2 / B / C choice;
- the Q1 allowlist's formal approval;
- managed (NOT_VERIFIED).

| Suite | What |
| --- | --- |
| `supabase/tests/common_account_owner_epoch_history_trigger_pg_run.sh` (7 tests) | H3's Q0-Q4: **FAIL before** on PR #446's head `32b258ba` (read with `git show`) and **refused after**; 15 guard variants (14 by the owner, one function hand-over); foreign-name triggers; internal (FK) triggers not counted; truncate refused; three races (update path, insert path, rollback) caught by the written-row check; re-install refused by a left trigger or an inexact guard, then moving every number on; the `brand_memberships` observation |
| `supabase/tests/common_account_owner_epoch_history_trigger_mutations.py` | 19 mutants of the new rules (three equivalent ones left out and named in the script) |
| the G5-20 suite | its "why the history matters" test flipped: the write is now refused and the foreign code never runs |
| the earlier mutation scripts | sites moved with the code: three in the owner-epoch script (the truncate path, the rollback, the lock order), five more there and one in the G5-20 script made unique because the new function repeats the trigger-shape text; every site of the three scripts occurs exactly once |
