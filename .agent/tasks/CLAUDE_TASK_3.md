# Claude Task 3

- task_id: x-social-mobile-multi-provider-auth-phase2-20260928
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
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

- task_id: x-social-mobile-multi-provider-auth-phase2-20260928
- result: K3 ready — Phase 0 PASS（#42 → #44 の順で統合）、Phase 2 のソース実装を PR #47 に作成。production mutation 0（GitHub 上の PR マージ2件を除く）。
- model: Opus 5.5
- phase0: PR #42 head `c5e0157`（OPEN/CLEAN、チェック緑）→ merge `f0cac1505184a2abd9c9d504142012a1be999cf3`、main に #42 の内容を確認 → PR #44 head `966d412` を新 main に対して再確認（CLEAN、重なりは `package.json` の別行のみ）→ merge `7870d10170d31e0a6b78ab245f4e9152a3628f00`。merge 後の main で #42 由来45ファイル・#44 由来11ファイルとも受入済み head とバイト一致。回帰: `npm test` 16/16、data-view 14/14、typecheck、lint、Expo web export すべて PASS。
- push/PR: branch `claude/g3-multi-provider-auth`、PR https://github.com/anohi-memories/kabumori/pull/47、commit `7bda196`
- provider_support_matrix:
  - メールアドレス: 新規登録（PKCE、確認リンク）・ログイン（既存のまま）・パスワード再設定（リンク → `PASSWORD_RECOVERY` → 新パスワード画面 → `updateUser`）— 実装済み
  - X: Supabase Auth の `x`（OAuth 2.0）を `signInWithOAuth` ＋アプリ内ブラウザ＋`exchangeCodeForSession` — 実装済み・設定待ち
  - Apple: iOS はネイティブ `expo-apple-authentication` → `signInWithIdToken`（nonce はハッシュを Apple、元値を Supabase へ）、iOS 以外はブラウザ OAuth — 実装済み・設定待ち
  - Google: ブラウザ OAuth ＋ PKCE — 実装済み・設定待ち（Supabase 推奨のネイティブ Google Sign-In は後の改善、各 client id と dev build が必要）
  - どの方法も本番設定（`GET /auth/v1/settings`）で有効な場合だけ押せる。無効なら「（準備中）」で成功を装わない。
