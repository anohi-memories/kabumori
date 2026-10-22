# public.brand_memberships column / system-column ACLs — G5's answers to G3's six questions (G5 proposal, not a decision)

Status: **answers + local PG17 evidence only.** No product SQL, migration, candidate, grant, RLS, Auth or managed setting is changed; no G3 / G4 / G6
file is changed; nothing touched a managed or production database (not even read-only). Production stays **NO_GO**. Every "should" below is a
proposal for the user (or the delegate) to decide; G5 decides no other owner's ownership, TASK or risk.

- TASK `common-account-g5-brand-memberships-system-column-acl-six-questions-design-20261022` (Issue #320, G5-01 generation, task 19, completion K5).
- The questions: G3's coordination on Issue #320 (comment 6330443480), from G3 TASK 19 (`postona-g3-pr370-system-column-acl-p2-contract-design-20261022`,
  Draft PR #434 head `472e9e8df7c7da60756f26bcffb722718f70cc0f`, accepted on #318 as design-only; PR #370 stays CHANGES_REQUIRED_P2).
- The reviewed code: G3's PR #370 head `547d9f920b124c9af286408eca696b10c67efe79` (H3 C3 TASK 8, Issue #330 comment 6329700338) and G5's PR #303
  owner-epoch candidate (`supabase/candidates/common_account_brand_owner_epoch/001_brand_owner_epoch.sql`, unchanged on this branch).
- Stacked on PR #438 (G5-18). New G5-owned files: this document, `supabase/tests/common_account_bm_column_acl_pg_{run.sh,test.ts}` and
  `supabase/preflight/managed_disposable/g5_19_bm_column_acl_doc_test.ts`.

**G5-20 update** (task `common-account-g5-l1-brand-memberships-column-acl-exposure-source-candidate-20261022`, Issue #320 task 20): Q2.1 / Q2.2 and the empty
allowlist of Q1 are now in the PR #303 candidate as a source revision (`docs/common-account/brand-owner-epoch.md` section 12), still awaiting its
independent Codex Sol (high) review; the gap assertions of this document's suite were flipped accordingly. The answers below are the record of
2026-10-22 and are otherwise unchanged.

Evidence labels: **[S]** a source fact read in this repository at the commits above; **[D]** reproduced by this task's PG17 suite (section 8);
**[P]** a decision candidate (G5's proposal); **[U]** NOT_VERIFIED on managed / production.

## 1. Answers at a glance

| # | Question | G5's answer |
| --- | --- | --- |
| Q1 | Future column ACLs on `brand_memberships`: forbidden or allowlisted, and who decides? | **[P]** Per-table rule: deny by default with an explicit allowlist that is **empty today** for every API role and PUBLIC, user and system columns alike. The user (or the delegate) approves; the table's owner (G3) writes it; G5 checks L-1 compatibility. |
| Q2 | Widen L-1 to `has_any_column_privilege` and to system-column `attacl`? A separate G5 TASK? | **Yes [P], as a separate G5 source TASK with a focused Codex Sol (high) review.** The gap is real [D]: three column grants are invisible to L-1 and the getter keeps answering; a column REFERENCES on the key lets an FK probe memberships past RLS and block the deletion cascade. |
| Q3 | May system-column SELECT / REFERENCES leave the guarantee (option B)? | **No objection from L-1's side [D]**: system-column grants allow no write, no FK, no anon row, nothing new for `authenticated`. The risk acceptance itself is the user's, and only if the widened L-1 (Q2) makes a lingering one fail closed. |
| Q4 | Who approves and runs the DDL / membership freeze (option A2)? | **[P]** The user approves; the operator of the already-required production mutation window runs it; G3 writes the runbook in its apply TASK. A2 alone cannot be guaranteed on managed [U]. G5 does not run it. |
| Q5 | Can G5's disposable managed environment measure same-value ALTER / GRANT rewrites and event-trigger side effects? | **Only on a disposable managed project** (Phase 13), behind the user's consent and with the conditions of section 6. On production it is **NO_GO** (it is a write); the read-only audit (G5-18) can list the event triggers but not their effects. |
| Q6 | How do the 2026-10-30 owner / explicit grants fit G3's 001 (runs as the owner, default-grant model)? | **[D]** On the existing table (old defaults) G3's 001 succeeds and G5's install follows. On a table rebuilt after 2026-10-30, G3's 001 **refuses** (`BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST`) while G5's installs without it. The fix belongs to the table's migration (G3), not to G5. |

## 2. Source facts [S]

| Fact | Where |
| --- | --- |
| The table: `brand_id`, `user_id`, `role`, `created_at`, primary key `(brand_id, user_id)`, RLS on, `authenticated` table SELECT with the self-select policy, `revoke all … from anon`, `revoke insert, update, delete … from anon, authenticated`; nothing about TRIGGER / TRUNCATE / REFERENCES or `service_role` | `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql` |
| L-1 (`private.account_lifecycle_owner_epoch_exposure()`) checks `has_table_privilege` only: TRIGGER for every API role; INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES for `anon` / `authenticated`; the getter calls it through `_covered()` on **every read** | `001_brand_owner_epoch.sql` (the exposure function and `_covered()`) |
| G3's forward candidate claims the table row and the user-column rows, refuses any column ACL at the prestate, checks `has_any_column_privilege` (INSERT / UPDATE / REFERENCES) after the REVOKE, and requires `service_role` SELECT / INSERT / UPDATE / DELETE as a **postcondition** | PR #370 `001_brand_memberships_api_privilege_revoke.sql` at `547d9f92` |
| The 2026-10-30 change: the defaults of role `postgres` in `public` stop granting new **tables** to `anon`, `authenticated`, `service_role`; existing tables keep their grants | `docs/security/supabase-data-api-explicit-grants-20261030.md` section 1 (Supabase changelog) |
| The project already uses column-level SELECT on purpose elsewhere (R-13 own-row identity tables; D-2's proposal on `social_accounts`), so "no column ACLs anywhere" is not a project-wide rule | the same document, R-5, R-13 and section 14 |

## 3. PG17 reproduction [D]

Two throw-away worlds (PostgreSQL 17.11, local socket only, fake data) are built from the REAL membership migration: **pre** (the model's old
default grants) and **post** (no default grants). G3's file is read at runtime from commit `547d9f92` with `git show` (never copied here).

| # | What | Result |
| --- | --- | --- |
| 1 | The migration's ACL | pre: `authenticated` SELECT + TRUNCATE + REFERENCES + TRIGGER, `service_role` everything, `anon` nothing. post: `authenticated` SELECT only, `service_role` nothing, `anon` nothing. Owner and RLS identical; no column ACL. |
| 2 | G3 001, then G5 001 | pre: G5's install refuses (`…_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS`), G3's 001 succeeds (`BM_PRIV_PRESTATE v2|…`), then G5 installs. post: G3's 001 refuses `BM_PRIV_POSTCONDITION_SERVICE_ROLE_DML_LOST` and leaves the ACL as it was; G5 installs directly. |
| 3 | Column grants vs L-1 (installed candidate) | `REFERENCES (brand_id, user_id)`, `UPDATE (role)`, `INSERT (brand_id, user_id, role)` to `authenticated`: `has_table_privilege` false, `has_any_column_privilege` true, the exposure check NULL, the getter keeps answering. The same REFERENCES at table level is seen at the next read and the getter answers NULL. |
| 4 | What a column REFERENCES on the key allows | A role that is a member of `authenticated` and owns a schema creates an FK onto `(brand_id, user_id)`. It sees no membership under RLS, yet an insert succeeds for another person's pair and fails (23503) for a missing one: an **existence oracle past RLS**. The workspace's `delete from public.brands` (the deletion saga's cascade) and an owner re-key both **fail** (23503 "still referenced"). Without the grant the FK is refused (42501). |
| 5 | Column UPDATE / INSERT today | With `UPDATE (role)` / `INSERT (…)` granted, `authenticated` updates 0 rows and its insert is refused by RLS (42501): only the absence of a write policy stops them. The epoch triggers keep firing for real writes (owner → admin → owner moves the epoch twice). |
| 6 | System-column grants | PostgreSQL accepts SELECT, INSERT, UPDATE and REFERENCES on system columns and records them in `attacl`; `has_any_column_privilege` ignores them; L-1 stays NULL. They allow nothing L-1 guards: `cannot assign to system column`, no INSERT target, `system columns cannot be used in foreign keys`, no unique index on `xmin`; `anon` with `SELECT (ctid)` reads 0 rows (RLS, no anon policy) and `count(*)` is refused; `authenticated` already reads `ctid` / `xmin` of its own rows through its table SELECT. |
| 7 | A widened check (model only, a function in a scratch schema, **not a candidate**) | Flags all three column grants and system-column grants to `anon`, `authenticated`, `service_role` and PUBLIC; quiet on the clean world and on an owner → owner entry. The real check misses every one of them. |
| 8 | G3's option A1 (self GRANT → REVOKE of the six system columns, one transaction) | All six `attacl` back to **NULL** (not an empty array), all six rows rewritten by the transaction, **no relation lock** on the table; a `ddl_command_end` event trigger fires once for the GRANT and once for the REVOKE; another session's system-column GRANT waits and hits its `lock_timeout` (55P03); a failing event trigger makes A1 fail as a whole (nothing left); an owner → owner entry made before is removed (narrowing only). |

## 4. The answers in detail

### Q1 — the column-ACL rule for `brand_memberships` [P]

- **Rule:** deny by default with an explicit allowlist, kept per table. For `brand_memberships` the allowlist is **empty**: no column-level privilege
  (SELECT, INSERT, UPDATE, REFERENCES; user or system column) for `anon`, `authenticated`, `service_role`, `authenticator` or PUBLIC.
  End-user access stays the table-level SELECT with the self-select policy; server writes stay the owner's definer RPCs and, where the table's owner
  decides it is needed (R-6), `service_role`'s table-level DML.
- **Why per table, why empty here:** the table holds no secret column and every column is needed by the self-select read, so a column SELECT
  narrows nothing (unlike D-2's `social_accounts`, which hides Vault references). Column write / REFERENCES grants are invisible to
  `has_table_privilege` and therefore to L-1 [D 3], and a column REFERENCES on the key is a full FK capability [D 4].
- **Who:** the user (or the delegate) approves the rule; the table's owner (G3, the owner of `20260918120000` and PR #370) writes it into the table's
  migration / candidate; G5 confirms L-1 matches it. A future allowlist entry is its own TASK that changes G3's postconditions and G5's L-1 together,
  with a Codex Sol (high) review and, for production, the user's approval.

### Q2 — widening L-1 [P]

- **Yes, in a separate G5 source TASK** (it changes PR #303's candidate, a product SQL candidate): focused Codex Sol (high) review of the diff,
  PG17 tests with a mutant per predicate, this suite's gap tests flipped, no apply.
- **What to add** (the shape the model of [D 7] measured):
  1. `has_any_column_privilege` for INSERT, UPDATE and REFERENCES, for every role `anon` / `authenticated` reach — the same predicate G3's
     postcondition uses;
  2. any system-column `attacl` item whose grantee is a role an API role reaches, or PUBLIC (system columns have no legitimate API use [D 6]).
- **Why it does not inherit G3's race:** L-1 is evaluated on **every read** of the getter, not once at install time; a grant committed after the
  last read is seen by the next read [D 3, table-level case]. The consumer contract of G5-11 (READ COMMITTED, verdict in the same statement) keeps
  each read on committed catalog state.
- **Effect to accept:** a stray column grant would make the getter answer NULL (every epoch consumer refuses) until it is revoked: fail closed on
  availability, by design.

### Q3 — option B (system columns out of the guarantee)

- **From L-1's side: no objection [D 6].** System-column grants give no write, no FK target and no row beyond what RLS and the table SELECT already
  give.
- **Conditions [P]:**
  1. B covers system columns only; user columns stay serialised.
  2. PR #370's documents state the narrowed contract, including the forward / rollback windows, R5's narrowing and the rollback refusal (R1b). These
     are G3's contract items.
  3. The risk acceptance is recorded by the user (or the delegate). G5 cannot accept it on anyone's behalf.
  4. The widened L-1 (Q2.2) is in place, so a system-column grant that lingers makes the epoch fail closed instead of going unseen.
- **A1, as a proposal [D 8]:**
  - It closes the window on PG17.11 without a table lock.
  - It leaves the ACL exactly NULL.
  - A concurrent writer is refused rather than lost.
  - It adds one event-trigger run per statement, and a failing event trigger aborts it as a whole (fail closed).
  - It removes a pre-existing owner → owner entry (narrowing only).
  - It does not serialise the role graph.
  - It depends on the PostgreSQL implementation, and managed is [U].
  - G5 sees no L-1 impact in it and **does not take on G3's SQL**.
- **G5's preference [P]:** A1 + B's wording for the remainder (role graph, managed), together with Q2. The choice is the user's.

### Q4 — option A2 (operational exclusion) [P]

- **Needed only** if neither A1 nor B is accepted, or as an extra rule inside the production mutation window. G3's 001 already requires "the user's
  separate GO, a production mutation window and a read-back".
- **Who:**
  - The user approves.
  - The operator of that window runs it.
  - G3 writes the runbook as part of its apply TASK, because it is the table's owner.
  - G5 runs nothing. G5's only role is that the getter (with Q2) acts as a detector afterwards.
- **What the runbook needs:**
  - The list of roles that can GRANT on the table: the owner's members, superusers and grant-option holders. That list comes from the read-only
    audit (G5-18 S1 / S6 / S7), which needs its own G0 approval.
  - A freeze on GRANT / REVOKE / DDL by those roles during the window.
  - A read-back of `relacl` / `attacl` afterwards.
- **Limit [U]:** the platform's own roles on managed may run DDL that the project cannot freeze. A2 alone is therefore not a guarantee there.

### Q5 — measuring on managed

- **Production: NO_GO.** A same-value ALTER / GRANT is a write, and it fires event triggers.
- **The read-only audit** (G5-18 S11 / S4, after G0) can list the event triggers and the md5 of their functions, but not what they do when they fire.
- **A disposable managed project** (Phase 13 plan, D-3 preflight gates PG1–PG7) is the only place to measure it. Conditions [P]:
  1. A new project with no real users, data or keys, linked to nothing.
  2. The user's consent phrase and cost acceptance.
  3. Time-boxed, and deleted afterwards.
  4. No OAuth / SNS / paid API.
  5. Run only G3's A1 probe and copies of the G5 test world.
  6. Record before and after: the event-trigger list, `pg_attribute.xmin` / `attacl` of the system columns, any PostgREST schema-reload effect [U], and any refusal by the platform's extensions [U].
  7. Stop and delete on any surprise.
- **NO_GO conditions:**
  - any project with real data;
  - production, or a staging project that shares users;
  - unapproved cost;
  - running as a platform administrator role;
  - a retry after a safety refusal through another path.
- **Who:** the probe content is G3's, the disposable-project harness is G5's (Phase 11 / 13), and the assignment is the delegate's.

### Q6 — the 2026-10-30 change and G3's 001 [D 1, 2]

- **The existing production table** (created before 2026-10-30) keeps its grants, so G3's 001 sees the old-default model it was written for. Its
  actual ACL and owner are [U] (audit S1 / S2).
- **A table rebuilt after 2026-10-30** (db reset, preview branch, a new or disposable project):
  - The migration's explicit grant leaves `authenticated` SELECT only.
  - `service_role` gets **nothing**.
  - TRIGGER / TRUNCATE / REFERENCES never appear.
  - Then G5's install needs no revoke, while G3's 001 refuses on its `service_role` DML postcondition (fail closed, nothing changed).
- **[P] for G3** (the table's migration owner; part of G3's Data API inventory, due 2026-10-27, still unassigned), one of:
  - (a) an explicit, R-6-justified `grant select, insert, update, delete on public.brand_memberships to service_role` in the table's migration
    (R-2 / R-3: revoke all, then the minimal grants); or
  - (b) 001 treating a `service_role` without DML as a precondition to report rather than a postcondition failure.
- **Owner:** the change does not move the table owner. Both files run only as the table owner, never as a superuser. Which role owns the table on
  managed is [U].
- **[U]:** the changelog names SELECT / INSERT / UPDATE / DELETE. Whether TRUNCATE / REFERENCES / TRIGGER defaults also stop is unverified. If they
  remain, G3's revoke stays necessary on a rebuild too. The post world models "no defaults at all".

## 5. Decision candidates and who does what [P]

| Who | What | Review / approval |
| --- | --- | --- |
| The user (or the delegate) | Choose A1 / A2 / B / C for PR #370; approve the Q1 rule; any risk acceptance (B); any managed run (G0 or a disposable project) | — |
| G5 (a new source TASK) | Widen L-1 in PR #303's candidate (Q2.1 + Q2.2) with tests; no apply | focused Codex Sol (high) |
| G3 (its TASKs) | PR #370 per the chosen option (A1 = G3 source TASK + H3 review); the Q1 rule in the table's migration; the 2026-10-30 rebuild grants (Q6) inside its Data API inventory; the A2 runbook if chosen | Codex Sol (high); the user for production |
| The delegate / overall command | Assign G3's Data API inventory TASK (due 2026-10-27); decide who approves the Q1 rule | — |

**Before any real SQL change (G5 or G3):**
- a focused Codex Sol (high) review of the exact diff;
- PG17 proof with mutants;
- this suite's expectations updated where they flip;
- no `supabase/migrations` change;
- production stays NO_GO until the user's explicit approval of a mutation window with a read-back.

## 6. Managed: NOT_VERIFIED

The current ACL / owner / column ACLs of `brand_memberships`, the event triggers and their effects, the platform's restrictions on GRANT / ALTER,
the default privileges after 2026-10-30 (TRUNCATE / REFERENCES / TRIGGER), whether `authenticated` can CREATE in any schema (needed to use a REFERENCES
grant), PostgREST's schema reload — all [U]. The G5-18 audit (after G0) reads the catalog part; the rest needs a disposable managed project.

## 7. Data API inventories (re-checked 2026-10-22 JST)

| Owner | Status |
| --- | --- |
| G4 | received |
| G6 | received (Issue #320 comment 6331091808, no impact on 2026-10-30) |
| G3 | **still unassigned**: Issue #318 is idle (`task_id: none`); Q6's rebuild grants belong in it — due 2026-10-27 |
| G5 | done (no impact) |

## 8. Tests and what was executed

All commands ran in `/Users/yuya/Developer/kabumori-g5-19` (a clean worktree stacked on PR #438) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed system, credential or network request.

| # | Check | Result |
| --- | --- | --- |
| 1 | `CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… bash supabase/tests/common_account_bm_column_acl_pg_run.sh` | **8 tests** passed, 0 failed (three consecutive runs): section 3 rows 1-8 |
| 2 | regression, PG17: the G5 suites | owner epoch 19, D-2 4, Data API 6, managed audit 5, owner transport 6, session verdict 13, R0 13, R1 15, base tables 5 — all passed |
| 3 | the whole harness incl. this document's test (5 tests) | **275 passed**, 0 failed (270 of PR #438 + 5 new) |
| 4 | type-check, lint, shell, whitespace; no product SQL / migration / candidate changed | `deno check --no-config`: no error; `deno lint --no-config`: no problem; `bash -n`, `git diff --check`: clean; `supabase/migrations`, `supabase/candidates` and `apps` unchanged |
