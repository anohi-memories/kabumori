# Claude Task 2

- task_id: kabumori-pr23-merge-redeploy-close-dryrun-20260924
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: H2/C2 PASS-WITH-FIX済みPR #23をfresh mainでmergeし、personalized-reportsをapp_enabled=falseのまま再deployして、大引けdry-runを複数回行い実LLM出力で修正効果を確認する。

## Accepted review state

PR #23:
- reviewed head: `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`
- H2 verdict: PASS-WITH-FIX
- production current function: v23 = known-good v21 source
- rollback source commit: `4590ba6`
- app_enabled=false

H2 fix:
- 同一文内の因果断定 + hedge tokenによるvalidator bypassを拒否
- unknown-cause許可は狭く維持
- morning brief 120 / close brief 160
- close-validator 14/14 PASS
- personalized-reports 58/58 PASS
- deno check/lint/diff PASS

## Mandatory startup

1. Independent worktree/checkout.
2. Read PROJECT_RULES.md / ORCHESTRATION.md / CURRENT_STATE.md / this TASK / H2 C2 report.
3. Fresh fetch origin/main and PR #23.
4. Verify PR head exactly `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`.
5. Confirm no overlap with G1 PR #24/legal files.
6. Read production state before mutation:
   - current personalized-reports version/source
   - verify_jwt
   - app_enabled
   - cron state
7. If app_enabled is not false, STOP.

## Step 1 — merge PR #23

If reviewed head unchanged and conflict-free:
- merge PR #23 pinned to reviewed head
- fresh fetch main
- verify merged source byte/content corresponds to reviewed head
- rerun relevant tests/checks before deploy

## Step 2 — predeploy checks

At minimum:
- close-validator tests
- personalized-reports suite
- deno check
- deno lint
- git diff --check
- confirm only personalized-reports function needs deploy
- no migration/schema required

If any fail, do not deploy.

## Step 3 — production redeploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- `app_enabled=false` throughout
- no cron change
- no DB/schema/migration
- no Auth/RLS
- no X changes
- no other Edge Function deploy

After deploy:
- read back deployed version
- confirm source matches merged main
- confirm verify_jwt=false
- confirm app_enabled=false

Keep known-good rollback source `4590ba6` immediately available.

## Step 4 — dry-run validation

Use the same safe dry-run mechanism as prior task.

Required:
- close dry-run at least 3 times
- morning dry-run at least 1 time if safely feasible

For every run record only non-sensitive summary:
- completed/failed
- draft call count
- Fact pass/fail
- local validator issues
- brief lengths if relevant
- unknown-cause/hedge behavior
- latency range
- approximate cost if available
- truncation
- notification status
- reportId/null status

Do not include user IDs, email, secret/token, or sensitive holding details in Report.

## Success criteria

Close path:
- at least 3/3 dry-runs complete through local validation
- Fact check succeeds or any failure is clearly content-semantic and investigated before proceeding
- no IMPACT_TOO_LONG for valid 104–160-char brief entries
- no false INFERENCE_NOT_HEDGED on legitimate unknown-cause wording
- no unsafe causal assertion passes local validator
- no malformed/truncated body
- no persistence
- no notification

Morning path:
- existing known-good behavior remains intact

## Immediate rollback conditions

Rollback to exact known-good source `4590ba6` if:
- repeated close local-validation failures persist
- validator allows an unsafe causal assertion
- malformed output reaches Fact stage unexpectedly
- unexpected report persistence or notification occurs
- app_enabled changes unexpectedly
- function regression affects legacy path
- deployment source/read-back mismatch

After rollback, verify byte/source match and app_enabled=false.

## Explicit gate rule

Do NOT set `app_enabled=true` in this TASK even if all dry-runs pass.

Successful completion only means:
- merged source accepted
- deployed safely
- dry-run behavior validated

Gate activation is a separate ChatGPT decision/task.

## Completion / K2

Report:
- fresh main before merge
- reviewed PR head
- merge SHA
- post-merge test counts
- deployed version
- deploy source read-back
- app_enabled before/after=false
- close dry-run results (>=3)
- morning result if run
- Fact/local validator results
- latency/cost/output observations
- push/persistence safety
- rollback status
- production mutations
- whether activation can be considered next
- remaining real-device QA

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
