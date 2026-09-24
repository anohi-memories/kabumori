# Claude Task 3

- task_id: x-autopost-phase1e-pr22-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: C1 PASS-WITH-FIX済みのPhase1E PR #22をfresh mainに対して安全に統合・mergeし、post-merge回帰確認を行う。production activation/deployは行わない。

## Reviewed target

PR #22:
- branch: `codex/h1-phase1e-security-review-20260924`
- reviewed head: `7406c1c60506323400247b6c24162a5da4097419`
- state at C1: OPEN / unmerged

Accepted review result:
- Phase1E source candidate PASS-WITH-FIX
- production activation remains NO
- H1 fixes:
  1. manual redirects for credential RPC/X requests; create 3xx => uncertain
  2. Vault-origin P0001 masking
  3. transactional CREATE/REVOKE/GRANT to close PUBLIC EXECUTE window

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK
5. Read H1 Phase1E report + Final C1
6. Fresh fetch origin/main and PR #22 head
7. Confirm dedicated independent G3 worktree/checkout
8. Confirm no overlap with active G4/H1/H2 work
9. Verify PR #22 head still equals reviewed `7406c1c...`
10. If head drifted semantically, STOP and report

## Integration checks before merge

- compare PR #22 changed files against fresh main
- confirm no conflicting changes landed in:
  - Phase1E migration
  - x_v2_claim_credentials*
  - x_v2_one_request_provider*
  - Phase1E tests/docs
- confirm PR #22 contains only the reviewed Phase1E fix scope
- verify mergeability
- do not resolve unrelated conflicts by guessing

## Required pre-merge verification

At minimum:
- focused Phase1E tests
- full x-test-post regression
- full _shared regression
- important-news-monitor regression
- disposable PostgreSQL Phase1E proof if local environment permits
- deno/static checks for changed sources
- git diff --check

If a required check cannot run, report why before merge and decide conservatively.

## Merge

If:
- PR head is unchanged from reviewed head
- no unsafe semantic drift/conflict
- required checks remain acceptable

then merge PR #22 to main using normal repository flow.

Do not squash away evidence unless repository convention requires it.

## Post-merge verification

After merge:
1. fresh fetch origin/main
2. record merge commit SHA
3. confirm each reviewed Phase1E source file on main matches the reviewed PR head semantics
4. rerun focused Phase1E tests
5. rerun key regressions
6. verify live dispatcher/legacy credential paths remain unchanged
7. verify no production apply/deploy occurred

## Forbidden

- production migration/DDL/DML/RPC apply
- `supabase db push`
- migration-history repair
- Edge Function deploy
- Cron mutation
- OAuth/Vault/token production mutation
- token refresh/rotation
- X API calls/posts/media
- enabling v2 producer/dispatcher
- apps/admin/**
- consumer mobile/**
- G1/G2 app work
- G4 Netlify work
- unrelated MIC work

## Production mutation budget

0, excluding normal GitHub merge.

## Completion / K3

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report:
  - fresh main before merge
  - PR #22 head verified
  - mergeability/conflict result
  - exact tests/counts
  - merge commit SHA
  - post-merge read-back
  - production mutation=0 excluding GitHub merge
  - remaining blockers before Phase1F / production
  - next recommendation

STOP for K3.

Do not start Phase1F in the same task.
