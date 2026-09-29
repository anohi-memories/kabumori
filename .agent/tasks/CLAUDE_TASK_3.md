# Claude Task 3

- task_id: x-social-mobile-account-deletion-correction-phase4b-20260929
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: H2 C2 FAILとなったDraft PR #52のaccount deletion設計を、P1/P2 findingsをまとめて修正する。局所パッチではなく、削除lease/state・cross-product consent・credential ownership・idempotent revoke/retryを一貫した設計として直す。

## Review source

- PR #52 reviewed head: `12146c4ab2bc635a2781b673146e1f8ad8350258`
- H2 verdict: FAIL
- production_mutation=0
- H2 report: latest section in `.agent/CODEX_REPORT_2.md`

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 report.
2. Continue in isolated G3 worktree; do not use H2 worktree.
3. Fresh fetch origin/main and inspect PR #52 divergence before changes.
4. Read current Supabase skill/docs first.
5. Re-check current official X revoke and Apple revoke guidance.
6. No production mutation.

## Must fix

### R1 — durable deletion state across reconnect / purge / auth-delete gap

Current transaction-local advisory locks are insufficient.

Required:
- introduce a durable per-user deletion state / lease / tombstone that survives HTTP/transaction boundaries.
- every relevant writer that could recreate/rotate social credentials or workspace/account state must fail closed while deletion is active, including at least:
  - X OAuth begin
  - X OAuth complete
  - posting credential refresh/rollout writers
  - posting/account creation paths relevant to this user
- deletion finalization must guard purge -> auth-user-delete gap.
- reconnect after credential snapshot must not create unrevoked new credentials.
- auth delete failure/retry must not allow workspace/account recreation.
- define explicit terminal/recoverable states and operator recovery.
- add end-to-end disposable DB/source tests for the exact R1 interleavings reproduced by H2.

### R2 — cross-product shared Auth deletion

Current social-mobile deletion deletes shared Supabase Auth and cascades Kabumori profile/data.

Required product decision in source:
- DO NOT silently delete Kabumori main-app data.
- choose one safe model:
  A. social-mobile-only deletion that removes social workspace/X data but retains shared Auth/main-app account, OR
  B. explicit global account deletion flow with full cross-product disclosure/consent and coordination.
- default to the least destructive design if product-wide consent is not explicitly established.
- UI copy and backend behavior must match exactly.
- no hidden cascade.
- document cross-product impact and remaining Kabumori-side coordination.

### R3 — ambiguous/shared Vault secret references

Required:
- before external revoke/purge, fail closed if any candidate secret ID is referenced by another workspace/account/OAuth/refresh record.
- bind deletion to a stable exact credential set.
- no cross-tenant secret deletion even under corrupt/legacy schema-valid state.
- add negative fixtures for shared/corrupt secret reference.

### R4 — missing X credential material false-success

Required:
- distinguish:
  - truly never-connected / no active X grant => deletion may proceed without revoke
  - connected account with missing required stored credential material => fail closed / operator recovery
- never record revoke complete if required token material is unexpectedly absent.
- preserve retry/idempotency.

### R5 — Apple single-use authorizationCode retry

Required:
- do not require replaying a consumed Apple authorizationCode after a later purge/auth failure.
- persist a safe durable checkpoint that Apple revoke completed, or explicitly require obtaining a fresh same-user authorizationCode on resume.
- retries must be truthful and recoverable.
- never ignore Apple revoke failure.
- UI state must not retain unusable code and present normal retry as valid.

### R6 — Edge CORS / platform support

Required:
- add correct OPTIONS/CORS behavior for web if web deletion is intended.
- if Apple browser deletion cannot satisfy the native authorizationCode requirement, disable/label that path truthfully.
- clearly declare supported deletion platforms/methods.
- no fake web support.

## Additional H2 issue — client context pinning

- deletion confirmation/reauth state must be pinned to exact user/session.
- if session/user changes between confirmation and submit, deletion must fail and require fresh reauth/confirmation.
- add regression test.

## Preserve passed boundaries

Do not regress:
- verified bearer token derives uid
- no uid from request body
- recent-auth gate
- anon/authenticated cannot execute privileged RPCs
- PUBLIC execute revoked
- safe search_path
- audit contains no raw ID/token/secret
- shared/admin/running/refreshing guards
- unknown FK dependent abort
- no production mutation.

## Tests required

Reproduce all H2 markers and make them pass safely:
- reconnect after credential snapshot
- reconnect after purge before auth deletion
- shared secret cross-tenant
- missing credential material
- Apple revoke then downstream failure then retry
- CORS preflight
- session-switch after confirmation

Run:
- full social-mobile tests
- Deno tests/check
- disposable Postgres behavior/ACL/race/rollback
- typecheck/lint
- Expo web+iOS export
- git diff --check
- secret/token/log scan
- mutation tests.

## Production constraints

No:
- migration apply
- Edge deploy
- real user/data deletion
- real Vault mutation
- real X revoke
- real Apple revoke
- provider/Auth console changes
- real X post

production_mutation=0.

## Completion / K3

Report:
- exact fixed PR #52 head
- resolution of R1–R6 + client-context issue
- chosen cross-product deletion model
- durable deletion state machine/lease design
- credential ownership invariant
- X/Apple retry semantics
- CORS/platform behavior
- changed_files/tests
- production_mutation=0
- whether ready for one final H2 acceptance review

Then status -> review_required, next_owner -> chatgpt, STOP for K3.
