# Claude Task 3

- task_id: x-social-mobile-multi-provider-auth-phase2-20260928
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: social-mobile Phase 1 accepted sourceを正しくmainへ統合したうえで、一般ユーザー向けのmulti-provider signup/login Phase 2をsource-firstで実装する。対象は X / Apple / Google / Email。認証用OAuthと自動投稿用X OAuthを混同せず、安全なprovider linkingと重複アカウント防止を設計・実装する。

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - Final C1 for social-mobile Phase 1
   - PR #42 / #44 exact reviewed heads
2. Use independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read the current Supabase skill before any Auth/Supabase work.
5. Fetch the current Supabase changelog index and current docs for:
   - Email/password signup
   - Apple social login
   - Google social login
   - X/Twitter social login
   - mobile OAuth/deep linking
   - identity linking / unlinking / automatic identity linking behavior
   - password recovery
6. Do not rely on remembered Supabase behavior when current docs differ.

## Phase 0 — integrate accepted Phase 1 first

Accepted heads:
- PR #42: `c5e0157f867450047a5f79a204df45aaeefecfa6`
- PR #44: `966d4123c13c4dcda1799772d262dde5be8cacb8`

Required order:
1. verify both PRs are still OPEN/MERGEABLE and exact heads are unchanged.
2. verify required checks are green.
3. merge PR #42 first.
4. fresh fetch main and verify #42 contents present.
5. re-check PR #44 against new main.
6. merge PR #44 second only if still clean and exact reviewed head.
7. fresh fetch main and run social-mobile regression:
   - npm test
   - typecheck
   - lint
   - Expo web export
   - git diff/status sanity
8. If either PR head changed or integration produces an unexpected semantic delta, STOP and report. Do not silently re-review.

Only after Phase 0 PASS may Phase 2 implementation begin from fresh accepted main.

## Product contract

The login/sign-up screen should support, where technically and product-wise safe:

1. **Xで続ける**
2. **Appleで続ける**
3. **Googleで続ける**
4. **メールアドレスで続ける**

This app assumes users operate X, so X may be the primary visual CTA.

However:

### Authentication X != posting X

- Supabase/social-login X authentication proves how the user signs into the app.
- X auto-post access must continue to use the existing `x-oauth-connect-user` + Vault/refresh/account-authority path.
- Never treat a Supabase provider access token as the posting credential.
- Never move posting refresh tokens into the mobile client.
- After X sign-in, UX may offer:
  「このXアカウントを自動投稿にも使いますか？」
  but accepting must enter the existing posting-account connection flow as a separate consent/trust step.

## Phase A — inventory exact current Auth contracts

Inspect and document:
- current `AuthProvider`
- signInWithPassword
- session restore/logout
- existing deep-link callback routes
- existing X posting connect flow
- app scheme / Expo linking config
- current user/workspace/brand creation assumptions
- any existing identity linking support
- any Supabase Auth provider configuration dependencies

Classify each as usable / partial / missing / config-gated.

## Phase B — multi-provider auth architecture

Implement source-side support for:

### Email
- sign up
- sign in
- email verification state if required by current Supabase contract
- password recovery request
- recovery callback/deep link
- new password completion

### Apple
- sign in / sign up using current recommended Supabase mobile flow
- iOS-first correctness
- cancel/error handling
- account/provider state refresh

### Google
- sign in / sign up using current recommended Supabase mobile flow
- cancel/error handling
- deep-link/session completion

### X
- sign in / sign up using Supabase Auth/social login if current Supabase docs support the target mobile flow
- no reuse of login provider token as posting credential
- after app auth completes, offer a separate posting-account connect step if appropriate

If one provider cannot be safely completed without external console/provider configuration, implement the client/source contract and expose a truthful config-gated state; do not fake success.

## Phase C — identity linking / duplicate account prevention

This is mandatory.

Handle at least:
- same email signs up with email then later Google
- same user later adds Apple
- same user later signs in with X
- provider returns no trusted matching email
- accidental creation of a second Supabase user
- existing logged-in user intentionally links a provider

Rules:
- do not auto-merge identities based only on display name/handle.
- do not authorize based on user_metadata.
- use current Supabase identity-linking semantics and docs.
- if safe automatic linking cannot be guaranteed, fail closed and require explicit authenticated linking.
- document account-recovery path for duplicate/ambiguous identity cases.

## Phase D — first workspace / onboarding continuation

After successful first account creation:
- create or obtain exactly one initial workspace/brand using the existing product model.
- do not invent a parallel tenant model.
- then continue into existing Phase 1 onboarding:
  auth -> workspace -> X posting connection -> verified handle -> minimum settings -> Home.
- if current backend lacks a safe creation path, implement the UI/domain contract and leave a clear backend gate rather than client-side privileged writes.

## UX requirements

- clear Japanese copy
- loading/cancel/error states per provider
- no raw provider/Supabase error leakage
- user can distinguish:
  - アプリへのログイン
  - 自動投稿するXアカウントの接続
- existing users must retain email/password login
- no hidden account creation on ambiguous linking paths
- no provider-specific dead-end screens

## Security constraints

- no service_role/secret keys in mobile
- no provider access/refresh token logging
- no X posting token in client
- no first-row fallback for user/workspace/account
- exact authenticated-user binding
- preserve RLS/tenant isolation
- do not use `user_metadata` for authorization
- no production Auth provider enablement/config mutation in this task
- no production DB migration in this task unless separately authorized
- no Stage 3B activation
- no real X post

## Tests

At minimum:
- email sign-up/sign-in state machine
- recovery state/deep-link parsing
- Apple success/cancel/error contract
- Google success/cancel/error contract
- X auth success/cancel/error contract
- X-login != posting-X credential regression
- identity-linking / duplicate-account cases
- ambiguous provider identity fails closed
- first-workspace/onboarding continuation
- existing password login regression
- logout/session restore regression
- no service_role/token/secret exposure
- typecheck
- lint
- Expo export/build smoke
- git diff --check

## Deliverable

Report:
- Phase 0 merge result with exact merge commits
- current provider support matrix
- implemented source changes
- config/provider-console blockers
- identity-linking policy
- first-workspace/onboarding contract
- changed_files
- tests
- security checks
- production_mutation
- remaining gaps
- recommendation for live/provider-console activation order

## Review policy

Because this touches Auth/provider identity:
- K3 should not auto-merge Phase 2 implementation into production.
- ChatGPT decides whether one focused H1 review is needed after K3.
- avoid multiple small review loops.

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- pending
