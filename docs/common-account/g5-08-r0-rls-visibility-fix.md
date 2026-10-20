# G5-08: every row the verdicts read must be visible — the fix for H1 C1 P2 on PR #383

Status: **SQL source candidate + local PG17 proofs. Not in `supabase/migrations/`; not applied to any managed or production database; not wired into
G4's Edge or any app; no grant, no ownership change and no RLS change outside the throw-away test database.** Production is **NO_GO**. A focused
**Codex Sol (high)** re-review of this change is required next.

- TASK `common-account-g5-pr383-r0-rls-hidden-workspace-p2-source-fix-20261020` (Issue #320, G5-01 generation, task 8, completion K5).
- The finding: H1 C1 on PR #383 (`759b89fa376f5b3ba9286fa49d5295a6e4938459`), Issue #306 REPORT 6289716702 / ACCEPT 6289776973 — `CHANGES_REQUIRED`, P2 x1:
  "RLS-filtered workspace can be mistaken for an absent workspace".
- Stacked on PR #383 (G5-07, R0) -> PR #375 -> PR #371 -> PR #358 -> PR #351 -> PR #303.
- Changed G5-owned files: `002_bootstrap_verdict.sql` (R0) and `001_authorization_verdict.sql` (R1 / W1 / W2 / GC, the same class) under
  `supabase/candidates/common_account_authorization_verdict/`; the R0 PG17 runner / suite / SQL mutation script; the R1 mutation script (one site moved);
  the G5-03 / G5-07 doc tests (the new signatures; the G5-07 counts are pinned as of G5-07); a status line in the G5-03 / G5-07 documents; this document
  and `supabase/preflight/managed_disposable/g5_08_rls_visibility_doc_test.ts`. No model, no migration, no file of another owner.

Evidence labels: **[D]** derived by a test or a scratch run of this task, **[M]** `origin/main` `0c42933c`, **[A]** assumption, **[U]** NOT_VERIFIED.

## 1. Verdict

| Question | Answer |
| --- | --- |
| Was the P2 real? | **Yes, on the real SQL** [D]. On PG17 with `public.brands` owned by another role, ordinary RLS on (not forced), every table privilege granted to the function owner and main's own policy `social_mobile_member_select_brands` (to `authenticated`, members only) [M], the PR #383 install was **accepted** and R0 answered **`allow`** for a person whose derived workspace was already owned by someone else. The same world with RLS off answered `deny:OWN_WORKSPACE_CONFLICT`. |
| The fix | Two guards, both PostgreSQL's own rule. **(1) Install:** every relation read must be a plain table whose EVERY row the function owner sees: RLS off, or the owner has BYPASSRLS, or the owner has the table owner's privileges (directly or by inheritance) with RLS not FORCED; otherwise `..._PRECONDITION_RLS_HIDES_ROWS <relation>`; a view is refused. **(2) Call:** R0, R1, W1, W2 and GC run with `row_security = off`, so a relation that RLS filters for the owner **raises an error** instead of returning fewer rows (a later owner / RLS change cannot reopen the hole). Nothing is granted; `row_security = off` bypasses nothing. |
| After the fix | The same layout: the install of R0 **and** of R1 is refused and leaves nothing; an R0 installed before the layout turned hostile raises `query would be affected by row-level security policy for table "brands"`; the G4 port sees a non-200, so main's begin and the code exchange run **0** times and no second owner appears [D]. With the guard removed from the installed R0 (`alter function ... reset row_security`) the same call answers `allow` again — the guard is what closes it [D]. |
| Legitimate layouts | Still allowed and still correct [D]: RLS on with the function owner owning the table; another table owner whose privileges the function owner inherits; a function owner with BYPASSRLS — each installs, refuses the pre-claimed workspace (`OWN_WORKSPACE_CONFLICT`) and allows a person with no workspace. |
| Wire / behaviour | Unchanged: the 8-key R0 wire, R1's refusal of the bootstrap features, every existing positive and refusal case (R0 13 tests, R1 15, G5-01 10, G5-02 5, owner epoch 19). |
| Still open | **The G4 / F3 begin gap is NOT fixed by this** (section 6): main's begin can still make the caller a second owner; R0 is advisory. Managed ownership / BYPASSRLS / auth-table RLS are NOT_VERIFIED: if the managed layout does not meet the rule, the install refuses (fail closed). |

## 2. The finding, reproduced (before the fix)

A scratch run (not part of the repository) on a throw-away PG17, at the PR #383 head, built the R0 runner's world (Phase 11 baseline, the real
membership migration, the ten F5 chain files, the owner-epoch candidate, 001), then, as the local superuser:
`alter table public.brands owner to <another role>; grant all on public.brands to <function owner>; alter table public.brands enable row level security`.

