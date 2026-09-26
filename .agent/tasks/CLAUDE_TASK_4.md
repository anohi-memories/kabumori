# Claude Task 4

- task_id: x-admin-pr33-bounded-real-auth-e2e-resume-20260926
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Custom SMTP設定後、PR #33のbounded real Auth E2Eを再開し、password recovery 1回 + invite 1回を完走してmerge前の最終実証を得る。

## Context

Previous task:
- x-admin-pr33-bounded-real-auth-e2e-20260926
- result: SAFE STOP / OPERATOR GATE
- reason: custom SMTP未設定で実メールが届かず、recovery/invite E2Eを完走できなかった

User has now completed and saved Custom SMTP configuration in Supabase using a temporary Gmail SMTP setup for testing.

PR #33:
- reviewed head: `2528b5686bcbb3630fb636cec12162803f921f8f`
- source review: PASS for bounded real E2E
- Netlify Preview: `https://deploy-preview-33--shiny-kheer-77a154.netlify.app`
- PR remains unmerged

## Scope

Resume only the previously blocked real E2E.

Allowed:
- verify SMTP is now active
- one recovery email flow
- one invite email flow
- disposable/test-only Auth users
- exact Preview callback URL already present
- temporary invite-only template/config adjustment if strictly necessary
- password update on test user
- AMR/session/cookie/logout/relogin/non-admin denial verification
- cleanup/restoration afterward

Not allowed:
- PR merge
- Vercel production deploy
- real operator/Admin account changes
- admin_users grants
- wildcard redirect
- changing shared mobile Reset Password template
- DB/RLS/RPC/migration
- G3 OAuth/Vault/X work
- important-news/common-search work

## Mandatory startup

1. Read current PR #33 TASK/report chain and latest C1.
2. Fresh verify PR #33 exact head still `2528b5686bcbb3630fb636cec12162803f921f8f`.
3. Verify Custom SMTP is active without exposing credentials.
4. Do not print SMTP password, Gmail app password, JWT, cookies, auth codes, token hashes, reset links, or passwords.
5. Use independent G4 worktree/browser context.

## Recovery E2E

Use a disposable/test-only non-admin account.

1. Request exactly one password recovery email from Preview.
2. Verify email delivery.
3. Open the link in the required browser/session context.
4. Verify `/auth/confirm` -> `/reset-password`.
5. Record only actual `amr.method` name; never token contents.
6. Require reviewed recovery-purpose AMR.
7. Update to a disposable password.
8. Verify signOut succeeds.
9. Verify redirect to `/login?reason=password_updated`.
10. Reopen `/reset-password`; form must no longer appear.
11. Login with the new password.
12. Verify non-admin Admin access is denied/fail-closed.

Unexpected AMR or session behavior => STOP. Do not broaden source allowlist.

## Invite E2E

Use a separate disposable/test-only non-admin account.

Preferred:
- use an invite-specific path/config that sends the invite to the Preview callback.
- do not modify shared Reset Password template.

If a temporary invite-only template/config change is strictly necessary:
- record prior state
- make only the minimum invite-specific change
- restore it immediately after the test

Then:
1. Send exactly one invite.
2. Verify email delivery.
3. Open through Preview.
4. Record actual `amr.method`.
5. Require reviewed invite-purpose AMR.
6. Complete password setup.
7. Verify logout.
8. Login.
9. Verify non-admin Admin denial.

Unexpected AMR/session behavior => STOP.

## Cleanup

- restore any invite-only temporary config/template change
- leave existing mobile redirect and Reset Password template unchanged
- Preview callback URL may remain only if it pre-existed this task
- remove disposable users only if safe/unambiguous; otherwise clearly mark/report test-only
- verify neither test user is in `admin_users`
- verify no Admin grant or cross-brand side effect

## Completion / K4

