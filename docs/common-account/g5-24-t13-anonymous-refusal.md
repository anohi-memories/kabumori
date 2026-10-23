# S2-1: T13 refuses an anonymous sign-in (isolated source candidate)

Status: **isolated source candidate + local PG17 proof.**
- No migration, app, Edge, Auth or G3 / G4 / G6 file changed.
- Nothing applied anywhere; no managed or production connection (not even read-only).
- It needs an independent Codex Sol (high) review before it counts. Production **NO_GO**.
- It does not make PR #457 (independent review still open) reviewed or passed.

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
| 1 subject | sub / role / session_id from ONE claim source (per-claim settings of an older PostgREST, else the JSON claims); `sub = p_user_id = auth.uid()`; role `authenticated`; session id present | **also `is_anonymous`, from the same source**. A missing claim (or JSON null) = not anonymous, exactly as R1 / R0 / SV read it; any other value than false → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`. Still **before any lock**. |
| 2 locks | login KEY SHARE → account FOR UPDATE → entitlement FOR UPDATE; account / service states | unchanged |
| 3 session | the session row is live, read after the locks | unchanged |
| ACL | owner-only EXECUTE, no API role reaches it | unchanged (same OID, ACL, owner, definer, volatility, empty `search_path`) |

The diff of the function body is exactly seven lines:
- one declaration;
- one read per claim source;
- two comment lines;
- one condition.

All other checks, codes, lock order and shape are unchanged; the generator copies the reviewed body byte for byte (section 5).

**How R0 / R1 / SV compare [C].** All three already refuse anonymous with the same reading (`002_bootstrap_verdict.sql` L129, L140, L144;
`003_session_verdict.sql` L95, L106, L110; R1 `001_authorization_verdict.sql` L167, L179 at `21a5cad4`). After this candidate, T13 agrees with
them.

## 2. Is an anonymous sign-in needed anywhere? (checked before deciding)

| Where | Result |
| --- | --- |
| apps (`apps/`) on main and on the G5 stack | no `signInAnonymously`, no `is_anonymous` use [M] [C] |
| Edge functions (`supabase/functions`) | none [M] [C] |
| the X OAuth onboarding design | requires "a real, non-anonymous Supabase Auth" user (`apps/social-mobile/docs/phase9-x-oauth-onboarding.md` L111 [M]) |
| `supabase/config.toml` | not in the repository: whether the managed project enables anonymous sign-ins is **[U]** |

**Conclusion:** no POSTONA path needs an anonymous person to pass T13.
- A signed-in person keeps the reviewed behaviour (section 4).
- A person who converts an anonymous login to a permanent one gets new tokens without the flag. An old token that still says `true` is refused
  until it refreshes: fail closed.

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
| 4 | PASS after, 17 cases compared with the reviewed T13 | the 6 anonymous forms (JSON true, "true", "false" string, 1; per-claim true, yes) now `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`; the 11 others identical (false, missing, null, per-claim false / missing, another session, expired, role anon, no session id, broken claims, no service); a committed anonymous call writes nothing; a writer handing over another id and REPEATABLE READ unchanged |
| 5 | before any lock: while another session holds the account row FOR UPDATE, the anonymous call is refused at once; a person's call waits and hits its lock_timeout | as stated |
| 6 | rollback: the reviewed body byte for byte, same OID; the anonymous case passes again; a second rollback refuses; the candidate re-installs | as stated |

`supabase/tests/postona_personal_t13_anon_mutations.py`: 11 mutants, each must make the suite fail:
- the check removed;
- only the literal `true` refused;
- either claim source not read;
- a missing claim taken as anonymous;
- `->>` instead of `->`;
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
- **Mixed clients:** a token without `is_anonymous` (an older client or GoTrue version) keeps working; a token with `is_anonymous: false` works; only
  `true` (or an unexpected value) is refused.
- **Not changed:** service enrollment, entitlements, the owner epoch, the workspace rule (S1-F1 stays a separate TASK), the existing migration
  file.

## 6. Coordination to offer (not posted; for the 担当ちゃ to route)

| To | Content |
| --- | --- |
| G3 (#318) | "When S2-1 is applied after its review, every X / Threads writer that calls T13 first refuses an anonymous sign-in with `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` before any lock; map it to 401. User RPCs that do NOT call T13 (P7 receipt / cancel, the 43 X entry points of PR #466) still need the session gate (S2-2) — this candidate does not cover them." |
| G4 (#319) | "The Threads OAuth begin / consume / complete and the claim candidate call T13 first, so they inherit the refusal; add an anonymous case to your T13 tests when you next touch them. No change to OAuth state, custody or lease is implied." |

## 7. Remaining

1. Independent Codex Sol (high) review of the two SQL files and the suite.
2. S2-2 (a session gate without the owner-epoch coupling) for the writers that do not call T13; S2-3 / S1-F1 (one personal-workspace rule) —
   separate TASKs.
3. The managed project's anonymous-sign-in setting and its JWT claims [U].
4. PR #457's independent review (open), G3 PR #370 A1 / A2 / B / C, Q1, MAINTAIN, the S1 open questions — unchanged.
