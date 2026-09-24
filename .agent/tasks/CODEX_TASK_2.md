# Codex Task 2

- task_id: x-autopost-phase0c2-production-deploy-retry-20260924
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase0c C2 reviewで、最初のx-test-post production deployがSupabase Functions API HTTP 500で失敗し、migration未適用・production mutation 0のまま停止した。Phase0b compatible clientを同じ安全順序で再試行し、成功時のみruntime確認→fresh preflight→exact migration applyへ進む。

## C2 outcome carried forward

- Phase0c result: STOPPED before migration.
- One authorized deploy attempt returned Supabase Functions API HTTP 500 internal error.
- Independent C2 read-back confirmed:
  - x-test-post remains ACTIVE v118
  - verify_jwt=false
  - runtime bundle SHA remains f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4
  - the three legacy global UNIQUE constraints still exist
  - Phase0c migration was not applied
- No successful production deploy, DB write, Cron/OAuth/Vault/settings mutation, or intentional X publish occurred.

## Mandatory fresh start

1. fetch fresh origin/main
2. read ORCHESTRATION / CURRENT_STATE / this TASK / latest REPORT2
3. inspect all active slots for overlap
4. verify Phase0b source commit 76dfe74 or byte-equivalent source is still present
5. read-only production metadata for x-test-post + three constraints/indexes + four planners + Cron
6. determine whether the previous HTTP 500 appears transient/platform-side or indicates a reproducible packaging problem

If another slot touches x-test-post, these three tables, four planner RPCs, the migration, Cron, or production settings, STOP.

## Gate A — diagnostic/preflight only

Before any production retry:
- reproduce local bundle/build/package preparation without deployment if possible
- inspect Supabase CLI/API error context without exposing secrets
- confirm no source/package/config regression
- confirm production remains on old compatible-with-legacy runtime
- confirm migration remains unapplied
- confirm all three legacy global constraints remain
- confirm brand-scoped indexes remain valid and scoped duplicates remain zero
- confirm four planner RPCs still use old target
- confirm Cron unchanged

## Gate B — explicit user consent immediately before retry

STOP and ask the user directly before the next production deploy attempt.

The request must say:
- retry only the compatible x-test-post deploy first
- if deploy succeeds, verify runtime/hash/source and perform a non-publish safe smoke
- then fresh-check schema/planners
- only then apply the exact reviewed migration
- no Cron/OAuth/Vault/publish_enabled/Netlify/Vercel changes
- no intentional X publish
- stop immediately on any mismatch/error

Prior generic OK does not count unless it directly answers this exact retry confirmation.

## Gate C — retry policy

- one retry attempt only under this task unless separately approved
- deploy only x-test-post
- preserve verify_jwt=false
- no secret/config change
- no unrelated Function deploy
- if HTTP 500 repeats, STOP and report; do not switch deployment method or retry again automatically
- if deploy succeeds, runtime files/hash must match approved origin source before migration

## Gate D/E/F — same safe rollout order

After successful deploy:
1. safe non-publish smoke
2. fresh schema/data/planner preflight
3. apply only supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql with exact reviewed bytes
4. no db push/history repair/old migration replay
5. postflight read-back:
   - legacy global constraints absent
   - brand-scoped unique indexes valid
   - no scoped duplicates
   - four planners use brand-scoped conflict target
   - planner security/search_path/ACL unchanged
   - x-test-post runtime unchanged from successful deploy
   - Cron unchanged
   - unrelated Functions unchanged
   - publish_enabled/OAuth/Vault untouched
   - intentional X publish/media/repost = 0

## Forbidden

- automatic second retry
- alternative deploy path after repeat failure without new approval
- unrelated Function deploy
- Cron/OAuth/Vault/token/publish_enabled mutation
- X publish/media/repost
- migration history repair
- db push
- Netlify/Vercel change
- queue/token/account-routing refactor

## Completion

When complete or stopped:
- status -> review_required
- next_owner -> chatgpt
- update CODEX_REPORT_2 with diagnostic result, consent, retry count, deploy metadata, runtime verification, migration status, postflight, mutation counts, remaining risk, commit/push/fresh-origin verification
- STOP for C2
