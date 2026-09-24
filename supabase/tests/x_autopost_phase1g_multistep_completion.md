# X autopost Phase1G — multi-request completion for tip threads and morning_greeting

Status: **source-only candidate**. Not applied, not deployed, not wired into the live dispatcher, the legacy greeting publisher, or any producer. No X request made.

Files:

- `supabase/migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql` (requires 1B/1D/1E/1F)
- `supabase/functions/_shared/x_v2_multistep.ts` (+ `_test.ts`) — next-safe-action planners, one-step provider, step-ledger RPC client
- `supabase/functions/_shared/x_v2_outcome_ledger.ts` (+ `_test.ts`) — matrix updated: tip / morning_greeting now typed; brand_post still disabled
- `supabase/functions/x-test-post/multistep_completion_migration_test.ts` — static checks
- `supabase/tests/x_autopost_phase1g_{fixture.sql,behavior.sql,run.sh}` — disposable PostgreSQL proof

## 1. Legacy paths audited (unchanged)

- **tip** (`x-test-post/index.ts`): `selectTip` → `generatePostParts` (1–3 parts; >1 only if >600 chars) → `postThreadToX` (sequential `postToX`, each reply to the previous id; 401 refresh + re-send) → `complete_tip_post(post, tip, first id)`: tip `last_used_at`/`use_count+1`, post succeeded, one success log `X post created` with `tip_id` and the **first** id. Other part ids are not persisted.
- **morning_greeting** (`runMorningGreetingManualPublish`): Storage receipt pre-check (skip if present) → `publish_claims` insert `(brand, post_type, date_jst)` status `publishing` (never reclaimed) → payload/image → media upload → create with `made_with_ai` + media id (both with 401 refresh + re-send) → `publish_claims` `published` + `x_post_id` + `published_at` → best-effort Storage receipt → dispatcher `complete_morning_greeting_post` (post succeeded + log `X post created`). Any error after the claim marks it `failed` (day is then human-review).

## 2. Step model

`post_provider_step_plans_v2` (one immutable row per attempt, written only while the attempt is `pre_x`):

| plan_kind | expected_steps | step 1 | steps 2..N |
| --- | --- | --- | --- |
| `tip_thread` | 1–3 (the generated part count) | `create_post`, no parent | `create_reply`, parent = previous confirmed id |
| `morning_greeting_media_post` | 2 | `media_upload` | step 2 `create_post`, `input_provider_object_id` = step 1's confirmed media id |

`begin_planned_provider_step_v2` is the only way to start a step (Phase1F `begin_provider_step_v2` is no longer executable by service_role). It rejects: no plan (`PROVIDER_STEP_PLAN_REQUIRED`), beyond the plan (`PROVIDER_STEP_BEYOND_PLAN`), wrong kind for the position (`PROVIDER_STEP_KIND_NOT_IN_PLAN`), wrong/absent/foreign media input or any input on a thread (`PROVIDER_STEP_INPUT_MISMATCH`), greeting without its day claim (`GREETING_PUBLISH_CLAIM_NOT_HELD`); then Phase1F rules apply (attempt `provider_started`, strictly sequential, never restarted, previous step confirmed, reply parent chain, terminal attempt accepts nothing). Step rows keep part index, kind, parent, consumed input, confirmed object id, and terminal outcome/code.

Attempt guards (triggers): a thread/greeting attempt with any confirmed `create_*` step cannot be recorded `x_rejected` (`X_REJECTED_AFTER_CONFIRMED_CREATE`) — something exists on X, so the honest record is uncertain or confirmed-incomplete.

## 3. tip completion — `complete_tip_post_v2(attempt, token, account, brand, tip_id)`

Locks the attempt, then requires: plan `tip_thread`; exactly `expected_steps` steps numbered 1..N; all `provider_object_confirmed`; step 1 `create_post` without parent; each later `create_reply` parented by the previous id; distinct ids; no inputs (`THREAD_STEPS_NOT_COMPLETE` otherwise). Then, in the same transaction via the Phase1F core: identity (claim/account/brand/type `tip`), legal predecessor state, post → `succeeded`, attempt → `completed` with the **root** id; and the exact legacy side effects: `tips` usage +1 and one success log (`tip_id`, root id, `X post created`). All part ids remain in `post_provider_steps_v2`. Repeat → `already_completed` with no side effect; recovery from `x_confirmed_db_incomplete` (root id) completes exactly once.

## 4. morning_greeting

