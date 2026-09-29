# Codex Task 2

- task_id: x-social-mobile-account-deletion-final-acceptance-review-20260929
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- purpose: PR #52 Phase 4b fixed head の最終受け入れレビュー。前回C2でFAILしたR1〜R6＋client session pinningだけをfocused regressionし、source merge可否を確定する。

## Review target

- Draft PR #52
- exact fixed head: `002d24ac99df2fbdf4e2423c1428ccb488a79f29`
- previous failed head: `12146c4ab2bc635a2781b673146e1f8ad8350258`
- implementation task: `x-social-mobile-account-deletion-correction-phase4b-20260929`

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest G3 Report / previous H2 FAIL report.
2. Independent H2 worktree; never reuse G3 worktree.
3. Fresh fetch origin/main and exact PR #52 head.
4. Read current Supabase skill and current docs/changelog relevant to Auth/Vault/Edge/security-definer/session deletion.
5. Check current X revoke and Apple revoke guidance only where needed.
6. production mutation = 0.

## Focused acceptance

Re-run and verify the previous failures:

1. R1 durable deletion state:
   - reconnect after credential snapshot is rejected
   - reconnect after purge/before login finalization is rejected
   - refresh/posting/account writers cannot recreate state during deletion
   - lease/tombstone survives transaction boundaries
   - operator recovery/retry is safe

2. R2 cross-product scope:
   - Kabumori main-app data is never silently deleted
   - social_only vs social_and_login is server-decided and UI-consistent
   - finalize rechecks profile/main-app presence under lock
   - no hidden auth cascade

3. R3 Vault ownership:
   - shared/duplicate/foreign secret references fail closed before revoke/purge
   - bound credential set is stable
   - no cross-tenant Vault deletion

4. R4 X missing credentials:
   - truly never-connected may proceed
   - connected/verified account with missing required material becomes operator_required
   - no false revoked state

5. R5 Apple retry:
   - single-use authorizationCode is never replayed after successful revoke
   - durable checkpoint/resume semantics are correct
   - failure requires truthful fresh reauth where appropriate

6. R6 CORS/platform:
   - OPTIONS and required headers work
   - unsupported Apple browser deletion is truthfully blocked/labeled

7. Client session pinning:
   - confirmation bound to exact userId + sessionId
   - user/session switch before submit sends no deletion request

## Additional final checks

- guard-trigger coverage: verify every relevant current writer/table that can recreate/rotate social workspace/account/credentials is protected.
- assess trigger interaction risk with dispatcher/posting flows.
- verify finalize direct SQL deletion of auth.users is safe under expected owner/ACL and consistent with Supabase semantics.
- confirm SECURITY DEFINER schema/search_path/EXECUTE grants remain safe.
- confirm audit/logs contain no raw IDs/tokens/secrets.
- verify PR remains source-only and no production mutation occurred.

## Required tests

- reproduce all prior H2 markers
- disposable Postgres behavior/ACL/race/reconnect/rollback/cleanup
- Deno tests/check
- full social-mobile tests
- data-view
- typecheck/lint
- Expo web+iOS export
- git diff --check
- secret/token/log scan
- mutation tests where practical

## Fix policy

- Small obvious local defect directly within the reviewed fixes may be repaired on PR #52 and retested.
- New design-level issue or production capability uncertainty => FAIL/STOP and report.
- Do not broaden review.

## Production constraints

No migration apply, Edge deploy, real deletion, Vault mutation, real X/Apple revoke, Auth/provider console changes, or real X post.

`production_mutation=0`.

## Completion / C2

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed PR #52 head
- R1–R6 + session-pinning status
- guard-trigger coverage
- auth.users finalization assessment
- tests
- any source fixes
- production_mutation=0
- source merge ready yes/no
- remaining production apply/deploy/E2E gates

Then status -> review_required, next_owner -> chatgpt, STOP for C2.
