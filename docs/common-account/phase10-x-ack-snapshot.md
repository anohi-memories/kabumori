# Common account — Phase 10 (F5): the X unconfirmed-post evidence set, recorded and acknowledged by snapshot

Status: **source candidate + executable offline proofs; nothing applied, nothing deployed, no managed Supabase
touched, no real X / Threads / Meta / OAuth call, no posting, no revoke.** Production NO_GO (section 12). Stacked on F5
PR #206 (Phase 9). No F3 (X), F4 (Threads), G3/G4, H5, POSTONA mobile or Kabumori app file was changed; F3 PR #204 is
used **read-only, byte for byte, from `git archive`**.

What this phase answers: F3's saga (PR #204, J3 V3 R1a) no longer accepts a bare count when the caller acknowledges "X
posts whose result was never known". It names the **exact evidence set** by a 64-hex snapshot. F5 PR #193 still sent the
count-only acknowledgement, which the saga now refuses (`snapshot_required`, nothing cleared). This phase is the F5
consumer of the new contract, and it keeps the three promises that matter for a person who may have to check X:

1. an unknown X post is **never turned into confirmed success** (no `done` without the pair on record here);
2. the person's **login and every other service stay** when only POSTONA ends;
3. a recorded `x_posts_unconfirmed` **never disappears** through ABA, retry, crash, takeover, stale lease, rollback or a
   later independent set.

```bash
export CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser>
bash supabase/tests/common_account_x_unconfirmed_snapshot_run.sh            # the migration's own proof (seconds)
python3 supabase/tests/common_account_x_unconfirmed_snapshot_mutations.py   # 25 deliberate regressions of it
bash supabase/tests/common_account_phase8_integrated_run.sh                 # F3 PR204 + F4 + F5 assembled (~4 min)
python3 supabase/tests/common_account_phase8_ts_mutations.py "$PWD"         # 36 regressions of the Edge code
```

## 1. The contract, extracted from F3 PR #204 (exact source; nothing assumed)

Source: `supabase/functions/social-mobile-account-delete/x_service_end_contract.ts` and
`supabase/candidates/postona_x_publish_entitlement/002_x_service_end_saga_stop.sql` at `45b08a87`.

| Item | Contract |
| --- | --- |
| saga answer on `done` | `x_posts_unconfirmed: n` **and** `x_unconfirmed_snapshot: <64 lowercase hex>`, present **only together**, only when `n > 0`. A count without a name, a name without a count, `0`, a non-integer or a malformed name is `failed` in F3's own mapper. |
| what the snapshot is | `sha256('x_unconfirmed:v1:' || subject_hash || ':' || reservation ids of the checkpoint, ordered)` — the subject hash, not the user id; reservation ids are random uuids, so two different sets are never the same name (even with the same count). |
| durable checkpoint | `public.social_mobile_account_deletion_x_unconfirmed(subject_sha256, reservation_id)`, written under the saga's lock before the purge; repeated by every later saga answer until acknowledged. |
| acknowledgement | service_role RPC `social_mobile_account_deletion_x_unconfirmed_ack(p_user_id uuid, p_snapshot text)`. Under the saga's per-person advisory lock. |
| answers | `acknowledged{cleared>0, replay}` — that exact set is cleared (`replay:true` = already was; **nothing is cleared again**). `snapshot_changed{x_posts_unconfirmed, x_unconfirmed_snapshot}` — the current set is not the named one, nothing cleared (`0` / `null` = the saga holds nothing). `deletion_in_progress` — a deletion row of this person exists, nothing cleared. `snapshot_required` — the former `(uuid, integer)` form: **clears nothing, ever**. Anything else = not known to be cleared. |
| receipts | `…_x_unconfirmed_ack_receipts(subject_sha256, snapshot, cleared)`: a delayed duplicate is answered from the receipt, never acted on twice. |
| the caller's duty | record **count + snapshot** in its own durable state first; acknowledge **that** snapshot; on `snapshot_changed` record the **new** pair before any new acknowledgement. |

