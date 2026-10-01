# Claude Task 3

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-e3-delete-revoke-residue-20261001
- purpose: E3で機能動作がPASSしたX自動投稿アプリのアカウント削除について、残っているnative iOS UIブロッカーを解消し、共通アカウント設計に踏み込まずに現行削除UIをリリース可能な見た目・導線まで仕上げる。

## Context

Previous G3 E3 reached Final K3 PASS:
- disposable X authorization revoke succeeded
- social-mobile workspace/membership/social account/X credential/OAuth transient data were removed
- unexpected residue = 0
- protected production posting accounts unchanged
- shared Supabase Auth/login/main-app profile intentionally remained under current `social_only` behavior
- real X posts = 0

Remaining UI findings from the native iOS Release verification:
1. On `login-methods`, the buttons for 「投稿用のX接続を確認する」 and 「アカウントの削除について」 can render as blank/invisible text while their tap area still works.
2. Account deletion is too deep to discover; Settings has no direct account-management/deletion entry.

A separate common-account/auth design effort is now defining the future company-wide account/service-entitlement model. This G3 task MUST NOT preempt or redesign that model.

## Mandatory startup

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, and this TASK.
2. Fresh-check `origin/main`.
3. Use an independent G3 worktree/checkout. Do not use G4/H1/H2 worktrees or simulator processes.
4. Confirm G4 PR #65 owns X account-switch auth-session work and currently touches X-connect/account-selection paths. Do not edit G4-owned files.
5. Confirm H2 PR #66 review and H1 PR #67 review do not overlap the files you intend to change.
6. Preserve all previous G3 E3 reports below; do not rewrite historical results.

## Allowed primary scope

Prefer the smallest set necessary:
- `apps/social-mobile/src/app/login-methods.tsx`
- `apps/social-mobile/src/app/(tabs)/settings.tsx`
- `apps/social-mobile/src/app/account-deletion.tsx` only if needed for UI consistency
- narrowly related social-mobile UI tests
- shared UI component only if the root cause is proven there and the change is demonstrably safe for all consumers

Do NOT edit:
- `apps/social-mobile/src/features/x-connect/**`
- G4-owned account-switch files
- Supabase Auth/provider flows
- account-deletion backend/state machine
- DB/RLS/RPC/migrations
- Vault/token storage
- OAuth ownership
- service-entitlement/common-account design
- production feature flags
- scheduler/posting paths

## Required work

### 1. Root-cause the invisible native buttons

Reproduce or inspect the iOS Release/native rendering path for:
- 「投稿用のX接続を確認する」
- 「アカウントの削除について」

Determine why the text is invisible while the Pressable remains tappable.

Do not merely change color blindly. Confirm whether the problem is caused by:
- `Link asChild` + `Pressable`
- inherited/native text/style behavior
- shared `styles.buttonText`
- Release-only rendering
- another concrete cause

Fix the actual source cause with the narrowest safe change.

### 2. Make account management discoverable from Settings

Add a clear, ordinary Settings entry for account/login management.

Preferred UX:
- a distinct account section/card in Settings
- direct route to `/login-methods`
- wording should make it obvious that login methods, X connection, and account/service deletion live there

If a direct deletion shortcut is clearly safer/usably better, it may be added, but do not bypass the existing preview/re-auth/confirmation deletion screen.

Do not move destructive logic into Settings.

### 3. Preserve deletion truthfulness

Current deletion UI must continue to:
- preview what the server says will be deleted/kept
- require fresh reauthentication
- require the typed confirmation
- report server-confirmed outcome only
- keep the current feature-gate behavior

Do not alter `social_only` / `social_and_login` semantics in this task. Those semantics will be reconsidered by the common-account project.

### 4. Feature flag

Do NOT globally enable `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` in this task.

Goal is source/UI readiness only.

After the common-account design decides the final deletion semantics, activation can be a separate controlled release step.

## Tests / verification

At minimum:
- relevant social-mobile tests
- new/updated UI/static tests proving the two button labels remain visibly rendered in native-compatible composition
- Settings contains a discoverable account-management route
- existing account-deletion preview/reauth/typed-confirmation behavior unchanged
- no G4 X-connect source change
- no Auth/DB/RLS/RPC/Vault/OAuth backend diff
- typecheck
- lint
- `git diff --check`

Native verification:
- use local iOS Simulator / Release-like build where practical
- visually confirm both affected button labels are visible
- confirm both routes are tappable and land on the correct screens
- confirm the Settings account entry is visible without requiring knowledge of hidden navigation
- no EAS build unless truly required; explain if unavoidable

## Production / safety

