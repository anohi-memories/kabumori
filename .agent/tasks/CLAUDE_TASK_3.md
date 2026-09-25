# Claude Task 3

- task_id: x-universal-oauth-refresh-pr37-merge-postverify-20260926
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
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

- task_id: x-universal-oauth-refresh-pr37-merge-postverify-20260926
- result: K3 ready — PR #37 merged with no semantic drift; post-merge verification all PASS; production mutation 0.
- model: Opus 5.5 (recommended Sonnet5（高）; user chose to continue on Opus 5.5)
- exact_reviewed_pr_head: `7309805953b4e4ec9763377a0a02093065da8c82` (single commit, parent `ccef709`), unchanged at merge time
- merge_sha: `777997a13c39c12ba409a0c6dc95cad18360038a` (`gh pr merge 37 --merge --match-head-commit 7309805…`; parents `5d4bcb5` + `7309805`)
- semantic_drift_check:
  - PR files = exactly `supabase/functions/x-test-post/index.ts` (+3/-1) and `supabase/functions/x-test-post/account_refresh_core_migration_test.ts` (+9); no migration/DB/Auth/Admin/important-news/common-search change.
  - `supabase/` unchanged between PR base `ccef709` and pre-merge main `5d4bcb5` (only `.agent/` moved).
  - local merge preview tree == merged tree (empty diff); both files blob-identical to `7309805` on main.
  - change: `requestXPost` takes an optional `redirect`; only the Vault-backed path passes `"manual"` (a 3xx now surfaces as a non-2xx → `X_REQUEST_FAILED:<3xx>`, never a silent POST replay); Kabumori call passes none (fetch default unchanged).
  - H1 PR #33: 10 files, all under `apps/admin/**` → no overlap.
- post_merge_tests (fresh main `777997a`):
  - x-test-post 501 passed / 0 failed (incl. new redirect regression test; vault_account_auth 15 + core static 9 = 24 focused)
  - _shared 141 / 0 (x_v2_account_refresh 12 in the pre-merge preview run)
  - disposable PostgreSQL 17: core alone `CORE_BEHAVIOR_PASS` / `CORE_RACE_PASS` / `CORE_CLEANUP_PASS`; stacked Phase1H PASS; Phase1I `BEHAVIOR` / `RACE` / `CLEANUP` PASS
  - deno check: vault_account_auth / core static test / x_v2_account_refresh 0 errors; index.ts same 6 pre-existing errors as before G3 (none new)
  - deno lint (changed/relevant files) clean; bash -n runners OK; `git diff --check` OK; targeted secret scan on the merge diff: 0 hits
- kabumori_legacy_path_check: vs pre-G3 main `ad66e4d` — `token_loader.ts`, `brand_context.ts`, `publish_guard.ts` unchanged; `saveXTokens`, `refreshXTokens`, the legacy `X_OAUTH2_*`/`loadBrandXTokens` credential block and the legacy `postToX` body (401 → `refreshXTokens` → one retry, default redirect) are text-identical.
- production_mutation: 0 (no migration apply, no Edge deploy, `X_VAULT_ACCOUNT_REFRESH` not set, no OAuth refresh, no Vault write, no X API call, no cron/settings/business data change)
- remaining_gates (from `supabase/tests/x_account_refresh_core.md` §6, none executed):
  - Stage 0: read-only read-back (schema/constraints/no triggers, Vault fn, AI Lab refs present+distinct, shared_refs=0, Edge client secret names; decide service_role direct Vault privilege separately)
  - Stage 1: apply core migration alone + deploy exact reviewed x-test-post (byte-verify), gate off; optional owner containment `publish_enabled=false` for AI Lab first
  - Stage 2: gate on, one observed AI Lab run (1 token request, commit, 201; only AI Lab's two secrets change; Kabumori store untouched); invalid_grant → reconnect path
  - Stage 3/4: synthetic future-account proof, generic enablement + monitoring/rollback
- remaining_issues: unchanged from the implementation report (reconnect vs in-flight commit deadlock is fail-closed; stuck `refreshing` needs owner SQL; unused `ai_lab_vault_token_source.ts`; service_role direct Vault privileges). Vercel check on PR #37 failed only on `build-rate-limit` (Supabase-only PR; not a blocker).
- changed_files (this report): `.agent/tasks/CLAUDE_TASK_3.md`
- push: origin/main (merge via GitHub; this report direct)
- deploy: none
- safety_checks: dedicated G3 worktree only; exact-head-pinned merge; no apps/admin/**, no PR #33 files, no shared rule files touched
- next_recommendation: ChatGPT K3; then owner decision on Stage 0 (read-only) → Stage 1 with a separately assigned rollout TASK (production apply/deploy still NO until explicitly approved).


## Final K3 — PR #37 merge/post-verify

Verdict: **PASS**.

- reviewed PR #37 head `7309805953b4e4ec9763377a0a02093065da8c82` merged without semantic drift.
- merge commit: `777997a13c39c12ba409a0c6dc95cad18360038a`.
- PR changed exactly 2 files: `x-test-post/index.ts` and `account_refresh_core_migration_test.ts`.
- x-test-post 501/501, _shared 141/141, disposable PostgreSQL core and Phase1I behavior/race/cleanup PASS.
- Kabumori legacy credential/refresh path remains unchanged.
- production mutation remains 0: no migration apply, Edge deploy, refresh gate enablement, real OAuth refresh, Vault write, X API call or Cron/settings/business-data change.
- source integration is complete and G3 is closed.
- Stage 0/1/2 rollout remains separately gated and requires a new explicitly approved production TASK.
