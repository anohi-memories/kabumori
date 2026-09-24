# X autopost Phase1F — provider outcome model and atomic per-type completion

Status: **source-only candidate**. Not applied, not deployed, not wired into the live dispatcher. No X request made.

Files:

- `supabase/migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql` (requires Phase1B, 1D, 1E)
- `supabase/functions/_shared/x_v2_outcome_ledger.ts` (+ `_test.ts`) — outcome → ledger RPC mapping, enabled/disabled post types
- `supabase/functions/x-test-post/atomic_completion_migration_test.ts` — static checks
- `supabase/tests/x_autopost_phase1f_fixture.sql`, `x_autopost_phase1f_behavior.sql`, `x_autopost_phase1f_run.sh` — disposable PostgreSQL proof

## 1. Provider outcome state machine (one attempt)

```text
claim_due_post_v2 ──► pre_x ──mark_post_provider_started_v2──► provider_started
   │                   │                                          │
   │   settle_post_pre_x_v2 (retryable) ─► finished/pre_x_retryable (post → pending, same account)
   │   settle_post_pre_x_v2 (terminal)  ─► finished/pre_x_terminal  (post → failed)
   │   reconcile_stale_pre_x_v2 (≥15m)  ─► finished/pre_x_* (only phase pre_x)
   │                                                              │
   │         typed complete_*_v2 ─────────────────────────────────┼─► finished/completed (post → succeeded)
   │         record_post_x_rejected_v2 ───────────────────────────┼─► finished/x_rejected (post → failed)   [new]
   │         record_post_x_uncertain_v2 ──────────────────────────┼─► finished/x_outcome_uncertain (post → failed)
   │         record_post_x_confirmed_incomplete_v2 ───────────────┴─► finished/x_confirmed_db_incomplete (post → failed)
   │                                                                     │ same typed complete_*_v2, same x_post_id
   │                                                                     └─► finished/completed (post → succeeded)
```

Invariants (all proved on disposable PostgreSQL):

- After `provider_started` nothing returns to `pre_x`/`pending`: `settle_post_pre_x_v2` and stale reconciliation only accept `phase = 'pre_x'`; the only post-start transitions are the four above.
- `x_rejected`, `x_outcome_uncertain`, `x_confirmed_db_incomplete` leave the post `failed`; `claim_due_post_v2` takes only `pending` rows and reconciliation only `pre_x` attempts, so none is re-claimable (Phase1D keeps legacy RPCs off bound rows).
- `x_rejected` is its own outcome (not overloaded on uncertain): requires `provider_started_at`, forbids `x_post_id`, requires `error_code` (CHECK constraint).
- Completion is exactly once: the attempt row is locked `FOR UPDATE`; an exact repeat returns `already_completed` and performs no side effect; a different `x_post_id` raises `X_COMPLETION_CONFLICT`. A later attempt for the same post makes an earlier one non-confirmable.
- Wrong claim token → `X_COMPLETION_CLAIM_INVALID`; wrong account/brand → `X_COMPLETION_ACCOUNT_MISMATCH`; wrong type → `X_COMPLETION_POST_TYPE_MISMATCH`; attempt not in a legal predecessor state → `ATTEMPT_NOT_CONFIRMABLE`. Legacy/unbound rows have no attempt and cannot use any v2 completion.
- `x_outcome_uncertain` cannot be completed by these RPCs (a proven-created post found later needs a separately reviewed reconciliation path).

## 2. Per-post-type completion matrix (live-source audit)

| post_type | existing completion | confirmed-X side effects in source | v2 atomic completion now | blocker |
| --- | --- | --- | --- | --- |
| interaction | `complete_interaction_post` | topic `last_used_at`/`use_count+1`; post succeeded; success log `Interaction X post created; topic=<id>`; `interaction_post_metrics` row (unique `x_post_id`) | **`complete_interaction_post_v2`** | poll payload not in the Phase1E text-only seam (seam extension needed before dispatch) |
| useful_tip | `complete_useful_tip_post` | useful tip usage; post succeeded; success log with `useful_tip_id`, `source_urls`, `verified_at`, `model_used`, `escalated_to_sol`, tokens, cost | **`complete_useful_tip_post_v2`** | — |
| morning_report | `complete_morning_report_post` (also the shared-packet path) | run `succeeded`/`x_post_id`/`error=null` (raises if missing); post succeeded; success log copying run source/model/tokens/cost | **`complete_report_post_v2`** (+ run must belong to the post) | — |
| close_report | `complete_close_report_post` | same on `close_report_runs` | **`complete_report_post_v2`** | — |
| us_premarket_report | `complete_us_premarket_report_post` | same on `us_premarket_report_runs` | **`complete_report_post_v2`** | — |
| tip | `complete_tip_post` after `postThreadToX` | tip usage; post succeeded; one success log with the **first** part's id | **no** (v2-disabled) | thread = N creates; needs per-part step ledger + completion over all parts |
| morning_greeting | `runMorningGreetingManualPublish` + `complete_morning_greeting_post` | `publish_claims` (brand/type/day) claim → complete/fail; Storage receipt; media upload + create; post succeeded; success log | **no** (v2-disabled) | two provider requests; `publish_claims`/receipt lifecycle must be folded into the step ledger |
| brand_post (AI Lab) | `complete_ai_salaryman_lab_brand_post` | fingerprint persistence + completion + log (per TS caller) | **no** (v2-disabled) | the RPC's SQL is production-only, not in repository source — cannot reproduce exactly |

The typed completions reproduce the legacy statements exactly (same tables, columns, messages, metadata), with added fail-closed identity checks (claim/account/brand/type, report run ↔ post). Everything runs in one function = one transaction; any error (e.g. the unique `interaction_post_metrics.x_post_id`) rolls back the post, ledger, counters and logs together.

