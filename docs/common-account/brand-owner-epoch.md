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
