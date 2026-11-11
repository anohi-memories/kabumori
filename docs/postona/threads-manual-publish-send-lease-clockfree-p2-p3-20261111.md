# POSTONA Threads manual publish — a send lease no clock ends (P2) and 002's rollback on a drifted fence (P3) (G4-02 #14, 2026-11-11)

task_id: `postona-g4-gen2-14-threads-send-lease-clock-divergence-and-trigger-rollback-p2-p3-20261111` (Issue #561).
Review fixed: H1 #42 (Issue #306, comment 6787827668): CHANGES_REQUIRED, P2 ×1 / P3 ×1 on PR #651 @ `aed29e94`.
Stacked on PR #651 (base = its head `aed29e945d679476085c8a0664f2394c56a61baf`). Supersedes the lease rule of
`threads-manual-publish-send-fence-p2-p3-20261110.md` §1 (the 120 s lease); everything else there still holds.

**Status:** source candidates and local PostgreSQL 17 only. Nothing is applied, deployed or registered. Every gate stays as in
source (`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false`). Production stays NO_GO. The changed SECURITY DEFINER fence body and
the changed rollback are **unadopted candidates that need review before adoption**. 002's begin / release bodies are unchanged
(`7d26e42e…` / `e92ec523…`); 001 is unchanged.

## 1. P2 — what was wrong

#13's fence ended the send lease after 120 s on the **database's** clock (`updated_at > clock_timestamp() - 120 s`), while the
publish server decided to send on **its own** clocks (30 s window). With only the database's clock ahead (H1 #42's world), the
database thought the lease was over, the reconnect committed, and the server — still inside its own window — posted under the
replaced connection. Any lease that one side ends by time and the other side obeys by time needs the two clocks to agree; no
read before the request and no offset assumption fixes that.

## 2. The contract now (one ordering, no clock)

| Part | Rule |
| --- | --- |
| Linearization point | The publish release's COMMIT (unchanged) |
| Send lease | A recorded state, not a duration: the account has an attempt in `publishing` (released; the server may be sending) or `uncertain` (a post may exist or may still come) |
| What ends it | Only a state no later send can change: the server's own answer for that request (`publish_returned`; `failed` = nothing sent / the provider refused), or the read-only reconcile's provider evidence (`published` / `published_unidentified` = the post exists; `failed` = the container is ERROR / EXPIRED, it can never be published) |
| What does NOT end it | Any clock. In particular reconcile turning an abandoned `publishing` into `uncertain` STEP_INTERRUPTED after 120 s (database clock) keeps the lease |
| Fence (002, SECURITY DEFINER trigger on G4's `postona_threads_binding.bindings`) | A write that gives the account another `oauth_state_id` while the lease is held → `THREADS_BINDING_SEND_IN_PROGRESS` (the connect transaction rolls back); outside READ COMMITTED → `THREADS_BINDING_SEND_FENCE_ISOLATION`. Body md5 `4992a4a16baad53a9eb17c3cfb71a3f6`; it reads no time |
| Serialization | The publish release holds the binding FOR SHARE to COMMIT; a reconnect's binding write waits, then the trigger sees the committed release in a fresh snapshot (unchanged from #13) |
| Edge (`threads_manual_publish.ts`) | Starts the request within 30 s of asking for the release, measured on its own monotonic clock and its own wall clock (backwards also refuses), else records `failed` STEP_INTERRUPTED and sends nothing; request bound 10 s. This keeps sends from going out stale and the lease short. The fence's safety relies on neither this nor on two clocks agreeing |

Why it holds: the server can only send after a committed publish release (`publishing`). From then until a final state is
recorded, the account's generation cannot move. A final state is recorded either by the server after its single request (it
never sends again for that release) or from the provider's own container status (the post exists, or the container can no longer
be published). No transition that ends the lease is driven by a clock.

Failure modes:

