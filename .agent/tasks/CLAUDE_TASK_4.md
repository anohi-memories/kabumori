# Claude Task 4

- task_id: x-admin-pr33-bounded-invite-e2e-after-binding-secret-20260927
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: Netlify Deploy PreviewへADMIN_INVITE_BINDING_SECRETを設定後、PR #33のinvite-purpose bindingを実メール/実sessionで1回だけE2E検証する。generic OTPは許可せず、招待purpose bindingが同一user/sessionに正しく効くことを確認する。

## Current state

PR #33:
- head: `0cc48fe3ac1c376d747a74b6b31ea34990615805`
- source/tests K4: PASS
- Admin/Auth tests: 103/103 PASS
- generic otp/magiclink denied
- signed invite-purpose cookie implemented
- cookie bound to same user + same session
- TTL <= 15 minutes
- password-update success clears cookie
- missing/short secret fails closed
- PR remains unmerged

Operator actions already completed in this chat:
- Netlify env `ADMIN_INVITE_BINDING_SECRET` created as sensitive secret
- Deploy Preview context has a value
- operator retried Deploy Preview #33 from latest branch commit
- latest preview rebuild was started around 2026-09-27 19:26 JST

Important:
- Never read, print, log, expose or copy the secret value.
- Do not ask the user to paste the secret.

## Authorization

User explicitly asked to place this G4 continuation task after configuring the Preview secret.

Authorized:
- read-only verification that the new PR #33 Deploy Preview rebuild succeeded
- bounded Supabase Auth invite E2E for one disposable non-admin user
- temporary Invite User email-template adjustment only if required to point the invite to the exact PR #33 Preview callback
- send one invite
- inspect resulting session claims/AMR without exposing tokens
- verify invite-purpose cookie presence/attributes without exposing its value
- set a disposable test password
- logout/relogin
- non-admin denial verification
- restore template and delete disposable user

Not authorized:
- PR #33 merge
- Vercel production deploy
- production Admin user modification
- `admin_users` grant/mutation
- wildcard redirect
- mobile reset redirect change
- Reset Password email-template change
- service_role exposure
- DB/RLS/RPC/migration changes
- X/OAuth/Vault changes
- unrelated G3 work

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - prior G4 invite-purpose report
   - prior C1/Auth review reports relevant to PR #33
2. Use independent G4 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog index and current docs relevant to:
   - Auth invite / verifyOtp
   - sessions / getClaims
   - password update / signOut
   - email templates / redirect URLs
6. Verify PR #33 exact head is still `0cc48fe3ac1c376d747a74b6b31ea34990615805` or stop on semantic drift.
7. Do not touch G3/PR #41.

## Stage 0 — Preview preflight

Verify the newly retried Deploy Preview #33:
- build completed successfully
- exact PR #33 head is deployed
- Preview callback URL remains:
  `https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`
- no production deploy occurred
- no wildcard redirect was added
- mobile `kabumori://reset-password` redirect unchanged
- Reset Password template unchanged

Verify the secret operationally WITHOUT exposing value:
- do not log env
- do not print secret
- do not inspect raw process environment
- infer readiness from successful invite-purpose behavior only

If Preview rebuild failed, stop and report exact non-secret build reason.

## Stage 1 — disposable invite setup

Use exactly one disposable non-admin test identity/account.

Required:
- must not be an existing operator/admin account
- must not be inserted into `admin_users`
- must not receive any brand/admin privilege
- must be deletable after test