F5 mirrors the two mappers in `supabase/functions/account-delete/x_unconfirmed.ts` (a function bundle does not import
another function's source). The integrated test `I0` holds F5's mapper, ACK arguments and ACK outcome reading **equal to
F3's own functions** on every answer the saga can give, and pins the RPC name.

## 2. What F5 does (and in which order)

```
saga answer: done (n, S)                          X is NOT yet recorded as done
  1. record (n, S)  durably, owner-leased         record_owned_service_deletion_x_unconfirmed     [P10 migration]
       lease_lost -> stop, nothing acknowledged   (the next owner re-reads the saga's still-intact checkpoint)
       cannot be recorded (3 tries) -> X recorded 'reconciliation_required', FAILED{x_posts_unconfirmed:n}
  2. acknowledge S                                 social_mobile_account_deletion_x_unconfirmed_ack(user, S)
       acknowledged            -> done
       snapshot_changed (n',S') -> go to 1 with (n',S')     (at most 3 acknowledgements; the 4th pair is recorded, not sent)
       snapshot_changed (0,null) / deletion_in_progress / snapshot_required / failed / unreadable / call error
                               -> nothing cleared: the saga keeps over-reporting (safe); the end continues
  3. record X 'done', then finish_owned_service_deletion (owner, lease, every answer settled)
```

Rules that follow, each with its test:

| Rule | Where proven |
| --- | --- |
| the pair is on record **before** the acknowledgement, and before X is `done` | `wiring_test.ts` (order in source), `postona_end_test.ts` "acknowledged by its SNAPSHOT", integrated `I7`, `X5` |
| the acknowledgement carries exactly `{p_user_id, p_snapshot}` — never a count (`p_expected` does not exist in the source) | `wiring_test.ts`, `postona_end_test.ts`, `I0` |
| a count **without a name** (an older saga, a foreign shape) is kept (count-only record), never acknowledged, X is `reconciliation_required`, `X_CLEANUP_FAILED{x_posts_unconfirmed}` | `postona_end_test.ts` "a count whose evidence set has no name…" |
| a **foreign** snapshot (another person's, from a tampered or mixed-up answer) clears nothing of theirs; the person's own set is recorded under its own name and acknowledged | integrated `X1` (A's checkpoint intact, no receipt for A, B's own set cleared by its own name) |
| **ABA**: a later independent set of the same size is not cleared by a delayed / replayed acknowledgement of the earlier one, nor by a count-only call | integrated `X2` |
| the set **changes under the acknowledgement**: both pairs stay on record, only the new set is cleared by its own name | integrated `X3`, `postona_end_test.ts` (bounded churn) |
| the acknowledgement **cannot be made**: the end completes, the person is told, the saga still holds the set, and the **recorded name** is the right handle to clear it later | integrated `X4` |
| the process **dies** between record and acknowledgement: nothing lost; the takeover records the same name **once** and acknowledges it | integrated `X5` |
| a **stale lease** (lost between the saga's answer and the record): nothing written, nothing acknowledged, the next owner finishes | integrated `X6`, `postona_end_test.ts` (two lease-loss points) |
| the **common ID is not deleted** while the evidence is incomplete: pair unrecordable → login stays, X not `done`, the saga is not told to forget; the retry deletes | integrated `X7` |
| the **Phase 10 code on a database without the recorder** (rollback under running code): an unconfirmed set stops the end before it is acknowledged; a clean end still works | integrated `R3` |
| the **Phase 9 code** (count-only acknowledgement) on the Phase 10 database with the PR #204 saga: the end completes, the count is recorded, the saga clears nothing and over-reports — the safe direction | integrated `R4` |

What the client sees is unchanged: the answer carries `x_posts_unconfirmed: n` only. **The snapshot never leaves the
server** (never in a body, never logged). POSTONA PR #211's parser (J4 R1/R2 fix, not touched here) expects exactly these
shapes: `ended` always carries `providers` (X `done`), `x_posts_unconfirmed` / `remote_unverified` only when non-empty;
`already_ended` carries what is on record.

## 3. The one new database object: `20261015120000_common_account_x_unconfirmed_snapshot_record`

Needed because Phase 8 kept a **count**, which cannot bind an acknowledgement. Additive (no table, column, grant, policy
or trigger is added; **one** CHECK is replaced by its widening, same name):

* `account_lifecycle_operations_reconciliation_shape` now also allows the key `x_unconfirmed_snapshots`: a JSON array of
  1–16 strings, each exactly 64 lowercase hex, allowed **only together with** `x_posts_unconfirmed` (a number). Every row
  valid under Phase 8 stays valid. (Evaluated with one `jsonb_path_match(…, '{}', true)` — the `silent` flag — wrapped in `coalesce(…,
  false)`: an error is a rejection, never a pass.)
* `public.record_owned_service_deletion_x_unconfirmed(user, service, operation, lease, count, snapshot) returns jsonb`,
  `SECURITY DEFINER`, `search_path = ''`, `service_role` only. `x_autopost` only; count `1..100000`; snapshot 64-hex.
  Lock order `login KEY SHARE → common_accounts → operation row` (the common helper), lease checked on the wall clock
  after the locks (`lease_lost`). **Count sticky at its maximum; snapshot appended once** (the same name twice is a
  no-op; a 17th distinct name is refused).
* the Phase 8 read-back `common_account_service_end_result` already returns the whole `reconciliation` object: unchanged.
  The Phase 8 count-only recorder stays (used only for a count that names no set).

Apply: **after Phase 9 and before any Edge build of this PR** (an end that has unconfirmed posts stops — `FAILED`,
nothing acknowledged — when the recorder is missing, so the order is also enforced at runtime; a clean end does not need it). Preflight refuses (with its own
code, leaving the catalog byte-identical): Phase 8 recorder/read-back or Phase 6 owner check missing (`…_PHASE8_MISSING`),
the owner check reachable by an API role (`…_OWNER_CHECK_ACL`), the Phase 8 shape check absent or a row carrying a foreign
key (`…_SHAPE`), a superuser owner (`…_OWNER`), a second application (`…_ALREADY_APPLIED`).

Rollback (`supabase/tests/common_account_x_unconfirmed_snapshot_rollback.sql`, never automatic): drops the function; the
CHECK returns to Phase 8's exact definition **only when no row carries snapshots**, otherwise the wider CHECK **stays**
(narrowing it would make the table reject its own audit rows; a CHECK with no writer is harmless) and the script says so.
A re-apply over either state is accepted. Never `CASCADE`.

## 4. Failure matrix

| Failure | What happens | Why it is safe |
| --- | --- | --- |
| recorder missing (migration not applied / rolled back under newer code) | pair cannot be recorded → X `reconciliation_required`, `FAILED{x_posts_unconfirmed}`; **not** acknowledged; entitlement stays `deleting` | the saga still holds the set; the person is told the count |
| `service_end_result` unreadable | stops before anything is touched (unchanged since Phase 8) | |
| acknowledgement RPC unreachable / 5xx / unreadable body | no clearing; the end continues; evidence on record here | over-reporting, never under-reporting |
| saga answers `deletion_in_progress` | no clearing; continue | another run of this person's deletion exists at the saga |
| saga is older than PR #204 (count without name) | `X_CLEANUP_FAILED{x_posts_unconfirmed}`, count kept, no acknowledgement | deploy order below; fails closed |
| 17th distinct evidence set of one operation | recorder raises; end stops (`FAILED` with the count) | something is wrong: stop, never truncate |
| ending while a previous un-acknowledged set exists at the saga | the saga's answer repeats it; record is a no-op; acknowledged now | idempotent |

## 5. Ending POSTONA alone preserves the login and every other service (integrated `X8`, unit test)

* F5 never deletes a login on this path (`social_only` scope or `X_CLEANUP_UNSUPPORTED`; unchanged, `I14` pins the
  POSTONA-only person with no Kabumori profile).
* **Finding fixed (F5-owned): another app's entitlement made every F5 flow unreadable.** `eligibility()` accepted only
  `kabumori` / `x_autopost`; one entitlement row of a third service key (a future app) turned `withdraw_postona` and
  `withdraw_kabumori` into `FAILED` before anything happened. It now accepts any well-formed service key
  (`^[a-z][a-z0-9_]{1,31}$`) for the single-service flows, **without touching it**. The whole-account deletion still
  cannot complete past a service it cannot end (the entitlement stays "remaining": `SERVICE_CLEANUP_INCOMPLETE`, login
  untouched — unit test). Reproduced first (`X8` failed with the old parser), fixed, proven.
* `X8` (database with a third key `future_app`, a test-only widening of the `service_key` CHECK in a throw-away copy):
  with Kabumori **suspended**, **ended** and **active** — the POSTONA end completes, the Auth user, the common account
  (`active`), the Kabumori profile and **both other entitlement rows are byte-for-byte equal** to before.

## 6. Proof inventory

| Proof | Command | Result |
| --- | --- | --- |
| migration: preflight refusals, exact change, static, behavior suite, 3-session race, rollback (both modes) | `common_account_x_unconfirmed_snapshot_run.sh` | see section 13 |
| migration: 25 deliberate regressions | `common_account_x_unconfirmed_snapshot_mutations.py` | see section 13 |
| Edge: unit + wiring (140 tests) | `deno test --no-config --no-check --allow-env --allow-read supabase/functions/account-delete/` | see section 13 |
| Edge: 36 deliberate regressions | `common_account_phase8_ts_mutations.py "$PWD"` | see section 13 |
| assembled F3 PR204 + F4 + F5 P1–P10 (39 e2e tests incl. X1–X8, R1–R4) | `common_account_phase8_integrated_run.sh` | see section 13 |
| release preflight: ten-member chain, probe (22 regressions), rollback ladder, matrix, notices | `CAL_PREFLIGHT_SECTIONS=all … common_account_release_preflight_run.sh` | see section 13 |
| preflight self-mutations (16) | `common_account_release_preflight_mutations.py` | see section 13 |
| Phase 9 shared sign-in (regression) | `common_account_phase9_shared_login_run.sh` | see section 13 |

Fail-before evidence (recorded before any code changed): the assembled runner against PR #204 with the Phase 9 code
failed exactly `I0` (mapper equality) and `I7` (a count-only acknowledgement clears nothing); `X8` failed with the old
service parser; the Phase 9 code on PR #204 is `R4` (safe, over-reporting).

## 7. Deploy and rollback order

Schema first, one reviewed file, never `db push`. **F3 PR #204's saga SQL and function first** (an older saga answers a
count without a name and every unconfirmed end then stops, fail-closed), **then this migration, then the Edge build**.
Rollback is the reverse: Edge build back to Phase 9 (safe: `R4`), then this migration's rollback (or leave it). The F3 side
is rolled back by F3's own file and **only when its checkpoint table is empty** (F3's R1b rule).

## 8. What is NOT in this PR (and why)

* no change to F3, F4, G3/G4, H5, POSTONA mobile, the Kabumori app, Cron, deploy, migrations of other stacks, grants,
  flags, release gates (`managed_auth_delete` stays BLOCKED; `IDP_PREPAUSE_BLOCKED` stays BLOCKED);
* no dedicated read-only "end result" action. J4 R1 asks for "an independently reviewed durable-result read-back": the
  durable facts are **already** returned by `withdraw_postona` when the service is `already_ended` (`I7`, unit test) and
  PR #211 consumes that shape; a separate preview-style action would be a new surface and needs the owner's decision;
* no editing of existing migrations, shared grants or flags (this phase adds one file).

## 9. Hand-offs (exact; observed source is separated from managed behavior)

**F3 (X saga, PR #204 and the legacy path)** — *observed in source*:
(a) `social_mobile_account_deletion_hold()` still compares the lease against `now()` (transaction start); F3's R3 fixed
`stop_x`, not the inherited `hold()` (J4 and J3 both list it). F5 does not depend on it (F5 checks its own lease on the
wall clock).
(b) F3-L1: the legacy saga path (`lock_own` / `pre_publish_check` row-then-G5, `create_batch` G5-then-FK, saga stop
`social_accounts` then rows) forms a three-way lock cycle (`O6`; verified one-statement repair `O7`). Never in the F5 flow.
(c) R2': a POSTONA-only person (no Kabumori profile) gets saga scope `social_and_login`; F5 refuses
(`X_CLEANUP_UNSUPPORTED`, `I14`). The **legacy** call `action: 'delete'` for that person with a common account deletes the
login and the common-account row (`I14b`, observed: login 0, common account 0). *Managed exposure (deployed code, older
installed builds) not inspected.* Owner: F3/G3 server containment (J4 mandatory gate 1). **Product consequence for the
"POSTONA first, Kabumori may pause" direction:** a person who has only POSTONA (no Kabumori profile) cannot end POSTONA
alone today — F5 refuses safely (`X_CLEANUP_UNSUPPORTED`, login untouched) because the saga derives its scope from the
*absence of a Kabumori profile*. The fix is F3's: derive the scope from the common account (a person with a common account
never gets `social_and_login`) and keep honoring `expected_scope: 'social_only'`; F5's request already sends it.
(d) F3 PR #204's ACK function is correct for F5's consumption; one note: an `acknowledged` answer requires `cleared > 0`
even for a replay (the receipt stores the cleared count) — F5 mirrors it; if F3 ever returns a replay with `cleared: 0`
F5 treats it as "not known to be cleared" (safe, over-reporting).

**G3 (X onboarding)** — *observed*: `begin_/complete_/consume_social_mobile_x_oauth_*` consult no entitlement (`I15`: a
reconnect works while an end is open). Add the Phase 3b writer guard call at the top of the three definers (exact text in
the Phase 9 doc §10). *Managed:* not checked.

**G4 / POSTONA app** — *observed*: PR #197 (head `2171ee4c`) bridges the client to `account-delete` with J4 P2 R1/R2
open; PR #211 (head `eb1011f2`) is the correction candidate. Both parse F5's shapes only; **this phase changes none of
them** (the snapshot is internal). Remaining: the legacy deletion screen of builds without #197 (see F3 (c)).

**F4 / Threads** — *observed*: Threads has no app-side revoke; the cleanup is "local removed, remote unverified" with the
person's acknowledgement (`I1`); F4's cleanup pair needs the reviewed EXECUTE grant candidate and a provider registration
(both OFF as shipped, `I3`/`I4`); PR #180's live-lease predicate is what F5 relies on. *Managed:* the Threads grant is
never revoked remotely — do not claim it.

## 10. Open design question for the coordinator (not decided here)

**D1 — a whole-account deletion with unconfirmed X posts ends with the count in the response only.** The pair is recorded
and acknowledged before the login goes (`X7`), the person is told the count in the final answer, and then the F5 record
cascades away with the account (by design: the person's data is deleted). If that one response is lost, the person never
learns that some X posts' results were unknown, and the saga's checkpoint is already cleared. Options: (a) accept (current,
as in Phases 8–9); (b) require the person's explicit acknowledgement of the count before the login goes (a new request
field and Kabumori screen — a contract and UI change, F5 + Kabumori app owner); (c) skip the saga acknowledgement when the
login is about to be deleted (the hashed, content-free checkpoint then stays at F3 as an orphan — retention question for
F3 / privacy). The single-service end (`withdraw_postona`) has no such gap: the pair stays on record and `already_ended`
returns it.

## 11. Residual blockers

Managed Supabase behaviour (PostgREST status mapping, RLS under real roles, `auth.sessions` privileges, GoTrue linking and
timing), real X revoke answers and rate limits, the reservation worker (no EXECUTE yet), provider registration, F3's
inherited `hold()` residual, the server-side entitlement on POSTONA writes (G3), the legacy deletion path, and one
independent **Sol（高）** review of PRs #183 + #193 + #206 + this one (the snapshot ACK is a concurrency-sensitive
consumer; the review should also read the `X1`–`X8` scenarios and the F3 lock order).

