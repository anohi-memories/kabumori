# Claude Task 3

- task_id: x-social-mobile-auth-x-connect-onboarding-phase1-20260928
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: `apps/social-mobile` を一般ユーザーが実際に使えるX自動投稿アプリへ進める第1段階。認証・X接続・初期オンボーディングを棚卸しし、既存基盤を壊さず「初回利用者がログイン→X接続→必要設定→利用開始」まで一本で通せる状態へ近づける。

## Product direction

ここからは基盤深掘りを一旦止め、ユーザー価値が見えるアプリ実装を優先する。

このTASKの最重要ゴール:
- `apps/social-mobile` の認証/X接続/onboardingを「画面だけ」「部分接続」「実利用可」に分類
- 欠けている最小実装を追加
- 一般ユーザーが迷わずX接続まで到達できる導線を作る
- 既存Universal OAuth/Vault基盤を再利用し、新しい並列認証方式を作らない

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3/C1 Stage 3B reports
   - relevant `apps/social-mobile` auth/accounts/settings screens
2. Use independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill before any Supabase/Auth implementation.
5. Inspect current Expo/React Native auth/session/X OAuth architecture before editing.
6. Do not touch G4-owned Home/posting UX files unless absolutely necessary; stop on overlap.

## Scope

### Stage A — inventory

Classify the current state of:
- sign in
- sign up / account creation
- password recovery if present
- session restore
- logout
- X account connection
- X OAuth callback/deep-link handling
- connected-account state
- reauth/reconnect path
- onboarding progress
- first-run settings
- error/loading/empty states

For each, label:
- implemented and usable
- partial
- UI only
- missing
- blocked by backend/config

Do not guess; inspect source and existing tests.

### Stage B — define minimal first-run journey

Target journey:
1. launch app
2. sign in / create account as supported by current product contract
3. connect X
4. confirm connected account
5. complete minimum settings required for later auto-post use
6. land on app Home

If sign-up/product identity is not yet safe to implement, leave a clear gate instead of inventing policy.

### Stage C — implement narrowest useful gap fixes

Allowed examples:
- missing routing/guard
- missing loading/error state
- missing connected-account status
- missing reconnect CTA
- missing callback handling
- onboarding progress persistence
- first-run routing
- account connection failure UX
- session restore bug
- obvious auth/X-connect wiring gaps

Do NOT:
- activate Stage 3B production pilot
- apply pending Stage 3B migrations
- merge PR #41
- change Admin PR #33
- invent billing
- build multi-SNS
- redesign all screens
- add new auth system parallel to existing Supabase flow

## Security constraints

- exact user/account binding
- no brand-first/first-row account fallback
- no token/plaintext secret in client/logs
- no service_role in mobile client
- fail closed on missing/ambiguous X account
- existing Vault/OAuth authority remains canonical
- preserve logout/session semantics
- preserve tenant isolation

## Tests

At minimum:
- auth/session provider tests where applicable
- onboarding routing tests
- X connected/disconnected/reauth states
- wrong-user/account binding rejection
- callback/deep-link parsing
- no secret/token leakage
- `npm run typecheck`
- `npm run lint`
- Expo export/build smoke if practical
- `git diff --check`

## Deliverable

Report:
- current-state inventory
- exact first-run journey
- implemented gaps
- changed_files
- tests
- screenshots/Preview notes if generated
- backend/config blockers
- security checks
- remaining UX gaps
- recommended next G3 step

## Production constraints

- no production OAuth mutation unless explicitly authorized
- no production rollout activation
- no migration apply/db push/repair
- no real X post
- no merge of unrelated PRs

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- pending