## 3. x_rejected treatment

`record_post_x_rejected_v2(attempt, token, error_code)` — only from `provider_started` with no outcome; post `running → failed`; attempt `finished/x_rejected` with the error code; logged as `failed` with message `X_REJECTED:<code>`. Non-reclaimable. The Phase1E seam's `x_rejected` outcome now has a durable home (`ledgerCallForOutcome`).

## 4. Multi-request foundation (tip, morning_greeting)

`post_provider_steps_v2` + `begin_provider_step_v2` / `finish_provider_step_v2`: one row per X request, created durably **before** the request, only after the attempt is `provider_started`. Step numbers are strictly sequential (`PROVIDER_STEP_OUT_OF_ORDER`), a started step can never be started again (`PROVIDER_STEP_ALREADY_STARTED`), and step 1 cannot be a `create_reply` with an invented parent. The next step needs the previous one `provider_object_confirmed` (`PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED`). Kind order is `media_upload → create_post` or `create_post → create_reply → …`, not another root post or a reply to media; a `create_reply` must name the previous step's object as parent (`PROVIDER_STEP_PARENT_MISMATCH`). Finishing an open step also requires an active `provider_started` attempt, locked before the step; terminal attempts cannot acquire a late outcome. An exact replay of an already-finished step remains read-only/idempotent; conflicting values fail (`PROVIDER_STEP_CONFLICT`). Step outcomes: `provider_object_confirmed` (object id required), `x_rejected`, `x_outcome_uncertain` (code required). A thread is therefore never represented by one id: a partial thread records which parts exist and which part is uncertain, and no part is re-sent.

Still missing (next task): a completion that consumes the step ledger (tip usage + one log per thread, greeting `publish_claims`/receipt), and TS providers that drive steps. Until then tip and morning_greeting have **no v2 completion** and stay disabled (`V2_DISABLED_POST_TYPES`).

## 5. Observability

- Trigger `post_queue_attempts_v2_log_started` (AFTER INSERT): legacy-shaped `started` log `Scheduled post claimed (v2 attempt N)` in the same transaction as the claim.
- Trigger `post_queue_attempts_v2_log_finished` (AFTER UPDATE OF phase, entering `finished` with an outcome other than `completed`): `failed` log with `error_code` and message `<OUTCOME>:<code>` (`PRE_X_RETRYABLE`, `PRE_X_TERMINAL`, `X_REJECTED`, `X_OUTCOME_UNCERTAIN`, `X_CONFIRMED_DB_INCOMPLETE` — the latter also carries the confirmed `x_post_id`).
- Success logs come only from the typed completion with the legacy metadata.
- The log status stays within the legacy `started/succeeded/failed` set; the exact provider state is in the message/`error_code`, and reclaimability is decided only by the ledger.

## 6. Migration / ACL safety

- One explicit `begin; … commit;`: no function is committed with the default PUBLIC EXECUTE grant; a failed assertion rolls everything back. Apply as its own unit with a tool that does not already wrap the file in a transaction. Not re-runnable (second apply fails at the first CREATE and rolls back).
- Fails closed (`PHASE1F_PRECONDITION_ATTEMPT_CONSTRAINTS_DRIFTED`) unless the two Phase1B attempt constraints are exactly the reviewed definitions before widening them.
- All 10 functions `SECURITY DEFINER`, `search_path = ''`. Typed completions, `record_post_x_rejected_v2` and the step RPCs are service_role-only; internal helpers and trigger functions have no API EXECUTE (not even service_role).
- Retires the effect-less Phase1B `complete_post_x_confirmed_v2` (EXECUTE revoked from service_role) so a confirmed create cannot skip its side effects. Phase1D's standalone proof asserts that wrapper is service_role-executable, so that proof fails when stacked on Phase1F by design.
- Supabase default privileges would give service_role write access to new tables: `post_provider_steps_v2` is SELECT-only for service_role, and the Phase1B ledger tables (`post_queue_attempts_v2`, `post_queue_account_turns_v2`) lose service_role INSERT/UPDATE/DELETE/TRUNCATE. The ledger changes only through SECURITY DEFINER RPCs.
- API-role direct INSERT/UPDATE/DELETE/TRUNCATE on `scheduled_posts` is also revoked. Phase1D's `kabumori.x_queue_domain` custom setting can be set by a caller, so it is not sufficient as an authorization barrier on its own; the reviewed SECURITY DEFINER RPCs remain the write path for bound rows. Legacy owner-executed planners/completions still operate on unbound rows. Confirm live direct-write consumers and ACLs before any production rollout.
- Depends on Phase1B/1D/1E objects; cannot be applied independently.

## 7. Verification

```bash
PHASE1F_PGHOST=/private/tmp/<sock> PHASE1F_PGPORT=<port> PHASE1F_PGSUPER=<local superuser> \
  supabase/tests/x_autopost_phase1f_run.sh
```

Non-superuser owner, Supabase-style default grants, fake data. Behavior proof covers ACL, started logs, interaction/useful_tip/three report completions with exact side effects, duplicate idempotency, conflicting id, forced unique-violation rollback of every effect, confirmed-incomplete non-reclaim and later exactly-once recovery, report run ↔ post mismatch rollback, wrong token/account/brand/type, pre-X attempt, legacy row, retired generic completion, x_rejected and uncertain terminality and logs, the forbidden rejected-with-id shape, provider-step ordering/idempotency/chaining for tip and greeting, and domain restoration. A two-session race proves concurrent duplicate completion yields exactly one `completed`, one `already_completed` and one set of side effects.
