# Codex Task 2

- task_id: push-delivery-deduplication-hardening-20260912
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol High
- purpose: 重要ニュース・市場Critical・個別朝刊/大引けで共有するPush通知経路について、二重enqueue・二重claim・retry・Cron重複・Expo再送などの重複通知リスクを監査し、既存機能を壊さず必要最小限のhardeningを行う。

## C2 Review — 2026-09-12

### Review result

- architecture audit: approved
- producer dedupe audit: approved
- P0 concurrent dispatcher risk identification: approved
- proposed atomic claim / SKIP LOCKED design: approved in principle
- settings re-check policy: approved in principle
- dispatcher retry/fail-safe design: approved in principle
- tests: approved for source/pure/contract level
  - combined relevant suite: 83/83 PASS
  - deno check: PASS
  - git diff --check: PASS
- implementation commit: `b83d73a25089a4a7b99bf1dc14985a6a8206fe59`
- push: confirmed on origin/main
- production changes: correctly none

### Blocking issue before production

The proposed migration and claim path have NOT yet been proven in a disposable real PostgreSQL/Supabase database.

Still required before production approval:
- apply migration in disposable DB
- rollback-contained migration proof
- two-session concurrent claim test proving one notification row is claimed at most once
- sent row cannot be reclaimed
- stale processing reclaim bounded
- retry state transitions verified against actual SQL behavior
- service-role-only RPC permissions verified
- settings opt-out claim behavior verified in DB

Current Supabase production project has no development branches (`list_branches` returned 0). Do NOT use production as the disposable test environment without a separate explicit user decision.

### Production remains prohibited

Do not perform any of the following until a later C2 approval:
- apply `20260912100000_harden_push_notification_claims.sql` to production
- `supabase db push`
- deploy `send-push-notifications`
- deploy `important-news-monitor`
- modify Cron
- send a real/test Push
- insert synthetic production notifications

### Remaining design notes

- Residual setting TOCTOU between atomic claim commit and external Expo request remains small but real; acceptable only after DB proof and final C2 review.
- Provider-accepted-but-client-timeout remains fundamentally ambiguous; current proposal intentionally fails terminally rather than risk duplicate resend.
- Migration history is divergent; `supabase db push` remains prohibited.

## Follow-up F1 — free local disposable DB proof

User selected the free path. Do not use a paid Supabase branch.

### Required startup checks

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and `.agent/CODEX_REPORT_2.md`.
2. Fresh-check `origin/main` before any work.
3. Use an isolated temporary clean worktree/clone.
4. Read other slot TASKs and stop if any active slot is modifying `send-push-notifications`, `important-news-monitor`, notifications RPC/migration, or the same migration file.
5. Do not touch the formal checkout or unrelated uncommitted changes.
6. `supabase db push` remains prohibited.

### Environment

Use a FREE disposable local PostgreSQL/Supabase environment only.

Preferred order:
1. Existing local Docker + Supabase CLI, if already available.
2. Existing local PostgreSQL instance, if available.
3. A temporary Docker PostgreSQL container if Docker is available.

Do not install paid services or create paid cloud resources. If Docker/PostgreSQL required for a disposable DB is unavailable, stop and report the exact missing prerequisite. Do not use production as a substitute.

### DB proof requirements

Against the disposable DB, prove the proposed migration `supabase/migrations/20260912100000_harden_push_notification_claims.sql` and claim path with actual PostgreSQL behavior, not only static tests.

Required:

1. **Migration apply**
   - Prepare only the minimal prerequisite schema/data needed to represent the current `notifications`, `alert_settings`, `personalized_reports`, tracked-stock/news relationships, and roles referenced by the migration/RPC.
   - Apply the proposed migration successfully.
   - Verify new columns/status/indexes/RPC exist with expected definitions.

2. **Rollback-contained proof**
   - Demonstrate the migration can be exercised in a disposable transaction/schema and cleaned up without affecting any production resource.
   - Record exact SQL/reproduction steps.
   - If the migration is intentionally forward-only and not transactionally reversible, prove all changes are expand-only and document a safe rollback/disable strategy before production.

3. **True concurrent claim**
   - Use two independent PostgreSQL sessions/connections.
   - Start claims concurrently against the same eligible pending notification set.
   - Prove a notification row is returned to at most one session due to `FOR UPDATE SKIP LOCKED` / atomic state transition.
   - Repeat enough times to exclude a single lucky ordering; record results.

4. **Claim-token CAS**
   - Prove a dispatcher with the wrong/old claim token cannot finalize another dispatcher's row.
   - Correct token can finalize exactly once.

5. **Sent terminality**
   - Prove a `sent` row is not reclaimable.

6. **Retry semantics**
   - Prove retry uses the same notification row, does not create another row, increments/bounds attempts correctly, and respects next-retry timing.
   - Prove terminal failure after the configured maximum attempt count.

7. **Stale processing**
   - If stale-processing reclaim is implemented, prove it is bounded and does not allow unlimited resend.
   - Ambiguous provider outcome must not be automatically replayed if design says terminal fail.

8. **Settings opt-out at claim**
   - `push_enabled=false` -> queued row is not delivered/claimed for send and is handled per design.
   - `market_critical_news=false` -> safely identified pending market-critical row is skipped.
   - `morning_report=false` / `close_report=false` -> safely identified matching personalized-report notification is skipped.
   - Unknown/deleted source mapping must fail closed rather than guess.

9. **Permissions**
   - Verify claim RPC is not callable by anon/authenticated roles if intended service-role-only.
   - Verify `SECURITY DEFINER` and search_path safety as implemented.

10. **Compatibility**
   - Existing pending/sent/failed/skipped rows remain valid after migration.
   - Existing producer dedupe constraints are not weakened.

### Tests after DB proof

Re-run at minimum:
- push dispatcher tests
- queue claim contract tests
- important-news regression if touched
- market-critical regression if touched
- personalized-report regression if touched
- `deno check` for changed modules
- `git diff --check`

Add only narrowly scoped integration/proof scripts if necessary. Do not add a permanent heavy test framework unless required.

### Production safety

This follow-up is proof-only. Still prohibited:
- production DB migration/RPC changes
- `supabase db push`
- Edge Function deploy
- Cron changes
- real/test Push
- synthetic production notifications
- OpenAI/X API calls
- user setting changes
- x-test-post changes/deploy

### Completion

If all proof passes:
- update `.agent/CODEX_REPORT_2.md` with environment, exact SQL/procedure, concurrent-session evidence, results, regressions, changed files if any, commit/push, and production rollout recommendation.
- set TASK `status: review_required`
- set `next_owner: chatgpt`
- push only proof/test/report changes to `origin/main`.

If local disposable DB proof cannot be performed for environmental reasons:
- do not weaken the requirement;
- report the missing prerequisite precisely;
- leave production rollout blocked;
- set `status: review_required`, `next_owner: chatgpt`.