| Situation | What happens |
| --- | --- |
| Normal send | reconnect refused until the server records the answer (≤ 30 s window + 10 s request + the record), then goes through |
| Only the database's clock ahead / jumps (H1 #42) | nothing changes for the fence; reconnect refused until the send is recorded or settled |
| The database gives up on the step (reconcile, 120 s on its clock) while the server is alive | `uncertain` STEP_INTERRUPTED: still fenced. The server's send goes out once; its record is refused (grant cleared); reconcile reads the container (PUBLISHED → `published`), then the reconnect goes through |
| Only the server's clock jumps ahead / back | the server refuses to send and records `failed` STEP_INTERRUPTED; that record ends the lease |
| Server dies after the release / its answer is lost / timeout / 5xx | `publishing` → (reconcile) `uncertain`; reconnect refused until reconcile reads PUBLISHED / ERROR / EXPIRED. A container that stays FINISHED keeps the reconnect refused until it reports EXPIRED (**liveness cost**; how long a real Threads container takes is NOT_VERIFIED) |
| Provider still processing a request the client gave up on | the lease stays until the provider's own container status is final, so a reconnect is ordered after that outcome — provided the provider's status is truthful (NOT_VERIFIED for real Threads) |
| Reconnect refused (any of the above) | H5 runtime's existing `COMPLETE_OUTCOME_UNKNOWN` ("re-read and start over"); binding and generation unchanged. No dedicated copy (would need H5 runtime / G1) |
| Disconnect / stop / G5 end / account deletion | not fenced (they never resume a send; a leased send is ordered before them) — unchanged |

Behaviour change vs #12/#13: a reconnect while an attempt is `uncertain` (answer lost) is now refused until reconcile settles it
(scenario 31 (d)); before, it went through.

## 3. P3 — 002's rollback on a drifted fence

002's rollback now refuses, before any change, unless the fence, its trigger and the table still have the exact shape 002's
postconditions check (the same predicate, copied verbatim into both files):
- `G4MG_ROLLBACK_FENCE_DRIFT`: function not SECURITY DEFINER / not owner-only / another owner / not VOLATILE / another
  `search_path` / another body (md5) / not a plpgsql trigger function; or not exactly one trigger using it; or that trigger is not
  `threads_manual_publish_send_fence` on `postona_threads_binding.bindings` with tgtype 23 (BEFORE ROW INSERT OR UPDATE),
  tgenabled `O`, no WHEN, no column list, no arguments, no constraint, no transition tables, not internal, no parent;
- `G4MG_ROLLBACK_TABLE_DRIFT`: the generation table not RLS-on / owner-only / policy-free;
- `G4MG_ROLLBACK_NOT_APPLIED` / `G4MG_ROLLBACK_OWNER` as before (the body md5 moved from NOT_APPLIED into the drift predicate).
002's install postcondition uses the same predicate (`G4MG_POSTCONDITION_FENCE`). 001's partial-state guard is unchanged.

## 4. Measured (2026-11-11, disposable PostgreSQL 17.11 UTF-8; fake Threads / PostgREST / GoTrue; the SQL is real)

Runner `G4T_APP_FLOW=1`, once per G5 profile, exit 0 `G4T_APP_FLOW_ALL_PASS` both times; every stage below ran in both runs.

