# Claude Task 3

- task_id: x-social-mobile-auth-phase2-bundled-correction-20260928
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: C1 FAILとなったPR #47 multi-provider Auth Phase 2を、H1で再現されたAuth境界の不具合をまとめて1回で修正する。個別パッチをばら撒かず、callback/PKCE/linking/recovery/provider-session/onboarding/provider-readinessを整合した一つの設計として修正する。

## Source

- PR #47 reviewed head: `7bda196147a749431774fba915a86d41bf43dc5d`
- H1 verdict: FAIL
- production mutation: 0
- accepted Phase 1 is already on main:
  - PR #42 -> `f0cac1505184a2abd9c9d504142012a1be999cf3`
  - PR #44 -> `7870d10170d31e0a6b78ab245f4e9152a3628f00`

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest H1 section in `.agent/CODEX_REPORT.md`
2. Independent G3 worktree/checkout.
3. Fresh fetch `origin/main` and PR #47 exact head.
4. Read current Supabase skill.
5. Re-check current Supabase changelog/docs for:
   - identity linking
   - exchangeCodeForSession / flowId
   - mobile PKCE/deep linking
   - password recovery
   - Apple / Google / X social login
6. Preserve all unrelated main changes and G4 files.

## Must fix — bundled Auth correction

### 1. Provider linking URL handling

Current shared browser helper rejects the external authorization URL returned by `linkIdentity()`.

Required:
- distinguish sign-in initiation URL provenance from authenticated identity-linking redirect URL provenance
- validate only expected secure schemes/hosts/provider destinations
- do not simply remove URL validation
- preserve exact authenticated-user binding
- no external arbitrary URL open

### 2. Duplicate callback false-success race

Current duplicate-code Set returns success before the first exchange completes.

Required:
- share the actual in-flight result/promise/outcome
- duplicate delivery must resolve to the same real result, never an unconditional success sentinel
- cover both code and token-hash callback paths where applicable
- lifecycle must clear safely across cancellation/failure/restart boundaries
- prevent double exchange while keeping truthful UI outcome

### 3. Preserve and validate `sb_flow_id`

Required:
- parser retains documented flow ID
- strict validation
- pass `flowId` to `exchangeCodeForSession`
- concurrent flow A/B tests
- stale/malformed/mismatched flow IDs fail closed
- no fallback to wrong latest verifier

### 4. Email signup enumeration

Required:
- identical neutral successful UX for new-address and obfuscated existing-address no-session responses
- duplicate-address/server variants must not restore enumeration
- no raw provider/server distinction shown

### 5. Provider credential persistence policy

H1 proved SDK session persistence can include provider access/refresh fields in AsyncStorage.

Required:
- define the intended storage policy explicitly
- persist only what is necessary for Supabase app session/PKCE restoration
- provider OAuth access/refresh fields must not be stored in plaintext AsyncStorage or exposed in React context/logs
- do not break Supabase session restore
- behavioral tests must verify actual storage payload, not regex source scans
- app-auth provider credentials must never become posting-X credentials

### 6. Password recovery exact-user/session binding

Required:
- recovery context bound to intended user/session/flow
- invalidate on incompatible SIGNED_IN/user switch/session switch
- recheck immediately before updateUser
- restart/callback overlap/user-switch tests
- no boolean-only global recovery mode

### 7. Exact callback parsing

Required:
- reject credentials/userinfo in callback authority
- reject unexpected port
- reject duplicate/conflicting code/token_hash/type/sb_flow_id values across query/fragment
- only documented allowed fields
- preserve rejection of posting callback, foreign scheme/host/path and implicit-token-only returns
- malformed/ambiguous callback must fail closed

## Also fix H1 continuation/readiness gaps

### New-account notice / onboarding continuation

- do not drop duplicate/new-account notice solely because 30 minutes elapsed if no workspace/ack exists
- define explicit acknowledgment/progress semantics
- session/user switch must invalidate stale onboarding state
- tests must prove exact-user progress isolation

### Provider availability truthfulness

