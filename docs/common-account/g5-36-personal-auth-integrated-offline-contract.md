# POSTONA personal auth: the G5 candidates together, and the call contract for G3 / G4 / G6 (offline integration)

Status: **offline integration of isolated source candidates.**
- New G5 files only: no SQL candidate, migration, Auth, Edge, app or G3 / G4 / G6 file changed. Nothing is applied anywhere. There is no
  managed or production connection, not even read-only.
- The candidates are **not merged or rebased**. Each is read from its own PR head with `git show`, its blob is checked, and it is loaded in a
  fixed order into one throw-away PostgreSQL 17.
- The consumers here are **FAKES**: they model the call sequences G5 asks for. They are not G3's or G4's code, and they do not decide G3's or
  G4's own design.
- Production **NO_GO**. PR #457 (owner-epoch history guard) is still under independent review; this document does not change that.
- TASK `common-account-g5-r0-r1-sv-t13-s2-3-s2-2-integrated-offline-contract-20261025` (Issue #320, G5-01 generation, task 36, completion K5).
- New files:
  - `supabase/tests/postona_personal_auth_integration_{pg_run.sh,pg_test.ts,fake_consumers.sql,ablation.py}`;
  - this document.

## 1. Install order (fixed blobs) and rollback order

| # | Candidate | From (PR head) | Blob | Needs | Changes |
| --- | --- | --- | --- | --- | --- |
| 0 | the world: R1 `001`, R0 `002`, SV `003`, W1 / W2, the owner epoch, the reviewed T13 (`20261010051938`, blob `da587631`) | `21a5cad4` (PR #457) | verdict blobs `6e4ebfc4` / `f78d87a9` / `a0680eb3` | — | — |
| 1 | D1 `002_verdicts_anonymous_strict.sql` | `c9f726e9` (PR #494) | `4f58351e` | the reviewed R0 / R1 / SV | bodies of R1 / R0 / SV |
| 2 | S2-3 `003_s2_3_workspace_eligibility.sql` | `bbc52a6b` (PR #506) | `84a9ad79` | R0 as D1 leaves it | + predicate, R0 body |
| 3 | S2-2 `004_s2_2_personal_session.sql` | `6d59f3b6` (PR #510) | `0790ad69` | `auth.uid()`, `auth.users`, `auth.sessions` only | + gate |
| 4 | S2-1 `001_t13_anonymous_refusal.sql` | `1c3b16a7` (PR #489) | `8cbba51c` | the reviewed T13 | T13 body |

- **Rollback:** the reverse order (4, 3, 2, 1), each with its own file (blobs `9fd0a07b`, `f2318751`, `ac50cb29`, `788f060b`).
- **Constraint:** S2-2's rollback refuses while any function body names the gate. Its consumers must be removed first; the suite shows this
  with the fakes.
- **Order:** 3 and 4 are independent of 1–2. 2 needs 1.

## 2. Results through the fake consumers [D] (all assertions; 7 tests ×3 PASS)

| Situation | G4 begin (`x_begin`) | G4 reconnect / callback | G3 create | G3 cancel / receipt (S2-2) | G3 worker (W1, no session) | R1 v1 (G6) |
| --- | --- | --- | --- | --- | --- | --- |
| a person, own workspace | `BEGIN_OWN` | token, then `COMPLETE_OK` | `g5oe:<epoch>:<lv>` | `CANCEL_OK` / `RECEIPT_OK` | `active` | allow, the 8 keys, `["postona:x_autopost"]` |
| a new person | `BEGIN_CREATED`, then `BEGIN_OWN` | — | — | — | — | — |
| anonymous / `is_anonymous` missing | T13 raises `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | same | same | `AUTH_REQUIRED` | — | deny `AUTH_REQUIRED` (8 keys) |
| session revoked / signed out / another person's | T13 raises | same | same | `SESSION_REVOKED` | — | deny `SESSION_REVOKED` |
| session expired | T13 raises | same | same | `SESSION_EXPIRED` | — | deny `SESSION_EXPIRED` |
| another person's workspace | — | `R1:deny:BRAND_ACCESS_DENIED` | same | — | — | deny `BRAND_ACCESS_DENIED` |
| legacy brand, no own workspace (C4) | `R0:deny:OWN_WORKSPACE_CONFLICT` | — | — | — | — | — |
| own workspace with another member | `R0:deny:OWN_WORKSPACE_CONFLICT` | — | — | — | — | **allow** (finding F-1) |
| owner A → B → A | — | the old token → `STALE_OWNER_EPOCH` | a new token | — | old token → `OWNER_EPOCH_CHANGED`; new → `active`; no token → `NO_BOUND_EPOCH` | — |
| service stopped (`suspended`) | T13 raises `SERVICE_NOT_ACTIVE` | — | — | still `CANCEL_OK` (P-2) | `SERVICE_NOT_ACTIVE` | deny `SERVICE_SUSPENDED` |

- **S2-2 = SV** for every claim case above (asserted per case).
- **Privileges:**
  - SV, S2-2, the S2-3 predicate, T13, W1 and the worker fake are executable by no API role, and no API role is a member of the owner;
  - R0 / R1 are executable by `authenticated` only;
  - an API role calling an owner-only gate is refused.
- **Rollback:** in reverse order it returns every reviewed body (R1 / R0 / SV / T13 md5); the reinstall works.

**Ablation** (`postona_personal_auth_integration_ablation.py`; control PASS, **3 / 3**): with one candidate left out, the install still passes
but the matrix fails.

| Left out | Why the matrix fails |
| --- | --- |
| S2-1 | the reviewed T13 lets the anonymous caller through. A **semantic** failure. |
| S2-2 | the gate is missing, so the fakes raise. A structural failure. |
| S2-3 | the predicate is missing (R0 as D1 leaves it, which would also allow C4), so the fakes raise. A structural failure. |

## 3. The contract per owner (proposals; the owners' own TASKs and designs are not overridden)

### G4 (#319) — X / Threads begin, reconnect, callback
1. **Begin, in one owner-owned SECURITY DEFINER, READ COMMITTED function:**
   - T13 (`auth.uid()`, `'x_autopost'`) first;
   - then R0 must answer `allow`;
   - then the S2-3 predicate for `auth.uid()`:
     - `absent` → create the personal workspace, where an existing row **raises** (never `on conflict do nothing` + join);
     - `own` → reuse it;
     - anything else → stop.
2. **Reconnect begin:** T13, then R1 `allow` for that workspace. Bind R1's `owner_epoch` to the OAuth state.
3. **Callback:** T13 again, then R1 again. Complete only if the token is **byte-identical** to the bound one; otherwise stop with no write.
4. **Must not:**
   - grant EXECUTE on SV / S2-2 / S2-3 / T13 / W1 to any API role;
   - choose a workspace from a client value;
   - reuse a single owned brand of another kind.

Gaps today (G5-32 §3.1):
- the live X begin calls no G5 gate (`auth.uid()` only) and joins on conflict;
- the Threads path runs its tests against a mock T13.

### G3 (#318) — reservations
1. **Create:** T13, then R1 `allow` for the brand. Store R1's `owner_epoch` on the row.
2. **Worker:** W1 with the stored pair before every send. Anything but `active` never sends. A row without a token never sends.
3. **Person-facing cancel / receipt / read:** S2-2 **first**, in the same statement. Act only on exactly `'active'`; NULL and every other
   answer touch nothing.
4. **Must not:**
   - grant the gates to API roles;
   - send without a bound token;
   - treat a mock PASS as an integration.

Gaps today (G5-32 §3.2):
- the X candidates carry no `g5oe`;
- cancel / receipt check `auth.uid()` only;
- the X Edge refuses only `is_anonymous === true`.

### G6 (#321) — AI Gateway
- **R1 v1 is unchanged:** 8 keys, `g5oe`, entitlements. The suite asserts the key set on allow and on every deny.
- D1 makes anonymous and missing-claim callers a **deny** with an existing reason, which the Gateway already passes through.
- No new grant is needed.
- Gap: the Gateway is wired nowhere yet (G5-32 §3.3).

## 4. Findings (recorded; nothing changed here)

| # | Finding | Proposal |
| --- | --- | --- |
| F-1 | R1 still **allows** a personal workspace that has another (non-owner) member. S2-3 / R0 refuse it at the begin. So a shared own workspace cannot be connected, but could be posted to if it already exists. | Decide with P-1 (shared workspaces, PENDING). The technical options are G3's create calling the S2-3 predicate too, or a later R1 change (a v1-compatible deny). Neither is chosen here. |
| F-2 | S2-3's rollback has no "callers" check (S2-2's has one). Rolling it back under a consumer leaves the consumer raising "function does not exist" (fail-closed, but abrupt). | A small G5 TASK adds the same `prosrc` callers check to S2-3's rollback. |
| F-3 | S2-2 (like SV) answers about the session only, so a person whose service stopped can still cancel / read receipts. | Intended pending **P-2**; a consumer that must refuse calls R1 / T13 instead. |
| F-4 | The earlier drivers in PR #489 / #494 / #506 still contain the truncating line. The fixed drivers are PR #514 / #515 (G5-35). | Keep #514 / #515 as the evidence; the owner chooses which version ships. |

## 5. Evidence and limits

- **Suite:** `postona_personal_auth_integration_pg_run.sh`, **7 tests ×3 PASS** (throw-away PG17.11, local socket, fake data).
- **Ablation:** 3 / 3.
- **Component drivers** (each on its own PR head, fixed versions; ASSERTION-only counting): all with control PASS:
  - T13 (PR #514 head `1c199aad`): **30 / 30**, all ASSERTION;
  - D1 (PR #515 head `652447bc`): **33 / 33**, all ASSERTION;
  - S2-3 (PR #515): **24 / 24**, all ASSERTION;
  - S2-2 (PR #510 head `6d59f3b6`, its own fixed driver with behaviour-only body mutants): **23 / 23**.
- **Static checks:** deno check / lint, `bash -n`, Python syntax.
- **NOT_VERIFIED:**
  - real GoTrue / JWT / PostgREST;
  - the managed tables' RLS, FKs and owners;
  - real G3 / G4 / G6 code;
  - concurrency between a membership change and a running verdict;
  - production.
- **[PENDING]:** P-1 (shared / legacy workspaces), P-2 (read / cancel after a stop), P-3 (ban), P-4 (sign-out scope and scheduled posts),
  P-5 (retention).
