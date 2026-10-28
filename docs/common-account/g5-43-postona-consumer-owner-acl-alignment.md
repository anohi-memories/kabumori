# POSTONA consumers on the G5 migration candidate: owner / ACL alignment (G5-43)

Status: **source-only.**
- Not applied.
- No G3 / G4 / G6 / H file changed: their sources were read and loaded at their PR heads, read-only.
- Production **NO_GO**.
- TASK `common-account-g5-postona-consumer-owner-acl-integration-unblock-20261028` (Issue #320, G5-01 generation, task 43, completion K5).

This updates the G4 "Ownership" row of G5-42's contract (§4), from "decision needed" to "measured; recommendation below". The decision itself stays with 担当ちゃ / the user.

## 1. Result in one line

The **no-grant** option (G5's proposal in G5-42) works:
- the lifecycle owner installs the G5 migration candidate, then G4's real X `001`–`004` and G3's real `001`;
- every G4 precondition holds, G5's ACLs do not change, and the real begin / consume run through the real G5 gates;
- the new read-only check reports nothing.

G5 adds **no grant**. Every other way of satisfying G4's precondition is measured and named by the check.

## 2. Measured (PG17.11, local, fake data; `supabase/tests/postona_personal_auth_consumer_alignment_pg_*`)

| Case | G4 / G3 | G5 check | Call |
| --- | --- | --- | --- |
| G4 `001` before G5 | refuses `G4X_PRECONDITION_AUTHORITY_MISSING private.postona_personal_session()`, nothing created | `GATE_OWNER_MISSING` | — |
| Aligned: everything by the lifecycle owner | X `001`–`004` and G3 `001` install; **no grant**; G5 ACLs byte-identical before and after | no finding | begin / consume OK through S2-2 + S2-3 + owner epoch |
| Aligned, refusals | — | — | All of these give `SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE` at begin and at consume:<br>• `is_anonymous: true`<br>• `is_anonymous` missing<br>• `is_anonymous` as a string<br>• role claim `anon`<br>• `session_id` missing<br>• an ended session<br>A→B→A on the owner membership gives `OWNER_EPOCH_CHANGED` (Q11). G3 `caller()` answers the person, gives `POSTONA_RESV_AUTH_REQUIRED` for an anonymous one, and is internal (`authenticated`: permission denied). R1 runs for `authenticated` (8 keys); `anon` / `service_role` are denied. |
| `mo`: begin / complete / consume owned by another non-superuser role | `001` refuses `G4X_PRECONDITION_AUTHORITY_NOT_EXECUTABLE`; nothing created | no finding (main's bodies call no gate) | — |
| `mo` + the "easy fix": EXECUTE on S2-2 / S2-3 / owner epoch to that role | **G4's precondition accepts it**; `001` / `002` / `004` install | `GATE_ACL_WIDENED` ×3, `CONSUMER_OWNER_MISMATCH` (helpers, begin, consume …) | — |
| `su`: the same three owned by a superuser | **G4's precondition accepts it** (`has_function_privilege` is true for a superuser); `001` / `002` / `004` install | `CONSUMER_OWNER_MISMATCH` (helpers, begin, complete, consume); no gate widened | — |
| Aligned, then begin's owner changed later | — | `CONSUMER_OWNER_MISMATCH` begin | fails closed (permission denied) |
| Other ways out (each applied, checked, undone) | — | Each one is named by the check (see the list below this table) | — |
| Rollback with consumers present | — | — | G5 rollback refuses `BUNDLE_ROLLBACK_CALLERS`, nothing dropped. After G4's rollbacks `004`→`001` and G3's schema removed (test world), it returns the exact pre-install catalog. |

The other ways out, each named by the check:
- a gate grant to `authenticated` / `service_role`;
- a NULL ACL;
- a G5 function with another owner;
- a superuser gate owner;
- `authenticator` made a member of the owner;
- R1 / R0 / W2 ACL drift;
- an invoker consumer, including a SQL-standard body;
- a definer consumer without a fixed search_path, or with `"$user"` in it;
- CREATE on `public` for an API role;
- a view on a gate.

These do not count as consumers:
- a caller of an exposed entry (begin);
- a definer that reaches a gate through G3's `caller()` and is owned by the lifecycle owner.

Mutation: 18 / 18 mutants of the check detected, each by an assertion naming its case.

## 3. Per owner (recommendations; their TASKs are not overridden)

| Owner | Finding | Recommendation |
| --- | --- | --- |
| **G4** (X `001`, Threads `001` / `002`) | The install precondition `has_function_privilege(owner, gate, 'EXECUTE')` also passes for a **grant** to another owner and for a **superuser** owner, both measured on X. Threads has the same line; this was checked statically only, because the PR #124 stack was not loaded. | Install as the lifecycle owner (no grant). Optionally tighten the precondition to "begin / complete owner = the owner of `private.postona_personal_session()`, not a superuser", and/or run G5's check after install. G4-1 (no T13 / R1 on X) and G4-2 (bare epoch) stay open. |
| **G3** (`001`) | Installs and runs on the candidate as the lifecycle owner. `caller()` is an owner-only definer helper behind S2-2. | Same installer. The G5-42 recommendation (owner / ACL self-check in `caller()`) still applies. Provide a rollback for `001`. Run G3's suites against this candidate once. |
| **G6** | R1 `authenticated` ACL is unchanged by every consumer install; the transport needs no grant. | Wire after the candidate is applied. |
| **H5** | Verified `is_anonymous` / `role` / `session_id` are required. Each missing or wrong one is refused (measured above). | Forward them unchanged. |

## 4. Open (not decided here)

1. **The G4 ownership decision** (担当ちゃ / user): G5 recommends no grant, with this check as the gate. A reviewed grant would be reported by this check as `GATE_ACL_WIDENED`, so choosing it means changing G5's rule in a separate, reviewed TASK.
2. **PR #457** (P2, H3 stopped): production is blocked. This work is independent of it; the owner-epoch candidate is loaded as the prerequisite world only.
3. G4-1 / G4-2 (G4), G3's `001` rollback (G3), H5 claims, F-1 / P-1 – P-5 (user).
4. **Not verified:**
   - managed owners / GoTrue / PostgREST / RLS;
   - G4 Threads at runtime;
   - G3 `002`–`006`;
   - dynamic SQL;
   - Edge / app callers;
   - production.