- Email UI must respect current provider/email/signup-disabled settings
- do not present a provider as ready merely because `external.*` is enabled if client-required config is absent
- source may distinguish:
  - provider enabled in Supabase
  - local/client config present
  - fully E2E verified (must remain false until later real-device gate)
- no fake readiness

### Apple linking path

H1 noted current explicit linking uses browser flow even on iOS.

Required:
- decide and document native-vs-browser linking path
- if browser linking retained, surface exact Services ID/secret config gate
- if native linking implemented, prove it preserves explicit identity-linking semantics
- do not claim native sign-in config automatically covers linking

## Preserve already-correct boundaries

Do NOT regress:
- X app-login != posting-X
- posting uses only `x-oauth-connect-user` + Vault path
- no client service_role
- no user_metadata authorization
- no merge by display name/handle
- Apple nonce behavior
- fixed messages/no raw provider errors
- Phase 1 session/login/logout behavior
- exact workspace/account fail-closed rules
- G4 Home/posting/history files

## Required tests

Recreate H1's seven negative probes as durable product tests where practical.

At minimum prove:
1. linkIdentity returned provider URL is accepted only when valid.
2. malicious/unexpected external URL is rejected.
3. duplicate callback gets same real failed/successful outcome as original.
4. concurrent PKCE flows select correct verifier by flowId.
5. malformed/stale/duplicate/conflicting flow IDs/params rejected.
6. new/existing email signup no-session messages indistinguishable.
7. provider access/refresh fields not persisted to plaintext storage/context.
8. Supabase app session restore still works.
9. recovery A -> login B invalidates recovery.
10. recovery exact-user/session succeeds only for bound user/session.
11. user-switch clears stale onboarding/new-account state.
12. provider/email disabled/config-missing UI fails closed.
13. X login remains separate from posting X.
14. existing password login/logout/session restore regressions.
15. Apple native nonce regression.
16. no secret/service_role/provider token logging.

Run:
- full `npm test`
- data-view tests
- typecheck
- lint
- Expo web + iOS export
- git diff --check
- secret scan

## Production constraints

- no provider enablement/disablement
- no redirect allowlist mutation
- no SMTP/template change
- no Apple/Google/X developer-console mutation
- no DB migration
- no Stage 3B activation
- no real X post
- production_mutation=0

## Completion / K3

Report:
- exact fixed PR #47 head
- each H1 finding => fix/result
- storage policy
- recovery binding design
- callback/flowId design
- linking design
- onboarding/user-switch behavior
- provider-readiness behavior
- changed_files
- tests
- remaining console/device gates
- production_mutation=0
- whether ready for one final focused H1 acceptance pass

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- exact fixed PR #47 head: `5fd483a5fc651da07d0791c68eaa557cdb201357`（branch `claude/g3-multi-provider-auth`、reviewed head `7bda196` からの1コミット。origin/main `1911e35` 時点で main 側の `apps/social-mobile` 変更なし＝rebase 不要）
- production_mutation=0（provider有効化/無効化・redirect allow-list・SMTP/テンプレート・Apple/Google/X コンソール・DBマイグレーション・Stage 3B・実X投稿、いずれも未実施）