Report:
- exact PR head / Preview
- SMTP active verification result
- recovery delivery PASS/STOP
- actual recovery AMR method
- password update/logout/relogin result
- non-admin denial result
- invite delivery PASS/STOP
- actual invite AMR method
- invite config/template temporary change + restoration, if any
- cleanup
- production/Auth mutations actually performed
- mobile redirect/template unchanged
- whether PR #33 is now ready for merge
- remaining blocker, if any
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- task_id: x-admin-pr33-bounded-real-auth-e2e-resume-20260926
- result: **STOP_UNEXPECTED_AMR (invite)** — リカバリE2EはPASS。招待E2Eで、token_hash招待リンク（`verifyOtp type=invite`）から作られたセッションの`amr.method`が`invite`ではなく**`otp`**だった。PR #33の許可リスト（`recovery`・`invite`のみ）に合わないため再設定フォームは出ず、失敗側に倒れた（安全）。TASKの「Unexpected AMR => STOP、許可リストは広げない」に従い停止。
- model_used: Opus 5.5
- PR #33 / Preview: head `2528b5686bcbb3630fb636cec12162803f921f8f`（reviewed headと一致、OPEN、未merge）、`https://deploy-preview-33--shiny-kheer-77a154.netlify.app`

### SMTP

- 操作者が一時的なGmail SMTPでカスタムSMTPを設定済み。Authentication → Emailsの「Set up custom SMTP」表示が消え、テンプレート編集が可能になったこと、テスト用アドレスへ実メールが届いたことで**有効を確認**。認証情報は表示・記録していない。

### Recovery E2E — PASS

- 配信: PASS（Preview `/forgot-password`から1回要求、Claudeのブラウザ画面で受信リンクを開いた。PKCEのため同一ブラウザ）。
- `/auth/confirm` → `/reset-password?from=email-link`でフォーム表示。
- 実`amr.method`: **直接は記録できず**。操作者がClaudeの確認前にパスワード更新まで進めたため。ただしフォームは`verifyRecoveryContext()`（`getClaims()`で`recovery`/`invite`のみ許可）が真のときだけ表示されるので、値は`recovery`か`invite`のどちらか（`otp`等ではない）。
- パスワード更新（入力は操作者）→ `/login?reason=password_updated`へ移動、session cookie 0件、`/reset-password`再訪でフォーム非表示、`/`は`/login`へ。
- 新パスワードで再ログイン（入力は操作者）→ `/`・`/posts`・`/important-news`はすべて`/unauthorized`（「管理者権限がありません」）、ブランド選択なし。パスワードでログインした状態で`/reset-password`を開いてもフォームは出ない。ログアウトでsession消去を確認。
- 非admin拒否: **PASS**（fail-closed）。

### Invite E2E — STOP

- Invite userテンプレートのみ、操作者が元の内容を控えた上でリンクを一時的に`https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm?token_hash={{ .TokenHash }}&type=invite`へ変更（Reset Passwordテンプレートは無変更）。
- **招待は計3回送信（TASKの「1回」から逸脱、操作者の操作）**: 1通目は迷惑メールに入って気づかず → 操作者がユーザーを削除して同じアドレスへ再招待（2通目は送信済みに見当たらず）→ 開いたリンクは無効判定（`/auth/confirm` → `/forgot-password?reason=link_invalid`、redirect 1回、cookie 0件、セッション作成なし＝削除済みユーザーの古いリンクと推定）→ 操作者が再度削除して3通目を送信。
- 3通目のリンクをClaudeのブラウザ画面で開いた: `/auth/confirm` → `/reset-password?from=email-link`、session確立（role `authenticated`、`aal1`）。
- 実`amr.method`: **`otp`**（`invite`ではない、発行から約57秒）。
- 結果: パスワード入力欄0件、「この画面は、パスワード再設定メールまたは招待メールのリンクから開いてください」を表示。**PR #33のままでは、token_hash方式の招待ユーザーはパスワードを設定できない。**
- 許可リストは広げていない（C1で`otp`許可は広すぎると指摘済み）。確認後、ブラウザ画面の招待ユーザーのcookieをローカルで削除。パスワード設定・ログアウト・再ログインは未実施。

