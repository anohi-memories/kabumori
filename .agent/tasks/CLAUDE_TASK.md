# Claude Task 2

- task_id: kabumori-pr29-merge-redeploy-final-dryrun-20260925
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C2 PASS-WITH-FIX済みPR #29をfresh mainでmergeし、personalized-reportsのみcontrolled redeployして、app_enabled=falseのまま大引け/朝刊dry-runで実出力を最終確認する。

## Accepted review state

Already on main / production:
- validator commit: `510acf5954b37410b50c23ff92c3f54af6458a72`
- H2 verdict for this validator change: PASS
- production before this task: personalized-reports v27
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- cron unchanged

PR #29:
- final reviewed head: `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`
- H2 verdict: PASS-WITH-FIX
- H2 fix: morning wording rule now explicitly covers user-visible `watch_notes[*].note_ja`
- tests at H2:
  - focused hardening + close-validator 32/32
  - personalized-reports 96/96
  - deno check/lint/diff PASS
- PR remains open/unmerged at task creation.

## Mandatory startup

1. Use an independent worktree / checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 report.
3. Fresh fetch origin/main and PR #29.
4. Verify PR #29 head is exactly `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`.
5. Confirm no active workstream edits personalized-reports or deploys the same function.
6. Read production before mutation.
7. If app_enabled != false, STOP.
8. If production source/version changed after this assignment, STOP and report before overwriting.

## Step 1 — merge

If reviewed head is unchanged and conflict-free:
- merge PR #29
- fresh fetch main
- verify merged source contains H2-reviewed content exactly
- record merge SHA

## Step 2 — post-merge verification

Run:
- report_hardening tests
- close_validator tests
- full personalized-reports suite
- MIC/report integration tests
- deno check
- deno lint
- git diff --check

Confirm:
- validator boundary unchanged
- Fact checker not loosened
- morning/close brief limits still 120/160
- MIC context integration remains intact

## Step 3 — controlled deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- verify_jwt=false
- app_enabled=false throughout
- x_enabled=false unchanged
- no cron change
- no DB/schema/migration
- no Auth/RLS
- no X changes
- no other Edge Function deploy

After deploy:
- read back deployed source/version
- verify deployed source matches merged main for personalized-reports
- verify app_enabled=false
- verify x_enabled=false
- verify cron unchanged

## Step 4 — dry-run

Required:
- close: **minimum 5 runs**
- morning: **minimum 2 runs**

For each run record non-sensitive summary:
- completed / failed
- LLM call count
- Fact pass/fail
- local validator issues
- inference wording class
- morning wording class
- brief length if relevant
- latency
- approximate cost if available
- truncation/malformed output
- MIC context present/absent if observable
- reportId/null
- notification status

Do not include user IDs, email, tokens, or holding details.

## Acceptance

Close:
- at least 5/5 required runs complete
- no false INFERENCE_NOT_HEDGED for legitimate unknown-cause wording
- no factual lead clause regression in inference_ja
- no unsafe causal assertion passes
- no IMPACT_TOO_LONG for valid output
- Fact/local checks pass
- no malformed/truncated output

Morning:
- at least 2/2 required runs complete
- no repeat of advisory-sounding false positive caused by 見守る/注意が必要/影響しやすい wording
- Fact/local checks pass
- no malformed/truncated output

Safety:
- no persistence
- no notification
- app_enabled=false
- x_enabled=false

## Failure / rollback

If a source regression, unsafe causal pass, repeated legitimate false reject, malformed output, unexpected persistence/notification, or deployed-source mismatch occurs:
- stop further rollout
- preserve evidence
- rollback only if required to restore known-safe production behavior
- never turn app_enabled on

If only one LLM stochastic failure occurs:
- classify cause before rollback; repeat within the allowed dry-run count if safe.
- do not hide repeated failures.

## Explicit gate

**Do NOT set app_enabled=true in this task.**

Even a full PASS only authorizes the next activation decision.

## Voice-policy follow-up

The completed audit `kabumori-voice-gate-product-policy-audit-20260925` was K2-accepted.
After this PR #29 stabilization task is accepted, next G2 should implement:
- delivery policy Phase 1
- shadow PASS/WARN/BLOCK classification + telemetry only
- no behavior change initially
Recommended implementation model for that follow-up: Opus5.5（高）
Recommended review: Codex Sol（高）

## Completion / K2

Report:
- fresh main before merge
- PR final head
- merge SHA
- tests
- deployed version
- deployed source read-back
- app_enabled/x_enabled before/after
- close 5-run results
- morning 2-run results
- Fact/local safety
- persistence/notification safety
- rollback status
- production mutations
- whether activation can be considered
- whether Voice-policy Phase 1 can start

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
