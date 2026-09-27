# Claude Task 4

- task_id: x-admin-pr33-bounded-invite-e2e-after-binding-secret-20260927
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Netlify Deploy PreviewへADMIN_INVITE_BINDING_SECRETを設定後、PR #33のinvite-purpose bindingを実メール/実sessionで1回だけE2E検証する。generic OTPは許可せず、招待purpose bindingが同一user/sessionに正しく効くことを確認する。

## Current state

PR #33:
- head: `0cc48fe3ac1c376d747a74b6b31ea34990615805`
- source/tests K4: PASS
- Admin/Auth tests: 103/103 PASS
- generic otp/magiclink denied
- signed invite-purpose cookie implemented
- cookie bound to same user + same session
- TTL <= 15 minutes
- password-update success clears cookie
- missing/short secret fails closed
- PR remains unmerged

Operator actions already completed in this chat:
- Netlify env `ADMIN_INVITE_BINDING_SECRET` created as sensitive secret
- Deploy Preview context has a value
- operator retried Deploy Preview #33 from latest branch commit
- latest preview rebuild was started around 2026-09-27 19:26 JST

Important:
- Never read, print, log, expose or copy the secret value.
- Do not ask the user to paste the secret.

## Authorization

User explicitly asked to place this G4 continuation task after configuring the Preview secret.

Authorized:
- read-only verification that the new PR #33 Deploy Preview rebuild succeeded
- bounded Supabase Auth invite E2E for one disposable non-admin user
- temporary Invite User email-template adjustment only if required to point the invite to the exact PR #33 Preview callback
- send one invite
- inspect resulting session claims/AMR without exposing tokens
- verify invite-purpose cookie presence/attributes without exposing its value
- set a disposable test password
- logout/relogin
- non-admin denial verification
- restore template and delete disposable user

Not authorized:
- PR #33 merge
- Vercel production deploy
- production Admin user modification
- `admin_users` grant/mutation
- wildcard redirect
- mobile reset redirect change
- Reset Password email-template change
- service_role exposure
- DB/RLS/RPC/migration changes
- X/OAuth/Vault changes
- unrelated G3 work

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - prior G4 invite-purpose report
   - prior C1/Auth review reports relevant to PR #33
2. Use independent G4 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog index and current docs relevant to:
   - Auth invite / verifyOtp
   - sessions / getClaims
   - password update / signOut
   - email templates / redirect URLs
6. Verify PR #33 exact head is still `0cc48fe3ac1c376d747a74b6b31ea34990615805` or stop on semantic drift.
7. Do not touch G3/PR #41.

## Stage 0 — Preview preflight

Verify the newly retried Deploy Preview #33:
- build completed successfully
- exact PR #33 head is deployed
- Preview callback URL remains:
  `https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`
- no production deploy occurred
- no wildcard redirect was added
- mobile `kabumori://reset-password` redirect unchanged
- Reset Password template unchanged

Verify the secret operationally WITHOUT exposing value:
- do not log env
- do not print secret
- do not inspect raw process environment
- infer readiness from successful invite-purpose behavior only

If Preview rebuild failed, stop and report exact non-secret build reason.

## Stage 1 — disposable invite setup

Use exactly one disposable non-admin test identity/account.

Required:
- must not be an existing operator/admin account
- must not be inserted into `admin_users`
- must not receive any brand/admin privilege
- must be deletable after test

Before sending:
- capture current Invite User template text/config safely
- if current template still points somewhere unsuitable, temporarily set only the Invite User template to:
  `https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
- do not change Reset Password template
- do not change Site URL unless absolutely required; prefer template-only adjustment
- do not add wildcard redirects

Send exactly ONE invite if possible.

If the operator/API causes an accidental duplicate invite:
- do not click older links
- use only the newest valid link
- report duplicate count
- do not keep resending blindly

## Stage 2 — invite link / purpose binding verification

Open the invite link in a controlled browser/session.

Before password update, verify all of the following without exposing credentials:
- callback reaches `/auth/confirm`
- redirect reaches `/reset-password?from=email-link`
- authenticated session exists
- actual AMR contains fresh `otp`
- user `sub` present
- session_id present
- invite-purpose cookie is PRESENT
- cookie name = `__Host-kabumori-admin-invite`
- HttpOnly = true
- Secure = true
- SameSite = Lax
- Path = /
- lifetime <= 900s
- cookie value is NEVER logged/read/reported
- password form is visible

Also verify negative boundary if practical without consuming another invite:
- generic OTP without valid binding is still denied by source/test contract
- do not create a second real OTP session solely to test this

Hard stop if:
- AMR is not otp
- cookie absent
- cookie malformed by observed attributes
- form not visible
- different user/session binding suspected
- any secret/token appears in logs/output

## Stage 3 — password setup

Set one disposable test password.

Verify:
- server-side context recheck occurs immediately before update
- password update succeeds once
- invite-purpose cookie is cleared after successful update
- signOut succeeds OR safe signout-unconfirmed state is shown
- no false successful-logout message on signOut failure
- reset page revisit does not show password form
- no token_hash/auth code/JWT/password remains in URL after flow

Do not report the password.

## Stage 4 — relogin and authorization boundary

Relogin with the new disposable credentials.

Verify:
- login succeeds
- account remains non-admin
- `/`
- `/posts`
- `/important-news`
all deny Admin access / route to the established unauthorized behavior

Verify:
- no `admin_users` row was created
- no brand access was granted

Then logout and confirm session is cleared.

## Stage 5 — cleanup

Mandatory:
- restore Invite User template exactly to its prior value/config
- delete disposable Auth user
- verify no `admin_users` row exists for it
- preserve Gmail Custom SMTP configuration
- preserve existing redirect URLs
- preserve mobile reset redirect
- preserve Reset Password template
- preserve PR #33 unmerged state
- no Vercel production deploy

## Tests / source regression

Because this is an E2E continuation on unchanged source:
- rerun focused Admin/Auth tests if practical
- at minimum confirm current source head unchanged and prior 103/103 suite remains applicable
- no source edit unless a real E2E defect is found

If a defect is found:
- STOP before broadening permissions
- do not add generic otp/magiclink
- report exact observed failure
- only make a source fix under a new or explicitly continued scoped task after ChatGPT review

## Completion gate

PASS only if:
- one real invite establishes `amr=otp`
- valid signed invite-purpose binding exists for same user/session
- password form becomes available
- password update succeeds
- purpose cookie clears
- logout/relogin works
- non-admin Admin denial works
- cleanup/restoration completes
- no secret/token/password exposed
- no unintended production mutation

If all PASS:
- PR #33 becomes eligible for one final consolidated release-boundary review/merge decision.
- Do NOT merge in this task.

## Required report

Record:
- task_id
- exact PR head
- Preview rebuild result
- invite count sent
- actual AMR method
- purpose cookie PRESENT/ABSENT + attributes only, never value
- form displayed yes/no
- password update result
- cookie clear result
- signOut result
- relogin result
- non-admin denial result
- template restored yes/no
- disposable user deleted yes/no
- admin_users mutation count = 0
- source changes if any
- production/config mutations performed
- remaining blockers/risks
- whether PR #33 is ready for final release-boundary review/merge decision

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K4.

## Report

- pending
