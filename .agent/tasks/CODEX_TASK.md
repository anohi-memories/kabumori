# Codex Task

- task_id: kabumori-important-news-monitor-caller-auth-finalize-20260923
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Luna
- purpose: PR #12のcaller-auth candidateを最新mainへfreshenし、full regressionとdisposable PostgreSQLでmigration実行証明まで行い、merge可能な最終candidateへ仕上げる。本番変更はまだ行わない。

## C1 decision

Previous task `kabumori-important-news-monitor-caller-auth-remediation-candidate-20260923` is **NOT PASS for merge yet, but design direction is accepted**.

Accepted findings/design:
- production has exactly four current pg_cron callers for `important-news-monitor`
- current callers had no credential
- Function-only auth would break all four jobs
- chosen design is coherent:
  - dedicated high-entropy header
  - Function-side fail-closed validation before service-role load/body parse/mode dispatch
  - Cron header value resolved from Vault at runtime
  - `verify_jwt=false` remains because pg_cron is not using a user JWT
- PR #12 is focused and production mutation remains 0
- targeted auth/wiring/migration tests passed 7/7
- Vercel preview check succeeded

Merge blockers:
1. PR #12 branch is behind/diverged from current main and must be freshened before review.
2. Full Important News regression suite was not run.
3. The migration was not executed against disposable PostgreSQL, so exact cron command patching / transactional fail-closed behavior is not yet proven.
4. PR #11 is a stale partial control-sync draft and must not be merged.

## Mandatory startup

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK
5. Read PR #12 and its runbook
6. Fresh fetch `origin/main`
7. Confirm H2/G1/G2 do not own `important-news-monitor`, these four Cron jobs, or the auth migration
8. Do not touch PR #11 except to report that it remains unmerged/stale

## Work

### 1. Freshen PR #12

- Rebase/cherry-pick the focused PR #12 implementation onto latest `origin/main`
- Resolve only genuine conflicts
- Do not carry stale `.agent` history into the implementation PR unless required by repository convention
- Reconfirm changed implementation scope remains limited to:
  - `supabase/functions/important-news-monitor/caller_auth.ts`
  - `supabase/functions/important-news-monitor/index.ts`
  - targeted tests
  - one forward migration for the four Cron jobs
  - operator runbook

### 2. Full verification

Run:
- targeted auth tests
- full `important-news-monitor` regression suite using the repository-approved invocation
- changed-file `deno check` / equivalent
- `git diff --check`

Document any pre-existing unrelated type issue separately.

### 3. Disposable PostgreSQL proof

Execute the migration candidate against an isolated disposable PostgreSQL/Supabase-compatible environment that contains a representative `cron.job` shape for the four jobs.

Prove:
- exactly the four intended jobs are patched
- schedules remain unchanged
- request bodies remain unchanged
- URLs remain unchanged
- active flags/other cron metadata remain unchanged
- only command header expression gains the dedicated secret header
- Vault lookup is runtime-only; secret literal is never embedded
- missing Vault secret fails before any partial update
- missing/extra job or unexpected command/header shape fails transactionally
- rerun after patch fails closed rather than silently duplicating the header
- rollback strategy is understood and documented; do not create a production rollback migration unless explicitly needed

### 4. Security checks

Confirm:
- missing/malformed/wrong secret rejected before body parse and privileged credential loading
- valid secret permits normal dispatch
- secret never appears in source, logs, responses, tests, reports, or migration text
- dry-run/manual/admin modes are protected by the same gate
- no mode bypass exists before authentication

## Production restrictions

Forbidden:
- production migration apply
- Vault write
- Function secret/config change
- Function deploy
- Cron mutation
- `verify_jwt` change
- auto_publish change
- manual Function invocation
- candidate injection
- X post / Push
- any unrelated schema/config change

## PR handling

- PR #12 may be updated/replaced with a fresh final candidate branch.
- Do not merge until all checks above pass and C1 approves.
- PR #11 must remain unmerged; if it is obsolete, report that for later cleanup rather than merging it.

## Handoff

Update `.agent/CODEX_REPORT.md` with:
- fresh main SHA
- final PR/head SHA
- exact changed files
- full regression result
- disposable PostgreSQL proof result
- Vercel/check status
- compatibility/rollback notes
- production mutation = 0
- C1 recommendation

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。問題が出た場合のみGPT-6 Sol Mediumへ上げる。**

## Report

- result: `review_required`; PR #12 refreshed onto `origin/main` `118fb488064876536e595e8a5e06fbd3c4c11f7e`, final candidate head `9dffce9620b8a04706cad314a1e558ea141cb105`.
- changed scope: the original seven implementation files only; no `.agent` files are in PR #12.
- tests: targeted auth/wiring/migration `7/7`; full Important News suite `431/431`; candidate modules `deno check` and `git diff --check` pass. Handler-wide check reaches the pre-existing error in unchanged `_shared/x_oauth2_post.ts:66`.
- PostgreSQL: exact candidate migration passed against disposable PostgreSQL 16.15 with representative Cron/Vault stubs. Four intended jobs alone were patched; runtime Vault resolution, metadata preservation, missing/noncanonical secret, missing job, late command-shape drift rollback, and rerun fail-closed were verified. Temporary container removed.
- checks: Vercel passed on final head; GitHub Actions reported no workflow runs.
- PR #11 remains open/draft/unmerged and untouched.
- production_mutation: `0`; no migration apply, Vault or Function secret/config change, Function deploy, Cron mutation, invocation, candidate injection, X post, or Push.
- C1 recommendation: review PR #12 and decide merge; no production action is part of this task.
