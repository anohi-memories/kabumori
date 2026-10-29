# POSTONA personal MVP: R1-MVP's one EXECUTE to authenticated — the product unblock for G6's real path (G5-48)

Status: **source-only.**
- Nothing is applied. No managed or production connection, including read-only.
- No G6 / G3 / G4 / H file is changed. G6's PR #556 (`903a89da`) was used through a read-only `git archive` only.
- PR #457 is untouched.
- Production is **NO_GO**.
- TASK: `common-account-g5-mvp-r1-authenticated-execute-product-unblock-20261029` (Issue #320, task 48, K5).

## 1. The blocker and the fix

- R1-MVP (G5-47, `parts/M20`) ships **owner-only**. G6's real path, PR #556 `createPostonaPostAssistMvp`, calls it through PostgREST as `authenticated` with the person's JWT. That path is therefore always `permission denied`, and G6 maps that to "not allow" (measured).
- The fix is **one privilege, in its own reviewable file**: `supabase/candidates/postona_personal_mvp_auth/MVP_R1_EXECUTE_GRANT.sql`.
  - It grants `EXECUTE` on exactly `public.common_account_authorization_verdict(text, text, text)` to `authenticated`.
  - Nothing else: no other function, schema or table, and nothing for `anon`, `service_role` or PUBLIC.
- Its stop is `MVP_R1_EXECUTE_REVOKE.sql`.
- `MVP_INSTALL.sql` and M20 are **unchanged**: the profile still installs owner-only. The grant is a separate step, so the bundled review can accept or reject it on its own.

## 2. Why authenticated may call it (the minimum-privilege argument)

R1-MVP is `SECURITY DEFINER` (`search_path ''`, `row_security off`, `STABLE`), owned by the non-superuser lifecycle owner. What a caller can learn or cause:

| Concern | Why it stays closed |
| --- | --- |
| Asking about someone else | The subject comes **only** from the JWT claims (D1 strict). `sub` must equal `auth.uid()`, `role` must be `authenticated`, and `session_id` must be a uuid that is **the caller's own live row** in `auth.sessions`. `is_anonymous` must be exactly the boolean `false`. Another person's workspace, or another person's session id under your own `sub`, is refused. |
| Forged claims | PostgREST sets the claims from the verified JWT. A forged pairing still needs the victim's raw `session_id`, which R1 never returns (only `s:` + a sha256 prefix). This is the same trust model as the reviewed R1 and `auth.uid()`. Managed behaviour is **NOT_VERIFIED**. |
| Workspace oracle | Another id, an absent id and an unknown id all give the same `BRAND_ACCESS_DENIED`. S2-3 is asked only for the caller's own derived id. |
| Privilege reach | The function calls only S2-3 and GC. Both must still be owner-only `SECURITY DEFINER` with `search_path ''`, or the grant refuses. The grant gives no access to any table or gate. |
| Writes | None. The function is `STABLE` and reads only. |
| Another app or feature | `FEATURE_NOT_ENABLED`, answered before any row is read. |
| Anything unexpected | `unknown` or `deny`, never `allow`. |

## 3. What the grant checks (one transaction; any failure changes nothing)

| Check | Refusal |
| --- | --- |
| Runs as a non-superuser | `R1MVP_EXEC_PRECONDITION_OWNER_IS_SUPERUSER` |
| R1-MVP is **exactly** the reviewed body:<br>• owner = `current_user`<br>• plpgsql, `SECURITY DEFINER`, `STABLE`, returns `jsonb`<br>• `proconfig` exactly `{search_path="", row_security=off}`<br>• `md5(prosrc)` = the M20 body, `8d8392a3ceee4e157dab73cab6b089a6` | `R1MVP_EXEC_PRECONDITION_NOT_MVP` (this also covers the full profile's reviewed R1) |
| The ACL is exactly owner-only (no second run, no drift) | `R1MVP_EXEC_PRECONDITION_ACL` |
| It is the only function of that name in `public` (PostgREST resolves by name) | `R1MVP_EXEC_PRECONDITION_OVERLOAD` |
| S2-3 and GC are still owner-only | `R1MVP_EXEC_PRECONDITION_DEPENDENCY` |
| `anon` and `service_role` are not members of `authenticated` | `R1MVP_EXEC_PRECONDITION_ROLE_GRAPH` |
| **Postcondition:** the ACL is exactly `owner=X/owner,authenticated=X/owner`; `anon` and `service_role` cannot execute | `R1MVP_EXEC_POSTCONDITION_ACL` |

`postona_personal_mvp_auth_build.py --check` re-derives the body pin from M20. Any change to M20 fails `--check` until the pin and the review are redone.

**The stop** (`MVP_R1_EXECUTE_REVOKE.sql`):
- It is idempotent.
- It does not depend on the body pin, so a drifted R1-MVP can still be closed.
- It revokes from **every** non-owner grantee, including ones granted outside these files. Its postcondition (owner-only, no API role reaches it) therefore cannot fail and leave `authenticated` granted.
- It refuses only:
  - as a superuser;
  - on something that is not R1-MVP (the full profile's ACL is G5-42's).
- After the stop, G6 gets `permission denied` for every call. This is fail-closed: nothing is sent.

**Rollback:** `MVP_ROLLBACK.sql` works with the grant still in place. Dropping the function removes its ACL, and the catalog is exactly as it was before the install (measured).

## 4. Measured

The suite (`supabase/tests/postona_personal_mvp_auth_pg_*`) ran on a disposable local PG17.11, in a world **without #457**, with fake data. Results:
- **8 / 8, three runs in a row.**
- Grant / stop mutants: **15 / 15 detected.**

**Grant refusals.** Each of the following refused, and the catalog was unchanged before and after:
- a superuser;
- another role;
- a drifted body;
- a drifted search_path;
- security invoker;
- volatile;
- an ACL drift;
- an overload;
- a widened S2-3 or GC;
- `anon` or `service_role` inheriting `authenticated`;
- a second run.

**The same 28 calls, as `authenticated`, in three states:**

| Case | As shipped | Granted | After the stop |
| --- | --- | --- | --- |
| the person, own workspace | permission denied | `allow g5pv:<lifecycle_version>` (8-key v1 wire, raw session id absent) | permission denied |
| anonymous; `is_anonymous` missing or the string `"false"`; no claims; claims not JSON; role claim `anon` or `service_role`; `sub` not a uuid; `session_id` missing; a login that does not exist | permission denied | `deny AUTH_REQUIRED` | permission denied |
| another person's live session id under the person's `sub`; an unknown session | permission denied | `deny SESSION_REVOKED` | permission denied |
| an ended session | permission denied | `deny SESSION_EXPIRED` | permission denied |
| another app; an unknown feature | permission denied | `deny FEATURE_NOT_ENABLED` | permission denied |
| a malformed workspace id | permission denied | `deny BRAND_REQUIRED` | permission denied |
| another active person (control: allowed on their own workspace) asking for the person's; another person's workspace; an unknown workspace | permission denied | `deny BRAND_ACCESS_DENIED` | permission denied |
| a second member | permission denied | `deny OWN_WORKSPACE_CONFLICT` | permission denied |
| a second owner | permission denied | `unknown WORKSPACE_OWNER_UNKNOWN` | permission denied |
| suspended | permission denied | `deny SERVICE_SUSPENDED` | permission denied |
| ended (not restarted) | permission denied | `deny SERVICE_NOT_ACTIVE` | permission denied |
| being ended; an end operation while the row reads active | permission denied | `deny SERVICE_DELETION_IN_PROGRESS` | permission denied |
| tampered generation triggers | permission denied | `unknown SERVICE_GENERATION_UNAVAILABLE` | permission denied |
| RESIDUAL A→B→A (owner / service_role only) | permission denied | `allow`, same token | permission denied |

Also, once granted:
- After end → restart, the token is strictly greater.
- `anon` and `service_role` are still permission denied.

**G6 (read-only).** PR #556's adapter, pinned to the personal MVP, ran over its **real** transport. Each request it sent was executed here as the person. Every request was `POST /rest/v1/rpc/common_account_authorization_verdict` with only `p_app`, `p_brand_id` and `p_feature`.

| State | Result |
| --- | --- |
| As shipped | not allow |
| Granted | allow; recheck with nothing changed gives the same generation |
| After end → restart | the generation moves |
| Suspended | `deny SERVICE_SUSPENDED` |
| A second member | `deny OWN_WORKSPACE_CONFLICT` |
| After the stop | not allow |

PR #500's port **without** the adapter still answers `unknown OWNER_EPOCH_SHAPE`. **No G6 change is needed for this grant.** PR #556 already pins the profile and maps `g5pv`.

## 5. Order, review, open items

**Order:**
1. G6 pins the personal profile (PR #556, owner's wiring §2 there).
2. `MVP_INSTALL.sql`.
3. `MVP_R1_EXECUTE_GRANT.sql`.
4. Wire.

The stop can run at any time.

**One bundled independent review** (Codex Sol, high), covering:
- M10 (MV);
- M20 (R1-MVP);
- the stricter P3;
- the two verbatim slices;
- **this grant and its stop.**

No review loop; PR #457 / H3 stay stopped.

**NOT_VERIFIED:**
- managed Supabase: role graph (`authenticator` membership options), PostgREST claim setting, default privileges;
- G6's Edge / app wiring and real ledger;
- Threads;
- production.

**Residual and undecided:**
- RESIDUAL A→B→A (service_role / owner).
- P-1 – P-5 are not decided (P-4 = sign-out vs pending jobs). R1 itself is session-bound.
