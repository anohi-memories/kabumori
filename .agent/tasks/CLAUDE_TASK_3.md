# Claude Task 3

- task_id: x-autopost-phase1h-pr28-merge-postmerge-verify-20260925
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1H PR #28をfresh mainに対して安全にmergeし、post-merge回帰確認する。production deploy/activationは行わない。

## Reviewed target

PR #28:
- branch: `codex/h1-phase1h-final-review-20260925`
- reviewed head: `ce60d7a29022956d049521ffaeb533a749152a60`
- state at C1: OPEN / unmerged

Accepted H1 fix:
- dispatcher must use the RPC-committed pre-X class
- settle write failure/malformed response => blocked_manual_reconciliation
- unsupported_type only after committed terminal settle

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1H report + Final C1
6. Fresh fetch origin/main and PR #28 head
7. Confirm dedicated independent G3 worktree
8. Confirm no overlap with active G4/H1/H2/G1/G2 work
9. Verify PR #28 head still equals reviewed `ce60d7a...`
10. If semantic drift exists, STOP

## Pre-merge verification

- compare PR #28 against fresh main
- confirm only reviewed Phase1H dispatcher/adapter/test/doc scope is present
- verify no conflicting Phase1H changes landed
- verify mergeability
- rerun:
  - focused Phase1B–1H
  - x-test-post
  - _shared
  - important-news-monitor
  - greeting/tip/publish_claim-specific
  - disposable Phase1H + relevant Phase1D/E/F/G proofs if available
  - deno check/lint
  - bash -n
  - git diff --check

## Merge

If reviewed head unchanged, no unsafe drift/conflict, and checks remain acceptable, merge PR #28 through normal GitHub flow.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm reviewed files on main match PR #28 semantics
4. rerun focused/key regressions
5. confirm live legacy dispatcher still does not import/activate v2 dispatcher
6. confirm gate remains OFF/unwired
7. confirm no production deploy/apply/X call occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- db push/history repair
- Edge deploy
- Cron/OAuth/Vault/token mutation/refresh
- real X API/post/media
- v2 gate enable
- scheduler/claim switch
- old claim revoke
- apps/admin/**
- consumer mobile/**
- G1/G2 work
- G4 work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

Report:
- fresh main
- reviewed PR head
- mergeability/conflicts
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

Do not start Phase1I in this task.
