# Claude Task 3

- task_id: x-social-mobile-auth-release-readiness-phase3-20260928
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: mainへmerge済みのmulti-provider Auth Phase 2を土台に、アプリ公開前に必要なAuth/アカウント設定のリリース準備を進める。production provider設定そのものは変更せず、実機E2Eへ進めるためのsource/UI/config validation/運用手順を完成させる。

## Source / accepted state

- accepted PR #47 head: `ed5f8b7890e538593dba369dd85cb99a12b27242`
- merged main: `fbddef2535b82bf4775c2e4fddb93eeefb8c638a`
- Final C1: PASS-WITH-FIX
- no further H1 review required absent a concrete discrepancy

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest relevant C1/H1 Auth report
2. Use an independent G3 worktree/checkout.
3. Fresh fetch `origin/main`; branch from current accepted main.
4. Read current Supabase/Auth/Expo documentation/skill as needed.
5. Confirm no overlap with G4. G4 owns posting/schedule/history/post-detail interaction work.
6. Stop if a required change would touch G4-owned files or production Auth/provider configuration.

## Product goal

A normal user should be able to understand and manage:
- how they sign in
- which login providers are available
- which providers are still setup-pending
- how password recovery works
- how to add/link another login method
- whether X login and X posting connection are separate
- what action is needed when a provider is not production-ready

Do not fake provider readiness.

## Scope A — Auth/account settings UX

Inventory the current account/login-methods/settings screens and implement the narrow missing UX needed for release readiness.

At minimum:
- show current signed-in identity/email safely
- show linked login methods from authenticated Supabase identity state
- clearly distinguish:
  - X login method
  - X posting-account connection
- expose password recovery entry where appropriate
- expose explicit provider-linking entry only where the Phase 2 safe path already exists
- show provider unavailable/setup-pending states truthfully
- never display provider access/refresh tokens
- never use user_metadata as authorization

Do not add unlink unless the backend/product contract is already safe and explicit. If not, leave it out and report.

## Scope B — App/deep-link configuration readiness

Audit source config for:
- app scheme
- auth callback route
- password recovery callback
- PKCE `sb_flow_id`
- iOS bundle identifier requirement
- Apple native login/linking requirements
- Google/X browser OAuth redirect assumptions
- email confirmation/recovery redirects

Implement only source/config validation that is safe without touching production consoles.

Requirements:
- fail closed when required build config is missing
- no fake “ready” status
- clear diagnostics suitable for operator/development use without exposing secrets
- no hard-coded production secret/client secret

If an exact bundle identifier or external console value cannot be derived safely, do not invent it; document the operator gate.

## Scope C — Release-readiness diagnostics

Create a small deterministic readiness layer that can answer, per provider:
- enabled in Supabase: yes/no/unknown
- required local build config present: yes/no
- source path implemented: yes/no
- real-device E2E verified: false unless actually verified
- usable now: yes/no

Keep “configured” separate from “verified”.

UI may present a user-friendly version, while detailed diagnostics stay developer/operator-only.

## Scope D — E2E execution checklist

Update docs with exact future manual gates for:
- Email signup/login
- email confirmation
- password recovery
- X app login
- Google login
- Apple login
- explicit provider linking
- user-switch/recovery negative cases
- simultaneous PKCE flows
- X login != posting-X confirmation

For each gate include:
- prerequisite config
- exact user action
- expected result
- failure/rollback observation
- whether it mutates production configuration

No production console mutation in this task.

## Preserve accepted Auth boundaries

Do not regress:
- provider-link URL provenance validation
- duplicate callback shared real outcome
- strict `sb_flow_id` handling
- neutral email-signup enumeration behavior
- provider credentials stripped from persistence/context
- exact-user/session recovery binding
- strict callback parsing
- exact-user onboarding isolation
- fail-closed provider readiness
- X login != posting-X/Vault
- Apple nonce behavior
- no client service_role
- no name/handle merge
- no raw provider/server error leakage

## File ownership / G4 separation

G3 may own:
- auth/provider/session/login-method/account-security related files
- auth callback/deep-link config helpers
- app config validation needed for Auth
- Auth docs/tests

G3 must NOT edit G4-owned posting interaction surfaces unless strictly unavoidable:
- posting draft/editor/approval UI
- schedule/history/post detail interaction flow
- retry/post action UI
- posting preview/regenerate components

If overlap is needed, STOP and report exact file/reason.

## Tests

