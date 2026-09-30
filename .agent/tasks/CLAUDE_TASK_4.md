# Claude Task 4

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- owner: claude
- slot: claude-4
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: iOSのX OAuth接続時に前回ログインしたXアカウントが再利用され、複数Xアカウント利用者が接続先を切り替えにくい問題を、本番向けに安全に修正する。

## Why this should be fixed

The issue was reproduced during E3 preparation:
- the X login sheet remembered the previously authenticated X account.
- the operator could not reliably switch to a different X account.
- a local-only temporary change that opened a clean login session allowed the intended disposable account to be selected.
- this can affect real users who own multiple X accounts and can lead them to authorize the wrong account.

Current source uses:
`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`
inside:
`apps/social-mobile/src/features/x-connect/use-x-connect.ts`

The installed app uses Expo 57 / `expo-web-browser ~57.0.3`.

Expo's current WebBrowser API supports an iOS auth-session option `preferEphemeralSession` that requests a private authentication session so normal browser cookies are not shared. Verify the installed type/API before implementation; do not add undocumented X query parameters.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout; never use G3's worktree or simulator session.
3. Fresh `origin/main`.
4. Confirm G3 is operational E3 verification only and is not editing `apps/social-mobile/src/features/x-connect/use-x-connect.ts` or related tests.
5. Inspect the installed `expo-web-browser` type/API for Expo 57 before editing.
6. Do not use or mutate the disposable E3 account, protected production accounts, Vault, DB, Auth data, or X provider settings.

## Scope

Primary allowed scope:
- `apps/social-mobile/src/features/x-connect/use-x-connect.ts`
- narrowly related social-mobile tests
- onboarding copy only if needed to explain account choice

Do not change:
- server-side X OAuth contract
- PKCE/state validation
- callback ownership binding
- Supabase Edge Functions
- DB/RLS/RPC/migrations
- Vault/token storage
- account deletion
- scheduler/posting paths
- production feature flags

## Required behavior

Goal: when a user chooses to connect or reconnect an X account on iOS, the auth session should not silently inherit a previously logged-in X identity in a way that prevents account choice.

Preferred implementation candidate:
- request an ephemeral/private auth session for the X connect flow on iOS using the supported Expo WebBrowser option.
- keep Android/Web behavior unchanged unless the installed API provides an equally documented and safe equivalent.

Requirements:
1. Preserve current PKCE, state, redirect URI and callback validation exactly.
2. Do not clear global Safari/browser cookies.
3. Do not sign the user out of unrelated web sessions.
4. Do not add undocumented X authorization parameters.
5. Do not weaken the server-side duplicate-X-account protection.
6. Cancel/dismiss/retry behavior must remain truthful.
7. Reconnect flow must use the same safe account-selection behavior.
8. No real X post or production credential mutation.

## UX

If needed, add a short truthful hint near the X connect button such as:
- the user will be asked to sign in/select the X account they want to connect.
Do not promise that every browser/platform will always show an account chooser if the platform cannot guarantee that.

## Tests

Add/adjust focused tests to prove at minimum:
- iOS X connect requests the supported private/ephemeral auth-session behavior.
- Android/Web do not receive an unsupported iOS-only behavioral change.
- redirect URI, state, PKCE challenge/verifier and callback parser remain unchanged.
- cancel/dismiss/success/error state behavior remains unchanged.
- duplicate-X-account server protection remains untouched.
- no global cookie clearing/browser data deletion is introduced.

Run:
- social-mobile tests
- typecheck
- lint
- relevant Expo export/config check if available
- diff/secret checks

No EAS build unless a native rebuild is actually required to test the API behavior. Prefer local iOS Simulator verification.

## Local visual/E2E verification

Use a local simulator/test environment only:
- confirm the X auth sheet no longer auto-reuses the prior X login in the problematic way.
- confirm the user can intentionally authenticate a different X account.
- do not use protected production posting accounts for this test.
- do not perform a real X post.

If reliable provider-side testing would require touching production credentials/accounts, STOP and report rather than doing so.

## Completion / K4

Report:
- task_id
- result
- root cause
- exact source behavior changed
- changed_files
- tests
- local simulator result
- commit_hash
- push/PR
- production mutation = 0
- remaining issues / platform caveats
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

Because this changes an OAuth/authentication boundary, ChatGPT will decide at K4 whether focused Codex review is required before merge.
