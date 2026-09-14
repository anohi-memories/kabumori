# Codex Task

- task_id: x-multibrand-phase3i-runtime-reconciliation-20260914
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: 本番x-test-post v107の現行runtimeを保持したまま、Phase 3HのAI Lab変更だけを安全に取り込み、新しいレビュー可能commitを作る。今回は本番deployしない。

## Confirmed state

Phase 3H C1: PASS.

Phase 3I DB rollout:
- `20260913123509_ai_lab_prelive_safeguards.sql` は本番適用済み
- `20260913151428_read_ai_lab_x_vault_token.sql` は本番適用済み
- Supabase migration history recorded versions:
  - `20260913230852` / `ai_lab_prelive_safeguards`
  - `20260913231013` / `read_ai_lab_x_vault_token`
- RPC / ACL / SECURITY DEFINER / empty search_path / unique index read-back: PASS
- migration history repair/reconcileは行っていない

Current production Function:
- `x-test-post` v107
- `verify_jwt=false`
- Phase 3H source commit `406b53c2a2838a5ac2a446fffb6e6feef954eb7a` はまだdeployしていない
- deploy前比較で、現行v107と`406b53c`の間にPhase 3H変更外の既存runtime差分が見つかった
- 特に `close_report_data_logic.ts`, `close_report_logic.ts`, `fixed_hashtags_logic.ts` はPhase 3Hで変更していないため、`406b53c`をそのままdeployすると既存処理を巻き戻す可能性がある

AI Lab production remains:
- `publish_mode=dry_run`
- `publish_enabled=false`
- OAuth scopes read-only: `tweet.read users.read offline.access`
- no posting_window
- X/media writes 0

## Decision

**Do not deploy commit `406b53c` as-is.**

The safe path is to reconcile Phase 3H changes onto the current production v107 runtime/source, preserve all unrelated current runtime behavior, create a new reviewable commit, and stop for C1 review before any Function deploy.

This task does NOT authorize replacing the current v107 versions of unrelated runtime files with the older `406b53c` versions.

## Start / safety

Before work:
- read `.agent/ORCHESTRATION.md`
- read `.agent/CURRENT_STATE.md`
- read this TASK and `.agent/CODEX_REPORT.md`
- fresh-check `origin/main`
- fresh-check `origin/codex/ai-lab-prelive-safeguards-20260913`
- inspect other active slots for overlap with `x-test-post`
- use isolated clean worktree/clone
- do not modify/stage unrelated existing changes

If another active slot is changing `x-test-post` or the same runtime files, STOP and report exact overlap.

## Goal

Create one new source commit that:
1. preserves the current production v107 runtime behavior for all non-Phase-3H code
2. carries forward the already C1-approved Phase 3H AI Lab safeguards
3. contains no production deployment
4. is pushed to a review branch so ChatGPT can C1-review the exact deploy candidate

## A. Establish the v107 source baseline

Determine the exact source corresponding to production `x-test-post` v107.

Preferred evidence, in order:
- downloaded deployed Function source/runtime files from Supabase API/tooling, or
- exact repository commit previously recorded as the v107 deploy source if byte identity can be proven

Do not guess the baseline from current `main` if byte identity to v107 is not proven.

Record:
- v107 runtime file list
- hashes/byte comparison where available
- the three known differing unrelated files and any additional differences
- whether the baseline maps exactly to a Git commit

Do not expose secrets or token values.

## B. Reconcile Phase 3H changes onto v107

Starting from the proven v107 source baseline, apply only the Phase 3H functional changes from:
- `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b`
- `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`

Preserve current v107 versions of unrelated runtime logic, especially:
- `close_report_data_logic.ts`
- `close_report_logic.ts`
- `fixed_hashtags_logic.ts`
- any other runtime file whose difference is unrelated to Phase 3H

Required Phase 3H behavior to preserve:
- AI Lab finite 280 Unicode-codepoint policy
- explicit future unlimited mode
- independent final dispatch length guard
- cross-brand dedupe before dispatch
- `ai_salaryman_lab_x` / `kaishain_ai_lab` fixed Vault-backed routing
- no fallback to Kabumori legacy token storage
- no refresh on AI Lab dispatch path
- fingerprint completion after confirmed X success
- duplicate-resend protection on uncertain completion
- dry_run / publish-disabled gates unchanged

The two DB migrations are already applied in production. Do not create replacement migrations and do not apply any SQL in this task.

## C. Diff discipline

