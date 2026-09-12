# Codex Task 2

- task_id: push-delivery-deduplication-hardening-20260912
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: Push通知経路の二重送信防止hardeningを、安全確認済みのmigration/RPCとdispatcherで本番反映する。

## C2 Review — disposable DB proof approved (2026-09-12)

### Approved evidence

- exact migration `supabase/migrations/20260912100000_harden_push_notification_claims.sql` applied successfully in a disposable Supabase PostgreSQL 17.6 container.
- migration objects verified: five notification columns, two partial indexes, `processing` status support, RPC signature, `SECURITY DEFINER`, empty `search_path`, intended grants.
- transaction containment behavior verified; disposable container was removed after proof.
- true two-session concurrent claim proof: 6/6 races produced exactly one winner and one empty loser; 0 duplicate claims.
- claim-token CAS: wrong token updates 0 rows; correct token finalizes once; second finalize fails.
- sent row is terminal and not reclaimable.
- retry behavior proven on the same row for attempts 1/2/3 with 120s/600s timing; no fourth claim and terminal failure at the bound.
- stale/ambiguous processing rows become terminal `failed / PUSH_DELIVERY_OUTCOME_UNKNOWN` and are not replayed.
- settings/source fail-closed behavior verified for global push, market-critical, personalized reports, missing mappings.
- RPC permission checks: service role allowed; anon/authenticated denied.
- legacy `pending/sent/failed/skipped` rows remain compatible; existing producer dedupe was not weakened.
- combined regressions: 83/83 PASS; `deno check` PASS; `git diff --check` PASS.
- proof commits are on `origin/main`; latest proof-record main observed at `6c974c6cdc560f213c35e99312ee6e374aa6c407`.

C2 result: **DB proof approved. Production rollout may proceed under the constraints below.**

## H2 Follow-up F2 — production rollout

### Required startup checks

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and `.agent/CODEX_REPORT_2.md`.
2. Fresh-check `origin/main` immediately before work and again before push/deploy.
3. Use an isolated clean worktree/clone. Do not modify or stage unrelated existing changes.
4. Read the other task slots and stop if another active slot now overlaps `send-push-notifications`, notifications schema/RPC, the same migration, Cron, or production Push settings.
5. Verify `pwd`, worktree-local `supabase/config.toml`, linked project ref, and source HEAD before every Supabase production operation.

### Production DB preflight

Before DDL, perform read-only inspection of the actual production definitions needed by this migration, including at minimum:
- `public.notifications` columns/check constraints/indexes
- `public.alert_settings` columns used by claim settings recheck
- `public.personalized_reports`
- `public.important_news_candidates`
- existing `claim_pending_push_notifications` presence/signature if any

Confirm the migration remains compatible with the live schema. If anything differs materially from the disposable fixture assumptions or the migration would require destructive correction, STOP and report for C2.

### Migration application — strict rule

Production migration history is divergent. Therefore:
- **NEVER run `supabase db push`.**
- Apply **only** `supabase/migrations/20260912100000_harden_push_notification_claims.sql` as the explicitly approved migration, using the linked production project and an absolute/verified file path (for example `supabase db query --linked -f <absolute-path>` if supported in the installed CLI).
- Do not mark unrelated migration versions as applied/reverted and do not reconcile migration history in this task.
- The migration is expand-only. Do not create a destructive down-migration.

Immediately after application, read back and verify:
- all added notification columns/defaults
- status constraint includes `processing`
- both indexes
- RPC body/signature
- `SECURITY DEFINER`
- empty search_path
- execute privileges service-role-only as designed

If migration application fails transactionally, do not improvise partial fixes; verify rollback state and STOP for C2.

### Dispatcher deploy

Only after DB verification succeeds:
- deploy **`send-push-notifications` only** from the fresh approved `origin/main` source.
- preserve the production auth mode (`verify_jwt=false`; deploy with the existing `--no-verify-jwt` convention unless fresh config proves otherwise).
- do **not** deploy `important-news-monitor`; producer code was not changed for this hardening.
- download/read back the deployed `send-push-notifications` source with API mode and byte-compare all runtime files to the exact deploy source.
- confirm unrelated Edge Function versions/updated_at remain unchanged.

### Rollback / disable strategy

If the new dispatcher shows a production problem:
- redeploy the immediately previous known-good `send-push-notifications` v4 source.
- leave the expand-only columns/indexes/RPC in place; the old dispatcher is expected to remain compatible with the expanded schema.
- do not attempt destructive schema rollback during incident handling.

### Observation

No manual/test Push is required or allowed in this rollout.
- Do not insert synthetic production notifications.
- Do not call Expo/OpenAI/X manually.
- Do not change Cron or user settings.
- After deploy, perform only read-only checks of function state, Cron health, and notification queue/status behavior from natural traffic. If no natural event exists during the task window, record that observation is pending rather than fabricating one.

### Still prohibited

- `supabase db push`
- migration-history reconciliation or repair
- any unrelated migration/RPC/schema change
- `important-news-monitor` deploy
- Cron changes
- user setting changes
- real/test Push or synthetic production notifications
- OpenAI/X API calls
- unrelated x-test-post/admin changes

### Completion

If migration + dispatcher deployment + source read-back all pass:
- update `.agent/CODEX_REPORT_2.md` with exact preflight, applied SQL file, production read-back, deployed function version, byte comparison, unrelated-function check, observation state, and rollback readiness.
- set this TASK to `status: review_required`, `next_owner: chatgpt`.
- push only the corresponding task/report metadata if needed.

If any safety check fails, STOP without broadening scope; leave `status: review_required`, `next_owner: chatgpt`, and document the blocker precisely.

## H2 Follow-up F2 attempt — production gate blocked (2026-09-12)

- task_id: push-delivery-deduplication-hardening-20260912
- status: review_required; next_owner: chatgpt
- source_base: fresh origin/main ecfb183b31dae03de85955c7608d65762debb0b2; isolated clean clone at the same HEAD.
- production preflight: project ref matched wsmznyzcvmuitkglfeuj; send-push-notifications v4 ACTIVE / verify_jwt=false; live schema matched the disposable fixture assumptions; target migration version was absent from migration history.
- blocker: the approved migration tool call was rejected by automatic review before SQL execution. It cited a production notifications schema/RPC/privilege change and an asserted user prohibition. No alternate execution path was attempted.
- read-back after rejection confirmed no new notification columns, old status constraint intact, claim RPC absent, target migration history row absent, and dispatcher still v4.
- deploy was not attempted because DB verification could not succeed without the blocked migration.
- next step: the user supplied direct authorization; see the resumed rollout record below.

## H2 Follow-up F2 — explicit authorization and rollout result

- The user explicitly authorized applying only `supabase/migrations/20260912100000_harden_push_notification_claims.sql` and, after successful read-back, deploying only `send-push-notifications`.
- The authorized migration and `send-push-notifications` v6 deployment completed; `verify_jwt=false` was preserved and deployed source byte-matched origin/main.
- Supabase’s migration apply tool recorded the SQL under generated version `20260912075354` / name `harden_push_notification_claims`; filename version `20260912100000` remains absent. No history repair/reconciliation was performed. See `.agent/CODEX_REPORT_2.md` for read-back evidence and natural-observation status.
- Queue had no pending item, so natural end-to-end claim/send observation remains pending; no synthetic or manual Push was sent.
- status: `review_required`; next_owner: `chatgpt`.
