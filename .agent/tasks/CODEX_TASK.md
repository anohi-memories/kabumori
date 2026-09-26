# Codex Task

- task_id: x-oauth-refresh-stage3a-final-security-review-20260926
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol（高）
- purpose: PR #38 Stage 3A Universal OAuth Refresh rollout foundationを、production apply前の最終1回レビューとして検証する。途中レビューは増やさず、この完成物をまとめて確認する。

## Scope

Review exact PR #38 head `050d62f` and the Stage 3A task/report.

Focus only on:
1. account-level rollout authority correctness
2. OFF/PILOT/ENABLED semantics and fail-closed defaults
3. exact-account isolation before any Vault read
4. SECURITY DEFINER / owner / search_path / EXECUTE ACLs
5. service_role-only mutation path
6. grandfathering safety
7. invalid_grant / reauth exact-account behavior
8. stuck refresh / lease / reconnect-vs-commit safety
9. observability contract not leaking token/secret identifiers
10. live `begin_x_account_refresh_legacy_post` replacement semantics
11. migration ordering and deployment plan given live-but-unrecorded core migration
12. no Kabumori legacy regression
13. no accidental broad rollout caused by global gate alone

## Review constraints

- read-only review by default
- do not apply production migration
- do not deploy Edge Functions
- do not change env/secrets
- do not enable any additional production X account
- do not run migration repair/db push
- do not touch G4/Admin Auth work
- do not expose token/secret values or Vault secret identifiers

## Required verification

- fresh `origin/main`
- exact PR head = `050d62f`
- inspect migration and Edge diffs
- rerun relevant source/DB tests where practical
- verify disposable DB behavior for rollout isolation and ACLs
- verify migration cannot accidentally replay the already-live core objects
- verify row absence/off mode blocks before Vault access
- verify grandfathering cannot enable an unrelated account
- verify health RPC output excludes sensitive credential identifiers
- verify migration-history plan is safe and explicitly separated from production execution

## Fix policy

If you find a small, unambiguous source-only P1/P2 issue within this scope, you may fix it directly on the PR branch and rerun tests.

Do NOT:
- broaden scope
- alter product behavior outside Stage 3A
- perform any production mutation
- normalize migration history in production

If a design-level issue is found, STOP and report it for G3.

## Completion / C1

Report to `.agent/CODEX_REPORT.md`:
- verdict: PASS / PASS-WITH-FIX / FAIL
- exact reviewed head/fixed head
- findings
- ACL/security review
- migration-history safety review
- tests
- changed_files
- commit/push if any
- production_mutation=0
- whether Stage 3A is ready for a separate production-apply TASK
- remaining risks
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.