### 補足（原因の見立て）

- `verifyOtp({ token_hash, type })`で確立したセッションは、typeが`invite`でもAuthサーバーが`amr`を`otp`として記録する挙動と判断。リカバリはPKCE（`exchangeCodeForSession`）経由でフォームが出たので、現行実装はPKCEのrecoveryでは通るが、token_hashのinviteでは通らない。
- token_hash方式のrecovery（テンプレートを変えた場合）も同様に`otp`になる可能性が高い。モバイル共用のReset Passwordテンプレートを変えない限り、現状のrecoveryには影響しない。

### Cleanup（操作者が実施、「片付け完了」の報告を受領）

- Invite userテンプレート: 控えておいた元の内容に戻した。
- テストユーザー: 再設定用・招待用（3通目）の2件とも削除。1・2通目の招待ユーザーも削除済み。どれも`admin_users`へは追加していない（リカバリ用ユーザーは`/unauthorized`で非adminを確認済み）。削除後に`admin_users`のread-back照会は行っていない。
- Redirect URLs: `kabumori://reset-password`、`https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`（Previewの方は本TASK以前から登録済み。操作者の判断で残している。PR #33の決着後に削除を推奨）。ワイルドカードなし。Site URLは無変更。
- モバイルの`kabumori://reset-password`・Reset Passwordテンプレート: **無変更**。
- カスタムSMTP（一時的なGmail）: 設定したまま。本番運用向けの送信元へ切り替えるかは別判断。

### production/Auth mutations

- Claude: ダッシュボードの設定・ユーザー・`admin_users`・DBはいずれも変更していない。Claudeのブラウザ画面のローカルcookie削除とログアウト操作のみ。
- 操作者: カスタムSMTP設定、テスト用ユーザー作成1件・リカバリ要求1回・パスワード更新、Invite userテンプレートの一時変更と復元、招待3回（招待ユーザー作成と削除を含む）、テストユーザー全件削除。
- merge・本番deploy・DB/RLS/RPC/migration: 0件。

### PR #33 ready for merge?

**No.** 招待（token_hash）経路で実`amr`が`otp`になるため、招待ユーザーがパスワードを設定できない。ソースの修正と再レビューが必要。

### remaining blocker

- 招待をどう安全に見分けるかの設計判断（`otp`を一律に許可するのはC1で却下済み）。

### next_recommendation

1. ChatGPT/C1で招待経路の方針を決める。候補（どれもレビューが必要）:
   - a. `/auth/confirm`で`verifyOtp(type=invite)`が成功した直後にだけ、サーバーが短時間有効の署名付き・httpOnly目印cookie（ユーザーIDに紐づけ）を発行し、`verifyRecoveryContext()`は「`amr`が`recovery`」または「`amr`が`otp`で直近15分以内かつ目印cookieのユーザーIDが一致」の場合に許可する。
   - b. 招待テンプレートを`{{ .ConfirmationURL }}`＋`redirect_to`（Previewの`/auth/confirm`）にしてPKCE/implicitでの実`amr`を再測定する（`invite`になるかは要実測）。
   - c. 招待は管理者が手動で仮パスワードを発行する運用にして、招待リンクによるパスワード設定は対象外とする。
2. 方針決定後、修正 → H1/C1レビュー → 招待1回だけの限定E2Eを再実施（今回のテンプレート一時変更手順を流用）。その際、recovery側の実`amr`（今回は直接記録できなかった）も、パスワード入力前にClaudeが確認する。
3. PR #33の決着後に、Preview用のRedirect URLを削除し、一時的なGmail SMTPを本番用の送信元へ切り替えるかを判断する。

## Completion

- status -> review_required
- next_owner -> chatgpt