## 12. Production NO_GO

(1) PR #121 → … → #206 and this PR are unmerged Drafts; (2) F3 PR #204 passed J3's focused source review
(R1a / R3a / R1b: `PASS_SOURCE_REVIEW`, production NO_GO) but is itself an unmerged Draft, and J3's own blocker list still names
this consumer plus an independent integrated gate; (3) nothing was applied to or read from a managed project; (4) the G3/G4 gates above; (5)
`managed_auth_delete` and `IDP_PREPAUSE_BLOCKED` stay blocked; (6) every release gate stays OFF.

## 13. Final proof run (2026-10-15, local PostgreSQL 17.11 on a Unix socket, Deno, fake data only)

| Proof | Result |
| --- | --- |
| `common_account_x_unconfirmed_snapshot_run.sh` (world P1–P9, preflight, apply, exact change, static, behavior, race, rollback) | `XU_ALL_PASS` |
| `common_account_x_unconfirmed_snapshot_mutations.py` | 25 / 25 mutants killed (control passes) |
| `deno test --no-config --no-check supabase/functions/account-delete/` | 140 passed, 0 failed |
| `common_account_phase8_ts_mutations.py "$PWD"` (Phase 8 + Phase 10 Edge rules) | 36 / 36 detected (control passes) |
| `common_account_phase8_integrated_run.sh` (all sections: e2e 39 tests, regression, apply order, rollback, ACL) | `PHASE8_ALL_PASS` |
| `CAL_PREFLIGHT_SECTIONS=all common_account_release_preflight_run.sh` (chain of ten, probe, rollback ladder, matrix 17 tests, notices 9, per-phase runners) | `COMMON_ACCOUNT_RELEASE_PREFLIGHT_ALL_PASS` |
| `common_account_release_preflight_mutations.py` | 16 / 16 killed |
| `common_account_phase9_shared_login_run.sh` (regression) | `PHASE9_ALL_PASS` |
| `common_account_phase9_mutations.py` (regression) | 14 / 14 killed |
| `common_account_core_fence_run.sh` (regression) | `COMMON_ACCOUNT_CORE_FENCE_ALL_PASS` |
| `common_account_phase3a_ts_mutations.py` / `phase4` / `phase6` (regression of the older Edge rules) | 46 / 46, 19 / 19, 18 / 18 detected |
| `deno lint supabase/functions/account-delete/` | 57 problems, the same count as the PR #206 head (no new one) |
| `deno check` of `lifecycle_logic.ts`, `http.ts`, `x_unconfirmed.ts` | pass (test files import `node:assert`; the tree's known type-package debt is not touched) |
| `git diff --check`, secret pattern scan of the diff | clean |
| `git merge-tree --write-tree origin/main HEAD` | clean |

Not run (and why): anything against a managed Supabase project (not permitted; section 12), real X / Threads / Meta, a device,
the F3 legacy path in production, Cron, a deploy, an independent review.