- source + tests + PR only
- no production deploy
- no feature-flag enable
- no destructive account deletion in this task
- no real X login/revoke/post
- production mutation = 0
- do not remove the retained disposable Auth/profile from the E3 test; that now belongs to the common-account/account-lifecycle decision

## Completion conditions

- invisible button root cause identified
- source fix implemented
- both labels visible in native verification
- Settings account-management entry added and verified
- deletion semantics/backend unchanged
- tests/typecheck/lint/diff checks pass
- commit + push + PR
- production mutation 0
- real X operations 0

## Report

Include:
- task_id
- result
- root cause of invisible buttons
- UX change
- changed_files
- tests
- native/simulator verification
- proof deletion backend/semantics unchanged
- proof no G4 overlap
- commit_hash
- push
- PR
- production mutation
- real X operations
- remaining issues
- safety_checks
- next_recommendation

Then status -> review_required, next_owner -> chatgpt and STOP for K3.

---

## Previous completed G3 history — preserved below

# Claude Task 3

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- continues_from: x-social-mobile-pr63-merge-native-e3-resume-20260930
- purpose: E3の使い捨てユーザー/X接続が正常に成立した状態から、アカウント削除E2Eを最後まで検証する。削除によるX認可失効、Vault/DB/Auth等の残存データ、既存本番アカウントへの非影響を確認する。

## Confirmed starting point

Operator report:
- local iPhone Simulator build is connected to real production data.
- a genuinely disposable X account `@tigers_torataro` is now connected successfully to the disposable social-mobile user.
- protected production posting accounts were not touched.
- account deletion and X authorization revoke have NOT been executed yet.
- a temporary local-only browser-session workaround was used to choose the correct X account; it was not committed.

The previous K3 blocker (wrong X account already connected in production) is therefore resolved.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and the previous G3 report history.
2. Use the existing independent G3 worktree/checkout only. Do not use G4's worktree.
3. Fresh-check `origin/main`, but do NOT pull unrelated G4 source changes into the already verified E3 session unless rebuilding becomes unavoidable.
4. Do not make source changes in this task unless a blocking defect is found. This task is operational E2E verification.
5. Confirm the disposable connected X identity is exactly `@tigers_torataro`.
6. Confirm protected production posting accounts remain unchanged and are excluded from every destructive selector.
7. Do not reveal token plaintext, secret values, Vault plaintext, or personal email addresses in logs/report.

## Phase 1 — read-only preflight before deletion

Capture a read-only baseline sufficient to prove isolation:
- disposable Auth/user/profile/workspace/membership state
- disposable social account state and platform identity
- disposable token-reference / Vault-reference existence only (never plaintext)
- OAuth state / pending rows relevant to the disposable flow
- deletion/audit/tombstone baseline if present
- protected production X account state/count/hash or equivalent invariant
- Vault count/identifier hash or equivalent protected-account invariant
- feature flags relevant to deletion remain unchanged; do not globally enable deletion

Confirm again:
- no real X post
- no scheduler/manual publish
- no provider-console mutation
- no protected production account mutation

## MANDATORY STOP — fresh destructive approval

After Phase 1 is complete and BEFORE the first destructive action, STOP and report:

- disposable identity confirmed: `@tigers_torataro`
- read-only baseline captured
- protected production accounts unchanged
- exact first destructive operation: execute the existing account-deletion flow for this disposable social-mobile user
- expected effects: delete the disposable account/workspace data, revoke only this disposable X authorization as designed, remove only this disposable credential material
- feature remains OFF globally

Then request **fresh explicit user approval in the conversation**.

The user's current request to create this TASK is NOT the destructive approval.
Do not reuse any older approval.

## Phase 2 — after fresh approval only: execute deletion

Only after explicit approval:
1. Use the existing app/account-deletion E2E path for the disposable user.
2. If a local-only flag/config is required to expose the deletion path, keep it local/uncommitted and do not globally enable production deletion.
3. Perform the deletion once. Do not retry blindly if the result is ambiguous.
4. Do not manually revoke other X accounts or make provider-console changes.
5. If deletion fails before completion, STOP and preserve evidence; do not run separate cleanup mutations unless explicitly approved.

## Phase 3 — verify X revoke

After successful deletion:
- verify the deletion path attempted/completed revoke for the disposable X authorization according to the existing implementation.
- prefer server-side/audit/result evidence that does not require retaining token plaintext.
- if provider-side confirmation requires an interactive X "Connected apps" check, ask the user to perform only that read/confirmation for `@tigers_torataro`.
- never revoke the app globally and never touch the protected production X accounts.
- do not perform a real X post as a revocation test.
- if automatic revoke is not provable or failed, STOP; do not perform a separate manual revoke without new explicit approval.

