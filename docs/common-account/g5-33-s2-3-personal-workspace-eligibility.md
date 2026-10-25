# S2-3: the personal-workspace eligibility predicate, and R0 using it (isolated source candidate)

Status: **isolated source candidate + local PG17 proof.**
- No migration, existing candidate, app, Edge, Auth, G3 / G4 / G6 file changed. Nothing is applied anywhere. There is no managed or
  production connection, not even read-only.
- It needs an independent Codex Sol (high) review before it counts. Production **NO_GO**.
- It does not make PR #457 (independent review open) reviewed or passed.
- TASK `common-account-g5-s2-3-personal-workspace-eligibility-r0-isolated-source-20261025` (Issue #320, G5-01 generation, task 33,
  completion K5).
- Contract: §4 of `docs/common-account/g5-32-personal-workspace-session-consumer-matrix.md` (PR #501, `e0d94c6d`), i.e. the rule of G5-23 §4.1.
- Base: D1 (PR #494, head `c9f726e9`, H4 PASS_SOURCE_FOCUSED). The candidate replaces R0 **as D1 leaves it**.
- New files only:
  - `supabase/candidates/postona_personal_auth/003_s2_3_workspace_eligibility{,_rollback}.sql`;
  - `supabase/tests/postona_personal_s2_3_workspace_{pg_run.sh,pg_test.ts,mutations.py}`;
  - this document.

## 1. The rule (one place)

`private.postona_personal_workspace_eligibility(p_user uuid) returns text`.

The person's own workspace is:
- the id `'u_' || substr(md5(user), 1, 24)` (the begin RPC, the deletion saga and R0 use the same derivation; the install checks it);
- kind `social_mobile_user_v1`;
- with **exactly one membership**: the person as `owner`;
- and the person owns **no other** brand.

This is G5-23 §4.1, the same rule as G4's Threads provisioner (PR #124).

| Answer | When | Same as D1's R0? |
| --- | --- | --- |
| `absent` | no row under the id, no membership under the id, no other owned brand | yes (C0) |
| `own` | the rule holds | yes (C1) |
| `OWN_WORKSPACE_CONFLICT` | another kind (C2); the id owned by someone else or the person only a member (C3) | yes |
| `WORKSPACE_OWNER_UNKNOWN` | the owner count under the id is not 1 | yes |
| `OWN_WORKSPACE_CONFLICT` | **new:** no own workspace but another owned brand (C4) | **no** (D1 allowed) |
| `OWN_WORKSPACE_CONFLICT` | **new:** the own workspace and another owned brand (C5) | **no** |
| `OWN_WORKSPACE_CONFLICT` | **new:** another member on the own workspace | **no** |
| `OWN_WORKSPACE_CONFLICT` | **new:** memberships under the id without its brand row | **no** |
| raises `POSTONA_PERSONAL_WORKSPACE_USER_REQUIRED` | a NULL user | — |

Properties:
- **Owner-only.** No grant: no API role can ask about another person. The install's postcondition proves it over the role graph, and an
  `authenticated` call is refused.
- **Its input must be a verified subject.** R0 passes its own (the JWT claims, D1-strict, equal to `auth.uid()`). A future caller (G4's X
  begin, G3's X create) must pass `auth.uid()` from inside its own reviewed owner-owned function, never a request value.
- **Read-only and lock-free.** One statement. It is STABLE, so inside R0's statement it reads R0's snapshot.
- **The G5-08 rules hold.** `brands` and `brand_memberships` must show this owner every row (RLS off, BYPASSRLS, or the table owner's
  privileges with RLS not FORCED); otherwise the install refuses. The predicate also runs with `row_security = off`, so a later filter raises
  instead of hiding a membership.

## 2. R0

Only R0's **body** is replaced (CREATE OR REPLACE: same OID, owner, ACL and attributes).
- Its own-workspace facts are gone from its statement. In their place it calls the predicate, in the same statement.
- It maps the answer:
  - `absent` / `own` → continue;
  - `OWN_WORKSPACE_CONFLICT` → v1 deny `OWN_WORKSPACE_CONFLICT`;
  - anything else → v1 unknown `WORKSPACE_OWNER_UNKNOWN` (that covers the real `WORKSPACE_OWNER_UNKNOWN`, and fails closed on any unexpected
    value).
- **No new reason, no new key, no v2.** The order of R0's checks is unchanged:
  - the feature, then the subject (D1: anonymous / missing claim refused);
  - then the session, the account and the service;
  - then the workspace.

  So an anonymous caller, or a revoked / expired session, is refused **before** the workspace is looked at (tested on a C4 person).

Checksums:

| Body | md5 |
| --- | --- |
| R0 as D1 leaves it | `f3fb1fb4102b0cbf969145045e079318` |
| R0 with S2-3 | `3e89fcff1a3232ef794cdf0483a75130` |
| the predicate | `fa4623601fe2ef6efc38478c9f65105e` |

## 3. Install and rollback

| Step | Install `003…sql` | Rollback `003…_rollback.sql` |
| --- | --- | --- |
| Preconditions | not a superuser; R0 is exactly D1's body (else `S23_PRECONDITION_R0_BODY_NOT_REVIEWED`; the S2-3 body → `S23_ALREADY_APPLIED`). R0's full shape: owner, definer, STABLE, settings, the G5-28 / G5-29 attribute baseline, ACL owner + `authenticated`, no API role reaching the owner, `is not true` (G5-31). No function under the predicate's name (`S23_PRECONDITION_PREDICATE_EXISTS`). Both relations: plain table, SELECT, not FORCED, every row visible, expected columns. The derivation equals the deletion saga's. | R0 is exactly the S2-3 body (D1's → `S23_ROLLBACK_NOT_APPLIED`) with the same R0 shape. The predicate is exactly the installed body and shape (owner-only ACL, attributes, `is not true`). |
| Action | create the predicate; revoke it from `public`, `anon`, `authenticated`, `service_role`; replace R0's body | put back R0's D1 body byte for byte (first, so nothing calls the predicate), then drop the predicate |
| Postconditions | predicate: body md5, owner, shape, ACL exactly `owner=X/owner`, no API role with EXECUTE or reaching the owner. R0: same OID, the S2-3 body, the same shape | no predicate; R0: same OID, D1's body, the same shape |

**Not changed:** R1, SV, T13, W1, the v1 wire, the owner epoch, entitlements, `auth.users`, `brands`, `brand_memberships`. Nothing is written,
moved, merged or taken over.

## 4. Evidence [D] (throw-away PostgreSQL 17.11, local socket, fake data)

World: the D1 suite's (G5 stack `21a5cad4` by `git archive`, verdict blobs checked), plus D1 (blob `4f58351e…` checked) on both databases.
"s23" gets the candidate; "rev" keeps D1.

| Test | What it shows |
| --- | --- |
| 1. FAIL before | On D1's R0 (md5 checked), C4, C5, a shared own workspace and an orphan membership are all **allowed**. |
| 2. Refused installs | Each refuses with its own code, and R0's body and shape stay; no predicate is left: a superuser; R0 STRICT; R0 `RESET ALL`; R0 granted to `anon`; an API role made a member of the owner; a function already under the predicate's name; FORCE RLS; RLS on with the owner neither table owner nor BYPASSRLS; a changed R0 body. The rollback refuses where never applied. |
| 3. Install | R0: same OID / owner / ACL / every attribute. Every other `public` / `private` / `auth` function is byte-identical. The predicate is owner-only (no EXECUTE for `anon` / `authenticated` / `service_role` / `authenticator`; a call as `authenticated` is refused). A second run → `S23_ALREADY_APPLIED`. |
| 4. The predicate | 12 people (C0–C5, two owners, the four new cases, a member of someone else's brand, no service) answer as the table in §1. A NULL user raises. Another person who owns several brands gets `OWN_WORKSPACE_CONFLICT`, and nobody else's answer changes. |
| 5. R0 before / after | **24 answers: 5 change** (the four new cases, plus C4 via the Threads feature; each allow → deny `OWN_WORKSPACE_CONFLICT`, with the same 8 keys, `v`, scope and subject). **19 are byte-identical**: C0–C3, two owners, member elsewhere, no service, the Threads feature, anonymous true, a missing claim, a revoked and an expired session, role anon, broken claims, another feature. For a C4 person, anonymous / missing claim / revoked session also stay identical (refused first). |
| 6. Owner change A → B → A | The predicate follows the live rows (`own` → conflict → `own`). R0's answer carries no owner epoch either way: an R0 allow authorizes only a begin, and the exchange and posts stay behind R1 + W1. |
| 7. Rollback | Refused, with the S2-3 R0 kept, on: R0 STRICT, R0 `RESET ALL`, predicate STRICT, the predicate granted to `authenticated`, predicate `RESET ALL`, a changed predicate body. Then it runs: D1's R0 byte for byte, same OID / shape, no predicate, C4 allowed again. A second rollback → `S23_ROLLBACK_NOT_APPLIED`. Re-install works; C1 is still allowed. |

- **Runs:** 7 tests ×3, all PASS.
- **Mutations:** 24 / 24 detected (control PASS): 7 on the rule, 2 on R0's mapping, 9 on the install guards, 6 on the rollback guards. The postcondition shape checks of R0 are equivalent mutants and not counted: the replace has just reset every
  attribute.
- **Static checks:** deno check / lint, `bash -n`, Python syntax, `git diff --check`.

**Stand-in:** the orphan membership. The fixture's foreign key forbids it, so the superuser inserts it with
`session_replication_role = replica`. Whether the managed `brand_memberships` has that key is NOT_VERIFIED: the POSTONA base tables are created
by no migration.

## 5. Not changed here, recorded for other owners

| Owner | Item |
| --- | --- |
| G4 (#319) | The live X begin (main `20260922003101…:34-45`) still joins an existing row under the derived id (`on conflict do nothing` + an owner insert) and reuses any single owned brand. To align: call T13 (or R0) first, then this predicate from inside the begin RPC with `auth.uid()`; refuse unless `absent` / `own`; treat an `on conflict` as a refusal, never a join. |
| G3 (#318) | X create takes the brand of the chosen X account and allows co-owners. To align: the predicate must answer `own` for the caller, and the brand must be that workspace. |
| G6 (#321) | No change: R0 is not on its path. R1's answers are unchanged by this candidate. |

## 6. Not verified / not decided

- **NOT_VERIFIED:**
  - the managed `brands` / `brand_memberships` (their RLS, FKs, owner and columns, and whether every row is visible to the lifecycle owner);
  - the managed GoTrue claim set;
  - real consumers;
  - concurrency between the predicate and a membership change committed during R0's statement (the predicate reads R0's snapshot; a race
    test is not part of this suite);
  - production.
- **[PENDING] P-1** (the user's decision): people with a legacy / shared workspace (C4 / C5, a shared own workspace) are **refused** by this
  rule. That is the fail-closed default, not a policy; a migration path or an opt-in would be a separate decision.
- A membership (not ownership) in someone else's brand is outside the §4.1 rule. The answer stays `absent` / `own`, and test 4 records it.
  Whether such memberships should count is part of P-1.
- Nothing about retention, deletion, receipts after a stop, locked / banned, or sign-out was decided (P-2 – P-5).
