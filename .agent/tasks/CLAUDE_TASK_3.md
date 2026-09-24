# Claude Task 3

- task_id: x-autopost-phase1f-pr25-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1F PR #25をfresh mainに対して安全にmergeし、post-merge回帰確認する。production activation/deployは行わない。

## Reviewed target

PR #25:
- branch: `codex/h1-phase1f-ledger-review-20260924`
- reviewed head: `b3740cc7c39010f02ad3505721a5b37d2e707dba`
- state at C1: OPEN / unmerged

Accepted H1 fixes:
1. revoke direct API-role DML on `scheduled_posts`
2. enforce provider-step first-kind/order/reply-parent integrity
3. reject late unfinished-step mutation once parent attempt is terminal

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1F report + Final C1
6. Fresh fetch origin/main and PR #25 head
7. Confirm dedicated independent G3 worktree
8. Confirm no overlap with active G4/H1/H2/G1/G2 work
9. Verify PR #25 head still equals reviewed `b3740cc7...`
10. If semantic drift exists, STOP

## Pre-merge checks

- compare PR #25 changed files against fresh main
- verify only reviewed Phase1F scope is present
- check no conflicts in Phase1F migration/tests
- verify mergeability
- rerun:
  - focused Phase1F + Phase1B/1D/1E regressions
  - x-test-post
  - _shared
  - important-news-monitor
  - disposable PostgreSQL behavior/race if available
  - deno check/lint
  - bash -n
  - git diff --check

## Merge

If reviewed head unchanged and checks remain acceptable, merge PR #25 using normal repository flow.

Do not bypass unrelated required checks; Vercel build-rate-limit is not relevant to this Supabase source-only change and must not trigger any production deployment workaround.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm reviewed Phase1F files on main match PR #25 semantics
4. rerun focused Phase1F and key regressions
5. confirm live dispatcher/producers remain unwired
6. confirm no migration apply/deploy occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- deploy
- Cron/OAuth/Vault/token production mutation
- X API/posts/media
- enabling v2 dispatcher/producers
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

Report:
- fresh main
- reviewed PR head
- mergeability/conflicts
- exact test counts
- merge commit SHA
- post-merge read-back
- production mutation=0 excluding GitHub merge
- remaining blockers
- next recommendation

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Do not start Phase1G in this task.
