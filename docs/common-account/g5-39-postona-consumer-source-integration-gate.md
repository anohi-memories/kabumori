# POSTONA: the G5 gates against the consumers' real source (G3 / G4 / G6), and the adoption gate

Status: **offline, source-only.**
- New G5 files only: no G5 candidate SQL, migration, Auth, Edge, app or G3 / G4 / G6 file changed. Nothing is applied anywhere. There is no
  managed or production connection, not even read-only.
- Unlike G5-36's fakes, the consumers' **own code** is run here, wherever it can be run alone.
- The rest of each product (tables, Edge wiring, managed Auth) is not run. Nothing here is a product PASS. Production **NO_GO**.
- TASK `common-account-g5-s2-2-s2-3-postona-consumer-source-integration-gate-batch-20261026` (Issue #320, G5-01 generation, task 39,
  completion K5).
- New files:
  - `supabase/tests/postona_personal_consumer_source_gate_{run.sh,pg_test.ts}`;
  - this document.

Labels:
- **[RUN]** the consumer's own code was executed here against the real G5 candidates;
- **[S]** read in source at the pinned head (path:line), not executed;
- **[PENDING]** a user policy (P-1 – P-5).

## 1. What was read and run (pinned)

| Owner | Head | What |
| --- | --- | --- |
| G5 | #489 `1c3b16a7`, #494 `c9f726e9`, #506 `bbc52a6b`, #510 `6d59f3b6`; rollbacks #521 `0b47b27c` (S2-3) and #525 `a4ce68ff` (S2-2); world `21a5cad4` | loaded through PR #518's runner (`fdc281fe`, blob checked) |
| G3 | #524 `32f59387` | `postona_x_resv.caller()` [RUN], cut from `001_postona_x_reservations.sql:163-176` (blob `88b5525f`); the Edge Auth verifier `supabase_auth.ts` [RUN] (blob `0b6e636b`) |
| G4 | #523 `cbd3922c` (on #522 / #516 / #511) | `require_person()` / `require_owner_epoch()` [RUN], cut from `001_x_oauth_personal_epoch.sql:112-145` (blob `9635d33e`) |
| G6 | #500 `636c38b9` | `g5_rpc_transport.ts` + `authority_port.ts` [RUN] (blobs `f1fc0ca2` / `0c7ef2b0`), with the shared modules they import |

## 2. Where each consumer stands

