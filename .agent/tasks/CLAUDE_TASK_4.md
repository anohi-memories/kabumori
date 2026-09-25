# Claude Task 4

- task_id: x-admin-pr33-auth-fix-round2-20260926
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C1でFAILとなったPR #33のAuth/security問題3点だけを修正し、real E2E前のsource candidateを再安定化する。範囲を広げない。

## Review baseline

PR #33 reviewed head:
- `e6b93beccfb9209dbe640fb9ea1464f2568f3c74`
- C1 verdict: FAIL
- do not merge this head

## Mandatory fixes

### P1 — recovery authority too broad

Current issue:
- reset authority allows generic `otp` and `magiclink` AMR.
- those do not prove recovery/invite intent.

Required:
- restrict reset authorization to exact documented recovery/invite purpose evidence only.
- if actual production recovery/invite flow emits a different AMR than expected, fail closed.
- do not broaden to generic OTP/magic-link.
- add regressions proving generic otp/magiclink cannot render or submit reset.

### P2 — 15-minute freshness checked only at render

Current issue:
- page validates once, then client submit trusts a boolean.
- leaving form open past 15 minutes can still call updateUser.

Required:
- re-verify claims / purpose / freshness immediately before password update.
- stale-open-form must fail closed before updateUser.
- add a regression where form rendered valid, clock advances beyond the allowed window, submit is rejected.

### P2 — sign-out failure falsely reported as success

Current issue:
- signOut returned/thrown failure can still produce updated/success result.

Required:
- do not claim completed logout unless signOut succeeds.
- returned error and thrown failure must produce safe failure/retry state.
- do not leave the UI implying the session was definitely cleared.
- add regressions for both returned-error and thrown-error signOut paths.

## Preserve existing guarantees

Do not regress:
- no account enumeration
- no open redirect
- callback destinations fixed local routes
- no service_role/client secret
- no credential logging
- non-admin never becomes Admin
- `admin_users` remains sole Admin gate
- PR #15 multibrand/brand isolation
- implicit fragment is stripped before session handling
- mobile reset flow outside `apps/admin/**` untouched

## Tests

Run:
- all `apps/admin/src/lib/*.test.ts`
- targeted recovery/invite/session tests
- stale-open-form regression
- generic otp/magiclink regressions
- signOut returned/thrown failure regressions
- admin/brand boundary tests
- tsc
- lint
- build
- git diff --check
- targeted secret scan

## Real E2E gate

Do not perform real email E2E in this task unless separately authorized.

At completion, report the exact operator setup needed for:
- one real password recovery flow
- one real invite flow
- disposable or expressly approved account
- Preview redirect allowlist
- actual AMR values
- cookie/session establishment
- post-update logout

Source fixes must be complete first.

## Forbidden

- PR merge
- production deploy
- Supabase Auth Site/Redirect mutation
- Auth user/admin_users mutation
- DB/RLS/RPC/migration
- unrelated apps/admin refactor
- G3 OAuth refresh files
- important-news/common-search work

## Completion / K4

Report:
- exact findings fixed
- final PR head
- tests/counts
- whether generic otp/magiclink are now denied
- whether submit-time freshness is enforced
- signOut failure behavior
- Admin/brand regression
- production mutation=0
- exact real-E2E operator gate
- readiness for another focused H1 review

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- pending

## Report (execution)

- task_id: x-admin-pr33-auth-fix-round2-20260926
- result: **PASS** — C1の3指摘（P1 1件・P2 2件）をすべて修正。範囲はこの3点のみ。PR #33 new head `2528b56`、MERGEABLE、Netlify Preview SUCCESS。再度の焦点付きH1レビューに渡せる状態。
- model_used: Opus 5.5（TASK推奨 Opus5.5（高））
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（PR作業は`g4/admin-password-recovery-20260925`、TASK更新はworktree本来のbranchから）

### exact findings fixed