Before sending:
- capture current Invite User template text/config safely
- if current template still points somewhere unsuitable, temporarily set only the Invite User template to:
  `https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
- do not change Reset Password template
- do not change Site URL unless absolutely required; prefer template-only adjustment
- do not add wildcard redirects

Send exactly ONE invite if possible.

If the operator/API causes an accidental duplicate invite:
- do not click older links
- use only the newest valid link
- report duplicate count
- do not keep resending blindly

## Stage 2 — invite link / purpose binding verification

Open the invite link in a controlled browser/session.

Before password update, verify all of the following without exposing credentials:
- callback reaches `/auth/confirm`
- redirect reaches `/reset-password?from=email-link`
- authenticated session exists
- actual AMR contains fresh `otp`
- user `sub` present
- session_id present
- invite-purpose cookie is PRESENT
- cookie name = `__Host-kabumori-admin-invite`
- HttpOnly = true
- Secure = true
- SameSite = Lax
- Path = /
- lifetime <= 900s
- cookie value is NEVER logged/read/reported
- password form is visible

Also verify negative boundary if practical without consuming another invite:
- generic OTP without valid binding is still denied by source/test contract
- do not create a second real OTP session solely to test this

Hard stop if:
- AMR is not otp
- cookie absent
- cookie malformed by observed attributes
- form not visible
- different user/session binding suspected
- any secret/token appears in logs/output

## Stage 3 — password setup

Set one disposable test password.

Verify:
- server-side context recheck occurs immediately before update
- password update succeeds once
- invite-purpose cookie is cleared after successful update
- signOut succeeds OR safe signout-unconfirmed state is shown
- no false successful-logout message on signOut failure
- reset page revisit does not show password form
- no token_hash/auth code/JWT/password remains in URL after flow

Do not report the password.

## Stage 4 — relogin and authorization boundary

Relogin with the new disposable credentials.

Verify:
- login succeeds
- account remains non-admin
- `/`
- `/posts`
- `/important-news`
all deny Admin access / route to the established unauthorized behavior

Verify:
- no `admin_users` row was created
- no brand access was granted

Then logout and confirm session is cleared.

## Stage 5 — cleanup

Mandatory:
- restore Invite User template exactly to its prior value/config
- delete disposable Auth user
- verify no `admin_users` row exists for it
- preserve Gmail Custom SMTP configuration
- preserve existing redirect URLs
- preserve mobile reset redirect
- preserve Reset Password template
- preserve PR #33 unmerged state
- no Vercel production deploy

## Tests / source regression

Because this is an E2E continuation on unchanged source:
- rerun focused Admin/Auth tests if practical
- at minimum confirm current source head unchanged and prior 103/103 suite remains applicable
- no source edit unless a real E2E defect is found

If a defect is found:
- STOP before broadening permissions
- do not add generic otp/magiclink
- report exact observed failure
- only make a source fix under a new or explicitly continued scoped task after ChatGPT review

## Completion gate

PASS only if:
- one real invite establishes `amr=otp`
- valid signed invite-purpose binding exists for same user/session
- password form becomes available
- password update succeeds
- purpose cookie clears
- logout/relogin works
- non-admin Admin denial works
- cleanup/restoration completes
- no secret/token/password exposed
- no unintended production mutation

If all PASS:
- PR #33 becomes eligible for one final consolidated release-boundary review/merge decision.
- Do NOT merge in this task.

## Required report

Record:
- task_id
- exact PR head
- Preview rebuild result
- invite count sent
- actual AMR method
- purpose cookie PRESENT/ABSENT + attributes only, never value
- form displayed yes/no
- password update result
- cookie clear result
- signOut result
- relogin result
- non-admin denial result
- template restored yes/no
- disposable user deleted yes/no
- admin_users mutation count = 0
- source changes if any
- production/config mutations performed
- remaining blockers/risks
- whether PR #33 is ready for final release-boundary review/merge decision

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K4.

## Report

- task_id: x-admin-pr33-bounded-invite-e2e-after-binding-secret-20260927
- result: **PASS** — 実メールの招待1回で、次の一連を確認した。
  - `amr=otp`のsessionが作られる。
  - 同じuser・sessionに署名付きinvite-purpose bindingが効き、パスワード入力欄が出る。
  - サーバー再確認 → 更新 → binding消去 → ログアウトの順で処理される。
  - 再ログイン後、非adminとして拒否される。
  - 片付けまで完了。
- source変更なし。secret・token・パスワードの露出なし。
- model_used: Opus 5.5
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`

