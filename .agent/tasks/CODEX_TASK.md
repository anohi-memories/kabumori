# Codex Task

- task_id: kabumori-important-news-caller-auth-merge-only-20260924
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: Luna
- purpose: C1 PASS済みのPR #12 caller-auth source candidateを、最新mainとのsemantic driftを再確認して通常手順でmergeする。production auth rolloutはこのTASKでは行わない。

## C1 decision

Previous task `kabumori-important-news-monitor-caller-auth-finalize-20260923` is **PASS for source candidate**.

Approved evidence:
- PR #12 final reviewed head: `9dffce9620b8a04706cad314a1e558ea141cb105`
- Freshened base used for final verification: `118fb488064876536e595e8a5e06fbd3c4c11f7e`
- Exact implementation scope: 7 files only:
  - `docs/runbooks/important-news-monitor-caller-auth.md`
  - `supabase/functions/important-news-monitor/caller_auth.ts`
  - `supabase/functions/important-news-monitor/caller_auth_test.ts`
  - `supabase/functions/important-news-monitor/caller_auth_wiring_test.ts`
  - `supabase/functions/important-news-monitor/caller_auth_migration_test.ts`
  - `supabase/functions/important-news-monitor/index.ts`
  - `supabase/migrations/20260923110440_important_news_monitor_caller_auth.sql`
- Targeted tests: 7/7 PASS
- Full Important News regression: 431/431 PASS
- changed-module checks and `git diff --check`: PASS
- handler-wide check reaches only the pre-existing unchanged `_shared/x_oauth2_post.ts:66` type error
- disposable PostgreSQL 16.15 proof PASS:
  - exactly four intended Cron jobs patched
  - schedule/body/URL/active/other metadata preserved
  - runtime Vault lookup confirmed
  - no secret literal stored
  - missing/noncanonical secret, missing job, unexpected command shape, and rerun all fail transactionally with no partial Cron mutation
- Vercel required status on final head: success
- production mutation during candidate work: 0
- PR #11 is stale/partial control-sync only and must never be merged.

Current main later received only H1 report/control synchronization after the verified base. Before merge, fresh-check again and verify no semantic overlap.

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK and latest `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Inspect PR #12 current head/checks/mergeability
7. Compare latest main against PR #12 reviewed base/head
8. Confirm no H2/G1/G2 ownership overlap with the 7 implementation files or the caller-auth migration

## Work

If and only if:
- PR #12 still contains exactly the reviewed implementation semantics,
- latest-main drift has no semantic overlap,
- required checks remain green,
- branch protection allows normal merge,

then merge PR #12 by the repository's normal merge strategy.

After merge:
- read back resulting main SHA
- verify the 7 implementation files on main match the reviewed candidate semantically
- confirm migration is present in source but **not applied**
- confirm production Function/Cron/Vault/config remain unchanged

PR #11:
- do not merge it
- it may be closed as obsolete only after confirming it contains no unique implementation source; otherwise leave it untouched and report.

## Forbidden production actions

Do NOT:
- apply `20260923110440_important_news_monitor_caller_auth.sql`
- create/update Vault secret
- configure `IMPORTANT_NEWS_CRON_SECRET`
- deploy `important-news-monitor`
- mutate the four Cron jobs
- change `verify_jwt`
- change `auto_publish`
- manually invoke the Function
- inject candidate / X post / Push
- modify unrelated source

Production rollout requires a separate explicit approval after merge.

## Handoff

Update `.agent/CODEX_REPORT.md` with:
- pre-merge main SHA
- PR #12 head/check status
- drift/conflict result
- merge result/resulting main SHA
- read-back result
- PR #11 disposition
- production mutation = 0
- exact next production rollout prerequisites

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