| Step | Result [D] |
| --- | --- |
| the layout | `owner=<another role> rls=t forced=f` |
| install PR #383's `002_bootstrap_verdict.sql` | **accepted** |
| a pre-claimed workspace under the victim's derived id (inserted by the superuser) | 1 brand, 1 owner (not the victim) |
| R0 for the victim | **`allow:null`** |
| control: the same world with RLS off on brands | `deny:OWN_WORKSPACE_CONFLICT` |

Why: a SECURITY DEFINER function runs with its owner's privileges; PostgreSQL skips RLS only for a superuser, a role with BYPASSRLS, or the table
owner (a role with its privileges) when RLS is not FORCED. SELECT privilege does not skip it. The function owner, a member of `authenticated`, is
filtered by main's member-only policy; the LEFT JOIN then sees no row and R0's "absent workspace" rule allows.

The PG17 suite keeps this reproduction (section 5, V-3): the installed R0 with `row_security` reset answers `allow` in the same layout.

## 3. What changed

**Install (both files, the same seven relations):** `public.common_accounts`, `public.service_entitlements`, `public.brands`, `public.brand_memberships`,
`private.account_lifecycle_operations`, `auth.users`, `auth.sessions`. Each must exist as a table (`relkind` `r` or `p`; a view could hide rows with its
`WHERE`), be SELECT-able by the function owner, not have RLS FORCED (kept from before), and — new — if RLS is enabled, the owner must have BYPASSRLS or
`pg_has_role(owner, table owner, 'USAGE')` (the owner rule of `check_enable_rls`: having the owner's privileges, i.e. an inheriting membership;
`MEMBER` alone would wrongly accept a SET-only membership). Codes: `BOOTSTRAP_VERDICT_PRECONDITION_RLS_HIDES_ROWS` (002),
`AUTH_VERDICT_PRECONDITION_RLS_HIDES_ROWS` (001); a view or a missing table stays `..._PRECONDITION_RELATION`.

