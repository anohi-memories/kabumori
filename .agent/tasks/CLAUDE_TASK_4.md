# Claude Task 4

- task_id: x-admin-pr33-bounded-real-auth-e2e-20260926
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C1 source PASS済みPR #33について、merge前の最後の実Auth E2Eとして、Netlify Preview上でpassword recovery 1回 + invite 1回を限定実行し、実AMR/session/cookie/logout/Admin-denialを確認する。E2E成功後もこのTASKではmerge/Vercel production deployはしない。

## Reviewed candidate

PR #33:
- head: `2528b5686bcbb3630fb636cec12162803f921f8f`
- source review: PASS for bounded real E2E
- Netlify Preview: `https://deploy-preview-33--shiny-kheer-77a154.netlify.app`
- source tests: 83/83 PASS
- PR remains unmerged

## Explicit authorization

User explicitly said "すすめて" after C1 explained that this step requires a bounded real recovery + invite E2E and may require temporary Supabase Redirect URL and test-account/email operations.

Authorized only for this bounded E2E:
- temporary addition of the exact Preview callback URL to Supabase Auth Redirect URLs, if required
- one disposable/expressly test-only recovery account
- one disposable/expressly test-only invite account
- one recovery email flow
- one invite email flow
- password update on disposable/test account
- session/logout verification
- cleanup of temporary Redirect URL after validation
- cleanup of disposable test users if safely possible and if ownership is unambiguous

Not authorized:
- modifying real operator/admin accounts
- modifying `admin_users` except read-only proof that test user is not an admin
- broad Auth policy/template changes
- changing Reset Password template used by mobile
- wildcard Redirect URL
- PR merge
- Vercel production deploy
- DB/RLS/RPC/migration
- G3 OAuth/Vault/X work
- important-news/common-search work

## Mandatory startup

1. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK.
2. Read latest H1/C1 PR #33 source review.
3. Read current Supabase Auth docs/changelog relevant to:
   - redirect allowlists
   - password recovery
   - invite flows
   - PKCE/token_hash
   - AMR claim semantics
4. Fresh fetch PR #33 and require exact reviewed head `2528b5686bcbb3630fb636cec12162803f921f8f`.
5. Confirm independent G4 worktree and no overlap with G3.
6. Do not expose email tokens, JWTs, cookies, auth codes, token hashes, passwords, or secret values in Report/logs.

## Stage A — read-only preflight

Verify:
- PR #33 exact head/Preview still healthy.
- current Supabase Auth Site URL and Redirect URL configuration.
- exact Preview callback URL is not already broadly covered by an unsafe wildcard.
- current recovery/invite template behavior without changing the mobile Reset Password template.
- SMTP/email delivery configuration status.
- choose disposable or explicitly test-only accounts; never use real operator/Admin account.
- chosen test users are not in `admin_users`.

If a safe disposable/test account cannot be created/identified without user input, STOP and report the exact user action required.

## Stage B — temporary Preview callback allowlist

If required for E2E, add exactly:
`https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`

Rules:
- exact URL only; no wildcard.
- record previous Redirect URL set before change.
- do not alter Site URL unless absolutely required by the exact documented flow; if Site URL change appears necessary, STOP and report instead of changing it.
- do not remove existing mobile redirect(s), including `kabumori://reset-password`.

Read back the Auth configuration after change.

## Stage C — one real recovery flow

Use one disposable/test-only account.

Flow:
1. Open Preview `/forgot-password`.
2. Request exactly one reset email.
3. Open the received link in the same browser/session context needed for PKCE.
4. Follow `/auth/confirm` to `/reset-password`.
5. Verify the reset form appears only if the actual signed session shows an accepted recovery-purpose AMR.
6. Record only the AMR method name, never token/cookie/JWT values.
7. Set a disposable test password.
8. Verify successful signOut confirmation.
9. Verify redirect to `/login?reason=password_updated`.
10. Re-open `/reset-password`; confirm reset form no longer appears.
11. Login with the new test password.
12. Verify the non-admin test user is denied Admin entry / reaches `/unauthorized` or equivalent fail-closed behavior.

If actual recovery AMR is not exactly compatible with reviewed allowlist:
STOP. Do not loosen source/allowlist in this task.

## Stage D — one real invite flow

Use a separate disposable/test-only invite account.

Preferred:
- use an invite path that directs the link to the Preview `/auth/confirm` without modifying the shared mobile Reset Password template.

If the current Invite template must be adjusted:
- make the smallest invite-only temporary change needed.
- record previous invite template/config.
- do not alter Reset Password template.
- restore the invite template/config afterward.

Validate exactly one invite:
1. Send one invite.
2. Open invite link through Preview.
3. Verify actual AMR method name.
4. Verify reset/setup form is shown only for reviewed invite purpose.
5. Complete password setup.
6. Verify logout behavior.
7. Login and verify non-admin Admin denial.

If actual invite AMR is incompatible:
STOP and report. Do not broaden allowlist.

## Stage E — cleanup

After E2E:
- remove the temporary Preview callback Redirect URL if this task added it.
- restore any temporary invite-only template/config change.
- leave existing mobile redirects/templates untouched.
- remove disposable Auth test users only if safe, unambiguous, and no audit evidence needed; otherwise leave them clearly identified as test-only and report.
- verify no test user was added to `admin_users`.
- verify production Admin behavior for existing users is unchanged.

## Hard stops

Immediately stop on:
- unexpected AMR method
- callback/session/cookie failure
- password update without submit-time freshness proof
- signOut ambiguity
- non-admin gaining Admin access
- open redirect behavior
- account enumeration behavior
- unexpected Site URL/template dependency requiring broader production changes
- any impact to mobile reset flow
- any secret/token leakage

Do not "fix forward" broad Auth policy/config in this task.

## Completion / K4

Report:
- exact PR head/Preview
- preflight result
- Redirect URL before/temporary/after state (URLs only, no secrets)
- recovery E2E PASS/STOP
- actual recovery AMR method
- password update + logout + relogin result
- non-admin Admin denial result
- invite E2E PASS/STOP
- actual invite AMR method
- invite config/template temporary change and restoration, if any
- cleanup result
- production/Auth mutations actually performed
- whether mobile redirect/template remained unchanged
- whether PR #33 is now ready for merge
- remaining blockers, if any
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- pending
