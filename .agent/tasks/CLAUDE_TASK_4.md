# Claude Task 4

- task_id: x-admin-pr33-bounded-real-auth-e2e-resume-20260926
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Custom SMTP設定後、PR #33のbounded real Auth E2Eを再開し、password recovery 1回 + invite 1回を完走してmerge前の最終実証を得る。

## Context

Previous task:
- x-admin-pr33-bounded-real-auth-e2e-20260926
- result: SAFE STOP / OPERATOR GATE
- reason: custom SMTP未設定で実メールが届かず、recovery/invite E2Eを完走できなかった

User has now completed and saved Custom SMTP configuration in Supabase using a temporary Gmail SMTP setup for testing.

PR #33:
- reviewed head: `2528b5686bcbb3630fb636cec12162803f921f8f`
- source review: PASS for bounded real E2E
- Netlify Preview: `https://deploy-preview-33--shiny-kheer-77a154.netlify.app`
- PR remains unmerged

## Scope

Resume only the previously blocked real E2E.

Allowed:
- verify SMTP is now active
- one recovery email flow
- one invite email flow
- disposable/test-only Auth users
- exact Preview callback URL already present
- temporary invite-only template/config adjustment if strictly necessary
- password update on test user
- AMR/session/cookie/logout/relogin/non-admin denial verification
- cleanup/restoration afterward

Not allowed:
- PR merge
- Vercel production deploy
- real operator/Admin account changes
- admin_users grants
- wildcard redirect
- changing shared mobile Reset Password template
- DB/RLS/RPC/migration
- G3 OAuth/Vault/X work
- important-news/common-search work

## Mandatory startup

1. Read current PR #33 TASK/report chain and latest C1.
2. Fresh verify PR #33 exact head still `2528b5686bcbb3630fb636cec12162803f921f8f`.
3. Verify Custom SMTP is active without exposing credentials.
4. Do not print SMTP password, Gmail app password, JWT, cookies, auth codes, token hashes, reset links, or passwords.
5. Use independent G4 worktree/browser context.

## Recovery E2E

Use a disposable/test-only non-admin account.

1. Request exactly one password recovery email from Preview.
2. Verify email delivery.
3. Open the link in the required browser/session context.
4. Verify `/auth/confirm` -> `/reset-password`.
5. Record only actual `amr.method` name; never token contents.
6. Require reviewed recovery-purpose AMR.
7. Update to a disposable password.
8. Verify signOut succeeds.
9. Verify redirect to `/login?reason=password_updated`.
10. Reopen `/reset-password`; form must no longer appear.
11. Login with the new password.
12. Verify non-admin Admin access is denied/fail-closed.

Unexpected AMR or session behavior => STOP. Do not broaden source allowlist.

## Invite E2E

Use a separate disposable/test-only non-admin account.

Preferred:
- use an invite-specific path/config that sends the invite to the Preview callback.
- do not modify shared Reset Password template.

If a temporary invite-only template/config change is strictly necessary:
- record prior state
- make only the minimum invite-specific change
- restore it immediately after the test

Then:
1. Send exactly one invite.
2. Verify email delivery.
3. Open through Preview.
4. Record actual `amr.method`.
5. Require reviewed invite-purpose AMR.
6. Complete password setup.
7. Verify logout.
8. Login.
9. Verify non-admin Admin denial.

Unexpected AMR/session behavior => STOP.

## Cleanup

- restore any invite-only temporary config/template change
- leave existing mobile redirect and Reset Password template unchanged
- Preview callback URL may remain only if it pre-existed this task
- remove disposable users only if safe/unambiguous; otherwise clearly mark/report test-only
- verify neither test user is in `admin_users`
- verify no Admin grant or cross-brand side effect

## Completion / K4

Report:
- exact PR head / Preview
- SMTP active verification result
- recovery delivery PASS/STOP
- actual recovery AMR method
- password update/logout/relogin result
- non-admin denial result
- invite delivery PASS/STOP
- actual invite AMR method
- invite config/template temporary change + restoration, if any
- cleanup
- production/Auth mutations actually performed
- mobile redirect/template unchanged
- whether PR #33 is now ready for merge
- remaining blocker, if any
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- pending
