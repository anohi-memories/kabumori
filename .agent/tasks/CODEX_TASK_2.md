# Codex Task 2

- task_id: push-delivery-deduplication-hardening-20260912
- owner: codex
- slot: codex-2
- status: done
- next_owner: user
- priority: high
- recommended_model: Sol High
- purpose: Push通知経路の二重送信防止hardeningを、安全確認済みのmigration/RPCとdispatcherで本番反映する。

## Final C2 Review — 2026-09-14

- result: **PASS / completed**
- production migration: approved exact migration applied successfully; five claim/retry columns, processing status, two partial indexes, service-role-only claim RPC, SECURITY DEFINER, empty search_path all read back successfully.
- migration history caveat: Supabase recorded generated version `20260912075354` / `harden_push_notification_claims`; repo filename version `20260912100000` remains absent. No repair/reconciliation was performed. `supabase db push` remains prohibited until migration history is reconciled separately.
- dispatcher: `send-push-notifications` rollout completed with `verify_jwt=false`; deployed runtime source byte-matched the approved source. Unrelated Functions were unchanged at rollout time.
- safety proof: true concurrent-claim proof 6/6 produced one winner and one empty loser; claim-token CAS, retry bound, stale-processing fail-closed behavior, permission boundary, and legacy compatibility were verified.
- tests: combined regressions 83/83 PASS; `deno check` PASS; `git diff --check` PASS.
- natural observation: no duplicate sends, pending/processing backlog, or failed notification rows were observed in later read-only monitoring. A full positive natural important-news enqueue→claim→send path is still not yet observed because no eligible natural notification occurred during the observation windows.
- operational caveat: `CLAIM_PENDING_NOTIFICATIONS_FAILED:504` has been observed intermittently, including a third occurrence by 2026-09-14. Each observed incident recovered on later cycles with pending/processing backlog 0 and no confirmed duplicate or lost send. Treat this as a separate reliability follow-up, not a blocker to closing the deduplication-hardening task.
- production boundary: no synthetic notification, manual Push, migration-history repair, or blind `supabase db push` was used.
- conclusion: the hardening implementation and production rollout are accepted. Future work should separately address transient DB/claim 504 resilience and obtain a natural positive enqueue→send observation.

## Approved evidence / rollout record

- Exact migration `supabase/migrations/20260912100000_harden_push_notification_claims.sql` passed disposable PostgreSQL proof before rollout.
- Concurrent claim proof: 6/6 races produced exactly one winner and one empty loser; 0 duplicate claims.
- Claim-token CAS: wrong token updates 0 rows; correct token finalizes once; second finalize fails.
- Sent rows are terminal and not reclaimable.
- Retry behavior: attempts 1/2/3 with bounded 120s/600s timing; no fourth claim; terminal failure at bound.
- Stale/ambiguous processing rows become terminal `failed / PUSH_DELIVERY_OUTCOME_UNKNOWN` and are not replayed.
- Settings/source fail-closed behavior verified for global push, market-critical, personalized reports, and missing mappings.
- RPC permission checks: service role allowed; anon/authenticated denied.
- Legacy pending/sent/failed/skipped rows remained compatible.
- Existing producer dedupe constraints were not weakened.
- Combined regressions: 83/83 PASS.
- Production read-back verified all added columns/defaults, processing status constraint, both indexes, RPC body/signature, `SECURITY DEFINER`, empty `search_path`, and service-role-only execute privilege.
- `send-push-notifications` was the only Function deployed for this task; deployed source was downloaded and byte-compared successfully.
- No Cron, user settings, secrets, OAuth, unrelated schema, or other Edge Function changes were made by this task.

## Standing safety note

Production migration history remains divergent. Do not use `supabase db push` or silently repair/reconcile migration history as part of unrelated work. Apply future approved migrations one file at a time with rollback-contained proof and post-apply read-back until a dedicated reconciliation task is completed.