**Call:** `set row_security = off` on R0, R1, W1, W2 and GC; the postconditions now require `proconfig @> {search_path="", row_security=off}`. With
`row_security = off`, PostgreSQL raises SQLSTATE 42501 whenever RLS would filter the query for the current (definer) role; it never turns RLS off.
The setting stays in force inside the helpers the verdicts call (P5's state, the brand owner, the owner epoch), so their reads are covered too
(V-2 shows it for a relation only P5 reads). Checked separately on PG17 [D]: the error is SQLSTATE `42501` (`check_enable_rls`), and the same
query with ordinary row security returns 0 rows silently.

**What 001 does NOT change:** the decision logic, the codes, the wire, the owner-epoch token and the ACL of R1 / W1 / W2 / GC are untouched; the
diff in 001 is the install loop above, `set row_security = off` on the four signatures, the postcondition's `proconfig` check and the header
comment. The grants stay two (`authenticated` on R1, `service_role` on W2; checked by the G5-03 / G5-08 doc tests and the exact-`proacl`
postcondition). Both changes can only refuse an install or turn a filtered read into an error; neither can turn a refusal into an allow.

**Install and call agree:** both apply PostgreSQL's own decision. A layout the install accepts can only become hostile through a later owner /
RLS / BYPASSRLS change by a privileged role; then the call errors (fail closed) instead of answering from fewer rows.

## 4. Every relation, every reader: what a hidden row did before (the cross-check of TASK step 2)

| Relation | R0 (bootstrap) | R1 (brand verdict) | W1 / W2 (worker) | Now |
| --- | --- | --- | --- | --- |
| `public.brands` | **allow** (the P2: a pre-claimed workspace read as absent) | `BRAND_ACCESS_DENIED` (deny) | P5 state -> not `active` (deny) | install refused / call errors |
| `public.brand_memberships` | a hidden second owner -> count 1 -> could allow | same | owner lookup | already held by PR #303's precondition (table owned by the function owner), now also by the general rule |
| `private.account_lifecycle_operations` | an open deletion read as none -> only `status = 'deleting'` refuses | same | P5 | main's `begin_*` set `deleting` in the same transaction [M: 20261001150000:987, :1138], so this was defence in depth; now guaranteed |
| `public.common_accounts` | `ACCOUNT_NOT_FOUND` (deny) | same | generation unreadable (deny) | same, plus the guards |
| `public.service_entitlements` | `SERVICE_NOT_REGISTERED` (deny) | same | P5 (deny) | same, plus the guards |
| `auth.users` / `auth.sessions` | `AUTH_REQUIRED` / `SESSION_REVOKED` (deny) | same | not read | same, plus the guards |

Other "empty means allow" paths: none in the three functions besides the rows above (an R0 allow needs an absent workspace or exactly one visible
owner; R1 / W1 allow only on present rows). Not a hiding vector: inheritance children (they add rows), SELECT rules (impossible on a table), column
privileges (table-level SELECT is required).

## 5. Invariants -> proofs (`common_account_bootstrap_verdict_pg_test.ts`)

| Invariant | Proof |
| --- | --- |
| V-1 the install refuses a relation whose rows RLS hides from the owner | `H1 C1 P2: ...`: R0 and R1 installs refused with `..._RLS_HIDES_ROWS public.brands`, nothing half-installed |
| V-2 the call errors on such a relation | the same test: R0 and R1 raise for `brands`; W1 raises for a hidden `public.common_accounts` (its own read) and a hidden `public.service_entitlements` (read only inside the P5 helper it calls: the setting holds in nested calls) |
| V-3 the guard is what closes it | the same test: with `row_security` reset on the installed R0, the hidden workspace answers `allow` |
| V-4 nothing irreversible after an error | the same test: the G4 port model sees a non-200: 0 begin, 0 exchange, the workspace still has its one owner |
| V-5 legitimate layouts work, and only those | `every row visible, the legitimate ways`: RLS on with the owner owning the table; an inherited table owner; BYPASSRLS — install, `OWN_WORKSPACE_CONFLICT` for the pre-claimed workspace, `allow` without one. A membership in the table owner WITHOUT inherit (SET only: `MEMBER` but not `USAGE`) is filtered by PostgreSQL and is refused (`..._RLS_HIDES_ROWS`); FORCED RLS stays refused (`the install refuses ...`) and a superuser owner is refused by the first precondition |
| V-6 a view is refused | the same test: a view as `auth.sessions` -> `BOOTSTRAP_VERDICT_PRECONDITION_RELATION auth.sessions` |
| V-7 every verdict function carries the guard | `install`: R0 `proconfig @> {search_path="", row_security=off}`; R1 / W1 / W2 / GC carry `row_security=off` |
| V-8 nothing else moved | every earlier test of the R0, R1, G5-01, G5-02 and owner-epoch suites, unchanged, passes |

## 6. Still open, and other owners' items (no file of theirs is edited)

- **G4 / F3 begin / complete SQL: unchanged and still needed.** Main's begin (`20260922003101:39-45` [M]) has no post-creation owner check, no P3b
  guard and no rollback on a pre-claimed workspace; the G5-07 suite still shows it making the caller a second owner. R0 is advisory (no lock): even
  a correct R0 cannot close a race between R0 and the begin. The begin must, under its locks, run P3b, derive the id, create idempotently, then
  require owners == {caller} and the caller's role `owner`, else raise and roll back; P3b again in complete. Notified earlier (Issue #319 comment
  6287813812); not repeated.