| Consumer | Gate used today | State | Evidence |
| --- | --- | --- | --- |
| G3: X / Threads person-facing entries (create, list, get, reschedule, reconfirm, cancel, single post; Threads create / cancel / receipt) | **S2-2** first, through `caller()`, before any row (`is distinct from 'active'`; NULL refuses) | candidate, wired by name, pinned to S2-2 `0790ad69` | [RUN] `caller()`; [S] the entries `001:354, :457`, `002:38`, `004:52`, `005:89…`, `006:156…`, `007:212, :256, :270` |
| G3: Edge → DB claims | `request.jwt.claims` = `{sub, role, session_id, is_anonymous: false}` — **is_anonymous is hard-coded** | candidate | [S] `postgres_db.ts:75-77`; [RUN] verifier |
| G3: X worker | `service_state_refusal` (no owner epoch, no W1) | candidate | [S] `003:48-57`, `004:96…` |
| G3: Threads create / worker | R1 (`007:230`), token stored; W1 with `'x_autopost'` at claim / preflight / record | candidate | [S] `007:118-136, :311` |
| G4: X begin / pre-exchange / complete / disconnect | **S2-2 + S2-3** (through `require_person`) + the brand owner epoch (a bare number); **no T13, R0 or R1** | candidate, by name; its X suites use fakes under the G5 names | [RUN] `require_person` / `require_owner_epoch`; [S] `002:94-115, :193-227, :291`, `004:74-79` |
| G4: Threads callback | PR #124's complete (T13 first), then owner epoch + lifecycle, then **S2-2** and **S2-3** | candidate; **blocked until H5 forwards `is_anonymous`** (its own header) | [S] `postona_g4_threads_personal_auth/002…:72-120` |
| G4: Threads begin | T13 only (PR #124); S2-2 still to wire | candidate | [S] G4 docs `x-threads-oauth-user-flow-batch-20261025.md:46, :81` |
| G6: Gateway | R1 v1 over the transport / port | **not wired** (tests and docs only since G6-17) | [RUN] transport + port |

## 3. Differences shown with the consumers' real code [RUN] (7 tests ×3 PASS)

| # | What | Result |
| --- | --- | --- |
| G4-1 | A **stopped service** (`suspended`) or a **locked account** still passes G4's X sequence. | `require_person` → `own` (S2-2 `active`, S2-3 `own`), and the owner epoch is unchanged. Meanwhile T13 raises `SERVICE_NOT_ACTIVE` / `ACCOUNT_LOCKED`, and R1 denies `SERVICE_SUSPENDED`. |
| G4-2 | G4's X binds only the brand owner epoch (a number). | Across a stop and restart of the service it stays **1 → 1**, while R1's token moves `g5oe:1:2 → g5oe:1:4` (lifecycle version). A begin before and a complete after a stop / restart would not be told apart by G4's X. |
| G4-ok | `require_person` on the real gates | person `own`, new `absent`, legacy (C4) and a shared own workspace → `OWN_WORKSPACE_CONFLICT`; anonymous, a missing claim and a revoked session → `SOCIAL_MOBILE_OAUTH_SESSION_NOT_ACTIVE`. As G5 intends. |
| G3-1 | G3's Edge verifier refuses only `is_anonymous === true`. | An Auth answer **without** `is_anonymous`, or with the string `"true"`, passes. The Edge then tells the database `is_anonymous: false`, so S2-2 cannot refuse it. The protection depends on GoTrue always sending the boolean, which is NOT_VERIFIED on managed. |
| G3-ok | `caller()` on the real S2-2 | a person passes; a revoked session is refused. If the Edge forwarded the token's **own** claim, an anonymous or unproven caller would be refused by the gate itself. |
| G6-ok | G6's real transport and port, fed real R1 answers | `allow` for the person. The anonymous and missing-claim cases are now `deny:AUTH_REQUIRED`, so G6's KNOWN GAP 1 is closed by D1. Also `deny:SESSION_REVOKED`, `deny:BRAND_ACCESS_DENIED` (another workspace) and `deny:SERVICE_SUSPENDED`. The 8-key wire is accepted as is. |
| rollback | With G3's `caller()` and G4's `require_person()` installed | the newest S2-2 (#525) and S2-3 (#521) rollbacks refuse with `CALLERS`, and both gates stay. |

## 4. The adoption gate, per owner (proposals; the owners' TASKs are not overridden)

| Owner | Smallest contract change | Acceptance gate (offline first) | Review | Must not |
| --- | --- | --- | --- | --- |
| **G3** | (1) The Edge forwards the **verified** `is_anonymous` (and refuses a missing or non-boolean one) instead of hard-coding `false`. (2) X reservations store R1's `g5oe` at create; W1 runs at claim / send; a row without a token never sends. (3) Cancel / receipt after a stop follow P-2 when decided. | G3-1 turns into a refusal; this suite's `caller()` cases unchanged; an A→B→A on an X row → `OWNER_EPOCH_CHANGED` | (1) H focused (auth boundary); (2) waits for PR #457's review | grant G5 gates to API roles; treat the GoTrue body as proof without the boolean |
| **G4** | (1) X begin and complete also call **T13** (or R1), so a stopped service or a locked account is refused (G4-1). (2) Bind R1's `g5oe` token, or the lifecycle version, not only the brand owner epoch (G4-2). (3) Threads: wire S2-2 into begin; adopt the callback's S2-2 once H5 forwards `is_anonymous`. | G4-1 and G4-2 refused in G4's own suites with the real G5 bodies | H focused (one batch) | reuse a non-`u_` brand; join on conflict; grant G5 gates to API roles |
| **G6** | Wire the transport to the real RPC only after G5's R1 / D1 are applied | this suite's G6 cases with the applied RPC | H focused at wiring | widen the plan allowlist beyond the decided plan |
| **H5** | Forward the verified claims unchanged, `is_anonymous` and `session_id` included | G4's Threads S2-2 unblocked | H focused | rewrite or drop claims |

**Ownership (needs one decision, not taken here):**
- G5's gates are **owner-only**; G4's docs ask G5 to "grant EXECUTE to the function owners".
- G5's position: consumers that call the gates are owned by the **lifecycle owner** (as in every G5 suite), so no grant is needed.
- Any grant to another role is a separate, reviewed change.

## 5. G5's own side: dependencies, order, fewer reviews

- **Dependencies** (none merged; Draft):
  - T13: #480 → #483 → #489 (→ #514, fixed driver);
  - D1: #486 → #487 → #488 → #494;
  - S2-3: #494 → #506 (→ #515, fixed drivers; → #521, rollback fence);
  - S2-2: #506 → #510 (→ #525, rollback fence).

  The integration order is G5-36's: world, D1, S2-3, S2-2, S2-1; rollbacks in reverse.
- **Fewer reviews (proposal):** instead of one review per small PR, **one** Codex Sol (high) review of the final heads as a set: #489 + #514, #494, #506 + #515 + #521, #510 + #525, with #518 and this PR as the evidence. Each later small fix would then join that set, not open a new review.
- **G5's completion condition for consumer adoption:**
  - that set reviewed;
  - one migration-ised candidate (a separate TASK; not done here);
  - the managed read-only audit (G5-18 gates) run with the user's approval;
  - then application by the owner.

  Until then every consumer stays **candidate / gated**.

## 6. Open, not decided here

- [PENDING] P-1 (shared / legacy workspaces; F-1: R1 still allows a shared own workspace), P-2 (cancel / receipt after a stop), P-3 (ban),
  P-4 (sign-out scope and scheduled posts), P-5 (retention).
- NOT_VERIFIED:
  - the managed GoTrue user body (is `is_anonymous` always a boolean?) and the claims PostgREST sets;
  - the rest of each product (G3 / G4 tables, Edge wiring);
  - production.
- PR #457 (owner-epoch history guard) is still under review (H3 stopped); G3's X owner-epoch binding waits on it.

## 7. Next TASK candidates (priority)

1. **G3** (#318): Edge `is_anonymous` forwarding (G3-1). Small, and closes an anonymous path end to end.
2. **G4** (#319): T13 in X begin / complete and the R1 token or lifecycle binding (G4-1 / G4-2).
3. **G5**: one combined Sol review of the G5 set (§5), then a migration-ised candidate.
4. **H5**: claims forwarding for Threads.
5. **User**: P-1 (with F-1) and P-2.