1. **P1 — リカバリ権限が広すぎた** → 修正。`hasRecoveryContext()`の許可リストを`recovery`・`invite`の**2つのみ**に変更（`otp`・`magiclink`を削除）。本番のrecovery/inviteが別のAMR値を出す場合は**フォームが出ず失敗側に倒れる**（汎用OTP/magic-linkへは広げない）。PKCEの`code`がrecovery/invite以外の由来でも、このAMR判定で弾かれる。
2. **P2 — 15分の鮮度確認が表示時だけだった** → 修正。新規Server Action `lib/actions/recovery-context.ts` の`verifyRecoveryContext()`（`getClaims()`で署名検証済みの`amr`を、**サーバーの時計**で判定）を、ページ表示時と**更新直前**の両方で呼ぶ。`completePasswordReset()`は真偽値ではなく検証関数を受け取り、入力検証→**その場でサーバー再検証**→`updateUser`の順。再検証がfalse・例外なら`updateUser`を呼ばない（`no_context`）。このActionは引数を取らないため、パスワードは従来どおりブラウザからSupabaseへ直接送られ、自前サーバーを経由しない。
3. **P2 — signOut失敗を完了扱いしていた** → 修正。`signOutConfirmed()`を追加し、`signOut()`がエラーを返した場合も例外を投げた場合も「ログアウト済み」とみなさない。その場合の結果は`updated_signout_unconfirmed`で、画面は入力欄を消し「パスワードは変更されましたが、ログアウトを確認できませんでした」と表示して**「ログアウトを再試行」**を出す。`/login`への移動は、ログアウトが確認できた時だけ（通常成功時／再試行成功時）。再試行も失敗した場合は「ブラウザを閉じてから新しいパスワードでログインし直す」よう案内し、セッションが消えたとは表示しない。

### final PR head

`2528b56`（`e6b93be` + 修正1 commit）。PR #33: OPEN、**MERGEABLE**（`UNSTABLE`はVercelのrate limit失敗のみ）。mainへは未merge。

### changed files（このTASK）

- `apps/admin/src/lib/password-recovery.ts`（許可リスト、`completePasswordReset`の再検証・signOut確認、`signOutConfirmed`）
- `apps/admin/src/lib/actions/recovery-context.ts`（新規、`verifyRecoveryContext` Server Action）
- `apps/admin/src/app/reset-password/page.tsx`（表示時の判定をActionへ集約）
- `apps/admin/src/app/reset-password/reset-password-form.tsx`（送信時の再検証、signOut未確認時の表示と再試行）
- `apps/admin/src/lib/password-recovery.test.ts`・`apps/admin/src/lib/admin-route-boundary.test.ts`（回帰テスト）

`forgot-password`・`/auth/confirm`・login・hash処理・PR #15のファイルは無変更。

### tests/counts（clean install）

- `node --experimental-strip-types --test src/lib/*.test.ts`: **83/83 pass**（前回73 → +10）
  - generic otp/magiclink: 表示判定で拒否（`otp`・`magiclink`・`email/signup`・`email_change`・`sso/saml`・`totp`・`token_refresh`すべてfalse）＋送信判定でも`updateUser`未実行
  - stale-open-form: 表示時は有効 → 時計を窓の外へ進める → 送信は`no_context`で`updateUser`未実行
  - 再検証が例外 → `no_context`、`updateUser`未実行
  - 再検証は入力検証の後・`updateUser`の前に1回だけ実行される
  - signOutがエラーを返す／例外を投げる → どちらも`updated_signout_unconfirmed`（「ログアウト済み」と報告しない）、`signOutConfirmed`の3パターン
  - 構造テスト: Action が`getClaims()`＋サーバー時計で判定し引数を取らないこと、フォームが表示時の真偽値を持たず送信時に`verifyRecoveryContext`を渡すこと、signOut未確認時は`/login`へ移動しないこと、移動先は`/login?reason=password_updated`のみ
- `npx tsc --noEmit`: PASS / `npm run lint`: PASS / `npm run build`: PASS / `git diff --check`: PASS
- secret scan: client bundleのJWTリテラル0件、差分に秘密値なし

### generic otp/magiclink

**拒否される**（表示時・送信時の両方）。

### submit-time freshness

