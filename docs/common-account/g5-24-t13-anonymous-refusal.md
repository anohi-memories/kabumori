# S2-1: T13 refuses an anonymous sign-in (isolated source candidate)

Status: **isolated source candidate + local PG17 proof.**
- No migration, app, Edge, Auth or G3 / G4 / G6 file changed.
- Nothing applied anywhere; no managed or production connection (not even read-only).
- It needs an independent Codex Sol (high) review before it counts. Production **NO_GO**.
- It does not make PR #457 (independent review still open) reviewed or passed.
- **G5-25 revision** (task `common-account-g5-s2-1-pr480-anonymous-claim-missing-failclosed-p2-source-fix-20261023`, Issue #320 task 25):
  the P2 of H4's independent review (Issue #331 comment 6366601676, Codex Sol (high), CHANGES_REQUIRED on PR #480 `1a974b8d`) is fixed.
  A **missing, null or empty** `is_anonymous` claim is now refused: only a proven false passes. PR #480 stays as the review evidence; the
  fix is a separate Draft PR on top of it. Section 8 holds the details.
- **G5-30 revision** (task `common-account-g5-t13-pr483-function-attribute-shape-guard-source-candidate-20261025`, Issue #320 task 30):
  the shape checks of the install and the rollback now also pin the function attributes that a CREATE OR REPLACE resets without an error,
  and a NULL in the check refuses. Before, PR #483 installed (and rolled back) over such a drift and erased it. The bodies are unchanged.
  PR #483 stays as the review evidence. Section 9 holds the details.

- TASK `common-account-g5-postona-personal-s2-1-anonymous-session-guard-source-candidate-20261023` (Issue #320, G5-01 generation, task 24,
  completion K5).
- Design: S2-1 of `docs/common-account/g5-23-postona-personal-auth-s1-contract.md` (PR #477, head `f7a221b7a45cf22c36b5e4d3d2c42ed564512d4a`).
- Finding it closes: S1-F2 (G3's coordination, Issue #320 comment 6355355712).
- New files only:
  - `supabase/candidates/postona_personal_auth/001_t13_anonymous_refusal{,_rollback}.sql`;
  - `supabase/tests/postona_personal_t13_anon_{pg_run.sh,pg_test.ts,mutations.py}`;
  - this document.

Labels: **[M]** main `0c42933ca5030ab31a56267529430d0473d9b155`; **[C]** a Draft candidate at a pinned commit; **[D]** this task's PG17 suite;
**[R]** another owner's reported result; **[U]** NOT_VERIFIED.

## 1. T13 before and after

T13 = `private.account_lifecycle_assert_active_service_write(p_user_id uuid, p_service_key text)`.
- Source: `supabase/migrations/20261010051938_common_account_service_write_guard.sql` in the G5 Draft chain [C].
- Last changed at `76b50e1e03f82faaa3460bab1603afa8fef3ce44`; the same blob `da587631cfe8872e3ccf6fd521b919a5439c6574` is at PR #457's head.
- Not on main.

| Step | Reviewed T13 | With this candidate |
| --- | --- | --- |
| 0 | READ COMMITTED only; service key valid | unchanged |
| 1 subject | sub / role / session_id from ONE claim source (per-claim settings of an older PostgREST, else the JSON claims); `sub = p_user_id = auth.uid()`; role `authenticated`; session id present | **also `is_anonymous`, from the same source; only a PROVEN false passes**: the JSON claim must be the boolean `false`, the per-claim setting exactly `'false'`. Missing, null, empty, another JSON type (string, number, object) or any other value → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` (G5-25). Still **before any lock**. |
| 2 locks | login KEY SHARE → account FOR UPDATE → entitlement FOR UPDATE; account / service states | unchanged |
| 3 session | the session row is live, read after the locks | unchanged |
| ACL | owner-only EXECUTE, no API role reaches it | unchanged (same OID, ACL, owner, definer, volatility, empty `search_path`) |

The diff of the function body is exactly seven lines (G5-24's version had six; the earlier text said seven):
- one declaration;
- one read per claim source;
- three comment lines;
- one condition.

All other checks, codes, lock order and shape are unchanged; the generator copies the reviewed body byte for byte (section 5).

**How R0 / R1 / SV compare [C].** All three refuse `is_anonymous: true` (`002_bootstrap_verdict.sql` L129, L140, L144;
`003_session_verdict.sql` L95, L106, L110; R1 `001_authorization_verdict.sql` L167, L179 at `21a5cad4`).
- Since G5-25, T13 is **stricter** than they are: they still read a missing / null claim as false.
- G5-25 does not change them (that needs its own TASK and review). The difference is a coordination item (section 8).
- In practice it matters only for a token without the claim; GoTrue documents the claim as always present [U on managed].

## 2. Is an anonymous sign-in needed anywhere? (checked before deciding)

| Where | Result |
| --- | --- |
| apps (`apps/`) on main and on the G5 stack | no `signInAnonymously`, no `is_anonymous` use [M] [C] |
| Edge functions (`supabase/functions`) | none [M] [C] |
| the X OAuth onboarding design | requires "a real, non-anonymous Supabase Auth" user (`apps/social-mobile/docs/phase9-x-oauth-onboarding.md` L111 [M]) |
| `supabase/config.toml` | not in the repository: whether the managed project enables anonymous sign-ins is **[U]** |

**Conclusion:** no POSTONA path needs an anonymous person to pass T13.
- A signed-in person keeps the reviewed behaviour (section 4).
- A person who converts an anonymous login to a permanent one gets new tokens with `is_anonymous: false`. An old token that still says `true`
  is refused until it refreshes: fail closed.
- G5-25: a token **without** the claim is refused too. No signed-token evidence of a valid GoTrue / PostgREST token lacking the claim was
  found, and no compatibility requirement was given; relaxing this needs that evidence and the user's decision (H4's condition).

## 3. Answer codes and HTTP (proposal for the consumers; T13 itself only raises)

T13 raises SQLSTATE 42501 with a fixed message. The mapping below is what the G5-23 S1 contract and the G5-11 consumer contract ask of a
consumer. It is **not** implemented here, and no G3 / G4 file is changed.

| T13 message | HTTP the consumer should answer | Note |
| --- | --- | --- |
| `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` (no / bad claims, another person, anonymous **(new)**, no live session) | 401 | the person must sign in (again) as a real user |
| `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`, `SERVICE_NOT_REGISTERED`, `SERVICE_NOT_ACTIVE`, `ACCOUNT_LOCKED`, `ACCOUNT_DELETION_IN_PROGRESS`, `SERVICE_DELETION_IN_PROGRESS` | 403 | the person exists, the service state refuses |
| `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE` (not READ COMMITTED, auth tables unreadable) | 503 | nothing is written or sent |
| `ACCOUNT_LIFECYCLE_SERVICE_INVALID` | 500 (a programming error) | — |
| (not T13's) an unknown resource and another person's resource | 404, the same for both | decided by the consumer after T13 |

## 4. Evidence [D] (throw-away PostgreSQL 17.11, local socket only, fake data)

`supabase/tests/postona_personal_t13_anon_pg_run.sh` builds two identical databases:
- from main's lifecycle chain (fixtures, onboarding, deletion, Phase 1, Phase 2, Phase 3a);
- plus the reviewed T13 and its fixture, read with `git show` from `76b50e1e` (blob ids checked).

"s21" gets the candidate; "rev" keeps the reviewed T13. The writer under test is the fixture's consumer stand-in
`public.fixture_guarded_service_write` (a definer writer owned by the lifecycle owner, EXECUTE for `authenticated`, T13 first): the shape of a G3 /
G4 writer, without touching their files.

| # | Test | Result |
| --- | --- | --- |
| 1 | FAIL before: the installed T13's body md5 equals the reviewed one; an anonymous sign-in writes, by JSON claims and by per-claim settings | reproduced (G3's finding) |
| 2 | refused installs leave the reviewed T13 untouched: superuser; another non-owner role; EXECUTE granted to `authenticated`; an API role made a member of the owner; a changed body; the rollback where the candidate never ran | each refused with its code, md5 unchanged |
| 3 | install: same OID (every consumer reference stays), same ACL, the expected body; no API role can execute it (no Data API path: `private`, no grant); a second run refuses | as stated |
| 4 | PASS after, 19 cases compared with the reviewed T13 (G5-25) | 11 now `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`: the 6 anonymous forms (JSON true, "true", "false" string, 1; per-claim true, yes) and the 5 unproven ones (JSON missing, null, `{}`; per-claim missing, empty). The 8 others are identical: JSON false, per-claim false, another session, expired, role anon, no session id, broken claims, no service (all proving false). A committed anonymous call writes nothing; a writer handing over another id and REPEATABLE READ are unchanged. |
| 5 | before any lock: while another session holds the account row FOR UPDATE, the anonymous call is refused at once; a person's call waits and hits its lock_timeout | as stated |
| 6 | rollback: the reviewed body byte for byte, same OID; the anonymous and the missing-claim cases pass again; a second rollback refuses; the candidate re-installs and refuses both | as stated |
| 7 | **P2 before** (G5-25): PR #480's own candidate (`1a974b8d`, read with `git show`) lets a missing JSON claim, a JSON null, a missing per-claim setting and an empty one through (while refusing `true`); its rollback restores the reviewed T13 | reproduced; this revision refuses all four (test 4) |

`supabase/tests/postona_personal_t13_anon_mutations.py`: 12 mutants (G5-25), each must make the suite fail:
- the check removed;
- only the literal `true` refused;
- either claim source not read;
- a missing or empty per-claim setting taken as false;
- a missing or null JSON claim taken as false;
- the JSON type not checked;
- the refusal moved after the locks;
- the body, shape and already-applied install guards removed;
- the rollback restoring a different body.

A body mutant has its checksums recomputed, so it fails for the rule and not for the checksum.

**Not run [U]:**
- the real G3 / G4 writers (their files are not touched here; they inherit the behaviour because they call T13 first);
- the managed project's auth settings and claims;
- PostgREST.

## 5. Install, compatibility and rollback

- **Order:** after the reviewed T13 (20261010051938) and before or after its consumers. Consumers keep calling the same function: no consumer
  change is needed or made.
- **The candidate refuses unless:**
  - the function is exactly the reviewed T13 (md5 of its body);
  - it is owned by the running role (not a superuser);
  - it is definer / volatile / plpgsql / returns void with an empty `search_path`;
  - EXECUTE is for its owner alone;
  - no API role reaches it through any membership.
- **The candidate's postconditions:** the same OID, the expected body, the same shape.
- **Rollback** (`…_rollback.sql`): refuses unless the function is exactly the S2-1 body, then puts back the reviewed body byte for byte (the
  same OID; postconditions as above). It writes no row. The rollback's body and the reviewed migration's body are identical text (checked when
  generating: `diff` empty).
- **Mixed clients (G5-25):** a token with `is_anonymous: false` works. `true`, a missing / null / empty claim and any unexpected value are
  refused. A client never sets the claim: GoTrue issues it, and PostgREST verifies the signature before it sets the claims T13 reads.
- **Not changed:** service enrollment, entitlements, the owner epoch, the workspace rule (S1-F1 stays a separate TASK), the existing migration
  file.

## 6. Coordination to offer (not posted; for the 担当ちゃ to route)

| To | Content |
| --- | --- |
| G3 (#318) | "When S2-1 is applied after its review, every X / Threads writer that calls T13 first refuses an anonymous sign-in with `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` before any lock; map it to 401. User RPCs that do NOT call T13 (P7 receipt / cancel, the 43 X entry points of PR #466) still need the session gate (S2-2) — this candidate does not cover them." |
| G4 (#319) | "The Threads OAuth begin / consume / complete and the claim candidate call T13 first, so they inherit the refusal; add an anonymous case to your T13 tests when you next touch them. No change to OAuth state, custody or lease is implied." |

## 7. Remaining (see also sections 8 and 9)

1. Independent Codex Sol (high) review of the two SQL files and the suite.
2. S2-2 (a session gate without the owner-epoch coupling) for the writers that do not call T13; S2-3 / S1-F1 (one personal-workspace rule) —
   separate TASKs.
3. The managed project's anonymous-sign-in setting and its JWT claims [U].
4. PR #457's independent review (open), G3 PR #370 A1 / A2 / B / C, Q1, MAINTAIN, the S1 open questions — unchanged.

## 8. G5-25: fail closed on a missing claim (H4 P2 on PR #480)

| Item | Detail |
| --- | --- |
| The finding | The G5-24 candidate turned a missing / null JSON claim, or a missing / empty per-claim setting, into false and let it pass (H4, Issue #331 comment 6366601676, P2). Its own docs claimed compatibility with an older GoTrue without signed-token evidence. |
| The fix | JSON: `case when jsonb_typeof(v_claims -> 'is_anonymous') = 'boolean' then v_claims ->> 'is_anonymous' end`. Per-claim: `nullif(current_setting('request.jwt.claim.is_anonymous', true), '')`. Unchanged condition: `v_anonymous is distinct from 'false'`. So only the JSON boolean false, or the per-claim text `'false'`, passes. |
| Body checksums | the reviewed T13 `08840016794a973225be767952265e79` (unchanged); the S2-1 body `1f8cd9c764c251f3232c61b7a77ff597` (was `cba0e35a9c7e9871f9770fcc036fcb73` in PR #480). The rollback's own precondition follows. |
| Unchanged | the T13 OID, owner, ACL, definer, volatility, empty `search_path`; lock order; every other check and denial code; the HTTP mapping of section 3; the rollback (the reviewed body byte for byte); the files' layout |
| Who checks what | **Signature, issuer, audience and expiry are not T13's job.** PostgREST (or the Edge in front of it) verifies the JWT before it sets `request.jwt.claims` / the per-claim settings, and T13 trusts only what that layer set. T13 adds the meaning of the verified claims: the person, the session and non-anonymity. It also re-reads the session row. An unverified token never reaches T13 as claims [U on managed: the PostgREST / GoTrue configuration is not read]. |
| R0 / R1 / SV | still treat a missing / null claim as false. **Not changed here** (each is its own reviewed candidate). Proposal for the 担当ちゃ: align them in one later G5 TASK with their own suites and a Sol review, or record that the difference is accepted. Until then, T13 is the stricter gate. |
| Tests | 7 tests ×3 (test 7 reproduces the P2 on PR #480's head; test 4 compares 19 cases); 12 / 12 mutants |
| Not verified | the managed GoTrue / PostgREST claim set; real G3 / G4 writers; production |

## 9. G5-30: the function attributes in the shape checks

| Item | Detail |
| --- | --- |
| Why | A CREATE OR REPLACE sets every attribute it does not name back to the default. PR #483's shape checks look at the owner, definer, volatility, return type, language, `search_path`, ACL and API-role reach only. So a drifted T13 was accepted and silently "repaired" by the install, and the same by the rollback (D1 got this guard in G5-28 / G5-29; T13 had not). |
| Measured baseline [D] | The reviewed T13 (76b50e1e) in PG17.11: not STRICT, not LEAKPROOF, PARALLEL UNSAFE (`u`), COST 100, no support function, `protrftypes` NULL, ROWS 0, `proargmodes` NULL, a plain function (`f`) returning one `void`, plpgsql, arguments `{p_user_id,p_service_key}` without defaults, definer, VOLATILE, `proconfig` `{search_path=""}`, EXECUTE for the owner only. Measured, not copied from D1. |
| Drift probe on PR #483 (`9d739904`) [D] | **Erased silently** by its install and its rollback: STRICT, PARALLEL SAFE / RESTRICTED, COST 50, LEAKPROOF, SUPPORT `textlike_support`, `RESET ALL` (proconfig NULL), and the catalog stand-ins TRANSFORM `{int4}` / `{}`, ROWS 10, argument modes `{i,i}`. **Already refused** by its shape check: an extra setting, STABLE, SECURITY INVOKER. **Refused by PostgreSQL itself** (the replace errors, so the transaction rolls back): an argument default, other argument names, a set-returning flag, another routine kind. `ALTER FUNCTION ... ROWS` is impossible on a function returning void. |
| The NULL hole | `RESET ALL` leaves `proconfig` NULL. `p.proconfig = array[...]` is then NULL, `not (NULL)` is NULL, and a plpgsql `IF` treats NULL as false: the check passed. The check is now `(...) is not true`, so a NULL refuses. |
| The fix | In all four shape checks (install pre / post, rollback pre / post): `and not p.proisstrict and not p.proleakproof and p.proparallel = 'u' and p.procost = 100 and p.prosupport::oid = 0 and p.protrftypes is null and p.prorows = 0 and p.proargmodes is null`, and `is not true` in place of `not (...)`. Only the attributes the probe showed to be erased are added; those PostgreSQL already refuses are not. |
| Unchanged | both function bodies and their md5 (`08840016…` reviewed, `1f8cd9c7…` S2-1), the anonymous-claim rule, every denial code and the lock order, OID, owner, ACL, definer, `search_path`. T13 reads no owner epoch; the session and entitlement answers are in the 19-case comparison. |
| Stand-ins | TRANSFORM, ROWS and argument modes can only drift here by a superuser's direct `update pg_catalog.pg_proc` (labelled CATALOG STAND-INS in the suite). A real plpgsql TRANSFORM needs a C extension that this PG17 does not have: the **real TRANSFORM path is NOT_VERIFIED**. STRICT, PARALLEL, COST, RESET ALL (owner) and LEAKPROOF, SUPPORT (superuser) use the real DDL. |
| Post-checks | The postcondition copies cannot see a drift: the CREATE OR REPLACE just before them resets these attributes. They stay as defence in depth. Their mutants are equivalent and are not counted. |
| Tests [D] | 10 tests ×3: G5-25's 7, plus (a) every drift reproduced on PR #483's own candidate and rollback (read with `git show`), (b) every drift refuses the install with `T13_ANON_PRECONDITION_SHAPE`, leaving the body and the drift, (c) every drift refuses the rollback with `T13_ANON_ROLLBACK_PRECONDITION_SHAPE`. The install and rollback tests compare the whole attribute row with the measured baseline. Mutants: 12 + 18 (9 removals from the install precondition, 9 from the rollback precondition). |
| Not verified | the managed project's real T13 attributes, owner and ACL; the managed GoTrue / PostgREST claims; real G3 / G4 writers; production. |
| Same pattern elsewhere (not changed here) | The D1 candidate (PR #488) uses the same `not (...)` form with `proconfig`. By reading it, a `RESET ALL` on R0 / R1 / SV would slip through it the same way. Not run on the D1 world and not changed (D1 is outside this TASK). Proposal: a separate small G5 TASK. |
