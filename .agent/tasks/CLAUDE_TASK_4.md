# Claude Task 4

- task_id: x-admin-pr33-invite-otp-purpose-binding-fix-20260926
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: 実E2Eで確認されたSupabase invite token_hash経路の `amr.method=otp` を安全に扱えるよう、generic otpを許可せず、invite成功直後だけ短時間有効なサーバー側purpose bindingを付与してPR #33を修正する。

## Observed production behavior

Bounded real E2E on PR #33 head `2528b5686bcbb3630fb636cec12162803f921f8f` showed:

- recovery E2E: PASS
- invite via `verifyOtp({ token_hash, type: "invite" })`:
  - session established
  - actual `amr.method = otp`
  - current reset gate correctly fails closed
  - invite user cannot set password

Do NOT solve by adding generic `otp` or `magiclink` to the allowlist.

## Required design

Implement a narrow invite-purpose binding:

1. In `/auth/confirm`, only after server-side `verifyOtp(type=invite)` succeeds:
   - obtain the authenticated user/session identity
   - issue a short-lived, signed, httpOnly, secure cookie marking **invite-purpose only**
   - bind it to the authenticated user identity
   - expiry must be no longer than the existing 15-minute recovery window
   - SameSite must be appropriately restrictive for this same-site callback/reset flow
   - do not place token_hash/auth code/JWT/password in the cookie

2. In reset authorization:
   permit password setup only when either:
   - signed fresh AMR proves `recovery`, OR
   - signed fresh AMR is `otp` AND the short-lived invite-purpose cookie is valid AND bound to the same current authenticated user.

3. The cookie must be:
   - server-generated
   - integrity protected
   - not caller-controlled
   - one-purpose only
   - cleared after successful password update
   - cleared on logout/signOut-confirmed path where appropriate
   - expired/invalid/mismatched cookie => fail closed

4. Generic OTP sessions without that server-issued invite binding must remain denied.

5. Keep the existing 15-minute submit-time freshness recheck immediately before `updateUser`.

## Security constraints

- no generic otp allowlist
- no magiclink allowlist
- no user_metadata/app_metadata for this purpose
- no client-stored boolean as authority
- no token_hash/JWT/auth code/password in cookie or URL beyond existing provider callback flow
- no service_role in client
- no admin_users mutation
- admin_users remains sole Admin gate
- no open redirect
- no account enumeration regression
- mobile reset flow unchanged
- shared Reset Password template unchanged
- G3 OAuth/Vault/X files untouched
- important-news/common-search untouched

## Secret/key handling

Prefer an existing appropriate server-only signing secret if one already exists and is suitable.
If no suitable secret exists:
- do not invent or commit one
- add a required server-only env var name and fail closed when absent
- report the exact env var name needed for Preview/production
- do not set production secrets in this task unless explicitly required for Preview verification and safely available

No secret values in source/report/logs.

## Tests

Add focused tests proving:

1. recovery AMR fresh => allowed without invite cookie.
2. generic otp + no cookie => denied.
3. generic otp + forged cookie => denied.
4. generic otp + expired cookie => denied.
5. generic otp + valid invite cookie for different user => denied.
6. generic otp + valid fresh invite cookie for same user => allowed.
7. stale otp even with invite cookie => denied.
8. invite cookie set only after successful `verifyOtp(type=invite)`.
9. unsupported callback type cannot set cookie.
10. failed/invalid invite cannot set cookie.
11. successful password update clears invite-purpose cookie.
12. signOut failure semantics remain safe.
13. existing Admin/multibrand/open-redirect/enumeration tests remain PASS.

Run:
- all `apps/admin/src/lib/*.test.ts`
- targeted callback/reset tests
- tsc
- lint
- build
- git diff --check
- targeted secret scan

## Preview verification

If the implementation needs a new server-only env var:
- report exact name
- do not expose value
- if Netlify Preview can be configured safely with an existing secret source, do so only for Preview and record it
- otherwise STOP after source/tests and request the exact operator action

Do not run another real invite E2E in this task unless Preview has the required secret/config and no further operator action is needed.

## Completion / K4

Report:
- exact design implemented
- changed files
- final PR #33 head
- tests/counts
- whether generic otp remains denied
- cookie binding/expiry/user-match semantics
- env var requirement
- Preview build/deploy status
- whether another bounded real invite E2E can start immediately
- production mutation
- remaining blockers
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- pending
