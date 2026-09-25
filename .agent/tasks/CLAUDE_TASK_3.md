# Claude Task 3

- task_id: x-universal-oauth-refresh-pr37-merge-postverify-20260926
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Sonnet5（高）
- purpose: C1 accepted H1 PASS-WITH-FIX for universal OAuth refresh source. Merge reviewed PR #37 into fresh main with no semantic drift, rerun focused post-merge verification, and stop before any production migration/deploy/token refresh. This is source integration only.

## Reviewed source

- original G3 implementation: `acbac42`
- H1 fixed/reviewed head: `7309805953b4e4ec9763377a0a02093065da8c82`
- PR #37: `codex/h1-universal-refresh-review-20260926`
- H1 verdict: PASS-WITH-FIX
- fix: Vault-backed X create requests now use `redirect: manual` so 307/308 cannot silently replay a POST.
- production activation remains NO.

## Mandatory startup

1. Read PROJECT_RULES.md / .agent/ORCHESTRATION.md / .agent/CURRENT_STATE.md.
2. Fresh fetch origin/main and PR #37.
3. Confirm exact PR head remains `7309805953b4e4ec9763377a0a02093065da8c82`.
4. Confirm no semantic drift after H1 review.
5. Use dedicated G3 worktree/checkout.
6. Confirm H1 is working only on PR #33 under `apps/admin/**`; no overlap.
7. If PR head drift, conflict, or unexpected file changes exist: STOP, do not merge.

## Scope A — merge PR #37

- Verify PR #37 changes are limited to:
  - `supabase/functions/x-test-post/index.ts`
  - `supabase/functions/x-test-post/account_refresh_core_migration_test.ts`
- Confirm no migration/DB/Auth/Admin/important-news/common-search drift.
- Merge PR #37 to main only if exact reviewed candidate remains intact.
- Record exact merge SHA.

## Scope B — post-merge verification

On fresh main after merge run focused verification:
- redirect regression
- vault_account_auth
- x_v2_account_refresh
- focused x-test-post
- _shared relevant suite
- disposable PostgreSQL core behavior/race/cleanup
- stacked Phase1I behavior/race/cleanup as needed
- targeted deno check/lint
- bash -n relevant runners
- git diff --check
- targeted secret scan

Verify Kabumori legacy token path remains unchanged.

## Explicitly forbidden

- production migration apply
- Edge deploy
- X_VAULT_ACCOUNT_REFRESH enablement
- real OAuth refresh/token rotation
- Vault writes
- X API/media/post
- Cron/settings/business-data mutation
- Stage 1/2 rollout
- apps/admin/**
- H1 PR #33 files
- important-news/common-search work
- unrelated cleanup

## Completion / K3

Report:
- exact reviewed PR head
- merge SHA
- post-merge tests/counts
- semantic drift check
- Kabumori legacy-path check
- production mutation=0
- remaining Stage 0/1/2 gates
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

## Report

- pending
