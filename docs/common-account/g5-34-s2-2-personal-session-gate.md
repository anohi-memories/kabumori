# S2-2: the person-session gate `private.postona_personal_session()` (isolated source candidate)

Status: **isolated source candidate + local PG17 proof.**
- No migration, existing candidate, app, Edge, Auth or G3 / G4 / G6 file changed. Nothing is applied anywhere. There is no managed or production
  connection, not even read-only.
- It needs an independent Codex Sol (high) review before it counts. Production **NO_GO**.
- It does not make PR #457 (independent review open) reviewed or passed, and does not depend on it.
- TASK `common-account-g5-s2-2-personal-session-only-gate-isolated-candidate-20261025` (Issue #320, G5-01 generation, task 34, completion K5).
- Contract: §5 of `docs/common-account/g5-32-personal-workspace-session-consumer-matrix.md` (PR #501).
- Stacked on PR #506 (S2-3, H4 PASS_SOURCE_FOCUSED), which is unchanged; S2-2 does not use it.
- New files only:
  - `supabase/candidates/postona_personal_auth/004_s2_2_personal_session{,_rollback}.sql`;
  - `supabase/tests/postona_personal_s2_2_session_{pg_run.sh,pg_test.ts,mutations.py}`;
  - this document.

## 1. The judgement: SV's, unchanged (source evidence)

The rules for the person and the session were compared in source:
- SV as D1 leaves it (PR #494 `002_verdicts_anonymous_strict.sql`, SV at L423-L480);
- R0 and R1 (same file);
- T13 with S2-1 (PR #489 `001_t13_anonymous_refusal.sql`).

| Aspect | SV (D1) | R0 / R1 (D1) | T13 (S2-1) | S2-2 |
| --- | --- | --- | --- | --- |
| Claim source | per-claim `sub` first, else JSON claims | same | same | **same as SV** |
| `is_anonymous` | only the JSON boolean `false` / per-claim `'false'` | same | same | same |
| `sub`, `session_id` | lowercase-hex uuid regex | same | `::uuid` cast | regex (as SV) |
| `role` | `authenticated` | same | same | same |
| `sub = auth.uid()` | yes | yes | yes | yes |
| Login | `auth.users` row | same | (via the session) | same |
| Session | `auth.sessions` by id **and** user_id, `not_after` null or future → `SESSION_REVOKED` / `SESSION_EXPIRED` | same, in v1 | same predicate, after the locks, one code | same as SV |
| Account / service / workspace / epoch | none (by design) | yes | account + service | **none** |

**Decision:**
- The body of S2-2 is SV's D1 body **byte for byte** (md5 `a5d4d71c532847a8573e86a4bd0c791d`). The suite checks this, and checks that every
  answer is the same.
- What changes is **only the install**. SV's install (G5S `003_session_verdict.sql:46-50, :71-73`) requires and calls
  `private.account_lifecycle_owner_epoch_exposure()`. That helper belongs to the owner-epoch chain (PR #285 → #303 → #457, still under
  independent review). S2-2's install does not, because the body never needs it.
- A new name, not a change to SV: the reviewed SV stays exactly as it is for its consumers. S2-2 is the gate a consumer can adopt **without**
  the owner-epoch chain.

## 2. The interface

`private.postona_personal_session() returns text` — no parameter.

| Answer | Meaning | Consumer action |
| --- | --- | --- |
| `active` | a signed-in, non-anonymous person (proven `false`), role `authenticated`, `sub = auth.uid()`, the login exists, and the session row (by id **and** user) is live now | may continue (its own checks still apply) |
| `AUTH_REQUIRED` | no proof of a person: no / broken / non-object claims; anonymous or `is_anonymous` missing / null / not the boolean false; role not `authenticated`; a malformed or non-canonical (upper-case) `sub` / `session_id`; `sub ≠ auth.uid()`; no login | 401; touch nothing |
| `SESSION_REVOKED` | no session row with that id **for this person**: signed out, revoked, or another person's session | 401; touch nothing |
| `SESSION_EXPIRED` | the row's `not_after` is past | 401; touch nothing |
| raises | an unreadable fact | the transaction fails; touch nothing |

**Fail-closed rule for consumers:**
- act only on **exactly** `'active'`, written as `if v is distinct from 'active' then refuse`;
- a NULL then refuses too. A NULL is unreachable here: the session subquery always yields one row. The suite also asserts that no answer is
  NULL.

**Consumers:**
- The consumer is an owner-owned, VOLATILE, READ COMMITTED RPC that calls the gate **first**, in the same statement as its own read or lock
  (the G5-11 consumer contract C-1 – C-5).
- Intended consumers: G3's Threads cancel / receipt and the X `get` / `list` / `cancel` / readback entry points (#463, #466).
- **Not for writers.** Writers keep T13, which also checks the account and the service.

**Not read, on purpose:**
- the common account, entitlements, brands, the owner epoch (R1 / T13 / W1 stay the authority for those);
- a GoTrue ban (`banned_until`): **[PENDING] P-3**;
- the sign-out scope (local or global, and what happens to scheduled posts): **[PENDING] P-4**.

None of these is adopted implicitly.

**Not changed:**
- the R1 v1 wire, `g5oe`, entitlements, the owner-epoch fence (W1);
- SV, R0, T13, the S2-3 predicate.

## 3. Install and rollback

| Step | Install `004…sql` | Rollback `004…_rollback.sql` |
| --- | --- | --- |
| Preconditions | not a superuser. The name is free: its own body → `S22_ALREADY_APPLIED`, any other → `S22_PRECONDITION_NAME_TAKEN`. `private` exists and the owner may CREATE there. `auth.uid()` exists and is STABLE. `auth.users` / `auth.sessions` are plain tables the owner may SELECT, with every row visible (G5-08). The `auth.sessions` (`id`, `user_id`, `not_after`) and `auth.users.id` types. **No owner-epoch helper.** | not a superuser; the gate exists (else `S22_ROLLBACK_NOT_APPLIED`) with exactly the installed body, owner, attributes and owner-only ACL (`is not true`, G5-31); no API role reaches it or the owner; no other non-superuser role may EXECUTE it; **no other function's body names it** (`S22_ROLLBACK_PRECONDITION_CALLERS`: PL/pgSQL calls are not tracked as dependencies, so a consumer must be removed first) |
| Action | create it; revoke it from `public`, `anon`, `authenticated`, `service_role` | drop it |
| Postconditions | the body md5, the owner, every attribute (G5-28 / G5-29 baseline, `is not true`), the ACL exactly `owner=X/owner`, no API role a member of a role that may EXECUTE it or of the owner, no other non-superuser role may EXECUTE it | it is gone |

## 4. Evidence [D] (throw-away PostgreSQL 17.11, local socket, fake data)

Two databases:
- **FULL:** the S2-3 suite's world (G5 stack `21a5cad4`, verdict blobs checked), plus D1 (blob `4f58351e…`) and S2-3 (blob `84a9ad79…`), with
  SV.
- **BARE:** only the auth fixture (`auth.users`, `auth.uid()`), `auth.sessions` and an empty `private` schema. No owner-epoch chain, no SV.

| Test | What it shows |
| --- | --- |
| 1. Setup | FULL's SV body has S2-2's checksum; BARE has no SV and no owner-epoch helper. |
| 2. FAIL before (the coupling) | SV's own install **refuses on BARE** because the owner-epoch helper is missing. (Measured: PostgreSQL resolves the helper's regprocedure literal when the check is planned, so the error is "function … does not exist" for that helper rather than SV's own code.) **S2-2 installs on BARE** and gives every expected answer there. |
| 3. Refused installs | Each refuses and creates nothing: a superuser; someone else's function under the name; FORCE RLS on `auth.sessions`; RLS on `auth.users` with the owner neither table owner nor BYPASSRLS; a VOLATILE `auth.uid()`; `auth.sessions` without `not_after`. The rollback refuses where never applied. |
| 4. Install | Every other `public` / `private` / `auth` function is byte-identical, ACLs included (SV, R0, R1, T13, W1, S2-3 …). The body is SV's. Owner-only: no EXECUTE for `anon` / `authenticated` / `service_role` / `authenticator`, and a call as `authenticated` is refused. A second run → `S22_ALREADY_APPLIED`. |
| 5. Same as SV | **27 answers, all identical to SV and as expected, none NULL.** They cover: a person (JSON and per-claim); an id with letters; the same id upper-cased; anonymous (both forms); `is_anonymous` missing / null / `"false"` / 0 / empty; role anon / service_role; malformed `sub` / `session_id`; no `session_id`; broken / array / no claims; no login; another person's session; an unknown (revoked) session; an expired one; `auth.uid()` naming another person (replaced inside a rolled-back transaction: in this world it reads the same claims, so without this the `sub = auth.uid()` check could not be observed); and a live session whose row is then deleted (a sign-out), seen at once as `SESSION_REVOKED`. |
| 6. Rollback | Refused, with the gate kept, on: STRICT; `RESET ALL`; a grant to `authenticated`; an API role made a member of the owner; a consumer function calling it; a changed body. Then it drops only S2-2, and SV is untouched. A second rollback → `S22_ROLLBACK_NOT_APPLIED`. Re-install works. |

- **Runs:** 6 tests ×3, all PASS.
- **Mutations:** **23 / 23** detected (control PASS): 8 on the gate's body, 9 on the install, 6 on the rollback. The first run showed the
  `sub = auth.uid()` mutant SURVIVED. The `auth.uid()` case above was added for it, and the final run detects it. Each body mutant runs with `S34_BEHAVIOUR_ONLY=1`, which skips the "same text as SV" checks, so it must be
  caught by a wrong answer, not by a checksum. The install's postcondition attribute clauses are equivalent mutants (the function was just
  created with the declared attributes).
- **Static checks:** deno check / lint, `bash -n`, Python syntax, `git diff --check`.

## 5. Not verified / not decided

- **NOT_VERIFIED:**
  - the managed GoTrue / PostgREST claim set (is `is_anonymous` always present, and is `session_id` always present?);
  - the managed `auth.users` / `auth.sessions` (RLS, owner, visibility to the lifecycle owner);
  - real consumers (none is wired: G3's wiring is G3's TASK);
  - production.
- **[PENDING]:**
  - P-3: whether a ban should refuse here;
  - P-4: local or global sign-out, and scheduled posts after a sign-out;
  - P-2: read / cancel / receipt after a stop. S2-2 answers about the session only; whether a locked person or an ended service may still read
    or cancel is decided by which gate a consumer calls.
  - P-1, P-5: untouched.

## 6. A defect in the earlier G5 mutation scripts (found here; their PRs are not changed)

| Item | Detail |
| --- | --- |
| The defect | To keep the md5 constants consistent after a body mutant, the T13 (PR #480 / #483 / #489), D1 (PR #486 – #494) and S2-3 (PR #506) scripts rewrite each file with `open(p, 'w').write(open(p).read().replace(…))`. Python evaluates `open(p, 'w')` first, which **truncates the file**; the read then returns `''`, and the file is written back **empty**. Every **body** mutant therefore ran against an empty candidate and rollback. It was "detected" whatever the suite checked, so those detections were **vacuous evidence**. Guard mutants (outside the function bodies) and rollback-file mutants never took that path and were valid. |
| How it was found | Here, the `sub = auth.uid()` body mutant was "detected" although this world's `auth.uid()` reads the same claims. A single re-run showed the rollback file was empty. |
| This PR | The S2-2 script reads before it writes and asserts the result is not empty. Body mutants run with `S34_BEHAVIOUR_ONLY=1`. Result: 22 / 23 on the first fixed run (the `auth.uid()` mutant SURVIVED). After the added case: **23 / 23**. |
| Re-verification of the earlier sets | Each script was copied to the scratchpad with only that line fixed (plus a "not empty" assertion), and run against its own clean worktree at its PR head (`1c3b16a7`, `c9f726e9`, `bbc52a6b`) on a throw-away PG17. **T13 30 / 30, D1 33 / 33, S2-3 24 / 24**, all with control PASS. The counts in those REPORTs hold. Their body-mutant evidence is valid only from this re-run; it was not valid before. |
| Not done here | The scripts in PR #489 / #494 / #506 still contain the defective line (frozen heads). Proposal: a small G5 TASK fixes that one line in each, on new branches, and re-runs. H4's re-runs of those scripts carried the same defect. |