## Phase 4 — residue / isolation verification

Read-only verify the disposable user's data is removed or intentionally retained exactly as designed. Check the relevant boundaries:
- Auth user/session
- profile/workspace/membership
- social account
- OAuth transient state
- token-reference/Vault credential
- content/settings/history rows owned only by the disposable workspace, where applicable
- deletion audit/tombstone records that are intentionally retained

Also prove protected production invariants are unchanged:
- existing production X accounts
- their credential references/Vault identifiers
- refresh state
- posting/scheduler state
- feature flags
- no real X post created

Classify every remaining row/value as:
- expected retained audit/tombstone
- unexpected residue
- unrelated protected production data

Do not "clean up" unexpected residue during verification. Report it first.

## Completion / K3

Report:
- task_id
- result
- destructive approval timestamp/message boundary
- deletion result
- X revoke proof/result
- residue matrix
- protected-account invariants before/after
- source changes (expected none)
- local-only temporary config used, if any
- tests/checks
- production mutations performed exactly
- real X posts = 0
- remaining issues
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Previous G3 task closure

Previous task `x-social-mobile-pr63-merge-native-e3-resume-20260930` reached Final K3 BLOCKED only because the first X identity was already connected to a protected production posting account. No destructive action occurred. Its report and Final K3 state remain in Git history / CURRENT_STATE and are not to be re-executed.

## Report — x-social-mobile-e3-delete-revoke-residue-20261001

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- result: **PASS** (E3 complete: deletion, X revoke, residue, protected invariants all verified). Two UI findings and one retained-by-design item are listed under remaining issues.
- model: Opus 5.5

### Destructive approval boundary
- Phase 1 (read-only baseline) finished, then STOP. Fresh explicit approval was requested in the conversation with the exact operation, expected effects and "feature stays OFF globally".
- User answered "承認する（自分で削除ボタンを押す）" at 2026-09-30T15:50:00Z (JST 10/1 00:50). No older approval was reused.
- The delete button was pressed once, by the user, in the local Simulator build. Claude pressed no destructive control.

### Deletion result
- App showed「削除しました — このアプリのデータを削除しました。ログイン用アカウントと「かぶモリ」のデータは残っています。」and returned to the login screen with the same notice banner (D2 fix confirmed on native).
- Scope: `social_only` (the disposable login also has a main-app profile), as predicted in Phase 1.
- Audit trail for the subject after the approval boundary (UTC): requested 15:57:07.42 → started 15:57:07.47 → x_revoked 15:57:07.91 → purged 15:57:07.95 → completed_social_only 15:57:08.05. No `failed` / `operator_required` / `blocked` row, no reason code. One attempt, no retry.

### X revoke proof
- Server-side: the flow stops with X_REVOKE_FAILED unless the X revoke endpoint returns success for both the refresh and the access token of exactly this account, and the `x_revoked` checkpoint is only written when the fingerprints of the revoked material match the credential set. The `x_revoked` audit row exists, followed by `purged`.
- Provider-side (user read-only check, logged in as `@tigers_torataro`): the app is no longer listed under X "connected apps". Nothing was pressed there.
- No global app revoke, no provider-console change, no real X post used as a test.

### Residue matrix (disposable subject, before → after)
| boundary | before | after | class |
|---|---|---|---|
| workspace | 1 | 0 | removed |
| membership | 1 | 0 | removed |
| social account (`tigers_torataro`, identity_verified, publish_enabled=false) | 1 | 0 | removed |
| token references in Vault (access + refresh) | 2 | 0 | removed |
| OAuth transient states (5 unconsumed) | 6 | 0 | removed |
| refresh state / scheduled posts / post logs / claims / windows / fingerprints of the workspace | 0 | 0 | none existed |
| deletion tombstone | 0 | 0 | none left (removed at finalize, as designed) |
| deletion audit rows (hashed subject only) | 10 | 15 | expected retained audit |
| Auth user / identity (email) / profile | 1 / 1 / 1 | 1 / 1 / 1 | expected retained (`social_only`: login belongs to the main app) |
| Auth sessions / refresh tokens | 3 / 4 | 3 / 4 | expected retained with the login (device sign-out is local) |
| handle present anywhere else | 0 | 0 | none |

Unexpected residue: **none**.