### exact PR head

`0cc48fe3ac1c376d747a74b6b31ea34990615805`（前回K4と同一、OPEN、未merge）。同じheadで`node --experimental-strip-types --test src/lib/*.test.ts`を再実行: **103/103 pass**。

### Preview rebuild result

- 操作者によるretryのbuild: Netlify deploy-previewの状態が`success`（2026-09-27 10:27Z = 19:27 JST）。
- 事前確認:
  - `/login`・`/forgot-password`・`/reset-password`・`/unauthorized`: 200
  - 偽の`token_hash`（`type=invite`、`next=https://evil.example`付き）: 307 `/forgot-password?reason=link_invalid`（外部へ飛ばない）
  - 応答で`__Host-kabumori-admin-invite`が`Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax`で消去されることを確認
- secretの準備状況は、実際の招待で目印が機能したことからのみ判断した。envの参照・表示はしていない。

### Stage 1 — invite

- Invite userテンプレート: 操作者が元の内容を控えたうえで、リンクだけを一時的に`https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm?token_hash={{ .TokenHash }}&type=invite`へ変更（Claudeが変更後の本文を確認）。Reset Passwordテンプレート・Site URL・Redirect URLsは無変更。
- テスト用アカウント: 新しい使い捨てアドレス1件（本番の運用・管理者アカウントではない）。
- **送った招待: 1回**（重複なし）。

### Stage 2 — link / binding（パスワード入力前、Claudeのブラウザ画面）

- `/auth/confirm` → `/reset-password?from=email-link`へ移動。URLにhashなし。
- 認証済みsessionあり（`authenticated`、`aal1`）。
- **実`amr.method`: `otp`**（発行から17秒）。`sub`あり、`session_id`あり（値は記録しない）。
- **invite-purpose cookie: PRESENT**（業務上の判定から確定）。
  - `otp`のsessionで入力欄が出るのは、ソース上、このuser・session向けの有効な署名付きbindingがある場合だけ。
  - JavaScriptからは見えない（`document.cookie`に無い）ので、**HttpOnlyを実地で確認**。
  - `Secure; SameSite=Lax; Path=/; Max-Age=900`: 発行と消去が同じ定数を使う（K4済みのunit・構造テスト）。消去応答の属性はPreviewで実測。発行時のSet-Cookie headerそのものは、ブラウザ画面の通信記録にページ遷移が残らないため直接は観測していない。
  - 値は読んでいない・記録していない。
- **パスワード入力欄: 表示あり**（2つ）。
- 否定側（bindingの無い`otp`は拒否）: 追加の実sessionは作っていない（TASKの指示どおり）。根拠は2つ。
  - 前回のE2Eで、binding導入前の`otp`招待sessionが実際に拒否された。
  - K4 PASS済みのテスト（cookie無し・偽造・期限切れ・別user・別session・secret無し）。

### Stage 3 — password setup

入力は操作者。Claudeはページ内のfetchの順序（URL・method・statusのみ、body無し）を記録した。

1. Server Action（`/reset-password` POST、再確認）→ 200
2. Supabase `PUT /auth/v1/user` → **200**（1回）
3. Server Action（`clearInvitePurpose`）→ **200**
4. Supabase `POST /auth/v1/logout` → **204**
5. `/login?reason=password_updated`へ移動（「パスワードを設定しました」の表示）

- 再確認は更新の直前に1回。消去は更新成功後、ログアウト前。
- 移動直前に`/login`・`/forgot-password`の先読みが中断されたが、画面移動によるもので影響なし。
- 移動後: session cookie 0件、URLにtoken・code・hashなし。`/reset-password`を開き直しても入力欄0件。
- **cookie clear**: 消去Actionは200で成功。HttpOnlyのためcookieが消えたこと自体はブラウザから直接観測できない。Set-Cookieの内容（`Max-Age=0`、同じ属性）はunit・構造テストで保証済み。
- **signOut**: 成功（204）。ログアウト未確認の表示は出ていない。

