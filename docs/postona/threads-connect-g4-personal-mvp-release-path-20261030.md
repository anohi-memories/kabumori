# POSTONA Threads connect — personal-MVP release path: product IF, pre-adoption QA and the g5pv review package (G4-02 #3, 2026-10-30)

task_id: `postona-g4-gen2-03-threads-personal-mvp-release-path-contract-integration-20261030` (Issue #561). Stacked on PR #572.

**Status:**
- source only; every gate is closed;
- nothing is applied or deployed;
- PRODUCTION_NO_GO;
- not "adoptable" before the scoped review in §3 passes.

**Recommended profile: `personal` (G5's MVP, g5pv)** — 1 person / 1 workspace, X + Threads first.
- `full` stays available, but is not adopted.
- The profile is configured, never detected.

## 1. Product IF for G1 / G2 (what the screens already have, and what they still need)

**What the screens already use.** The accounts screens (`src/app/accounts/index.tsx`, `[id].tsx`, G1/G2-owned) already mount G4's `ThreadsConnectCard` and `ThreadsDisconnectCard` with `{ threadsAccount, accounts, reload, preview }`. No screen change is needed for the flow itself.

| Card / hook state | Meaning | What the screen shows / does |
| --- | --- | --- |
| connect `idle` | nothing running | connect / reconnect button (`threadsConnectView` mode) |
| connect `running` | the system auth browser is open | button disabled |
| connect `verifying {accountId}` | server receipt; `reload()` already called | "confirming"; shows connected only when the reloaded accounts say so |
| connect `done failed {code, reconcile}` | refused or unknown | safe copy per code (`CONNECT_FAILURE_COPY`). **G4-02 #3:** `reconcile: true` (`EXCHANGE_OUTCOME_UNCERTAIN` / `COMPLETE_OUTCOME_UNKNOWN`) now also calls `reload()` (it was missing) |
| connect `done canceled / expired / unavailable {code}` | person cancelled / state expired / build not configured | copy; no request |
| disconnect `confirming → running → verifying / done` | explicit confirmation of the exact account | unchanged (`uncertain` → `reload()`) |

**What G1 / G2 still have to provide** (config only; G4 changes none of it):
1. `expo.extra.threadsConnectCallbackUrl`: the exact HTTPS callback registered at Meta.
2. iOS `associatedDomains` with `applinks:<callback host>` (iOS 17.4+). Android: a verified App Link (`autoVerify`, https, host, path / pathPrefix).
3. The release flag: `THREADS_CONNECT_UI_ENABLED` (source gate, today `false`), turned on only at the release step.

**The server side, after the reviews and approval** (G4 / operators):
- Entry env: `THREADS_CONNECT_ENABLED=true`, H5's `POSTONA_THREADS_*` config, and `POSTONA_THREADS_G4_AUTH_PROFILE=personal`.
- The static `THREADS_CONNECT_EDGE_WIRED` (G4).

## 2. Pre-adoption QA (isolated PG17; fake GoTrue / Threads / PostgREST; measured)

**`G4T_BRIDGE_FLOW=1` (Edge handler → H5 runtime → G4 bridge → SQL), once per profile.** The same 8 scenarios and 4 negative controls run on both profiles, plus:

| Case | full | personal |
| --- | --- | --- |
| 10a service ended while the person is at Threads (SYNTHETIC) | `CALLBACK_REFUSED`, sql `SERVICE_NOT_ACTIVE` | same |
| 10b forged sub (another started person) after begin | `CALLBACK_REFUSED`, `H5_ACTOR_INVALID` | same |
| 10b forged session_id (another person's live session) | `CALLBACK_REFUSED`, `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | same |
| 10b forged `is_anonymous=true` | `COMPLETE_OUTCOME_UNKNOWN`, `THREADS_SESSION_NOT_ACTIVE` (S2-2) | `CALLBACK_REFUSED`, `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` (G5 MVP T13) |
| 10b forged `role=anon` | `CALLBACK_REFUSED`, `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` | same |
| 10c a connected person's service ends | reconnect start `SERVICE_NOT_ACTIVE` | same, and MV for the binding's generation = `SERVICE_NOT_ACTIVE` |
| control: no `is_anonymous` claim | refused at the callback (S2-2) | refused at **start** (G5 MVP T13) |
| control: H5's transport as-is | refused at the callback (custody) | refused at **start** (G5 MVP T13) |

Every case ends with nothing bound. `CALLBACK_REFUSED` means the refusal came before the code exchange, so the code is never spent.

**`G4T_APP_FLOW=1` (real app hooks → supabase-js → local Edge → … → SQL):**
- **18/18 per profile.** Node exits by itself in 1–6 s; the runner has no timeout and no kill.
- **New:** reconciliation outcomes re-read the accounts (scenarios 8, 9 and 18).

**g5pv candidate.** Each install precondition was checked on a fresh MVP world with exactly one thing wrong. All were refused:
- G5 MV missing;
- MV exposed to `authenticated`;
- S2-2 exposed;
- PR #124's complete exposed;
- PR #124's complete not the reviewed body;
- run as a superuser;
- an API role (`authenticator`) able to become the owner;
- on the full profile.

**Rollback:** it refuses the full binding and refuses while a view depends on the schema. The sequence install → `ALREADY_APPLIED` → rollback (002 first) → install again works.

**No mixing:**
- The full profile's `binding_epoch/001`, `personal_auth/001` and `/002` all refuse on top of g5pv.
- g5pv refuses on full.

**Mutant:** the completion's MV call replaced by `'active'` → scenarios 8 and 18 fail.

## 3. Review package for the ONE scoped review (the new personal SQL boundary only)

**Scope.** Only `supabase/candidates/postona_g4_threads_personal_mvp/001_threads_binding_g5pv.sql` and its rollback, plus the profile pin (`owner_bridge.ts` personal branch, and `composition.ts` `g4AuthProfile`).
- H1-29 already passed the bridge, the composition and the timer fix; do not repeat them.
- Bundle the review with G5's MVP review (M10 MV / M20 R1-MVP).

**Diff against the reviewed full entry (personal_auth/002 body):** identical except:
- (a) the owner / owner-epoch / lifecycle block is replaced by `MV(actor, gen.brand_id, 'x_autopost', gen.lifecycle_version) = 'active'`, mapped by `g5pv_refusal`;
- (b) the explicit S2-3 call is dropped, because MV contains S2-3 and the derived-workspace check;
- (c) S2-2 runs after MV, not before S2-3.

`record_state_generation` loses `p_owner_epoch` and gains the same MV check. The tables lose `owner_epoch`.

**Threats and the evidence for each:**

| Threat | Why it is closed | Evidence |
| --- | --- | --- |
| an old allow comes back after service end + restart (A→B→A of the generation) | MV compares the `lifecycle_version` recorded at begin | scenario 7 / app scenario 8; the mutant |
| a second workspace or member appears while the person is at Threads | MV contains S2-3 | app scenario 18 (PR #124's complete does not catch it) |
| forged claims after begin (sub / session / anonymous / role) | H5's claim + G5's T13 + S2-2 | 10b, both profiles |
| the service ends mid-flow | T13 in H5's claim, then MV | 10a / 10c |
| completion outside the entry, or of an unreviewed complete | md5 pin + owner-only ACL, re-checked on every call | control `complete_pr124_directly`; the COMPLETE_UNPINNED / EXPOSED probes |
| the entry used as a way around G5's owner-only gates | the install refuses if MV / S2-2 are not owner-only | the GATE_EXPOSED probes |
| an API role reaching the owner | the install refuses and the postconditions refuse | the OWNER_REACHABLE probe |
| profiles mixed | each install refuses on the other; the bridge is pinned by config | the mixing probes; app scenario 15; unset → 503 (16) |
| the rollback dropping more than its own schema | pg_depend guard before CASCADE | the DEPENDENTS probe |

**Not claimed:**
- managed Supabase behaviour (claims from PostgREST, Vault, roles);
- owner transfer, which is outside the MVP (G5-46 §1, P-1);
- RESIDUAL A→B→A via service_role or the owner (G5-47 §5).

## 4. Other owners (minimal IFs; their files were not written)

- **H5 (idle, not started):** a `bridgeFactory?` port in `ConstructionPorts` and `nondeployable.ts`. Until then, G4's composition is the product path.
- **G5:** the profile decision (MVP recommended by this TASK's scope); P3's real revoke (G3 L-1); the MVP bundled review. G4 adds no GRANT, and PR #124's authenticated EXECUTE stays NO_GO.
- **G3 (#318 task 45 is reading G4's credential functions):**
  - Their signatures are unchanged in this PR: custody writer, verified token read, `binding_row`.
  - In the personal profile, `binding_row` returns `bind_lifecycle_version`, not `bind_owner_epoch`.
  - After a disconnect, the account row, binding and custody are gone (cascade).
  - After a reconnect, the binding carries the new state and the current `lifecycle_version`.
  - After a service end, MV for that generation is `SERVICE_NOT_ACTIVE`. A G3 send must compare its own stored generation (G3-40 / MV), not the binding's.
- **G1 / G2:** §1 config items 1–3.

## 5. Adoption order (each step needs its own approval)

1. Profile decision: `personal`.
2. Scoped review (§3), bundled with G5's MVP review. **PASS before anything below.**
3. Non-production SQL, as the non-superuser lifecycle owner:
   - G5 MVP_INSTALL (+ its P1 chain);
   - PR #124 + custody;
   - g5pv 001;
   - custody 002;
   - H5 claim;
   - the publish / cleanup / disconnect candidates.
4. Edge deploy with `POSTONA_THREADS_G4_AUTH_PROFILE=personal`; G1/G2 callback and app links; non-production device check.
5. A real Threads check, only after explicit approval.
6. The flags.

**NOT_VERIFIED:**
- managed Supabase;
- real GoTrue / Threads / PostgREST;
- the Edge deploy;
- a real device / Universal Link;
- production.
