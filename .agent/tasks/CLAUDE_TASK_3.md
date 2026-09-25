# Claude Task 3

- task_id: x-autopost-phase1g-pr27-merge-postmerge-verify-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1G PR #27をfresh mainに対して安全にmergeし、post-merge回帰確認する。production activation/deployは行わない。

## Reviewed target

PR #27:
- branch: `codex/h1-phase1g-multistep-review-20260925`
- reviewed head: `5a62af547dbc840c1f7b140d6d51d8876c1a7223`
- state at C1: OPEN / unmerged

Accepted H1 fixes:
1. reject stale/non-current-JST morning_greeting schedule date at publish-claim acquisition
2. recheck execution-day JST before each provider step
3. helper rejects duplicate confirmed thread IDs before suggesting completion

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1G report + Final C1
6. Fresh fetch origin/main and PR #27 head
7. Confirm dedicated independent G3 worktree
8. Confirm no overlap with active G4/H1/H2/G1/G2 work
9. Verify PR #27 head still equals reviewed `5a62af54...`
10. If semantic drift exists, STOP

## Pre-merge verification

- compare PR #27 changed files against fresh main
- confirm only reviewed Phase1G scope is present
- verify no conflicting Phase1G changes landed on main
- verify mergeability
- rerun:
  - focused Phase1G + Phase1B/1D/1E/1F regressions
  - x-test-post
  - _shared
  - important-news-monitor
  - greeting/tip-specific suites
  - disposable PostgreSQL behavior/race if available
  - deno check/lint
  - bash -n
  - git diff --check

## Merge

If reviewed head unchanged, no unsafe conflict/drift, and checks remain acceptable, merge PR #27 through normal GitHub flow.

Do not bypass or workaround production infrastructure checks.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm reviewed Phase1G files on main are semantically/blob identical to PR #27
4. rerun focused Phase1G and key regressions
5. confirm live v2 dispatcher/producers remain unwired
6. confirm no migration apply/deploy/X calls occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- deploy
- Cron/OAuth/Vault/token mutation
- real X API/posts/media
- enabling v2 dispatcher/producers
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

Report:
- fresh main before merge
- reviewed PR head
- mergeability/conflict result
- exact tests/counts
- merge commit SHA
- post-merge read-back
- production mutation=0 excluding GitHub merge
- remaining blockers
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not start live v2 dispatcher implementation in this task.
