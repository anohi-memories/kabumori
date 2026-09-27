# Codex Task

- task_id: x-stage3b-publish-authority-focused-rereview-20260927
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol（高）
- purpose: PR #41 fixed headのfocused re-review。前回C1 FAILのP1 publish authority/timeboxとP2 AI Lab除外だけを中心に、atomicity/ACL/回帰を確認する。新規設計レビューを広げない。

## Review target

- PR #41 exact head: `6b25305e57bb1d6ad119c06c779042daba210547`
- prior failed head: `cd7adf5d1eb5a91773f21c7d8959766e1dd38229`

## Must verify

1. separate publish authority exists and is not conflated with refresh rollout.
2. no row/off/revoked/not-started/expired blocks generic Stage 3B brand_post before X create even with a still-valid access token.
3. consent revocation, brand disable, account publish disable and brand_post disable all block new X create.
4. publish authority is rechecked close enough to X create to make revocation semantics match the documented boundary.
5. rollback first step publish `revoked` alone blocks subsequent new X creates.
6. refresh generation ceiling remains refresh-only; valid-token behavior follows publish authority, not rollout accident.
7. AI Lab and Kabumori are rejected by generic setter/check/dispatcher/completion paths.
8. exact matching AI Lab running row + AI Lab account cannot be completed by generic RPC and causes no fingerprint/log write.
9. new table/function ACLs: RLS, owner, search_path, PUBLIC/anon/authenticated EXECUTE, service_role grants.
10. no cross-account completion/publish-state mutation.
11. AI Lab existing production path unchanged.
12. Kabumori legacy path unchanged.
13. Stage 3A refresh behavior unchanged.
14. migration ordering remains safe without db push/repair.

## Constraints

- read-only by default
- no production migration/deploy/rollout/publish changes
- no real X/token refresh
- no G4/Admin Auth changes
- production_mutation=0

Small unambiguous source-only P1/P2 fix may be made only if directly within these findings; otherwise STOP/report.

## Required verification

- inspect fixed diff from `cd7adf5` -> `6b25305`
- rerun focused Deno tests
- rerun disposable DB publish-authority behavior/race/ACL tests
- verify matching-AI-Lab negative regression
- verify rollback-revocation regression
- changed-file check/lint/diff/secret scan

## Completion / C1

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed head
- P1 result
- P2 result
- atomicity/rollback assessment
- ACL/security result
- regressions
- tests
- production_mutation=0
- whether PR #41 is technically ready for owner consent + separately authorized Stage 3B production pilot

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

## H1 completion — focused re-review

- verdict: PASS-WITH-FIX; reviewed `6b25305e57bb1d6ad119c06c779042daba210547`, fixed PR #41 head `59f4f53`.
- prior P1 publish authority/timebox and P2 AI Lab exclusion are resolved at source. H1 fixed an additional P2: authority is now checked after proactive/reactive token refresh, before each actual X create attempt.
- source tests: 619 passed; disposable PostgreSQL behavior/ACL/AI Lab negative/revocation and race tests passed; production mutation 0.
- report: `.agent/CODEX_REPORT.md`; C1 decision and separate owner/product/production authorization remain required.