Run and preserve:
- full `apps/social-mobile` test suite
- data-view tests
- typecheck
- lint
- Expo web export
- Expo iOS export
- git diff --check
- added-line/new-file secret scan

Add focused tests for any new readiness/account settings logic.

## Production constraints

Do NOT:
- enable/disable Supabase Auth providers
- edit redirect allowlist
- change SMTP/templates
- edit Apple/Google/X developer consoles
- add production secrets
- deploy production Auth changes
- apply DB migrations
- activate Stage 3B
- make a real X post

production_mutation=0.

## Review policy

Do not request Codex review automatically.
This is source/UI/config-readiness work after a completed Auth boundary review.

If a genuinely new high-risk Auth/security boundary is introduced, report it at K3.
If independent review is needed while Codex capacity is constrained, recommend a separate Claude review first.

## Completion / K3

Report:
- exact branch/head
- user-facing account/Auth UX added
- provider readiness model
- app/deep-link config findings
- exact remaining operator/console gates
- changed_files
- tests
- production_mutation=0
- any G4 overlap
- whether any new high-risk boundary was introduced
- recommended next release step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- exact branch/head: `claude/g3-auth-release-readiness` @ `d1f34674c10db1f71eab2766308cf4e9bba9482b`、PR #50（https://github.com/anohi-memories/kabumori/pull/50）。main `c403f14` から分岐。origin/main はその後 G4 のレポートコミットのみ進行、`apps/social-mobile` の差分なし。
- production_mutation=0（provider有効化/無効化・redirect allow-list・SMTP/テンプレート・Apple/Google/Xコンソール・本番secret・Auth deploy・DBマイグレーション・Stage 3B・実X投稿、いずれも未実施）。
- CI: Vercel は「Deployment rate limited」で fail（CURRENT_STATE の方針どおり Preview rate limit 単独はブロッカー扱いしない）、Netlify は変更対象外で skip/cancel。

### user-facing account/Auth UX added（`src/app/login-methods.tsx`）
- ログイン中のアカウント: メールアドレスと 確認済み/未確認。メールなしのアカウントは「メールアドレスは登録されていません」。
- ログイン方法: メール/X/Apple/Google を「利用中 / 追加できます / 準備中」で表示。
  - 表示は認証済みユーザーの `getUserIdentities()` のみに基づく。identity_data・user_metadata・provider token は不使用。
  - 追加は `usableNow` のときだけ、Phase 2 の明示 linkIdentity 経路で行う。
  - メールのログイン方法追加は安全な経路が無いため「準備中」と表示。
  - 削除（unlink）は、backend/product の契約が無いため未提供。画面にもその旨を明記。
- パスワード: メール利用者には「再設定メールを送る」を表示（ログイン中アドレス宛、`email.reset` で制御、既存の中立文言）。メールなしの利用者には、パスワードが無いことを説明。
- 「XでのログインとX投稿の接続は別です」カード:
  - Xでログイン: 利用中/未設定。
  - 投稿用のX接続: 接続済み/要再接続/未接続。mock や未読込の場合は「確認できません」。
  - アカウント画面へのリンク付き。
- 開発ビルド（`__DEV__`）のみ、開発者向けの準備状況診断を表示。

### provider readiness model（`src/domain/auth-release-readiness.ts`、pure・決定的）
- プロバイダごとの項目:
  - `enabledInSupabase` yes/no/unknown（`/auth/v1/settings`、読めなければ unknown）
  - `buildConfigPresent`
  - `sourceImplemented`
  - `e2eVerified`（常に false）
  - `usableNow`
  - `blockers`（固定コード）
- `usableNow` の判定:
  - ソーシャル: Phase 2 のゲート AND blocker 0件（fail closed）。
  - メール: sign-in 可否。
- メールの新規登録・再設定は、コールバック scheme が正しいことも必須。
- AuthProvider の signInWithProvider / linkProvider / email capabilities をこのレポートで制御。
- 一般ユーザーには 利用中/追加できます/準備中 のみを表示。「configured」と「verified」は分離。
- 運用者向け `npm run auth:readiness`:
  - booleans/コードのみ出力。URL・key・token は出力しない。
  - 設定エラーがあれば exit 1。
  - `--fetch-settings` は公開 settings を読むだけの GET。