### Protected-account invariants (before = after, byte-equal hashes)
- protected social accounts: 3, row hash (ids, workspace, platform user, both token references, publish flag, status, updated_at) unchanged
- Vault rows referenced by protected accounts (id + updated_at hash) unchanged; all other Vault ids unchanged; Vault total 22 → 20 (= exactly the two disposable references)
- refresh state count/hash, refresh rollout, non-user workspaces hash, the other pre-existing user workspace: unchanged
- scheduled_posts 408, post_execution_logs 949 (latest timestamp unchanged, before the test), publish_claims 20, posting_windows 19, fingerprints 103: unchanged
- auth users 4, profiles 2: unchanged
- global totals changed only by the disposable rows: user workspaces 2→1, memberships 2→1, social accounts 4→3, OAuth states 28→22

### Other fields
- source changes: none committed. No PR.
- local-only temporary config (uncommitted, not in any product build): `.env.local` (real-data mode + deletion flag), `app.config.js` (throwaway bundle id), generated `ios/`, and a one-line ephemeral auth-session option in the X-connect hook used only to pick the right X account. The hook edit has been reverted in the worktree; the other files stay untracked until K3, then are removed.
- feature flag: the deletion entry is still gated by the client build flag, which is unset in every committed config. Nothing was enabled globally. No secret, Edge function, migration or provider setting was changed.
- tests/checks: operational verification only (read-only SQL before/after diff). No code changed, so no test run.
- production mutations performed exactly: (1) the user's X connect for the disposable account (new social account + 2 Vault references + OAuth states), done before this TASK; (2) one account-deletion call by the user, which revoked that X authorization and removed the rows above and wrote 5 audit rows. Nothing else.
- real X posts = 0. No scheduler/manual publish.

### Remaining issues
1. **Invisible buttons on the Login methods screen (native iOS, Release build).** 「アカウントの削除について」and「投稿用のX接続を確認する」render as blank space; the hidden area is still tappable and navigates. The deletion entry is effectively undiscoverable for a signed-in, onboarded user (the onboarding-gate entry from PR #59 is visible and fine). Release blocker for the deletion feature; needs a source fix + Simulator check. Not fixed here (operational task).
2. **Deletion entry is deep**: Home → アカウントを切り替える → ログイン方法 → bottom card. Not in the 設定 tab, where the user looked first. Consider a direct entry.
3. X auth session reuses the previous X login (already assigned to G4).
4. The disposable login itself remains in production (main-app profile exists → `social_only`). Removing it is a main-app (G1/G2) account-delete or operator action; not done.
5. Unchanged release gates: Apple production config, legal URLs/texts, audit retention policy, main-app account-delete coordination.

### Safety checks
- no token plaintext, Vault plaintext, secret value/id or personal email in logs or this report
- every destructive selector was the caller-bound deletion flow of the disposable user; no first-row fallback, no manual SQL mutation, no cleanup mutation
- protected production posting accounts untouched and proven unchanged
- dedicated G3 worktree only; G4 worktree and X-connect source untouched

### Next recommendation
- Final K3 for E3 = PASS candidate.
- Open a small source task for issue 1 (and decide issue 2) before the deletion flag can be enabled in any product build.
- Decide who removes the leftover disposable login (issue 4).


## Final K3 — E3 deletion/revoke/residue

- verdict: **PASS**
- accepted task: `x-social-mobile-e3-delete-revoke-residue-20261001`
- operational result: the disposable social-mobile service data was deleted once after fresh approval; its X authorization was revoked; no unexpected residue remained.
- accepted scope: `social_only`. The shared Supabase Auth user / login identity / main-app profile were intentionally retained.
- residue: workspace, membership, social account, disposable X credential references/material, and OAuth transient state removed as designed; deletion audit retained as designed.
- protected production posting accounts and their credential references/state remained unchanged.
- real X posts: 0. No scheduler/manual publish. No global deletion flag enable. No source commit or PR from this task.
- source changes: none. Local-only verification edits/config were not product changes; the X-connect temporary hook edit was reverted before report.
- remaining release blocker: native iOS Login methods screen has invisible/tappable-only buttons for the deletion and posting-X navigation. Deletion entry is also too deep. Keep deletion feature globally gated until UI/flow work is addressed.
- retained disposable login/profile is intentional under current `social_only` behavior and now becomes input to the new common-account/service-entitlement design rather than an E3 failure.
- Codex review: **not required for this K3** because no implementation source changed and the purpose of this task was operational E2E of already reviewed boundaries. Re-review at the next source change / production activation gate.
- AI Lab diary: 候補あり — 使い捨てアカウントで「このアプリだけ利用終了」の流れを最後まで試し、他のサービス用ログインを残したままX連携とアプリ専用データだけ消えることを確認した。
- next: common-account design should replace the current proxy-style service-existence decision with an explicit service entitlement. Separately fix the native deletion/navigation button visibility before enabling self-service deletion broadly.