### H1 findings => fix / result
1. Provider linking URL provenance: sign-in は `isAllowedSignInUrl`（https・userinfo/port なし・プロジェクトホスト・`/auth/v1/authorize` 完全一致）、linking は `isAllowedLinkUrl`（プロバイダ別ホスト google=`accounts.google.com` / x=`x.com`,`twitter.com` / apple=`appleid.apple.com`、https・userinfo/port なし、`redirect_uri` がちょうど1つで `https://<project host>/auth/v1/callback` と一致）。それ以外は開かない。→ 修正済み・テスト＋変異テストで検出確認
2. Duplicate-callback false success: `handledCodes` の成功扱いを廃止。code / token_hash ごとに in-flight の Promise を共有し、重複配信は本物の結果（成功も失敗も）を受け取る。→ 実 supabase-js で交換1回・同一結果を確認
3. `sb_flow_id`: `experimental.appendPkceFlowIdToRedirects: true` を有効化し、code には妥当な `sb_flow_id` を必須化。`exchangeCodeForSession(code, { flowId })` で当該フローの verifier のみ使用。ブラウザ往復は自分が開始した flowId 以外の callback を交換前に拒否。→ 並行 A/B、stale、形式不正、flow 不一致（未消費の C を使って交換が起きないことと C が消費されないことを確認）
4. Email signup enumeration: 新規/既存アドレスとも同一の固定文言 `SIGN_UP_CHECK_EMAIL_MESSAGE`、`email_exists`/`user_already_exists`/`identity_already_exists` も同じ表示。→ 修正済み
5. Provider credential persistence: 下記 storage policy。→ 実 supabase-js の保存ペイロードで検証
6. Password recovery binding: 下記 recovery binding design。→ A→B 切替で失効、updateUser 直前の再確認
7. Exact callback parsing: userinfo・port・パス違い・未知フィールド（`access_token` 含む）・query/fragment 内外の重複・code+token_hash・code+type・error+資格情報を invalid に。→ 修正済み

### storage policy
- `src/lib/session-storage.ts` の `createSanitizingStorage` を Supabase client の storage に適用（native=AsyncStorage、web=localStorage）。`setItem` のたびに `provider_token` / `provider_refresh_token`（トップレベルと `currentSession` 内）を除去して保存。
- React context の `session` は `stripProviderCredentials(session)` のコピーのみ。
- アプリ自身のセッション（access/refresh token・user）はそのまま保存され、復元・更新・ログアウトは Phase 1 と同じ。
- 検証: `tests/auth-sdk-behavior.test.mjs` で provider token 入りの交換応答後、保存内容に値もフィールド名も無く、新しい client で復元できることを確認。src 内でフィールド名を扱うのは sanitizer のみ（契約テストで強制）。

### recovery binding design
- `src/domain/recovery-binding.ts`: `PASSWORD_RECOVERY` で `{ userId, sessionId(JWT session_id) }` に束縛。その後の auth イベントで同一ユーザー＋同一セッションでなければ（別ユーザーのログイン、新規サインイン、サインアウト）解除。boolean だけのモードは廃止。
- `completePasswordRecovery` は `getSession()` を読み直して `recoveryMatches` を `updateUser` 直前に再確認し、不一致なら解除して `recovery_context_lost` を返す（パスワードは変更しない）。

### callback / flowId design
- 上記 3・7 のとおり。deep link（`Linking`）経由の callback はメール確認/再設定リンク用で、flow 期待値なしで完了（code は `sb_flow_id` 必須のまま）。posting 用 `oauth-callback` は厳密パーサで invalid となり auth 側では一切処理しない。
- 共有 outcome は最大32件保持。

### linking design
- 明示的な「アカウント → ログイン方法」画面からのみ。開始ユーザー ID を渡し、往復後に結果ユーザーと現在のセッションユーザーが両方一致しなければ signOut して `link_user_mismatch`（別ユーザーのまま続行しない）。
- Apple: iOS は native Sign in with Apple → `linkIdentity({ provider: 'apple', token, nonce })`（ユーザー自身のセッションでの ID token リンク、Services ID 不要）。iOS 以外はブラウザ OAuth リンクで、ビルド宣言 `apple_web` が必要。
- 名前/ハンドルでのマージなし、`user_metadata` 不使用、unlink なし。

### onboarding / user-switch behavior
- 新規アカウント通知は30分期限を廃止。非メールの identity が1つ・workspace なし・未確認の間表示し、明示的な確認でのみ消える（ユーザー単位）。
- オンボーディング状態は読み込んだ user id と一緒に保持し、ユーザー切替時は新ユーザーの状態を読むまで loading（前ユーザーの進行状況・確認済みフラグは引き継がない）。

