# Claude Task 4

- task_id: x-admin-pr33-auth-fix-round2-20260926
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C1でFAILとなったPR #33のAuth/security問題3点だけを修正し、real E2E前のsource candidateを再安定化する。範囲を広げない。

## Review baseline

PR #33 reviewed head:
- `e6b93beccfb9209dbe640fb9ea1464f2568f3c74`
- C1 verdict: FAIL
- do not merge this head

## Mandatory fixes

### P1 — recovery authority too broad

Current issue:
- reset authority allows generic `otp` and `magiclink` AMR.
- those do not prove recovery/invite intent.

Required:
- restrict reset authorization to exact documented recovery/invite purpose evidence only.
- if actual production recovery/invite flow emits a different AMR than expected, fail closed.
- do not broaden to generic OTP/magic-link.
- add regressions proving generic otp/magiclink cannot render or submit reset.

### P2 — 15-minute freshness checked only at render

Current issue:
- page validates once, then client submit trusts a boolean.
- leaving form open past 15 minutes can still call updateUser.

Required:
- re-verify claims / purpose / freshness immediately before password update.
- stale-open-form must fail closed before updateUser.
- add a regression where form rendered valid, clock advances beyond the allowed window, submit is rejected.

### P2 — sign-out failure falsely reported as success

Current issue:
- signOut returned/thrown failure can still produce updated/success result.

Required:
- do not claim completed logout unless signOut succeeds.
- returned error and thrown failure must produce safe failure/retry state.
- do not leave the UI implying the session was definitely cleared.
- add regressions for both returned-error and thrown-error signOut paths.

## Preserve existing guarantees

Do not regress:
- no account enumeration
- no open redirect
- callback destinations fixed local routes
- no service_role/client secret
- no credential logging
- non-admin never becomes Admin
- `admin_users` remains sole Admin gate
- PR #15 multibrand/brand isolation
- implicit fragment is stripped before session handling
- mobile reset flow outside `apps/admin/**` untouched

## Tests

Run:
- all `apps/admin/src/lib/*.test.ts`
- targeted recovery/invite/session tests
- stale-open-form regression
- generic otp/magiclink regressions
- signOut returned/thrown failure regressions
- admin/brand boundary tests
- tsc
- lint
- build
- git diff --check
- targeted secret scan

## Real E2E gate

Do not perform real email E2E in this task unless separately authorized.

At completion, report the exact operator setup needed for:
- one real password recovery flow
- one real invite flow
- disposable or expressly approved account
- Preview redirect allowlist
- actual AMR values
- cookie/session establishment
- post-update logout

Source fixes must be complete first.

## Forbidden

- PR merge
- production deploy
- Supabase Auth Site/Redirect mutation
- Auth user/admin_users mutation
- DB/RLS/RPC/migration
- unrelated apps/admin refactor
- G3 OAuth refresh files
- important-news/common-search work

## Completion / K4

Report:
- exact findings fixed
- final PR head
- tests/counts
- whether generic otp/magiclink are now denied
- whether submit-time freshness is enforced
- signOut failure behavior
- Admin/brand regression
- production mutation=0
- exact real-E2E operator gate
- readiness for another focused H1 review

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- pending
