# Codex Task

- task_id: x-social-mobile-pr65-ephemeral-x-auth-session-review-20261001
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol（高）
- target: PR #65 exact head `e8a7785d5635096aa428899d28e629a95b7e3f31`

## Purpose

Focused pre-merge OAuth/authentication-boundary review of the iOS X posting-account connection change that requests an ephemeral/private auth session so a previously logged-in X account is not silently reused.

This is a source/security review only. Provider-side live account switching remains an operator E2E check and must not be simulated with protected production accounts.

## Verify

### 1. Expo API / platform behavior
- installed `expo-web-browser 57.0.3` actually supports `AuthSessionOpenOptions.preferEphemeralSession`
- the option is valid for `openAuthSessionAsync` and is iOS-scoped as claimed
- implementation passes `{ preferEphemeralSession: true }` only on iOS
- Android/Web behavior is not unintentionally changed
- no native rebuild/config/plugin change is required beyond the existing expo-web-browser native module already in the development build; flag uncertainty if this cannot be proven from source/package state

### 2. OAuth security invariants
- authorization URL host/protocol validation remains unchanged
- state generation/verification remains unchanged
- PKCE verifier/challenge generation remains unchanged
- callback redirect validation remains unchanged
- callback request body and ownership binding remain unchanged
- no undocumented X parameters were added
- no global cookie/browser-data clearing was introduced
- duplicate-X-account server protection is untouched
- no token/Vault/DB/Auth/server-side write path was changed

### 3. Session/account-selection semantics
- ephemeral session is an appropriate way to avoid sharing normal Safari/browser cookies for this posting-account connect flow
- wording does not overpromise that an account chooser will always appear
- reconnect path uses the same behavior
- cancellation/dismiss/retry/error handling stays truthful
- assess the caveat that the browser/provider may ignore the request, and whether the current UX copy is sufficient

### 4. Tests
Review whether the new tests prove behavior rather than only source-string shape where possible.
Run/re-run relevant:
- focused X auth-session tests
- full social-mobile test suite
- typecheck
- lint
- any safe static/export checks useful for this boundary

If a test is brittle or gives false confidence, fix only narrowly within PR scope and report the new exact head.

### 5. Scope / safety
Confirm:
- PR changes only intended client files/tests
- no overlap with G3 E3 destructive verification
- no production mutation
- no real X login/post/revoke
- no DB/RLS/RPC/migration/Edge/Vault/Auth-provider mutation
- no secret leakage

## Provider-side E2E boundary

Do NOT attempt to type X credentials, use protected production X accounts, revoke any authorization, or post to X.

The operator must separately verify on a safe disposable account/device that the iOS auth sheet no longer silently reuses the previous X session and that a different X account can be authenticated.

Codex should state whether source is safe to merge **conditional on that provider-side E2E**.

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- exact reviewed head
- findings and any fixes
- OAuth/security invariant result
- platform behavior result
- test evidence
- remaining provider-side caveat
- production mutation = 0
- whether PR #65 is source-safe to merge after operator E2E passes
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (tests only)**; no client runtime/security defect found.
- original reviewed head: `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- final reviewed/pushed PR #65 head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`.
- H1 replaced weak source-string assertions with executed hook/SDK-bridge tests; client behavior is byte-unchanged from the original PR head.
- focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- source is safe to merge **after C1 and safe operator provider-side E2E pass**. Account switching on an actual device/browser remains unverified; keep merge hold.
- production_mutation=0; see `.agent/CODEX_REPORT.md` for evidence and caveats.
