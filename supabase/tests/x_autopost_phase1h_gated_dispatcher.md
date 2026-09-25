# X autopost Phase1H — gated v2 dispatcher (source candidate)

Status: **source-only, gate OFF**. `v2_dispatcher.ts` is not imported by `x-test-post/index.ts`; the live scheduler keeps calling the legacy `claim_due_post` path. No deploy, no migration apply, no X request.

Files:

- `supabase/functions/x-test-post/v2_dispatcher.ts` — gate + dispatcher (`runV2DispatchOnce`)
- `supabase/functions/x-test-post/v2_dispatch_ledger_rpc.ts` — PostgREST adapter + resume credential reader
- `supabase/migrations/20260925120000_x_autopost_phase1h_dispatch_resume.sql` — content snapshots, plan-before-start guard, resumable listing, resume credential RPC
- tests: `v2_dispatcher_test.ts`, `v2_dispatch_ledger_rpc_test.ts`, `dispatch_resume_migration_test.ts`, `supabase/tests/x_autopost_phase1h_{behavior.sql,run.sh}`

## 1. Gate contract

- Server env `X_AUTOPOST_V2_DISPATCH`. **ON only when the value is exactly `enabled`** (case- and whitespace-sensitive). Missing, empty, `true`, `1`, `on`, `Enabled`, padded values, or an env read that throws → OFF.
- Read by the server with `isV2DispatchGateOn(Deno.env.get)`; the dispatcher receives a boolean and runs only for `gateOn === true` (not truthy strings). No request body, header, admin or mobile input is consulted.
- OFF → `gate_off` before any ledger or X call (proved with a ledger that throws on any access).
- Nothing falls back to the legacy path: the dispatcher never calls `claim_due_post`, `postToX`, `postThreadToX`, token refresh, `oauth_token_store`, `loadBrandContext` or env tokens (static test).

## 2. Post-type matrix

| type | v2 dispatcher | reason |
| --- | --- | --- |
| useful_tip, morning_report, close_report, us_premarket_report | single create | Phase1E seam + Phase1F typed completion |
| tip | multi-step thread | Phase1G plan/steps + `complete_tip_post_v2` |
| morning_greeting | multi-step media → create | Phase1G claim/plan/steps + `complete_morning_greeting_post_v2` |
| interaction | **disabled** (`V2_INTERACTION_POLL_SEAM_MISSING`) | legacy posts may carry a poll; the seam is text-only and must not silently drop it |
| brand_post | **disabled** (`V2_BRAND_POST_COMPLETION_SOURCE_MISSING`) | completion SQL is production-only |
| anything else | **disabled** (`V2_UNSUPPORTED_POST_TYPE`) | |

`claim_due_post_v2` cannot filter by type, so a disabled type that was bound anyway is settled `pre_x_terminal` right after the claim with zero provider calls (`unsupported_type`). Producers must not bind disabled types.

## 3. State machine (one run = one unit of work)

```text
gate OFF ───────────────────────────────────────────────► gate_off
list_resumable_v2_attempts(1) ── row ──► RESUME (below)
claim_due_post_v2() ── none ──► no_work
  disabled type ──► settle terminal ──► unsupported_type
  resolve credential (Phase1E, claim.social_account_id only) ── fail ──► settle ──► pre_x_retryable | pre_x_terminal
SINGLE: prepare content ─► createXTextPostOnceV2 (identity → mark provider start → exactly one create)
  pre-X outcome ─► settle ─► pre_x_*
  x_rejected ─► record_post_x_rejected_v2 ─► provider_rejected
  uncertain ─► record_post_x_uncertain_v2 ─► provider_uncertain
  x_created ─► typed completion ─► completed
             └─ fails ─► record_post_x_confirmed_incomplete_v2(same id) ─► confirmed_db_incomplete
MULTI: [greeting: schedule_date must be today JST, else settle terminal — no X call]
  identity pre-check (before the greeting day claim, so an expired token does not burn the day)
  prepare content ─► [greeting: acquire day claim] ─► plan ─► snapshot ─► mark provider start
  STEPS (re-read ledger every iteration): next safe action from persisted steps
    begin (durable) ─► exactly one request ─► finish step (durable)
    confirmed ─► next iteration | uncertain ─► attempt uncertain | rejected ─► attempt rejected,
      or uncertain if a create was already confirmed (X_THREAD_PARTIAL_…)
    all confirmed ─► typed completion (no provider request) ─► completed | confirmed_db_incomplete
    step budget reached ─► in_progress (resumed by a later run)
RESUME: snapshot + ledger only (no memory). Credential via read_x_publish_credential_for_resume_v2
  (only when a next step exists). Greeting whose day passed with a step still to send ─► attempt uncertain.
Any ledger write that fails after provider start ─► blocked_manual_reconciliation (never re-sent).
```