**強制される**（更新直前にサーバー側で署名検証済みclaimとサーバー時計で再判定）。補足: SupabaseのAPIは有効なセッションがあれば`updateUser`を受け付けるため、利用者が本アプリを通さずにSupabaseを直接呼ぶ経路まではアプリ側では止められない（Supabase側の設定の領域）。本修正で閉じたのは「アプリのフォームを開いたまま放置した場合」。

### signOut failure behavior

エラー返却・例外のどちらでも「完了」とせず、未確認状態＋再試行ボタン。確認できた時だけ`/login`へ。

### Admin/brand regression

PR #15のbrand-boundary・brand-query-isolation・selected-brandを含む既存テストはすべてPASS。`admin_users`ゲート（layout）は無変更。公開の再設定画面はmultibrandヘルパーを使わない（構造テストで継続確認）。

### Netlify Preview（head `2528b56`）

SUCCESS。`/login`・`/forgot-password`・`/reset-password`・`/unauthorized` 200（`/unauthorized`は1回だけcurlのHTTP/2通信エラーが出たが再取得3回すべて200）。保護ルートは`/login`へ1回、loop無し。`/auth/confirm`は`?next=`を無視して固定宛先、偽・種類違いのリンクは`link_invalid`。`/reset-password`は直アクセス・エラーhash・偽トークンhash・tampered cookieのいずれでもフォーム非表示、Auth API通信0件、consoleエラー0件。

### production mutation

**0件**（merge・本番deploy・Supabase Auth設定・Auth user/`admin_users`・DB/RLS/RPCいずれも無し）。実メールは送っていない。

### exact real-E2E operator gate（未実施、別途承認が必要）

1. **アカウント**: 使い捨て、または明示的に承認されたテスト用アカウント1件（招待用にもう1件）。本番の運用アカウントは使わない。
2. **Redirect URL許可リスト**: SupabaseのRedirect URLsへ `https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm` を**一時追加**（ワイルドカード不可）。検証後に削除。`kabumori://reset-password`は残す。
3. **リカバリ1回**: Previewの`/forgot-password`から送信 → 同じブラウザでメールのリンクを開く（PKCE）→ `/auth/confirm` → `/reset-password`でフォームが出ること。
4. **招待1回**: 招待メールが`/auth/confirm`へ来るようにする（Invite templateを`{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`にするか、`redirectTo`付きで招待）。既定テンプレートのままだと`/reset-password`へ届かない。**Reset Password templateはモバイルと共用なので変更しない**。
5. **実際のAMR値の確認（最重要）**: 各フローで、発行されたセッションの`amr[].method`が`recovery`／`invite`であること。違う値ならフォームは出ない（安全側）→ 許可リストを広げる前に再レビューが必要。
6. **cookie/セッション確立**: `/auth/confirm`後に`/reset-password`でフォームが出ること（PKCEのcode verifier cookieがサーバー側で読めること、verifyOtp後のcookieがredirectに載ること）。
7. **更新後のログアウト**: パスワード更新後に`/login?reason=password_updated`へ移ること、戻って`/reset-password`を開いてもフォームが出ないこと、新パスワードでログインでき、非adminなら`/unauthorized`になること。
8. 可能なら**送信時の鮮度**も確認: リンクから15分超待ってから送信し、変更されないこと。

### readiness for another focused H1 review

**準備完了**。対象はPR #33 head `2528b56`のmain比差分（`apps/admin/src`の11ファイル）。重点: 3指摘の修正内容（許可リスト、Server Actionでの送信時再検証、signOut確認とUI）と、その回帰テスト。推奨モデル: Sol（高）。

## Completion

- status -> review_required
- next_owner -> chatgpt


## Final K4 — PR #33 auth fix round2

Verdict: **PASS**.

- all three C1 findings fixed at PR #33 head `2528b5686bcbb3630fb636cec12162803f921f8f`.
- generic otp/magiclink denied; only recovery/invite purpose accepted.
- submit-time freshness reverified server-side immediately before updateUser.
- signOut returned/thrown failure no longer reported as completed logout.
- apps/admin tests 83/83 PASS; tsc/lint/build/diff/secret scan PASS.
- PR #15 multibrand/Admin regression PASS.
- Netlify Preview PASS.
- production mutation=0; real recovery/invite E2E not yet run.
- independent H1 re-review required before merge.
