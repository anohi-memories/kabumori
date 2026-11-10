# POSTONA Threads manual publish — send onset vs reconnect (P2) and 001's rollback on a partial 002 (P3) (G4-02 #13, 2026-11-10)

task_id: `postona-g4-gen2-13-threads-publish-send-boundary-and-partial-rollback-p2-p3-20261110` (Issue #561).
Review fixed: H1 #41 (Issue #306, comment 6762869443): CHANGES_REQUIRED, P2 ×1 / P3 ×1 on PR #650 @ `141d44fd`.
Stacked on PR #650 (base = its head `141d44fdf704bd0877a2976e9cf2c5d6dd8694f4`).

**Status:** source candidates and local PostgreSQL 17 only. Nothing is applied, deployed or registered. Every gate stays as in
source (`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false`). Production stays NO_GO. The new trigger function (SECURITY
DEFINER) and the changed rollbacks are **unadopted candidates that need review before adoption**. 002's begin / release bodies
are unchanged (`7d26e42e…` / `e92ec523…`, as H1 #41 reviewed them).

## 1. P2 — the send onset

H1's order: the publish release COMMITs (attempt `publishing`, old generation stored), the person reconnects the same Threads
user before the server's HTTP request, then the old attempt posts (+1) under a connection that has already been replaced. No
read before the request can close this: a reconnect can always commit between that read and the request.

**Contract (linearization point = the publish release's COMMIT):**

| Part | What it does |
| --- | --- |
| Send lease (no new column) | An attempt in `publishing` whose `updated_at` (set by the publish release, = its transaction start) is younger than 120 s. Ends when the server records the answer (`publish_returned` / `failed` / `uncertain`) or lapses (the same 120 s after which reconcile treats the step as abandoned) |
| `postona_threads_binding.manual_publish_send_fence()` + trigger `threads_manual_publish_send_fence` (BEFORE INSERT OR UPDATE, FOR EACH ROW on G4's `postona_threads_binding.bindings`) | A write that gives the account another `oauth_state_id` (= another credential generation: connect, reconnect, re-bind to another Threads user) while that account holds a send lease raises `THREADS_BINDING_SEND_IN_PROGRESS`. The whole connect transaction rolls back (no state, binding or secret change); the app shows its existing "start over" result. Outside READ COMMITTED such a write raises `THREADS_BINDING_SEND_FENCE_ISOLATION` (a snapshot taken before a lease committed could miss it). SECURITY DEFINER, `search_path=""`, owner-only ACL; md5 `1e9c3cbf99dc053c72eb134cef913cb1` |
| Edge (`_shared/social/threads_manual_publish.ts`) | The publish request starts only within `THREADS_PUBLISH_SEND_START_WINDOW_MS` (30 s) of asking for the release, on both the monotonic clock and `deps.now()` (a clock that moved backwards also refuses). Otherwise nothing is sent and the attempt is recorded `failed` `STEP_INTERRUPTED` (existing code and app copy). The request is bounded at 10 s, so it ends inside the lease: the lease starts at the release transaction, which starts after the server asked |

So:
- a reconnect committed **before** the publish release → the release refuses (G4-02 #12);
- a publish release committed **first** → the reconnect cannot commit until that one send is over. The send is ordered before
  the reconnect, made at most once, and an unknown outcome is settled read-only (reconcile, never resent);
- a lease that lapsed (a server stalled > 120 s) → the reconnect goes through, and the stalled server does not send (its window
  is 30 s).

Serialization in PostgreSQL: the publish release holds the binding row FOR SHARE to its COMMIT. A reconnect's binding write
waits for it; the trigger then runs, and its query takes a fresh READ COMMITTED snapshot that sees the release (measured,
scenario 33 (e)). The completion's `INSERT … ON CONFLICT DO UPDATE` runs both the INSERT and the UPDATE branch of the trigger.

Timeouts and recovery:

| Situation | What happens |
| --- | --- |
| Normal send | lease ≤ (start window 30 s) + (request bound 10 s) + the record; the reconnect is refused meanwhile and goes through once the answer is recorded |
| The server dies after the publish release | the attempt stays `publishing`; reconnects are refused until the lease lapses (120 s); then the next reconcile turns it `uncertain` STEP_INTERRUPTED and settles it read-only from the container status (never resent) |
| The server stalls between release and request | past 30 s it sends nothing and records `failed` STEP_INTERRUPTED; past 120 s the lease has lapsed and a reconnect may already have happened, so it must not send, and it does not |
| Unknown publish outcome (timeout, 5xx) | recorded `uncertain`: the lease ends, reconnects go through, reconcile is read-only (scenario 31 (d)) |
| Reconnect refused | H5's runtime reports any failed completion as `COMPLETE_OUTCOME_UNKNOWN` (re-read, start over); the binding and the generation are unchanged (measured; the completion is one transaction), and the retry after the send succeeds |

What the database cannot close: the provider still processing a request after the client gave up on it (timeout). Not fenced,
by design: disconnect / stop / G5 end / account deletion (they never resume a send, and a send whose lease began before them is
ordered before them); `create_container` / `check_container` (no post comes from them, and the publish release re-checks the
generation).

## 2. P3 — 001's rollback on a partial 002

001's rollback checked only 002's table. With the table missing but 002's begin / release bodies still installed, it rolled
authorize back and left a mixed stack. Now, before any change, it refuses:
- `G4MP_ROLLBACK_002_PRESENT`: 002's table exists (unchanged);
- `G4MP_ROLLBACK_002_PARTIAL`: begin or release has 002's body (`7d26e42e` / `e92ec523`), or the send fence function or its
  trigger exists;
- `G4MP_ROLLBACK_STACK_UNKNOWN`: begin / release are not the bodies 001 was installed over (`6ae40adb` / `bd5bed5a`).

002 itself: install refuses if any of its parts exists (`G4MG_PRECONDITION_ALREADY_APPLIED`). Its rollback needs every part as
installed (`G4MG_ROLLBACK_NOT_APPLIED` otherwise), drops the trigger, the function and the table, and checks nothing is left
(`G4MG_ROLLBACK_POSTCONDITION_LEFTOVER`). Install order and rollback order are unchanged: install release candidate → verdict 001
→ manual publish 001 → 002; roll back 002 first, then 001.

## 3. Measured (disposable PostgreSQL 17.11, UTF-8; fake Threads / PostgREST / GoTrue; the SQL is real)

Measured on 2026-11-10 (runner `G4T_APP_FLOW=1`, exit 0, `G4T_APP_FLOW_ALL_PASS`):

| Check | Result |
| --- | --- |
| e2e, personal / full profile | **33/33** / **33/33** (the whole runner ran once per profile; the stage checks below ran in both runs) |
| Fail-before with PR #650's 002 exactly (`git show 141d44fd:…/002…sql`) | exactly **33** fails: (a) the reconnect committed (`verifying`, generation moved) while the publish was released but not sent, then the old attempt posted (`published`, publish +1) — H1 #41's order |
| Fail-before without 002 / without 001 | exactly 31 32 33 / 30 31 32 33 fail |
| Scenario 33 after the fix | (a) committed release `publishing`, bound to the old generation, nothing sent yet; the reconnect refused (`failed:COMPLETE_OUTCOME_UNKNOWN`, generation unchanged); the one send went out (`published`, +1); the retry after it `verifying`, generation moved. (b) a new attempt `published` +1, bound to the new generation. (d) lapsed lease: reconnect `verifying`, the stalled server sent nothing (`failed\|STEP_INTERRUPTED`, +0). (e) the re-bind waited about 1.9 s for the held publish release, then `THREADS_BINDING_SEND_IN_PROGRESS`, binding kept; under REPEATABLE READ `THREADS_BINDING_SEND_FENCE_ISOLATION`; settled read-only `failed\|CONTAINER_EXPIRED`, then the reconnect `verifying`. (c) another Threads user during the send: refused, binding kept — but refused the same way with PR #650's 002, by the existing completion checks, so (c) is not evidence for the fence |
| Fence mutants | trigger on INSERT only → 33 fails ((e)); no lease bound → 33 fails ((d)); no isolation guard → 33 fails; #12's no-binding-lock mutant now also fails 33 |
| #12 regression | scenarios 31 / 32 pass; #12's 002 checks and mutants unchanged (no generation compare → 31; read-back gate → 30 / 31) |
| 002 install / rollback | install (begin / release `7d26e42e` / `e92ec523`, owner / ACL / definer / settings unchanged; table RLS on, owner-only, 0 policies; fence md5 `1e9c3cbf`, owner-only EXECUTE, SECURITY DEFINER, trigger type 23 enabled); twice refused; rollback restores `6ae40adb` / `bd5bed5a` and leaves no table / fence / trigger; reinstall; 002 → 001 rollback |
| 002 partial states | lone table, lone fence, bodies + fence without the table, 002 without its trigger: install `ALREADY_APPLIED`, rollback `NOT_APPLIED`; a failing body or fence postcondition leaves nothing |
| 001 rollback (P3) | H1's state (002 installed, table dropped) → `G4MP_ROLLBACK_002_PARTIAL`, authorize / begin / release md5 unchanged (`f31f16d6` / `7d26e42e` / `e92ec523`); also with the trigger / fence dropped, a lone fence → `002_PARTIAL`; an unknown begin body → `STACK_UNKNOWN`; nothing changed in any case |
| Edge start window (Deno) | after the window → no publish request, `failed` STEP_INTERRUPTED; clock moved back → no request; at the window edge → one request; window + bound + 60 s ≤ lease, the contract's 10 s bound and the SQL's 120 s pinned. Without the check: 2 of these fail |
| Deno: Threads offline suites (shared social Threads tests except the entry / meta callback ones + publish Edge) / connect entry + composition (`threads-oauth-connect-user/deno.json`) / meta callbacks (`--allow-net=127.0.0.1`) | 183/183 / 14/14 / 37/37 |
| App unit tests (threads connect, iOS return, disconnect, manual publish) | 65/65 |
| Process gate (`index.ts` as in source) | 7/7 |
| `G4T_VERDICT=1` / `G4T_BRIDGE_FLOW=1` | ALL_PASS / ALL_PASS |
| `bash -n`, `node --check`, `deno lint`, `git diff --check` | clean |

## 4. NOT_VERIFIED / remaining

- Real Threads (does an old token still work after a reconnect; does a timed-out request still post), real GoTrue / PostgREST,
  managed Supabase, a device.
- A re-bind to a DIFFERENT Threads user during a send: the fence covers it by construction (any new oauth_state_id), but the
  e2e case (c) is refused by the existing completion checks even without the fence, so it is not evidence for the fence.
- A reconnect inside REPEATABLE READ racing a lease is refused by the isolation guard; the race itself is not driven (the guard
  refuses regardless of the race).
- Reconnect refusal UX: the app shows its existing "start over" result for an unknown connect refusal; no new copy.
- Review of the new SECURITY DEFINER trigger function and the two rollbacks before any adoption.
- G1 #635 carries older copies of the e2e, the runner, the Edge DB-name guard, `threads_manual_publish.ts` and its test.