- Managed [U]: who owns `public.brands` and the other tables, whether the lifecycle owner has BYPASSRLS, whether `auth.users` / `auth.sessions` have
  RLS enabled and for whom, PostgREST's status for SQLSTATE 42501 (G4 treats any non-200 as not allowed). If a managed layout fails the rule the
  install refuses; making it pass is an ownership / ACL decision for its owner with the user's approval, not a grant in this candidate.
- A privileged role that can `ALTER FUNCTION ... RESET row_security` or change a table owner can also change the function (L-6 class).
- Unchanged separate gates: the R1 vs W1 / W2 coverage asymmetry and the privileged-maintenance history gap; PR #233; the F3 / G3 revoke of TRIGGER /
  TRUNCATE / REFERENCES on `public.brand_memberships`; managed Auth / ACL; G1's draft storage (a separate TASK candidate); the old F5 archive
  (DEFERRED_BY_USER).

## 7. Tests and re-run

```bash
CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser> bash supabase/tests/common_account_bootstrap_verdict_pg_run.sh
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_bootstrap_verdict_mutations.py <repository root>
CAL_PGHOST=… CAL_PGPORT=… CAL_PGSUPER=… python3 supabase/tests/common_account_authorization_verdict_mutations.py <repository root>
deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/
```

The R0 runner now also creates a second, never-logging-in role for the hostile layouts and drops it at the end; every runner refuses a host that is
not a `/tmp` socket directory.

## 8. What was executed for this document

All commands ran in `/Users/yuya/Developer/kabumori-g5-08` (a clean worktree stacked on PR #383) against a throw-away local PostgreSQL 17.11
(`listen_addresses` empty, a Unix socket under `/private/tmp`, fake data, deleted at the end). No managed or production system, no credential, no
network request, no real OAuth.

| # | Check | Result |
| --- | --- | --- |
| 1 | the reproduction of section 2 on the PR #383 head (scratch script) | install accepted, `allow:null`; control `deny:OWN_WORKSPACE_CONFLICT` |
| 2 | the R0 PG17 suite `common_account_bootstrap_verdict_pg_run.sh` | **13 tests** passed, 0 failed (three consecutive runs; 11 of G5-07 + 2 new) |
| 3 | SQL mutation of 002 + the G5-08 sites of 001 `common_account_bootstrap_verdict_mutations.py` | control PASS, **39/39 detected**, 0 invalid (the 30 of G5-07 with one site moved + 9 new: hidden rows accepted, a view, BYPASSRLS ignored, inheritance ignored, a SET-only membership accepted, R0 / R1 / W1 without `row_security = off`, the R1 install accepting hidden rows) |
| 4 | SQL mutation of 001 `common_account_authorization_verdict_mutations.py` | control PASS, **51/51 detected**, 0 invalid (one site moved, no mutant added) |
| 5 | regression, PG17: `common_account_authorization_verdict_pg_run.sh`, `common_account_g5_01_authz_pg_run.sh`, `common_account_g5_02_rpc_preconditions_pg_run.sh`, `common_account_owner_epoch_run.sh` | 15, 10, 5, 19 passed |
| 6 | regression, pure: G5-01 (13) + G5-02 model (11) + G5-06 bootstrap (9) | 33 passed |
| 7 | the whole harness incl. the document tests `deno test --no-config --no-check --allow-read --allow-env supabase/preflight/managed_disposable/` | **217 passed**, 0 failed (211 of PR #383 + 6 new) |
| 8 | type-check, lint, shell, whitespace | `deno check --no-config` (the models, the suites, the harness): no error; `deno lint --no-config`: `Checked 55 files`, no problem; `bash -n`, `python3 -m py_compile`, `git diff --check`: clean |

Not run, on purpose: any managed access; applying the candidates anywhere but the throw-away database; changing G4's Edge or the begin / complete SQL;
the Codex Sol (high) re-review (the next step).