### app/deep-link config findings
- scheme `kabumori-social` はコールバックの scheme と一致（実際の app.json をテストで確認）。
- `expo-web-browser` / `expo-apple-authentication` プラグインと `ios.usesAppleSignIn: true` はあり。
- **`ios.bundleIdentifier` が app.json に無い。** 推測で入れず operator gate とし、Apple native は準備中のまま。
- PKCE `sb_flow_id` は付与済み。allow-list がクエリ付き URL を受け付けることが gate。
- Supabase の client 設定について:
  - https でない URL、secret/service_role の key は `supabase_config_invalid` として fail closed。
  - 失敗の種類（missing/invalid）を `getSupabaseConfig` の `kind` として追加。
- この作業環境には `.env` が無いため、本番 Supabase の provider 有効状態はレポートしていない（unknown）。

### exact remaining operator/console gates（詳細: `apps/social-mobile/docs/auth-release-readiness-phase3.md` §4、各 gate に前提設定・操作・期待結果・失敗/ロールバック・本番設定変更の有無を記載）
- G0 redirect allow-list（`?sb_flow_id=` を許可）【本番設定変更】
- G1 メール新規登録/ログイン【本番設定変更】
- G2 メール確認【本番設定変更】
- G3 パスワード再設定
- G4 X ログイン【本番設定変更】
- G5 Google ログイン【本番設定変更】
- G6 Apple ログイン（オーナーが bundle id を決定・Client ID 登録・dev build）【本番設定変更】
- G7 明示リンク（Manual linking）【本番設定変更】
- G8 ユーザー切替/再設定の否定ケース
- G9 同時 PKCE フロー
- G10 X ログイン ≠ 投稿 X
- 各 gate の通過後に、そのビルドの `EXPO_PUBLIC_AUTH_PROVIDERS` に追加する。

### changed_files（すべて `apps/social-mobile/` 配下）
- `docs/auth-release-readiness-phase3.md`（新規）
- `package.json`（`auth:readiness` スクリプト）
- `scripts/auth-readiness-check.mjs`（新規）
- `src/app/login-methods.tsx`
- `src/components/auth-screen.tsx`（`usableNow` を参照）
- `src/domain/account-security.ts`（新規）
- `src/domain/auth-release-readiness.ts`（新規）
- `src/lib/supabase.ts`（失敗 `kind`）
- `src/providers/auth-provider.tsx`
- `tests/auth-boundary-regression.test.mjs`（ハーネスに新モジュールを登録のみ）
- `tests/auth-release-readiness.test.mjs`（新規）
- `tests/multi-provider-auth-contract.test.mjs`

### tests
- `npm test` 57/57 pass（新規 13 件 + 契約 1 件を追加）
- data-view 14/14 pass
- typecheck OK、lint OK
- Expo export web/ios とも成功
- `git diff --check` OK
- secret scan（追加行 + 新規ファイル）ヒットなし、src に console 出力なし
- 変異テスト 11/11 検出:
  - blocker 無視
  - 新規登録で callback を無視
  - sign-in で backend を無視
  - scheme を常に OK
  - bundle id の blocker を削除
  - 設定 unknown を非ブロック化
  - e2e を詐称
  - mock を投稿 X とみなす
  - 準備中を偽って「追加できます」
  - サインイン/リンクの provider gate 削除（各1件）
  - 最初は provider gate 削除が検出されなかった。契約テストを2か所とも確認する形に強化し、検出されるようにした。
- 未実施: ログイン後画面のブラウザ/実機での表示確認（Supabase の接続設定が無く、ログイン後画面に到達できないため）。

### any G4 overlap
- なし。G4 の PR #49（`posts/[id].tsx`, `components/ui.tsx`, `post-interaction*`）とファイルの重複なし。settings タブ・accounts 画面・投稿系ファイルは未変更。

### whether any new high-risk boundary was introduced
- なし。新しい Auth API 呼び出し・権限・保存先・トークン扱いは追加していない。
  - 追加は準備状況による fail-closed のゲート強化と表示のみ。
  - パスワード再設定の入口は既存の `requestPasswordReset` を再利用。
- Phase 2 の各境界は維持:
  - URL provenance / 重複 callback / `sb_flow_id` / 中立 sign-up
  - provider token の除去 / recovery の束縛 / 厳密パース
  - onboarding の分離 / X ログイン ≠ 投稿 X
  - Apple nonce / service_role なし / 名前でのマージなし
- Codex レビューは不要と判断。

### recommended next release step
1. オーナーが iOS の bundle identifier を決め、app.json に設定する（Apple native の前提）。
2. G0（allow-list）→ G1〜G3（メール）の順に本番設定の変更を承認し、実機 E2E を行う。
3. 続けて G4〜G7、否定ケースの G8〜G10 を実施し、通過したものからビルド宣言に追加する。