### Stage 4 — relogin / authorization

- 新パスワードで再ログイン（入力は操作者）→ 成功（`amr=password`）。
- `/`・`/posts`・`/important-news`: いずれも`/unauthorized`（「管理者権限がありません」）、ブランド選択なし。
- ログイン中に`/reset-password`を開いても入力欄は0件。
- `/unauthorized`のログアウトボタン（Claudeが押下）→ `/login`、cookie 0件、`/`は`/login`へ。
- 削除前に操作者がSQL Editorで読み取り確認: このユーザーの`admin_users`は**0行**、`brand_memberships`は**0行**。`auth.users`に行を自動で作るtriggerは無い（migration確認済み）。

### Stage 5 — cleanup（操作者、「片付け完了」を受領）

- Invite userテンプレート: 控えておいた元の内容に**戻した**。
- テストユーザー: **削除した**（`admin_users`・`brand_memberships`は削除前から0行。両tableとも`auth.users`削除でcascade）。
- 維持したもの: Gmail Custom SMTP、Redirect URLs（`kabumori://reset-password`とPreviewの`/auth/confirm`、ワイルドカードなし）、Reset Passwordテンプレート、Netlifyの`ADMIN_INVITE_BINDING_SECRET`（Deploy Previews）、PR #33の未merge状態。
- Claudeのブラウザ画面: ログアウト済み、cookie 0件。

### required fields

- invite count sent: **1**
- actual AMR method: **otp**
- purpose cookie: **PRESENT**（HttpOnlyは実地確認。Secure／SameSite=Lax／Path=/／Max-Age=900は同じ定数とテストから。値は未読・未記録）
- form displayed: **yes**
- password update result: **成功**（`PUT /user` 200、1回）
- cookie clear result: **消去Action成功（200）**。消えたことの直接観測は不可（HttpOnly）
- signOut result: **成功**（204）→ `/login?reason=password_updated`
- relogin result: **成功**
- non-admin denial result: **PASS**（3 routeとも`/unauthorized`）
- template restored: **yes**
- disposable user deleted: **yes**
- admin_users mutation count: **0**
- source changes: **なし**
- production/config mutations:
  - Claude: なし（ブラウザ画面でのログアウト操作のみ）。
  - 操作者: Invite userテンプレートの一時変更と復元、招待1回（ユーザー作成）、パスワード設定、ユーザー削除。
  - merge・本番deploy・DB/RLS/RPC・Site URL・Redirect URLs・Reset Passwordテンプレートの変更: 0件。

### remaining blockers / risks

1. **本番（Vercel）への`ADMIN_INVITE_BINDING_SECRET`設定**がmergeの前提。Previewとは別の値を推奨。未設定のまま出すと、招待だけが失敗側に倒れる（リカバリは動く）。
2. 本番で招待を使うには、Invite userテンプレートを本番のAdmin URLの`/auth/confirm?token_hash={{ .TokenHash }}&type=invite`にする必要がある。あわせて、そのURLのRedirect URLs登録を確認する。今回は一時変更して元に戻したため、**現在の本番テンプレートは元のまま**（招待は既定のSite URL宛てで、Adminのパスワード設定には届かない）。
3. リカバリの実`amr`（PKCE経由）は、2026-09-26のE2Eでは直接記録できていない（入力欄が出たことから`recovery`か`invite`のどちらかと判断）。
4. Preview用のRedirect URL、一時的なGmail SMTPは、PR #33の決着後に整理を判断する。

### whether PR #33 is ready for final release-boundary review / merge decision

**Yes**（最終のrelease-boundary review・merge判断の対象にできる）。本TASKではmergeしていない。merge時は、上記の1（本番の鍵）と2（本番の招待テンプレート・Redirect URL）を同時に扱う必要がある。

### Addendum for K4 — operator decision input (2026-09-27, after E2E PASS)

操作者（ユーザー）とのやり取りを受けて、K4判断のための追記。

