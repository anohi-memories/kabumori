# D1: R0 / R1 / SV read `is_anonymous` as strictly as T13 (isolated source candidate)

Status: **isolated source candidate + local PG17 proof.**
- No migration, existing candidate, app, Edge, Auth or G3 / G4 / G6 file changed.
- Nothing applied anywhere; no managed or production connection (not even read-only).
- It needs an independent Codex Sol (high) review before it counts. Production **NO_GO**.
- It does not make PR #457 (independent review open) reviewed or passed.

- TASK `common-account-g5-personal-r0-r1-sv-anonymous-claim-d1-source-candidate-20261024` (Issue #320, G5-01 generation, task 27, completion K5).
- Design: D1 of `docs/common-account/g5-26-personal-claim-workspace-if-contract.md` (PR #485).
- The reference: T13 with S2-1 (PR #483 `9d7399047affcac44649aeb7d204be3a609dc528`, H4 PASS_SOURCE_FOCUSED).
- New files only:
  - `supabase/candidates/postona_personal_auth/002_verdicts_anonymous_strict{,_rollback}.sql`;
  - `supabase/tests/postona_personal_d1_verdicts_{pg_run.sh,pg_test.ts,mutations.py}`;
  - this document.

## 1. What changes

| Function | Reviewed (G5 Draft stack, unchanged since `ceb77ce45f0e79510ac7551849288b17991f81d2`) | With D1 |
| --- | --- | --- |
| R1 `public.common_account_authorization_verdict(text,text,text)` (`001_authorization_verdict.sql`, blob `6e4ebfc4…`) | per-claim `is_anonymous` missing / empty → `'false'`; JSON missing / null → `'false'` | per-claim must be exactly `'false'`; JSON must be the boolean `false` (`jsonb_typeof`). Anything else leaves the subject unset → the existing v1 deny `AUTH_REQUIRED`. |
| R0 `public.common_account_bootstrap_verdict(text,text)` (`002_bootstrap_verdict.sql`, blob `f78d87a9…`) | same as R1 | same as R1 |
| SV `private.account_lifecycle_session_verdict()` (`003_session_verdict.sql`, blob `a0680eb3…`) | same as R1 | same as R1; the answer is the existing `'AUTH_REQUIRED'` |

- **Per function:** two reading lines and their comments change. Nothing else in the body changes; the generator copies each reviewed
  definition byte for byte.
- **The install:** CREATE OR REPLACE of the three bodies only. The OIDs, owner, STABLE, SECURITY DEFINER, `search_path = ''`,
  `row_security = off` and the ACLs (R1 / R0: owner + `authenticated`; SV: owner only) are kept.
- **Guards:**
  - each body must be exactly the reviewed one (md5) and each shape the reviewed one;
  - no API role may be a member of the owner;
  - the postconditions check the same OIDs, the expected bodies and the same shape / ACL;
  - the rollback restores the reviewed bodies byte for byte.

## 2. Invariants proved [D] (throw-away PostgreSQL 17.11, local socket only, fake data)

`supabase/tests/postona_personal_d1_verdicts_pg_run.sh` builds the G5 verdict suites' own world from the G5 Draft stack at `21a5cad4`:
- the method: `git archive`, with the three verdict blobs checked;
- the model baseline, the real membership migration, the ten F5 chain files;
- the owner-epoch candidate, as **test infrastructure only**; its own review is PR #457's;
- R1 / R0 / SV.

There are two identical databases: "d1" gets the candidate, "rev" keeps the reviewed verdicts.

| # | Test | Result |
| --- | --- | --- |
| 1 | FAIL before: the installed bodies are the reviewed ones (md5); a token without `is_anonymous` gets an R1 allow, an R0 allow and SV `active` | reproduced |
| 2 | refused installs leave the reviewed verdicts untouched (md5 + OID / settings / ACL): superuser; an API role made a member of the owner; EXECUTE on SV granted to `authenticated`; EXECUTE on R0 granted to `anon`; a changed R0 body; the rollback where never applied | each refused with its code |
| 3 | install: the expected bodies; same OIDs, settings, ACLs, STABLE definer; **every other function of `public` / `private` byte-identical** (W1, W2, T13, the owner epoch, the lifecycle …); `anon` / `service_role` / `authenticator` cannot execute R1 / R0; no API role can execute SV; a second run refuses | as stated |
| 4 | PASS after: 20 claim forms × 3 functions compared between the two databases | **12 answers change**: JSON missing, JSON null, per-claim missing, per-claim empty × R1 / R0 / SV, each now **exactly** the existing `AUTH_REQUIRED` answer. **48 are byte-identical**, among them the person's allow (8 keys, `g5oe:<epoch>:<version>`, `["postona:x_autopost"]`). The others: the already-refused anonymous forms (true, "true", "false" string, 1, {}, per-claim true / yes), expired / unknown session, role anon, no session id, uppercase `sub` (D2 unchanged), broken claims, a login without the service. |
| 5 | rollback: reviewed bodies byte for byte, same OIDs / ACLs; the missing claim is accepted again; a second rollback refuses; re-install works | as stated |

`supabase/tests/postona_personal_d1_verdicts_mutations.py`: 16 mutants, each must make the suite fail:
- per function, a missing / empty per-claim setting taken as false, a missing / null JSON claim taken as false, and the JSON type unchecked
  (3 × 3);
- the body, R0 / SV / R1 shape, already-applied and superuser guards removed;
- the rollback restoring a different SV body.

Body mutants get their checksums recomputed, so each fails for the rule.

## 3. What stays exactly as it was (v1)

- The wire: the 8 keys (the Edge adds the two times), `decision`, every reason, `scope`, `subject`, the hashed session ref, `owner_epoch` =
  `g5oe:<owner epoch>:<lifecycle_version>`, `entitlements` = `["postona:x_autopost"]`.
- The only new outcome is the **existing** deny `AUTH_REQUIRED` for an unproven claim. G6's parser already handles it (a deny reason it passes
  through). No v2 is needed.
- HTTP mapping (consumers):
  - `AUTH_REQUIRED` → 401;
  - service / account states → 403;
  - an unknown and another person's resource → the same 404;
  - an unreadable dependency → 503.
- Row reads, the one-statement snapshot, the absence of locks in R0 / R1 / SV, READ COMMITTED in T13: untouched.
- D2 (UUID spelling: regex here, cast in T13) is **not** changed (measured: an uppercase `sub` gets the same answer before and after).

## 4. G4 / G6 (decided / open / v2)

| To | Decided | Open | v2? |
| --- | --- | --- | --- |
| G4 (#319) | when applied (after review), R0 refuses a token without `is_anonymous: false`, exactly as T13 (PR #483); the transport must forward the verified claims unchanged | who changes the live X begin (`auth.uid()` only) and when it adopts the workspace rule (G4-35 Q4, S1-F1) | no |
| G6 (#321) | R1's v1 wire is unchanged; an unproven claim now gets deny `AUTH_REQUIRED` | when G6 adds the "token without the claim → deny" test (G6 idle) | no |

## 5. Boundary with G3 and S2-2

- SV is still owner-only and still installs only next to the owner-epoch candidate (its install checks the exposure helper).
- D1 changes only how SV reads the claim. The session-only gate that G3's P7 readback / cancel and the 43 X entry points need, without the
  owner-epoch coupling, is **S2-2**: a separate G5 TASK. Nothing here wires a G3 consumer.

## 6. Not verified / not decided

- **[U]:**
  - the managed GoTrue / PostgREST claim set (H4: NOT_VERIFIED);
  - real G3 / G4 / G6 consumers;
  - the managed owner / ACL;
  - production.
- **Undecided by the user (unchanged):**
  - the meaning of locked / banned;
  - retention / deletion;
  - receipt / cancel after a stop;
  - old shared workspaces;
  - local / global sign-out.
