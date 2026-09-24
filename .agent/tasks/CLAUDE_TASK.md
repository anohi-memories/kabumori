# Claude Task 2

- task_id: kabumori-pr19-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: K2実装PASS + H2/C2 PASS-WITH-FIX済みのPR #19を、fresh mainへ安全に追従させ、必要な競合解消後にmergeし、post-merge検証する。

## Accepted review state

- PR #19 reviewed head: `7dcf41c5714d620c41b3077376b9f5febbd129b2`
- H2 fix: missing market value時にchange表示を出さない
- H2 focused tests: 49/49 PASS
- privacy/user-boundary: PASS
- production mutation: 0

## Product-scope decision from C2

- Existing scheduled cohort remains users with active `tracked_stocks` rows.
- "No holdings" means a watch-only eligible user can still receive the market-wide report.
- A user with zero active holdings and zero watch rows is **not** added to the cohort in this PR.
- Do not enumerate all profiles/users or infer eligibility from alert settings.
- Future zero-tracked-user delivery is a separate product/cost/consent decision.

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK, H2/C2 report.
3. Fresh fetch origin/main and PR #19.
4. Verify current PR head remains `7dcf41c5714d620c41b3077376b9f5febbd129b2`.
5. Determine why GitHub currently reports PR #19 non-mergeable.
6. Rebase/merge fresh main into the PR branch only if semantic resolution is straightforward.
7. If conflict touches report/privacy/release semantics and cannot be mechanically resolved, STOP and report exact conflict; do not guess.

## Required source clarification

Before merge, ensure comments/tests/docs do not falsely claim that zero-tracked users are scheduled.
- It is acceptable for report-building logic to support an empty holdings list.
- Scheduled population remains unchanged.
- If existing tests or PR text imply broader delivery, minimally clarify them within PR #19 scope.

## Merge

If conflict-free after fresh-main integration and checks pass:
- merge PR #19
- do not deploy Edge Function
- do not flip `app_enabled`
- do not change cron or production settings

## Post-merge verification

Run:
- relevant personalized-reports / market-analysis / app report tests
- deno check/lint on changed function files
- src TypeScript/static check as feasible
- Expo export smoke if feasible
- git diff --check
- verify X/shared-fact paths remain unchanged
- verify merged main contains H2 fix

## Forbidden

- Edge Function production deploy
- `app_enabled=true`
- production DML/DDL/migration
- Auth/RLS changes
- X queue/planner/posting edits
- G1 release-Web/branding files unless only resolving a nonsemantic merge conflict
- X/admin/MIC work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  - fresh main before integration
  - original reviewed head
  - conflict/rebase result
  - any minimal cohort-wording clarification
  - merge SHA / post-merge main SHA if merged
  - exact tests/checks
  - confirmation no deploy/gate flip
  - production mutation=0
  - remaining rollout steps
- STOP for K2.