- `acquire_greeting_publish_claim_v2(attempt, token)` (pre-X, post type `morning_greeting`, post running and bound to the attempt's account): inserts the day claim with `execution_id = attempt id`. Idempotent for its owner; `GREETING_ALREADY_PUBLISHED` if the day is published; `GREETING_PUBLISH_CLAIM_HELD` if another execution/attempt holds it. **Never transferred**, including to a later attempt of the same post (legacy-equivalent: a failed day is human-review). Recommended dispatcher order: resolve credential and verify identity first, acquire the claim immediately before `mark_post_provider_started_v2`, to minimise pre-X losses of the day.
- An attempt that finishes with any outcome other than `completed` / `x_confirmed_db_incomplete` marks its claim `failed` with `<OUTCOME>:<code>` (legacy marks failed on any error). `x_confirmed_db_incomplete` keeps the claim `publishing` so completion can still publish it.
- `complete_morning_greeting_post_v2(attempt, token, account, brand)`: requires plan `morning_greeting_media_post`, exactly two steps, media confirmed, create confirmed with `input = media id`. Then in one transaction: identity/state (core), post → `succeeded`, attempt → `completed` with the create id, `publish_claims` of **this attempt** (`execution_id`, brand, type, date = post `schedule_date`, status `publishing`) → `published` + `x_post_id` + `published_at`, and the legacy success log `X post created`. Repeat → `already_completed`; forced failure rolls back all of it.
- Storage receipt: external and not transactional. As in the legacy path, `publish_claims` is authoritative; a future dispatcher writes the receipt best-effort **after** commit and must also run the legacy receipt pre-check read-only before acquiring the claim (compatibility with pre-claim history).
- Deliberate difference: the legacy scheduled path marks the post `succeeded` when the day was already published elsewhere (receipt/claim skip). v2 cannot complete without a provider step, so it fails closed: `GREETING_ALREADY_PUBLISHED` → the dispatcher settles `pre_x_terminal`.

## 5. Helpers (`x_v2_multistep.ts`)

- `nextThreadAction(expected, steps)` / `nextGreetingAction(steps)`: reconstruct confirmed ids from the ledger and return one action: `begin` (with exact parent/input), `complete` (all ids), or `blocked` (in-flight, uncertain, rejected, gap, wrong parent/kind/input, extra). Never a re-send.
- `runProviderStepOnceV2({credential, action, request, beginStep})`: refuses a request that does not match the planned action (kind, parent, media id, empty text/bytes) before anything is begun; awaits the durable begin; exactly one request (`redirect: manual`, timeout, exact-account bearer); classifies confirmed / rejected (4xx) / uncertain (network, 3xx, 408, 5xx, 2xx without id). No refresh, no retry, no loop.
- `createV2StepLedgerClient`: service_role RPC/SELECT adapter for acquire/plan/beginPlanned/finish/list/completeTip/completeGreeting; unknown error bodies become `STEP_LEDGER_UNAVAILABLE`.
- The Phase1E exact-account resolver and identity check are reused unchanged.

## 6. v2 post-type matrix

| post_type | v2 completion | status |
| --- | --- | --- |
| interaction | `complete_interaction_post_v2` | source-ready (poll payload still needs a seam) |
| useful_tip | `complete_useful_tip_post_v2` | source-ready |
| morning_report / close_report / us_premarket_report | `complete_report_post_v2` | source-ready |
| tip | plan `tip_thread` + `complete_tip_post_v2` | **source-ready (Phase1G)** |
| morning_greeting | claim + plan + `complete_morning_greeting_post_v2` | **source-ready (Phase1G)** |
| brand_post | — | **disabled**: `complete_ai_salaryman_lab_brand_post` SQL is production-only, not auditable from source |

No live routing is enabled.

## 7. Migration / ACL

Single explicit `begin; … commit;` (apply alone, with a tool that does not wrap files in a transaction; not re-runnable). Fails closed unless Phase1F objects exist and `publish_claims` has a unique non-partial index on exactly `(brand_id, post_type, date_jst)` (live Phase0c shape). Additive: new plan table, one new nullable column `post_provider_steps_v2.input_provider_object_id`, 8 functions (all `SECURITY DEFINER`, `search_path = ''`), 2 triggers on `post_queue_attempts_v2`, one revoke (`begin_provider_step_v2` from service_role). Public RPCs are service_role-only; internal/trigger functions have no API EXECUTE. Plan table is SELECT-only for service_role. `publish_claims` keeps its live service_role SELECT/INSERT/UPDATE grant because the unchanged legacy REST helpers need it — a service_role caller could still write claims directly (residual, legacy compatibility).

## 8. Verification

```bash
PHASE1G_PGHOST=/private/tmp/<sock> PHASE1G_PGPORT=<port> PHASE1G_PGSUPER=<local superuser> \
  supabase/tests/x_autopost_phase1g_run.sh
```

Non-superuser owner, Supabase-style default grants, fake data, fixture-only fault-injection triggers. Covers ACL; plan idempotency/conflict/invalid/type/claim/token; greeting claim idempotency, already-published, held-by-other and stale-attempt refusal; pre-X end failing the claim; plan-required and raw-entry denial; 2-part and 3-part threads completing exactly once with all ids; wrong parent/kind/input; missing middle; uncertain and rejected parts blocking later steps; rejected-after-confirmed refusal; terminal attempts; partial threads non-reclaimable; forced tip failure rollback and confirmed-incomplete recovery; greeting ordering, media binding (including another attempt's media), uncertain create blocking replay and failing the claim, happy path with claim publication, duplicate completion, forced greeting failure rollback keeping the claim `publishing`; legacy row; API-role denial. A two-session race proves concurrent completion of the same thread yields one `completed`, one `already_completed`, one set of side effects.

## 9. Remaining

- v2 dispatcher (claim → resolve → identity → [claim/plan] → mark → steps → ledger/typed completion) and producers — not written, not enabled.
- brand_post completion source; interaction poll seam; per-account pre-X refresh writer; Kabumori credential in its account's Vault refs; uncertain → proven-created reconciliation path; operator tooling for failed greeting days.
- Production gates: live-definition diff (incl. `publish_claims` shape/grants, `tips`, `scheduled_posts` writers), atomic 1B→1G chain apply proof (explicit transactions vs. apply tooling), staged rollback plan.