| Check | Result |
| --- | --- |
| e2e personal / full | **33/33** / **33/33** |
| Fail-before: #13's 002 exactly (`git show aed29e94:…/002…sql`) | exactly **31 33** fail. 33 (d) = H1 #42: release committed, only the database's clock ahead → the reconnect committed (`verifying`, generation moved), the old attempt then posted (publish +1). 31 (d): a reconnect while the outcome was unknown went through |
| Fail-before: PR #650's 002 / without 002 / without 001 | exactly 31 33 / 31 32 33 / 30 31 32 33 |
| 33 after the fix | (a) released, nothing sent: reconnect refused, one send (+1), reconnect after `verifying`. (b) new attempt +1 on the new generation. (d) database clock alone ahead: reconnect refused; the database gave up (`uncertain`): still refused; the send went out once (+1), its record refused, still refused while unsettled; reconcile → `published`, then `verifying`. (f) Edge wall clock +121 s / (h) −5 s: refused until the Edge recorded `failed` STEP_INTERRUPTED (+0), then `verifying`. (g) both + given up: Edge sent nothing, attempt stays `uncertain`, container FINISHED → still refused; container EXPIRED → `failed` CONTAINER_EXPIRED, then `verifying`, +0. (e) the owner's re-bind waited ~1.98 s for the held publish release then `THREADS_BINDING_SEND_IN_PROGRESS`; with the database's clock 121 s ahead still `THREADS_BINDING_SEND_IN_PROGRESS`; REPEATABLE READ → `THREADS_BINDING_SEND_FENCE_ISOLATION`. (c) another Threads user refused (existing checks; not a fence proof) |
| 31 (d) after the fix | `uncertain` → reconnect refused (`failed:COMPLETE_OUTCOME_UNKNOWN`) → reconcile `published` (+0, never resent) → reconnect `verifying` |
| Fence mutants | INSERT-only → 33 ((e); the app's upsert fires the BEFORE INSERT trigger, so app reconnects are still refused); `publishing` only (no `uncertain`) → 31 33; no isolation guard → 33 |
| #12 mutants | no binding lock → 32 33; no generation compare → 31 32 33; read-backs gated → 30 (31 (d) no longer reconnects while unknown) |
| 002 rollback drift (P3), each before any change, catalog + bodies unchanged | trigger DISABLED / ENABLE REPLICA / ENABLE ALWAYS / `BEFORE UPDATE OF oauth_state_id` / `WHEN (false)` / AFTER / a second trigger on the function / SECURITY INVOKER / `search_path` reset / STABLE / EXECUTE granted to authenticated / body changed → `G4MG_ROLLBACK_FENCE_DRIFT` (12); table SELECT granted / RLS disabled / a policy → `G4MG_ROLLBACK_TABLE_DRIFT` (3) |
| 002 install / rollback | fence md5 `4992a4a1`, owner-only, SECURITY DEFINER, trigger 23 `O`; install with a disabled trigger → `G4MG_POSTCONDITION_FENCE`, nothing left; twice refused; rollback restores `6ae40adb` / `bd5bed5a`; reinstall; 002 → 001 rollback leaves no table / fence / trigger; partial states and 001's P3 guard as in #13 |
| Deno: Threads offline suites + publish Edge / connect entry + composition / meta callbacks (+ local HTTP) | 183/183 / 14/14 / 41/41 |
| App unit (threads connect, iOS return, disconnect, manual publish) | 65/65 |
| Process gate (`index.ts` as in source) | 7/7 |
| `G4T_VERDICT=1` / `G4T_BRIDGE_FLOW=1` | ALL_PASS / ALL_PASS |
| `bash -n`, `node --check`, `deno lint`, `git diff --check`, secret scan of the diff | clean / 0 hits |

## 5. NOT_VERIFIED / remaining

- Real Threads: container status semantics (PUBLISHED / EXPIRED being final and truthful), how long until EXPIRED, an old token
  after a reconnect; real GoTrue / PostgREST; managed Supabase; a device; the G3 worker.
- Liveness: a dead server plus a container that stays FINISHED keeps the account's reconnect refused until EXPIRED; reconcile
  must be triggered (the app's existing read-back). No dedicated "posting in progress / waiting for Threads" copy.
- A re-bind to a DIFFERENT Threads user during a send is refused by the existing completion checks even without the fence (e2e
  (c)); not evidence for the fence.
- The REPEATABLE READ race itself is not driven (the guard refuses regardless).
- G1 #635 carries older copies of the e2e, the runner, `threads_manual_publish.ts` and its test.
