# Codex Task

- task_id: x-admin-pr33-final-auth-security-review-20260926
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol（高）
- purpose: K4 PASS済みPR #33（Web Admin password recovery / invite flow）を、Auth/session/open-redirect/account-enumeration/admin-boundaryの観点だけに絞って独立最終レビューする。production Auth設定・ユーザー変更・mergeは禁止。

## Target

PR #33:
- branch: `g4/admin-password-recovery-20260925`
- reviewed candidate head: `e6b93be`
- current known state: OPEN / MERGEABLE
- Netlify Deploy Preview: PASS at exact head
- source scope: main比で `apps/admin/src` の認証フロー10ファイルのみ

## Review focus

### A. recovery/invite trust boundary
Verify:
- normal password-login session cannot use reset-password.
- only sufficiently recent email-link-authenticated recovery/invite session can show/reset.
- stale/expired AMR fails closed.
- unsupported callback types fail closed.
- reused/invalid callback cannot escalate.

### B. redirect / URL safety
Verify:
- no user-controlled `next` / `redirect_to`.
- callback and post-reset destinations are fixed local routes.
- Netlify/proxy behavior cannot turn fixed local redirects into open redirects.
- fragments/query credentials are stripped/not logged/not persisted.

### C. account enumeration / credential safety
Verify:
- forgot-password response remains indistinguishable across account existence outcomes.
- password/token values never enter URL/log/client telemetry.
- no service_role/client secret exposure.
- no Auth response body leakage.

### D. Admin authorization boundary
Verify:
- password reset/invite establishes Auth identity only; it never grants Admin.
- `admin_users` remains sole Admin authorization gate.
- non-admin after password reset cannot enter Admin pages.
- PR #15 multibrand/brand-isolation remains intact.

### E. session semantics
Pay special attention to:
- actual Supabase AMR claim shapes expected for recovery/invite/otp/magiclink.
- 15-minute freshness logic and clock assumptions.
- implicit-flow fragment handling order.
- PKCE code exchange/cookie establishment.
- sign-out after password update.

If AMR assumptions are not sufficiently guaranteed from code/tests/docs, classify as a blocker or require bounded real E2E before merge.

## Required verification

Run focused only:
- all `apps/admin/src/lib/*.test.ts`
- recovery/invite tests
- admin/brand boundary tests
- adversarial redirect/session tests
- tsc
- lint
- build
- git diff --check
- targeted secret scan

Netlify Preview may be read-only tested. Do not send real reset/invite email unless explicitly authorized.

## Production safety

Read-only only.

Forbidden:
- PR merge
- Supabase Site URL/Redirect URL mutation
- Auth user/admin_users mutation
- DB/RLS/RPC/migration
- service_role exposure
- production deploy
- unrelated X OAuth/Vault changes
- important-news/common-search work

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- final reviewed/fixed PR head
- AMR/session verdict
- redirect/enumeration/admin-boundary verdict
- tests/counts
- whether real recovery E2E is required before merge
- remaining operator gates
- production mutation=0
- recommendation for merge/production config

When complete:
- status -> review_required
- next_owner -> chatgpt
- update `.agent/CODEX_REPORT.md`
- STOP for C1.
