# Codex Task

- task_id: x-stage3b-second-account-pilot-final-review-20260927
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol（高）
- purpose: PR #41 Stage 3B second-account pilot preparationを、production pilot前の最終1回レビューとして検証する。途中レビューは増やさず、このcross-account publish境界・RPC・pilot契約をまとめて確認する。

## Scope

Review exact PR #41 head `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`.

Focus only on:
1. exact-account routing and no brand-first/first-row fallback
2. AI Lab path unchanged
3. Kabumori legacy path unchanged
4. candidate/account/content ownership binding
5. user-consent/admin-enable gates and fail-closed behavior
6. new `complete_vault_account_brand_post` SECURITY DEFINER correctness
7. owner/search_path/EXECUTE ACLs
8. no cross-account completion/fingerprint/state mutation
9. pilot OFF/PILOT/ENABLED behavior
10. pilot expiry/generation ceiling/unresolved-error blocking
11. invalid_grant/uncertain/lease/race isolation
12. duplicate claim/post prevention
13. migration ordering/deployment safety given existing migration-history debt
14. Stage 3B activation/rollback plan safety
15. whether owner/product gate is correctly separated from technical readiness

## Constraints

- read-only review by default
- no production migration apply
- no Edge deploy
- no rollout/publish/brand/content-setting mutation
- no token refresh
- no X post
- no migration repair/db push
- no G4/Admin Auth changes
- no secret/token/credential identifier exposure

## Required verification

- fresh origin/main
- exact PR head unchanged
- inspect all 8 changed files
- rerun focused Deno tests
- rerun disposable DB behavior/race/ACL tests
- verify RPC cannot complete another brand/account row
- verify no API-role EXECUTE leak
- verify account/content mismatch stops before generation/X
- verify AI Lab and Kabumori behavior remains unchanged
- verify production pilot plan cannot broad-enable another account
- verify migration does not depend on blind historical apply

## Fix policy

Small, unambiguous source-only P1/P2 issues may be fixed directly on PR #41 and retested.

Do NOT:
- broaden product scope
- change candidate/product consent policy
- activate production pilot
- normalize migration history

Design-level issue => STOP and report for G3.

## Completion / C1

Report to `.agent/CODEX_REPORT.md`:
- verdict PASS / PASS-WITH-FIX / FAIL
- reviewed/fixed head
- findings
- exact-account isolation review
- RPC/ACL/security review
- pilot/migration safety
- tests
- changed_files
- commit/push if any
- production_mutation=0
- whether PR #41 is technically ready for owner consent + separately authorized Stage 3B production pilot
- remaining risks
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.