### provider-readiness behavior
- `providerReadiness` = `enabledInSupabase`（`GET /auth/v1/settings` の `external`、不明なら false）/ `configuredForBuild`（ビルド宣言 `EXPO_PUBLIC_AUTH_PROVIDERS`、未設定＝email のみ。Apple native は `ios.bundleIdentifier` と native 利用可否も必要）/ `e2eVerified`（常に false）。`usable` は前2つの AND。使えない方法は「（準備中）」で押せない。
- メール: サインインは email 宣言かつプロジェクトで無効でないこと、新規登録は `external.email` かつ `disable_signup === false`（不明なら不可）、再設定は `external.email`。UI のタブ/ボタンを無効化し、provider 側でも Auth 呼び出し前に再確認。
- 現状 app.json に `ios.bundleIdentifier` が無いため Apple native は usable にならない（正直な表示）。

### changed_files（`7bda196..5fd483a`、すべて `apps/social-mobile/` 配下）
`.env.example`, `docs/multi-provider-auth-phase2.md`, `package.json`, `package-lock.json`（`expo-constants ~57.0.19` 追加）, `src/app/login-methods.tsx`, `src/components/auth-screen.tsx`, `src/domain/auth-flows.ts`, `src/domain/onboarding.ts`, `src/domain/recovery-binding.ts`（新規）, `src/features/onboarding/onboarding-gate.tsx`, `src/lib/auth-client-flows.ts`, `src/lib/session-storage.ts`（新規）, `src/lib/supabase.ts`, `src/providers/auth-provider.tsx`, `tests/auth-flows.test.mjs`, `tests/auth-sdk-behavior.test.mjs`（新規）, `tests/multi-provider-auth-contract.test.mjs`。G4 の Home/投稿/履歴ファイル、`apps/admin/**`、共有ルールファイルは未変更。

### tests
- `npm test` 37/37 pass、`node --test src/domain/data-view.test.ts` 14/14 pass、typecheck OK、lint OK、`npx expo export` web / ios とも成功、`git diff --check` OK、secret scan（追加行＋新規ファイル）ヒットなし、src に console 出力なし。
- 必須テスト 1–16 の対応: 1–2 `auth-flows`（sign-in/link URL 許可・悪性URL拒否）、3–5 `auth-sdk-behavior`（重複・並行 flowId・stale/不正 flowId）、6 neutral sign-up、7–8 `auth-sdk-behavior`（保存ペイロード・復元）、9–10 recovery binding（A→B 失効・完全一致）、11 onboarding user-switch/notice、12 readiness/email capabilities の fail-closed、13 契約（login X ≠ posting X）、14 契約（password login・restore・logout・recovery 順序）、15 契約（Apple nonce: hashed→Apple、raw→Supabase、sign-in と native link 両方）、16 secret/token ログなし（src 静的検査＋scan）。
- 変異テスト 11/11 検出: flowId 未渡し、重複を成功扱い、期待 flow 照合削除、storage sanitize 削除、recovery の session_id 照合削除、recovery の user 照合削除、callback の userinfo/port 検査削除、重複パラメータ検査削除、link URL の redirect_uri 不要化、sign-in URL を任意 https 許可、onboarding のユーザー切替検査削除。
- 未実施: 実機/実プロバイダでの E2E（下記ゲート）。

### remaining console / device gates（未実施）
1. redirect allow-list が `kabumori-social://auth-callback?sb_flow_id=…` を許可すること（例 `kabumori-social://**`）
2. メール: Confirm email・SMTP・PKCE テンプレート、実機での確認/再設定リンク（recovery A→login B を含む）
3. X / Google: provider 有効化と OAuth クライアント、実機で PKCE 往復（同時2回試行を含む）
4. Apple: `ios.bundleIdentifier` 設定と Client ID 登録、dev build で sign-in と native linking
5. Manual linking 有効化後に linking・`identity_already_exists`・別ユーザーでのリンク失敗を確認
6. 各ゲート通過後にのみビルドの `EXPO_PUBLIC_AUTH_PROVIDERS` に追加（`e2eVerified` はコード上 false のまま）

### ready for one final focused H1 acceptance pass
- はい。7件の Must fix と追加修正3件を一つの設計として反映済みで、上記テスト・変異テストで確認済み。STOP for K3。