Produce a three-way review summary:
- current production v107 -> reconciled candidate
- Phase 3H reviewed commit `406b53c` -> reconciled candidate
- unrelated current v107 runtime logic preserved vs `406b53c`

The candidate must not contain accidental rollback of unrelated runtime changes.

If the reconciliation requires semantic choices in unrelated logic, STOP instead of guessing.

## D. Tests

Run at minimum:
- Phase 3H brand/shared tests
- relevant `x-test-post` suite
- regression tests covering close report / fixed hashtags / any preserved runtime areas implicated by the v107 differences
- `git diff --check`
- changed-file `deno check`, or prove only pre-existing baseline-equivalent diagnostics remain

Specifically verify:
- 279/280 pass, 281 blocked
- dry_run cannot reach X dispatch
- AI Lab Vault route has no legacy fallback
- no token refresh on AI Lab route
- fingerprint completion semantics remain idempotent / duplicate-resend safe
- Kabumori existing behavior remains unchanged
- the v107 close-report/fixed-hashtag behavior is retained

## E. Commit / push / stop

Create a new review branch/commit for the reconciled deploy candidate.

Push to the private repo `anohi-memories/kabumori` for C1 review.

Report:
- exact branch
- exact commit SHA
- proven v107 baseline/source evidence
- files changed from v107
- files intentionally preserved from v107
- tests
- comparison to `406b53c`

Then set:
- status: `review_required`
- next_owner: `chatgpt`

**STOP before deploy.**

## Production boundary

Already-applied Phase 3I migrations remain in place.

Still strictly prohibited in this task:
- `x-test-post` deploy
- any other Edge Function deploy
- production DB write/migration
- `supabase db push`
- migration history repair/reconcile
- `publish_mode=live`
- `publish_enabled=true`
- OAuth reauthorization/scope change
- `tweet.write` / `media.write` addition
- token refresh/liveness test
- real/test X post or media upload
- posting_window change
- Cron change
- Kabumori OAuth/token/handle/publish mutation
- Mio change
- broad privilege cleanup for the separately observed anon/authenticated table grants
- secret/token/password/2FA output

## Separate security observation

Existing broad table grants (including TRUNCATE-like privileges for anon/authenticated despite RLS) are a separate owner-review item. Do not modify them here. Record exact affected objects only if already known from read-only evidence; do not broaden scope.

## Completion gate

This reconciliation task passes only when:
- exact v107 source baseline is proven
- Phase 3H changes are rebased/ported onto that baseline without unrelated rollback
- regression tests pass
- new candidate is pushed for review
- production Function remains v107 and unchanged
- X/media writes remain 0

After C1 review of the new candidate, a separate explicit authorization will be required to deploy `x-test-post`.

## Report

- task_id: `x-multibrand-phase3i-runtime-reconciliation-20260914`
- result: `review_required` — reconciled candidate pushed; stopped before deploy.
- changed_files: `x-test-post/index.ts`; 12 imported `_shared/brand` runtime modules and their relevant tests; two `x-test-post` test files updated for deferred X-auth ordering; the two exact, already-applied Phase 3I migration source files included unchanged for static security tests. Full paths are in `.agent/CODEX_REPORT.md`.
- production_source_base: `25998fc8927d8bd45a89478b1fec8b4bc5ba782b`, proven byte-identical to all 27 files returned by the deployed v107 Function API.
- candidate: branch `codex/x-multibrand-phase3i-runtime-reconciliation-20260914`, commit `c4eb2855f2adc66e5518feaa51eef63bbf139e4d`, pushed to origin for C1.
- tests: 448/448 relevant Deno tests passed; ten core Phase 3H files pass `deno fmt --check`; `git diff --check` pass. `deno check` has exactly the six same diagnostics as v107 baseline and no new diagnostics. Broader brand formatting check reports 10 source files unformatted in the reviewed source; no formatting-only edits made.
- deploy: none. Production re-read remained ACTIVE v107, verify_jwt=false, same 27 files and aggregate hash. No SQL, migration, DB write, Edge Function deploy/invocation, Cron/OAuth/token/settings change, X post, or media upload in this task.
- remaining_issues: C1 review and a separate explicit deploy authorization remain required. Do not reapply/replace the two migrations.
- safety_checks: preserved the v107 close-report TOPIX behavior and exact `close_report_data_logic.ts`, `close_report_logic.ts`, and `fixed_hashtags_logic.ts`; preserved the other 25 existing runtime files; AI Lab stays dry_run/publishing-disabled and its route has no legacy-token fallback or refresh.
- next_recommendation: C1-review the exact candidate branch/commit; do not deploy until separately authorized.