Return classes: `gate_off`, `no_work`, `unsupported_type`, `pre_x_retryable`, `pre_x_terminal`, `provider_rejected`, `provider_uncertain`, `confirmed_db_incomplete`, `completed`, `in_progress`, `blocked_manual_reconciliation`. `V2_NON_RECLAIMABLE_CLASSES` = all except `gate_off`, `no_work`, `pre_x_retryable`, `in_progress`. The ledger enforces this independently: only `pre_x_retryable` returns a post to `pending`; only resumable multi-step attempts (all finished steps confirmed, none in flight) are continued.

## 4. Proofs (fake ledger mirroring the reviewed SQL rules + fake X transport; global `fetch` throws)

- **Single create exact-once**: one create per claim with the claimed account's own token (two accounts, two tokens); later runs `no_work`; 401 after start → rejected, no refresh, one create; timeout / 503 / 307 / 2xx-without-id → uncertain, one create, never retried; completion failure → confirmed-incomplete with the same id, three further runs make no request, the operator's typed completion then completes exactly once.
- **Tip restart**: 3 parts, `maxProviderStepsPerRun = 1`, a fresh ports object per run (no memory survives): runs `in_progress, in_progress, completed`; exactly 3 creates; texts from the snapshot in order; replies chained to the previous confirmed id; 3 distinct ids; one completion. Uncertain second part → no third create ever. Rejected reply after confirmed root → recorded uncertain. Crash between the X response and recording (finish fails) → blocked, never re-sent.
- **Greeting restart**: run 1 uploads media and stops; run 2 (fresh memory) creates with exactly the media id read from the ledger and completes; 1 upload, 1 create; day claim published; after-commit receipt hook called once. Uncertain create → never replayed, day claim failed. Stale JST schedule → zero X calls of any kind (not even identity). Expired token → found before the day claim is taken.
- **SQL** (disposable PostgreSQL): snapshot validation/immutability, plan+snapshot required before provider start for tip/greeting (single types unaffected), resumable listing excludes in-flight/uncertain/pre-X/single-create/completed, resume credential only while a next step exists and only for the exact account.

## 5. Refresh boundary

No exact-account pre-X refresh writer exists. The dispatcher never refreshes. An access token that X rejects at the identity pre-check returns `pre_x_retryable` / `X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X` (the Phase1B attempt cap of 3 turns repeated failures terminal); on resume it returns `in_progress` without touching the attempt. Next blocker (Phase1I): a per-account refresh writer that reads the account's own refresh-token Vault ref, calls X's token endpoint **pre-X**, and atomically rotates that account's Vault secrets — never the shared `oauth_token_store`.

## 6. Activation safety (future; nothing here is authorized)

1. **Live-definition / ACL read-back** (read-only, approved separately): legacy claim/retry/fail/complete RPCs and planners, `scheduled_posts` writers and grants, `publish_claims`/`tips`/report-run shapes, `social_accounts` Vault columns, AI Lab Vault RPC, Vault ACL, function owners.
2. **Ordered migration apply proof 1B → 1D → 1E → 1F → 1G → 1H** on a production-shaped disposable copy; each file applied alone (1E–1H contain explicit transactions; confirm the apply tool does not wrap them).
3. **Exact-account credential readiness**: each cohort account has its own `vault_access_token_secret_id`, `identity_verified`, `publish_enabled`; Kabumori's token moved out of `oauth_token_store`.
4. **Refresh-writer readiness** (Phase1I) or an operator procedure to keep cohort tokens fresh.
5. **Deploy the v2 dispatcher with the gate OFF** (a separate cron/function entry that calls `runV2DispatchOnce(ports, isV2DispatchGateOn(Deno.env.get))`); verify `gate_off` and zero ledger writes.
6. **Shadow / no-provider dry validation**: run content preparation and ledger reads only; no bound producers yet.
7. **Enable for one cohort**: one account, one type (e.g. `close_report`); only that producer writes bound rows; the Phase1D gate requires the legacy claim to be retired before any bound row exists — so this step is where `claim_due_post` EXECUTE is revoked from service_role **after** the legacy dispatcher has been switched to `claim_due_post_legacy_unbound_v2` and drained.
8. **Observe**: ledger outcomes, execution logs, X timeline, no duplicate ids.
9. **Staged expansion**: add types/accounts one at a time; tip and morning_greeting last.
10. **Legacy retirement**: only after drain and read-back.

Rollback points: before any bound row exists, gate OFF + re-grant the legacy claim is a full rollback. After provider start, nothing can be rolled back automatically: a created X post exists; uncertain/rejected/incomplete attempts stay failed and non-reclaimable; recovery is operator reconciliation (typed completion with the confirmed id, or manual review). Turning the gate OFF stops new work immediately; in-progress multi-step attempts simply wait (they are only resumed by the v2 dispatcher).

## 7. Remaining blockers

- Phase1I refresh writer; Kabumori credential into its account's Vault refs.
- interaction poll seam; brand_post completion source.
- uncertain → proven-created reconciliation tooling (operator); operator path for failed greeting days.
- Real content adapters for v2 (OpenAI generation, report-run creation, greeting media from Storage) — the dispatcher takes them as injected ports; not written here.
- Stacking note: Phase1G's standalone behavior proof marks tip/greeting attempts without snapshots, so it fails when stacked on 1H by design (the 1H guard).
- Production gates in §6.