**運用前提**
- 本Admin（`apps/admin`）は、操作者1人だけが使うサイトである。操作者のアカウント2種を運用するだけで、ほかの人を招待する予定はない。
- 実際に必要なのは、操作者自身が**パスワードを忘れたときのrecovery**だけ。recoveryは2026-09-26の実E2EでPASS済み。
- invite対応は、PR #33の最初の設計で、利用者数を考えずにrecoveryと同じ画面で扱う形にしたもの。今回のbinding・鍵・2回の実E2Eは、使わない機能のためのコストだった（G4の設計判断の反省点）。

**X自動投稿アプリ（`apps/social-mobile`）への流用可否 — そのままは不可**
- 仕組みが違う: social-mobileはExpo/React Nativeで、sessionは端末内（AsyncStorage）に保存する。今回のinvite-purpose bindingは、Next.jsのサーバールート（`/auth/confirm`）とhttpOnlyの`__Host-` cookieに依存するWeb専用の仕組み。
- 「招待」の意味が違う: 複数ユーザーのアプリで必要になるのは、たぶん「ブランドにメンバーを招く」機能（`brand_memberships`、role: owner/admin/member/viewer）で、アプリ内の権限の話。Supabase AuthのAdmin招待メールとは別物。
- 現状: social-mobileの認証は`signInWithPassword`のみ（`src/providers/auth-provider.tsx`）。新規登録・招待・recoveryの画面はまだ無い。
- 流用できるもの:
  - 実測で得た知見: token_hashの招待`verifyOtp`は`amr=otp`になる。汎用otpを許可せず、用途を別途サーバー側で束縛する必要がある。
  - Supabase側の運用手順: Custom SMTP、テンプレート変更、Redirect URL登録、実メールE2Eの進め方。
  - `validateNewPassword`などの小さな純粋関数の一部。

**G4の推奨（K4で判断してほしいこと）**
1. **推奨: PR #33はrecovery機能としてmerge判断する。本番ではinviteを使わない。**
   - 本番（Vercel）に`ADMIN_INVITE_BINDING_SECRET`を設定しない。
   - 本番のInvite userテンプレートも変更しない（現状のまま）。
   - この場合、inviteのコードは鍵が無いため失敗側に倒れ、入力欄を出さない（安全）。上のReportの「remaining blockers」1・2は**不要**になる。
2. 代替: inviteのコード（`invite-purpose.ts`、`/auth/confirm`のbinding発行、`clearInvitePurpose`、`netlify.toml`の例外コメント）をPR #33から削除して単純化する。source変更になるため、再テストと焦点レビューが必要。操作者は手間の少ない1を希望。
3. どちらの場合も、Netlify Deploy Previewの`ADMIN_INVITE_BINDING_SECRET`は、PR #33の決着後に削除してよい（Previewでしか使っていない）。Preview用のRedirect URL、一時的なGmail SMTPの整理も同じタイミングで判断する。
4. social-mobileでメンバー招待が必要になった時点で、アプリ用の招待（`brand_memberships`連動）を別TASKとして設計する。今回の知見はその設計の入力として使う。

## Completion

- status -> review_required
- next_owner -> chatgpt


## Final K4 — product-scope decision

Verdict: **TECHNICAL PASS, but invite is not a product requirement for the current internal Admin**.

- bounded invite E2E passed at PR #33 head `0cc48fe3ac1c376d747a74b6b31ea34990615805`.
- current Admin is operated by one owner for two internal accounts; invited users are not part of the intended product model.
- non-admin invited users cannot access the Admin anyway because `admin_users` remains the authority gate.
- the real requirement is password recovery for the owner's own Admin login.
- therefore no production invite configuration is required: do not set a Vercel invite-binding secret, do not repoint the production Invite template, and do not add invite users for this Admin.
- PR #33 should be reconsidered as a recovery-only feature before merge; invite support is unnecessary attack surface/operational complexity.
- Preview-only invite secret can be removed after the PR decision.
