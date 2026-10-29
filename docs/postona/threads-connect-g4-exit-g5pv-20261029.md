# POSTONA Threads connect — the app e2e exits on its own, and G4's entry for G5's personal MVP (g5pv) (G4-02 #2, 2026-10-29)

task_id: `postona-g4-gen2-02-threads-app-e2e-exit-g5pv-auth-contract-integration-20261029` (Issue #561).
Status: **source only. Every gate is still closed, nothing is applied or deployed. PRODUCTION_NO_GO.**

## 1. The app e2e did not exit (H1 #306 P3 `APP_FLOW_RUNNER_EXIT_NOT_VERIFIED`)

**Cause (a product leak, not only a test problem).** `threads-connect-starter.ts` races three things:
- the auth browser's result;
- the app link;
- a deadline timer, `deps.wait(expiresAt - now)`. The state lives about 10 minutes.

When the browser or the link wins, the deadline timer was never released. In the app, that timer lingered for up to the state's lifetime. In Node, it kept the test process alive for about 10 minutes after the 14 assertions.

**Fix (G4-owned app code):**
- The starter hands `wait(ms, cancelled)` a promise that settles as soon as the race is decided, in a `finally`, so every way out is covered.
- The runtime then calls `clearTimeout` on the timer.
- There is no global dependency (no AbortController); stubs that ignore the second argument keep working.

**New unit test** (`tests/threads-connect.test.mjs`): the timer is released for each of the four ends (browser, link, cancel, deadline). Without the `release()` line it FAILs (measured), with it it passes.

**Measured on the runner, with no timeout and no kill in it:**

| | Result |
| --- | --- |
| Before (PR #568 head `67049cdd`) | 14 `ok` lines, then node was still alive after 152 s; stopped by hand. Not counted as a PASS. |
| After | node exits by itself with status 0, 1–2 s after the start. Same on 3 fresh databases (`kabumori_tb_<pid>_app` per run), and again in every later run (both profiles, every time). |

The runner prints `node exited by itself with status 0 after N s`. A hang now shows as a hang; nothing hides it.

## 2. G5's personal MVP (g5pv) for G4's Threads entry

**The G5 contract checked** (source at PR #563 head `9846c0f0`; `MVP_INSTALL.sql` blob `eebaabf2` is the same as at PR #550):
- 1 person, 1 workspace.
- No brand owner epoch: `account_lifecycle_brand_owner_epoch` does not exist in this profile.
- The generation is `common_accounts.lifecycle_version`, the number in R1-MVP's `g5pv:<n>`.
- G5-46 §5 asks G4 to bind `lifecycle_version` instead of the owner epoch.
- For work done on behalf of a person, G5 offers the owner-only `private.postona_personal_worker_verdict(user, workspace, 'x_autopost', n)` (MV).

**The old dependency.** G4's binding entry needs F5's owner epoch:
- `../postona_threads_binding_epoch/001` refuses to install without it.
- `record_state_generation` and `complete_and_attest_binding` compare it.

So on the MVP profile, G4's Threads connect could not be installed at all.

**New G4-owned candidate:** `supabase/candidates/postona_g4_threads_personal_mvp/001_threads_binding_g5pv.sql`, plus its rollback.
- It is the MVP alternative to full-profile 001 + `personal_auth/001` + `002`. Install exactly one of the two.
- It keeps the same schema and tables, minus `owner_epoch`. Custody `002` and H5's claim SQL apply on top unchanged (measured).
- The same refusal codes are kept where the rule is the same.
- **Begin:** `record_state_generation(actor, state, n)` requires MV = `active`. MV checks:
  - the derived personal workspace;
  - S2-3 = `own`;
  - the service is active;
  - `n` is the current value.
- **Completion:** the same entry as G4-43, with two changes:
  - PR #124's md5-pinned complete is re-checked on every call, as before.
  - The owner / owner-epoch block is replaced by MV with the `n` recorded at begin (ABA → `THREADS_BINDING_SERVICE_GENERATION_CHANGED`).
  - Then S2-2 runs (live, non-anonymous session).
- **Install refuses** if any of these holds:
  - on the full profile: `THREADS_BINDING_G5PV_PRECONDITION_FULL_PROFILE`;
  - if G5's MV or S2-2 is missing, or not owner-only;
  - if the complete is not pinned or is exposed.
- **Postconditions:** only owner ACLs; 4 functions.
- **The rollback refuses:**
  - the full binding;
  - anything outside the schema that depends on it (no CASCADE reach).
- **Not added:** no GRANT, no RPC exposure, no G5 change.

**Bridge / composition:**
- `createG4ThreadsOwnerBridge(connect, now, profile)` takes `"full"` (the default for the existing callers) or `"personal"`. Anything else is refused at construction.
- The composition requires `POSTONA_THREADS_G4_AUTH_PROFILE`, which the entry's reader passes:
  - unset or any other value → the composition is not built (503 `THREADS_CONNECT_RUNTIME_UNAVAILABLE`);
  - a profile that does not match the database → every begin is refused (the other profile's SQL does not exist).
- The profile is pinned, never detected, as G5 recommends for G6.

## 3. App e2e on both profiles (`G4T_APP_FLOW=1 supabase/tests/postona_g4_threads_person_session_run.sh`)

**Path under test:** real app hooks → real supabase-js → local Edge entry (Deno) → G4 composition → H5 verifier / runtime → G4 bridge → isolated PG17. GoTrue, Threads and PostgREST are faked.

**The two worlds:**
- **full:** the G4-01 world, which includes PR #303.
- **personal:** the same base *before* PR #303, then:
  - G5's lifecycle chain rest (`21a5cad4`, the commit G5's own MVP runner pins);
  - `MVP_INSTALL.sql`, so T13, S2-2 and S2-3 are G5's MVP copies;
  - PR #124, custody, G4 g5pv 001 and the same stack.

**18/18 on each profile.** Scenarios 1–14 are as in G4-02 #1, with the same codes on both profiles. The new ones:

| # | Scenario | full | personal |
| --- | --- | --- | --- |
| 15 | bridge pinned to the other profile | `START_REFUSED`; sql: owner-epoch function / g5pv `record_state_generation` does not exist; state rolled back, Threads 0 | same |
| 16 | no profile configured | `THREADS_CONNECT_RUNTIME_UNAVAILABLE`, no browser | same |
| 17 | the person already owns another brand | `START_REFUSED` by PR #124's begin (`SOCIAL_MOBILE_WORKSPACE_CONFLICT`) | same |
| 18 | the person comes to own another brand while at Threads | `COMPLETE_OUTCOME_UNKNOWN`, `OWN_WORKSPACE_CONFLICT` (G4-42's S2-3 recheck) | `COMPLETE_OUTCOME_UNKNOWN`, `OWN_WORKSPACE_CONFLICT` (G5's MV) — PR #124's complete does not catch it |

In both profiles, scenario 8 (ABA) is refused with `THREADS_BINDING_SERVICE_GENERATION_CHANGED`; in personal this comes from MV. Scenarios 6 (anonymous) and 7 (not started) run against G5's MVP T13 in the personal world.

**Candidate checks:**
- refused on the full profile;
- its rollback refuses the full binding;
- install → `ALREADY_APPLIED` → rollback (custody 002 first; refused while a view depends on it) → install again.

**Mutant:** the completion's MV call replaced by `'active'`. The personal e2e then fails scenarios 8 and 18 (`MUTANT_CAUGHT`).

## 4. Owners and what is still open

- **H5:** the `bridgeFactory` port is still not adopted. H5's files are unchanged; G4's composition stays the working path. With the port, the composition becomes one line (`bridgeFactory: (connect) => createG4ThreadsOwnerBridge(connect, Date.now, profile)`).
- **G5 / 担当ちゃ:** the profile decision (personal MVP or full with #457) is still open, so G4 ships both and pins one by configuration. The MVP's P3 (no person can write `brand_memberships`) is stood in by a TEST-WORLD revoke, as in G5's own runner; the real revoke is G3's L-1.
- **G3:** no change. Reservations on g5pv are G3-40 (PR #559).
- **G1 / G2:** callback URL, associated domains / App Links, release flag (unchanged from G4-02 #1).
- **Review:** the g5pv entry changes the authorization basis of an H1-reviewed entry (owner epoch → G5's MV). It adds no new grant or exposure. Recommendation: one focused look together with G5's bundled MVP review when the profile is chosen. No review TASK was created.
- **NOT_VERIFIED:**
  - managed Supabase, real Threads / GoTrue / PostgREST;
  - the Edge runtime deploy;
  - a real device;
  - G5-44's T13 in the full world (that world uses main's write guard);
  - production.