- implemented_source_changes: ログイン画面（4ボタン＋メールの ログイン/新規登録/パスワードを忘れた）; AuthProvider（PKCE、新規登録・再設定・各プロバイダ・明示的な連携・認証の戻りリンク処理・利用可能プロバイダ取得・再設定モード）; `auth-callback` route（戻すだけ、解析しない）; 新パスワード画面（再設定中は最優先表示）; ログイン方法画面（連携の一覧と追加）; 初回案内に「新しいアカウントを作成しました」確認と X ログイン後の案内; `app.json` に Apple サインイン設定; `expo-apple-authentication` 追加。
- config_blockers（本番・コンソール側、未実施）: Redirect URL 許可リストに `kabumori-social://**`; メール確認の有効/無効と SMTP; X プロバイダ（Supabase コールバック用 OAuth 2.0 クライアント、メール要求 ON、投稿用コネクタとは別クライアント）; Apple（`ios.bundleIdentifier` 未設定 → 設定して Client ID に登録、Android/Web で使うなら Services ID と半年ごとの鍵更新）; Google OAuth クライアント; 手動連携（Manual linking）の有効化。
- identity_linking_policy: 自動連携は Supabase 自身の「確認済み同一メール」の場合のみ（名前・ハンドルで統合しない、`user_metadata` は一切読まない）。メール→後で Google（同じ確認済みメール）は Supabase が自動連携。後から Apple/X を足すのは「アカウント → ログイン方法」からの明示的な `linkIdentity` のみ（手動連携が無効なら正直に表示）。メールが返らない X/Apple でログインすると新ユーザーになるため、ワークスペース作成前に「新しいアカウントを作成しました（以前別の方法で登録していたならログアウトして元の方法で入り、ログイン方法から追加）」を表示。別ユーザーで使用中の方法の連携は `identity_already_exists` で拒否し統合しない。既存メールでの新規登録・再設定は存在の有無を明かさない。連携解除は今回なし。誤って作った2つ目のアカウントはワークスペースを持たないため、元の方法で入り直せば影響なし（削除は既存の account-delete／運用対応）。
- first_workspace_onboarding_contract: 変更なしで接続 — ログイン →（該当時）新アカウント確認 → 初回案内 → 投稿用 X 接続（サーバー側 `begin_social_mobile_x_oauth_connection` が `u_…` ワークスペースとオーナー所属をちょうど1つ作成）→ ハンドル確認 → 最小設定 → ホーム。クライアントからの特権書き込みなし。
- changed_files: 新規 `src/domain/auth-flows.ts`、`src/lib/auth-client-flows.ts`、`src/app/auth-callback.tsx`、`src/app/login-methods.tsx`、`src/components/new-password-screen.tsx`、`tests/auth-flows.test.mjs`、`tests/multi-provider-auth-contract.test.mjs`、`docs/multi-provider-auth-phase2.md`; 変更 `src/providers/auth-provider.tsx`、`src/components/auth-screen.tsx`、`src/app/_layout.tsx`、`src/app/accounts/index.tsx`（ログイン方法への導線）、`src/features/onboarding/onboarding-gate.tsx`、`src/lib/supabase.ts`（PKCE）、`app.json`、`package.json`/`package-lock.json`（expo-apple-authentication）。すべて `apps/social-mobile` 配下、G4 のタブ画面は未変更。
- tests: `npm test` 32/32（新規16: 認証の戻りリンク解析〔投稿用リンク・別スキーム・不正値の拒否〕、新規登録の結果、ブラウザ/Apple の成功・キャンセル・失敗、利用可能プロバイダ判定、固定エラー文言、新パスワード検証、重複アカウント確認、X ログイン≠投稿用 X、`user_metadata`/プロバイダトークン/service role 不使用、PKCE と開いてよいホストの限定、コードの二重交換防止、Apple の nonce、連携は明示のみ、既存パスワードログイン・セッション復元・ログアウト・再設定の順序）。わざと壊した5パターン全て検出。data-view 14/14、typecheck、lint、Expo export（web・iOS）、`git diff --check`、secret scan（一致はマージコミット ID のみ）。
- security_checks: モバイルに service_role/秘密鍵なし; プロバイダのアクセス/リフレッシュトークンは読まない・保存しない・ログしない; 投稿用 X トークンはクライアントに来ない; ユーザー/ワークスペース/アカウントの先頭行フォールバックなし; 認証済みユーザーへの厳密な結び付け; RLS/テナント分離は不変; `user_metadata` で認可しない; 本番 Auth 設定・プロバイダ有効化・マイグレーション・Stage 3B・X 投稿はいずれも未実施。
- production_mutation: 0（コード・設定・DB。GitHub 上の PR #42/#44 マージのみ）
- remaining_gaps: プロバイダのコンソール設定と実機 E2E; ネイティブ Google Sign-In への移行; 連携解除; 複数ワークスペース UI; ホームの「接続済み」固定表示（G4 担当）; content settings 表の本番配置。
- activation_order_recommendation: (1) Redirect 許可リスト＋メール確認方針 → (2) メール新規登録・再設定を実機確認 → (3) X プロバイダ（投稿用とは別クライアント）→ (4) Apple（bundle id 設定・Client ID 登録・実機 dev build）→ (5) Google → (6) 手動連携を有効化して連携と衝突時の表示を確認。
- next_recommendation: ChatGPT K3 → 認証の境界に関わるため H1 の集中レビューを1回（範囲: X ログイン≠投稿用 X、連携方針、PKCE/戻りリンク、再設定）→ その後コンソール設定の TASK。


## Final K3 — multi-provider Auth Phase 2

Verdict: **PASS for source implementation; focused Auth review required before merge/activation**.

- Phase 0 integration PASS:
  - PR #42 merged -> `f0cac1505184a2abd9c9d504142012a1be999cf3`
  - PR #44 merged -> `7870d10170d31e0a6b78ab245f4e9152a3628f00`
  - accepted source verified on main; regressions PASS.
- Phase 2 PR #47 head: `7bda196147a749431774fba915a86d41bf43dc5d` (OPEN/MERGEABLE).
- source support implemented for X / Apple / Google / Email signup/login.
- email signup + password recovery source path implemented.
- X app-auth remains separate from posting-account OAuth/Vault path.
- provider linking is explicit; no name/handle/user_metadata-based account merge.
- provider availability is config-gated and does not fake readiness.
- no production Auth provider/config/database mutation; no real X post.
- tests: npm test 32/32, data-view 14/14, typecheck/lint, Expo web+iOS export, diff/secret scan PASS.
- because this touches Auth identities, PKCE, provider linking and recovery, one focused H1 review is required before merge or provider activation.
