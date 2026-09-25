# Claude Task 2

- task_id: kabumori-pr26-merge-redeploy-final-dryrun-20260925
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C2 PASS済みPR #26をfresh mainでmergeし、personalized-reportsのみ再deployして、app_enabled=falseのまま大引けdry-run 3〜5回と朝刊1回を実施し、実LLM出力で最終安定性を確認する。

## Accepted review state

PR #26:
- reviewed head: `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- H2/C2 verdict: PASS
- changed source:
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/close_validator_fix_test.ts`

Production currently:
- v25 = known-good v21 source `4590ba6`
- verify_jwt=false
- app_enabled=false
- cron unchanged

## Mandatory startup

1. Independent worktree/checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / H2 C2 report.
3. Fresh fetch origin/main and PR #26.
4. Verify PR head exactly `2b40a617e34c73c301e40a17692883ac70fd3e0a`.
5. Confirm no overlap with G1/X work.
6. Read production state before mutation.
7. If app_enabled != false, STOP.

## Step 1 — merge

If reviewed head unchanged and conflict-free:
- merge PR #26 pinned to reviewed head
- fresh fetch main
- verify merged personalized-reports source matches reviewed head
- rerun relevant tests/checks

## Step 2 — predeploy verification

Run at minimum:
- close-validator suite
- full personalized-reports suite
- deno check
- deno lint
- git diff --check

Confirm:
- only personalized-reports needs deploy
- no migration/schema
- prompt/limits unchanged
- morning 120 / close 160 unchanged

If any fail, do not deploy.

## Step 3 — deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- use same safe method as prior rollout
- verify_jwt=false
- app_enabled=false throughout
- no cron change
- no DB/schema/migration
- no Auth/RLS
- no X changes
- no other Edge Function deploy

After deploy:
- download/read back deployed source
- verify byte/content match merged main
- verify app_enabled=false
- verify cron unchanged

Keep rollback source `4590ba6` immediately available.

## Step 4 — dry-run

Required:
- close dry-run: minimum 3, preferably 5
- morning dry-run: 1

For each run record non-sensitive summary only:
- completed / failed
- LLM call count
- Fact pass/fail
- local validator issues
- inference wording class
- brief length if relevant
- latency
- approximate cost if available
- truncation
- reportId/null
- notification status

Do not include user IDs, email, tokens, or sensitive holding details.

## Success criteria

Close:
- all required runs pass local validation
- no false INFERENCE_NOT_HEDGED for legitimate unknown-cause text
- no IMPACT_TOO_LONG for valid brief
- no unsafe causal assertion passes
- Fact succeeds
- no malformed/truncated body
- no persistence
- no notification

Morning:
- completes with Fact/local checks PASS
- no regression

## Immediate rollback

Rollback to exact known-good source `4590ba6` if:
- any repeated legitimate unknown-cause false rejection persists
- unsafe causal assertion passes
- local validator regression appears
- malformed/truncated output
- unexpected persistence/notification
- app_enabled changes
- deployed source mismatch
- legacy behavior regression

After rollback:
- verify source matches `4590ba6`
- verify app_enabled=false
- verify cron unchanged

## Explicit gate rule

Do NOT set `app_enabled=true` in this task.

Even full success only authorizes considering a separate activation task after K2.

## Completion / K2

Report:
- fresh main before merge
- PR head
- merge SHA
- post-merge tests
- deployed version
- source read-back
- app_enabled before/after=false
- close dry-run results 3〜5回
- morning result
- Fact/local validator results
- latency/cost/output observations
- persistence/notification safety
- rollback status
- production mutations
- whether activation can be considered next
- remaining real-device QA

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
