# Claude Task 3

- task_id: x-social-mobile-auth-x-connect-onboarding-phase1-20260928
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
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

- task_id: x-social-mobile-auth-x-connect-onboarding-phase1-20260928
- result: K3 ready — 初回利用の一本道（ログイン → X 接続 → 接続確認 → 最小設定 → ホーム）を実装。PR #42。production mutation 0。
- model: Opus 5.5
- push/PR: branch `claude/g3-social-mobile-onboarding`、PR https://github.com/anohi-memories/kabumori/pull/42、commit `c5e0157`
- inventory（変更前、ソースと既存テストで確認）:
  - ログイン（メール/パスワード）: 実装済み・利用可
  - 新規登録: **なし（製品判断待ち）** — 公開登録か招待制か、メール確認の方針が未決定
  - パスワード再設定: **なし（製品判断待ち）** — 再設定リンクの deep-link 契約が必要
  - セッション復元・ログアウト: 実装済み・利用可
  - X 接続: 部分的 — PKCE 一式はアカウント画面内にのみ存在、接続後にデータが古いまま
  - OAuth コールバック/deep link: 部分的 — 解析・検証はあり（アプリ内認証セッション）、OS から届いた場合の route なし
  - 接続状態の表示: 部分的 — 本番データの読み込み失敗時に**ダミーのアカウントを表示**していた
  - 再接続: 部分的 — backend は同じ行を再利用するが、UI は「別のXアカウントを接続」で理由表示なし
  - 初回案内・進捗: なし（ログイン後いきなりホーム）
  - 初期設定: 部分的／backend 待ち — 設定タブはあるが `social_mobile_content_settings` は本番未配置
  - エラー/読み込み/空状態: 部分的 — ログインの全エラーが「メール/パスワードを確認」、アカウント画面に空/不可の表示なし
- first_run_journey: 起動 → セッション復元 → 未ログインならログイン（新規登録・再設定は「このアプリではまだ行えません」と明示）→ 本番データモードでは `OnboardingGate` がサーバー状態から段階を決定（`domain/onboarding.ts`）: ワークスペースなし/X なし/接続途中 → **X 接続**、`connection_status='failed'` → 理由付き **再接続**、ワークスペース2つ以上/X 2つ以上 → **安全側で停止（推測しない）** → `identity_verified` で **ハンドル確認** → 設定行あり、または「ホームへ進む（投稿の好みはあとで設定）」（ユーザー別のローカル記録）→ **ホーム**。モック表示モードは案内をスキップ。
- implemented_gaps: 案内ゲート＋段階導出（純粋関数）＋ RLS だけで読む状態取得（自分の所属 → その brand の X アカウントの非秘密列 → 設定行の有無）; X 接続処理を `useXConnect` に一本化（既存フローをそのまま移設、state/verifier はメモリのみ、所有 ID を送らない）; アカウント画面の接続後再読み込み・再接続表示・空/不可状態; DataProvider に `reload()`（追加のみ）; 本番データモードでダミーアカウントを出さない; `oauth-callback` route（ホームへ戻すだけ、リンクは解析・保存しない）; ログインエラーを固定文言へ（サーバー文言を表示しない）
- changed_files: 新規 `src/domain/onboarding.ts`、`src/data/onboarding-repository.ts`、`src/features/onboarding/onboarding-gate.tsx`、`src/features/x-connect/use-x-connect.ts`、`src/app/oauth-callback.tsx`、`src/lib/auth-errors.ts`、`tests/*.test.mjs`（4本）、`docs/onboarding-auth-x-connect-phase1.md`; 変更 `src/app/_layout.tsx`、`src/app/accounts/index.tsx`、`src/providers/{data,active-account,auth}-provider.tsx`、`src/components/auth-screen.tsx`、`package.json`（`test` script）。すべて `apps/social-mobile` 配下。G4 担当のタブ画面（ホーム/投稿予定/設定/履歴/投稿詳細）は未変更。G4 の push 済みブランチとの重なりなし。
- tests: `npm test`（node:test）16/16 — 案内の段階判定、中断からの再開、理由付き再接続、曖昧時の停止、他 brand のアカウント無視（誤ユーザー/アカウント結合の拒否）、deep-link/コールバック解析（state 不一致・別 redirect・code 欠落・プロバイダエラー・キャンセル）、ログインエラーの固定文言、クライアントに service role/秘密情報なし、state/verifier の非保存、RLS 読み取り範囲、ダミー非表示、画面の順序。わざと壊した4パターン全て検出。`npm run typecheck` / `npm run lint` clean; `expo export --platform web` 成功; `git diff --check`; secret scan 0。
- screenshots: 未作成（ログインには Supabase 環境変数が、案内画面にはログイン済みセッションが必要なため。共有チェックアウトで dev server を起動しないルールも考慮）
- backend_config_blockers: 新規登録/再設定の製品方針; `social_mobile_content_settings` の本番配置（設定保存＝Stage 3B の同意保存先でもある）; X Developer Portal の redirect `kabumori-social://oauth-callback`; 本番データ用ビルドの `EXPO_PUBLIC_DATA_SOURCE=supabase`＋publishable key。
- security_checks: 利用者と所属/アカウントの厳密な結び付け（自分の所属から導出、クライアント指定の ID は使わない）; brand/行の先頭へのフォールバックなし; トークン・秘密情報はクライアントに出ない（テストで固定）; モバイルで service_role なし; 曖昧・欠落時は安全側で停止; 既存の Vault/OAuth（`x-oauth-connect-user`）が唯一の経路; ログアウト/セッションの意味は不変; テナント分離は RLS のまま。
- remaining_ux_gaps: ホーム（G4 担当）の「接続済み」表示が固定値（`connectionStatus` を読むべき）; X 接続の解除機能なし（backend に revoke RPC なし）; 複数ワークスペースの UI; 新規登録・再設定。
- production_mutation: 0
- next_recommendation: ChatGPT K3 → PR #42 レビュー → 製品判断（新規登録方針・content settings 配置）→ 次の G3: 新規登録/再設定の実装、または content settings 配置 TASK。


## Final K3 — social-mobile onboarding phase 1

Verdict: **PASS**.

- PR #42 head `c5e0157f867450047a5f79a204df45aaeefecfa6` is OPEN/MERGEABLE.
- first-run path now exists in source: login -> X connect/reconnect -> verified handle confirmation -> minimum settings gate/skip -> Home.
- existing Supabase session and `x-oauth-connect-user` path are reused; no parallel auth/OAuth system was introduced.
- real-data mode no longer falls back to fake account data.
- ambiguous multiple-workspace/account states fail closed rather than choosing a first row.
- X connect state/verifier remain memory-only; no token/service_role/secret exposure.
- G4-owned Home/settings/history/post files were not modified.
- tests: 16/16 plus typecheck/lint/Expo web export/diff/secret scan PASS.
- production mutation=0.
- sign-up and password recovery intentionally remain product gates, not guessed implementations.
- no intermediate H1 review is required; combine any app-side review after G4 Phase 1 unless a new backend/Auth security boundary appears.
