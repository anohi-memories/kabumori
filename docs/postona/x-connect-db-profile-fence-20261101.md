# POSTONA X connect — the database must agree with the entry's profile (G4-02 #7, 2026-11-01)

task_id: `postona-g4-gen2-07-x-personal-db-profile-mismatch-failclosed-edge-fence-20261101` (Issue #561). Stacked on PR #613.

**Status:** source and local QA only. Nothing is applied or deployed. Production stays NO_GO.

## 1. The risk, and the fix

**Risk (measured).** With `POSTONA_X_AUTH_PROFILE=personal` on the Edge and the full profile in the database, X connect simply ran: the full SQL does not bind the service generation. The environment value cannot see the database.

**Fix.**
- **SQL:** `supabase/candidates/postona_g4_x_oauth_personal_mvp/006_x_connect_profile_fence.sql` adds `public.postona_x_connect_profile_v1() returns text`, answering `personal` or `mismatch`. It exists only in the personal build.
- **Edge:** `x-oauth-connect-user` calls it first, with the caller's JWT, on every start and callback: before GoTrue, the X code exchange and any write. Only exactly `personal` passes.

| The database / the answer | The entry |
| --- | --- |
| `personal` | continues |
| `mismatch`, any other answer | 503 `X_CONNECT_PROFILE_MISMATCH` |
| full, or not installed (PostgREST 404) | 503 `X_CONNECT_PROFILE_MISMATCH` |
| timeout, network failure, any other status | 503 `X_CONNECT_PROFILE_MISMATCH` |
| the JWT is not accepted (401) | 401 `SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED` |

**`personal` only when all of these hold, read from the catalog in one statement:**
- F5's owner epoch function does not exist;
- begin, complete and consume are exactly the reviewed 005 bodies, and `require_owner_epoch` is exactly the personal body (md5 of `prosrc`), each the only function of its name;
- G5's MV exists; it and the helper are callable by their owner only;
- all share one owner, and that owner is not a superuser.

**md5 of the fence's body:** `be205910898f0d332b6494db014f31a8`.

## 2. New surface (scope for the single review)

**Exactly one `GRANT EXECUTE` on this one function to `authenticated`** (not anon, not service_role).
- SECURITY INVOKER, STABLE, `search_path ''`. **No new SECURITY DEFINER.**
- It reads only `pg_catalog`, and writes nothing.
- A signed-in person can learn one word about the deployment, and nothing else.
- Authenticated reading of `pg_catalog.pg_proc` on managed Supabase is **NOT_VERIFIED**. If it were refused, the entry refuses: fail-closed.

Add this function and the Edge's call to the single review already proposed (the generated personal X delta, its build script, the verdict gate, together with G3's consumer change). H1-29 / H4-15 are not repeated.

## 3. Measured (isolated PG17 and the real local stack; fake X / Threads)

**FAIL → PASS.** The X entry **without** the call, on the full profile, connects (`NEGATIVE_CONTROL_CAUGHT x_entry_without_db_check`). With the call, on the same SQL: refused at start and at the callback, 0 X calls, no state written at start, the account unchanged.

**SQL probes (`G4T_VERDICT=1`). Each single change turns the answer to `mismatch`:**
- owner epoch function present;
- helper with another body;
- begin with another body;
- helper exposed;
- G5's MV exposed;
- G5's MV missing;
- a second function of a checked name.

**Install and rollback:**
- 006 refuses on full, and without the personal X, and twice;
- `authenticated` gets `personal`; `anon` and `service_role` have no EXECUTE;
- rollback, then install again.

**Real local stack (`postona_g4_oauth_local_stack/run.sh`): 21/21, node exits by itself.** The new scenarios:

| # | Scenario | Result |
| --- | --- | --- |
| X8 | through real PostgREST | a person: `personal`; no JWT: refused; tampered JWT: 401 |
| X9 ×2 | owner epoch present; fence absent (404) | start and callback refused; **0 X calls** (with a positive control in the same worker), no state at start, credential unchanged, generation unchanged; correct again = connects |
| X10 | disconnect on a mismatched database | `disconnected`; 0 provider calls |

**Existing scenarios on the real stack, unchanged:** connect, reconnect, real refresh, anonymous, signed out, session switch, service stop, ABA.

**X app e2e:** main / g4 / g4p 11/11 each.
- main and g4 run their older scenarios through a labelled stand-in for the answer (they have no fence). Their new scenario asks the real database and proves the refusal.
- g4p always asks its real database.

## 4. Limits (stated, not hidden)

- **Disconnect is deliberately not fenced.** It is a direct RPC without the Edge, it reaches no provider and stores no credential, and blocking it would leave a person unable to disconnect on a misconfigured deployment.
- (See G4-02 #8: `x-refresh-writer-db-profile-fence-20261101.md`; a fence is built, its live wiring is its owner's.) **Token refresh does not pass through this entry.** Main's refresh core and its worker are the only token writer (G4-40 002) and are not G4's Edge. This fence does not stop them on a mismatched database. Do not run the refresh worker on a mismatched database; G3's send still needs G4's verdict + MV.
- **The check runs at request time, per request.** A database changed between the check and the RPC is still subject to the SQL's own rules.
- **The fence's pins are exact.** Any later change to a pinned body makes X connect refuse until the pin is updated with a review: that is the point, and it needs planning.

## 5. Non-production adoption

**Install** (order; each step its own approval):
1. G5 MVP
2. PR #124 + custody
3. Threads g5pv + stack
4. personal X 001, X 002–004, personal X 005
5. **006**
6. verdicts
7. Only then: the Edge with `POSTONA_X_AUTH_PROFILE=personal`

**Rollback:**
1. the Edge first (or stop routing to it)
2. **006**
3. the verdicts
4. the X files (005 → 001)

Rolling 006 back under a running Edge turns X connect off (fail-closed).

**Do not adopt if any of these holds:**
- the database still has `private.account_lifecycle_brand_owner_epoch`;
- the fence answers anything but `personal` to a signed-in test person;
- the X refresh worker would run against a database that answers `mismatch`;
- G5's MVP or the single review has not passed;
- the Edge `POSTONA_X_AUTH_PROFILE` is unset.

**NOT_VERIFIED:**
- managed Supabase;
- real X / Threads;
- `supabase functions deploy`;
- a real device;
- G5's real W0;
- production.
