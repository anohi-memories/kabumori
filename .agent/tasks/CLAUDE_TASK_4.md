# Claude Task 4

- task_id: x-admin-pr33-invite-otp-purpose-binding-fix-20260926
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: 実E2Eで確認されたSupabase invite token_hash経路の `amr.method=otp` を安全に扱えるよう、generic otpを許可せず、invite成功直後だけ短時間有効なサーバー側purpose bindingを付与してPR #33を修正する。

## Observed production behavior

Bounded real E2E on PR #33 head `2528b5686bcbb3630fb636cec12162803f921f8f` showed:

- recovery E2E: PASS
- invite via `verifyOtp({ token_hash, type: "invite" })`:
  - session established
  - actual `amr.method = otp`
  - current reset gate correctly fails closed
  - invite user cannot set password

Do NOT solve by adding generic `otp` or `magiclink` to the allowlist.

## Required design

Implement a narrow invite-purpose binding:

1. In `/auth/confirm`, only after server-side `verifyOtp(type=invite)` succeeds:
   - obtain the authenticated user/session identity
   - issue a short-lived, signed, httpOnly, secure cookie marking **invite-purpose only**
   - bind it to the authenticated user identity
   - expiry must be no longer than the existing 15-minute recovery window
   - SameSite must be appropriately restrictive for this same-site callback/reset flow
   - do not place token_hash/auth code/JWT/password in the cookie

2. In reset authorization:
   permit password setup only when either:
   - signed fresh AMR proves `recovery`, OR
   - signed fresh AMR is `otp` AND the short-lived invite-purpose cookie is valid AND bound to the same current authenticated user.

3. The cookie must be:
   - server-generated
   - integrity protected
   - not caller-controlled
   - one-purpose only
   - cleared after successful password update
   - cleared on logout/signOut-confirmed path where appropriate
   - expired/invalid/mismatched cookie => fail closed

4. Generic OTP sessions without that server-issued invite binding must remain denied.

5. Keep the existing 15-minute submit-time freshness recheck immediately before `updateUser`.

## Security constraints

- no generic otp allowlist
- no magiclink allowlist
- no user_metadata/app_metadata for this purpose
- no client-stored boolean as authority
- no token_hash/JWT/auth code/password in cookie or URL beyond existing provider callback flow
- no service_role in client
- no admin_users mutation
- admin_users remains sole Admin gate
- no open redirect
- no account enumeration regression
- mobile reset flow unchanged
- shared Reset Password template unchanged
- G3 OAuth/Vault/X files untouched
- important-news/common-search untouched

## Secret/key handling

Prefer an existing appropriate server-only signing secret if one already exists and is suitable.
If no suitable secret exists:
- do not invent or commit one
- add a required server-only env var name and fail closed when absent
- report the exact env var name needed for Preview/production
- do not set production secrets in this task unless explicitly required for Preview verification and safely available

No secret values in source/report/logs.

## Tests

Add focused tests proving:

1. recovery AMR fresh => allowed without invite cookie.
2. generic otp + no cookie => denied.
3. generic otp + forged cookie => denied.
4. generic otp + expired cookie => denied.
5. generic otp + valid invite cookie for different user => denied.
6. generic otp + valid fresh invite cookie for same user => allowed.
7. stale otp even with invite cookie => denied.
8. invite cookie set only after successful `verifyOtp(type=invite)`.
9. unsupported callback type cannot set cookie.
10. failed/invalid invite cannot set cookie.
11. successful password update clears invite-purpose cookie.
12. signOut failure semantics remain safe.
13. existing Admin/multibrand/open-redirect/enumeration tests remain PASS.

Run:
- all `apps/admin/src/lib/*.test.ts`
- targeted callback/reset tests
- tsc
- lint
- build
- git diff --check
- targeted secret scan

## Preview verification

If the implementation needs a new server-only env var:
- report exact name
- do not expose value
- if Netlify Preview can be configured safely with an existing secret source, do so only for Preview and record it
- otherwise STOP after source/tests and request the exact operator action

Do not run another real invite E2E in this task unless Preview has the required secret/config and no further operator action is needed.

## Completion / K4

Report:
- exact design implemented
- changed files
- final PR #33 head
- tests/counts
- whether generic otp remains denied
- cookie binding/expiry/user-match semantics
- env var requirement
- Preview build/deploy status
- whether another bounded real invite E2E can start immediately
- production mutation
- remaining blockers
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

## Report

- task_id: x-admin-pr33-invite-otp-purpose-binding-fix-20260926
- result: **PASS (source/tests/Preview build) / OPERATOR GATE for invite E2E** — 招待専用の署名付きpurpose bindingを実装した。generic `otp`／`magiclink`は引き続き拒否する。PR #33 new head `0cc48fe`。Previewには新しいserver-only env varが未設定のため、招待は現在も**失敗側に倒れる**（フォーム非表示）。次の招待E2Eの前に、操作者がNetlifyへ値を1つ設定する必要がある。
- model_used: Opus 5.5
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（PR作業は`g4/admin-password-recovery-20260925`、TASK更新はworktree本来のbranchから）

### exact design implemented

1. **発行（`/auth/confirm`）**: 毎リクエストの最初に既存のinvite-purpose cookieを消す。そのうえで、**このリクエスト自身が`verifyOtp(type=invite)`に成功した場合だけ**、verifyOtpが返した新しいsessionのaccess tokenを`getClaims(token)`で署名検証する。claimsに新しい`otp`認証（15分以内）と`sub`・`session_id`があれば、cookieを発行する。
   - 値: `v1.<user id>.<session id>.<expires>.<HMAC-SHA256署名>`。token_hash・auth code・JWT・パスワードは入れない。
   - 署名鍵: server-only env `ADMIN_INVITE_BINDING_SECRET`（32 byte以上）。用途固定の文脈文字列を付けて署名。
   - cookie: `__Host-kabumori-admin-invite`、`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=900`。
   - SameSite: Strictにすると、メールリンク（cross-site）から`/reset-password`へのredirectでcookieが送られず、表示時の判定が通らない。Supabaseのsession cookieと同じLaxにした。cross-siteのsubrequest・POSTには送られない。
2. **判定（`verifyRecoveryContext` Server Action、表示時と更新直前の両方）**: `getClaims()`で検証済みのclaimsとサーバー時計で、次のどちらかの場合だけ許可する。
   - 新しい`recovery`/`invite` AMR（従来どおり、cookie不要）。
   - 新しい`otp` AMR、かつ有効なinvite cookie。有効とは、署名が一致し、期限内で、発行から15分以内、かつ`sub`と`session_id`の**両方が現在のsessionと一致**すること。
3. **消去**: `/auth/confirm`の全リクエストで消す。パスワード更新が成功した直後、signOutの前に、新しいServer Action `clearInvitePurpose()`（引数なし、消すだけ）で消す。cookieは`session_id`に紐づくので、signOut後のsessionでは使えない。
4. **secretが無い・短い場合**: 発行も受理もしない。招待は失敗側に倒れ、リカバリには影響しない。
5. 送信直前の15分再検証、signOut確認、固定のredirect先、列挙対策、`admin_users`ゲートは無変更。

### changed files

- `apps/admin/src/lib/invite-purpose.ts`（新規、server-only。`node:crypto`とsecretを使うためclient componentからはimportしない）: 発行・検証、`hasPasswordSetupAuthority`、`/auth/confirm`の処理を`confirmEmailLink`としてテスト可能な形に分離。
- `apps/admin/src/lib/password-recovery.ts`: AMR鮮度判定を`hasFreshAuthentication`・`isWithinRecoveryWindow`として共通化（許可リストは`recovery`/`invite`のまま）。`completePasswordReset`に、更新成功後に呼ぶ`clearPurposeBinding`を追加。
- `apps/admin/src/app/auth/confirm/route.ts`: cookieの消去と発行、`confirmEmailLink`経由に変更。redirect先は従来と同じ固定の2つ。
- `apps/admin/src/lib/actions/recovery-context.ts`: 判定を`hasPasswordSetupAuthority`へ置き換え、`clearInvitePurpose`を追加。
- `apps/admin/src/app/reset-password/reset-password-form.tsx`: `clearInvitePurpose`を渡すだけ。
- テスト: `src/lib/invite-purpose.test.ts`（新規）、`src/lib/admin-route-boundary.test.ts`（構造テストを更新）。
- `apps/admin/netlify.toml`（コメントのみ）、`apps/admin/.env.local.example`（変数名を空値で追加）。

### final PR #33 head

`0cc48fe3ac1c376d747a74b6b31ea34990615805`（`2528b56` + 1 commit）、OPEN、MERGEABLE、未merge。

### tests/counts

- `node --experimental-strip-types --test src/lib/*.test.ts`: **103/103 pass**（前回83 → +20）
- TASKの必須テストとの対応（`invite-purpose.test.ts`）:
  - 1. recovery AMR → cookieもsecretも無しで許可
  - 2. otp／magiclink、cookie無し → 拒否
  - 3. 偽造cookie（空、`true`、1文字削除・追加、署名無し、期限改ざん、version違い、別鍵の署名、過大長）→ 拒否
  - 4. 期限切れ → 拒否（期限ちょうどまでは許可）。1窓を超える未来期限 → 拒否
  - 5. 別ユーザー・別session宛のcookie → 拒否（どちら向きの不一致も）
  - 6. 同じユーザー・sessionの新しいcookie → 許可
  - 7. 古いotp（15分超）は有効なcookieがあっても拒否
  - 8. cookieは`verifyOtp(invite)`成功後にだけ発行され、`getClaims`は返されたsessionのtokenで呼ばれる
  - 9. recovery（token_hash）・PKCE codeでは発行されない
  - 10. verifyOtpの失敗・例外、session無し、`getClaims`の失敗・例外、古いotp、otp以外、`session_id`無し、secret無し → いずれも発行されない
  - 11. 更新成功時は `updateUser` → cookie消去 → `signOut` の順。未更新（no_context・failed）では消去しない
  - 12. signOut失敗は従来どおり`updated_signout_unconfirmed`。消去が例外でも結果は変わらない
  - 追加: secretは`ADMIN_INVITE_BINDING_SECRET`のみから読み、32 byte未満・`NEXT_PUBLIC_`版は無視。cookie属性の固定。tokenにはid・期限・署名のみ。
  - 構造テスト（`admin-route-boundary.test.ts`）: routeは最初に消去し、`outcome.invitePurposeToken`がある時だけ発行（`cookieStore.set`はこの2つのみ）。Actionは引数なしの2つだけ。formは`clearInvitePurpose`を渡す。client componentは`invite-purpose`をimportしない。`NEXT_PUBLIC_*INVITE*`は無い。`invite-purpose.ts`はlog・service_role・admin_users・table読み取り・user/app_metadataを使わない。
  - 既存のAdmin・multibrand・open-redirect・列挙対策・signOutのテストはすべてPASS。
- `npx tsc --noEmit`: PASS / `npm run lint`: PASS / `npm run build`: PASS / `git diff --check`: PASS
- secret scan: 差分にJWT・鍵・パスワードなし。`.next/static`（client bundle）に`ADMIN_INVITE_BINDING_SECRET`・`createHmac`なし。テスト内の鍵は`test-only-...`の明示的なダミー。

### whether generic otp remains denied

**Yes.** cookie無し・偽造・期限切れ・別ユーザー・別session・secret未設定の`otp`、および`magiclink`は、表示時・送信時とも拒否する。

### cookie binding / expiry / user-match semantics

- binding対象は`sub`（ユーザー）と`session_id`（その招待で作られたsession）。両方一致が必須。
- 期限は発行から900秒（= 既存の15分窓）。cookieの`Max-Age`も900秒。さらに`otp`の`amr.timestamp`も15分以内が必須（時計ずれ許容60秒は既存と同じ）。
- 不一致・期限切れ・形式不正・署名不一致（`timingSafeEqual`で比較）は失敗側に倒れる。

### env var requirement

- **`ADMIN_INVITE_BINDING_SECRET`**（server-only、ランダム32 byte以上、例: `openssl rand -base64 48`）。値はどこにも記録していない。
- 本アプリ専用の新しい鍵で、Supabase・Xの権限は持たない。既存の適切なserver-only secretはAdminアプリに無かった（従来、Netlifyのサイトは「secretを持たない」方針。`netlify.toml`のコメントに、この1つだけ例外である旨と理由を追記した）。この方針変更はChatGPTの確認対象。
- 設定場所: Netlify → Site configuration → Environment variables。ScopeにFunctionsを含め、Deploy contextはDeploy Previews（本番のVercelへの設定はmerge判断時に別途）。**`NEXT_PUBLIC_`は付けない**。設定後、Deploy Previewの再ビルドが必要（server実行時に読むため）。
- 本TASKでは設定していない。「既存のsecret source」が無く、新しい値の生成と設定は操作者の作業になるため。

### Preview build/deploy status

`0cc48fe`: Netlify deploy-preview **SUCCESS**。
- `/login`・`/forgot-password`・`/reset-password`・`/unauthorized` 200、`/`は`/login`へ307。
- `/reset-password`直アクセスでpassword入力欄0件。
- `/auth/confirm?token_hash=偽&type=invite&next=https://evil.example` → 307 `/forgot-password?reason=link_invalid`（外部へ飛ばない）。応答で`__Host-kabumori-admin-invite`が`Max-Age=0; Secure; HttpOnly; SameSite=lax`で消去されることを確認。
- `type=magiclink` → `link_invalid`。

### whether another bounded real invite E2E can start immediately

**No.** 先にNetlify Deploy Previewへ`ADMIN_INVITE_BINDING_SECRET`を設定して再ビルドする必要がある（未設定のままだと、招待は正しく失敗側に倒れ、フォームは出ない）。設定後は、前回の手順（Invite userテンプレートの一時変更 → 招待1回 → Claudeのブラウザ画面で開く → パスワード入力前にAMRとcookieの有無を確認 → 設定 → ログアウト → 再ログイン → `/unauthorized` → 片付け）で実施できる。

### production mutation

**0件**（merge・本番deploy・Supabase Auth設定・ユーザー・`admin_users`・DB/RLS/RPC・Netlify/Vercelのenvいずれも無し）。PR branchへのpushのみ。

### remaining blockers

1. Netlify Deploy Previewへの`ADMIN_INVITE_BINDING_SECRET`設定（操作者）。
2. H1/C1による本修正の焦点レビュー。
3. 招待1回の限定E2E。
4. merge前に、本番（Vercel）にも同じ変数を設定する必要がある（Previewとは別の値を推奨）。未設定のまま本番へ出すと、招待だけが失敗側に倒れる。

### next recommendation

1. H1/C1で焦点レビュー（推奨: Sol（高））。重点: cookieの発行条件（invite成功後のみ）、user＋session両方への紐付け、SameSite=Laxの妥当性、消去のタイミング、secret未設定時に失敗側に倒れること、Netlifyを「secretを持たない」方針から外れる1変数の是非。
2. レビューPASS後、操作者がNetlify（Deploy Previews、Functions scope）に`ADMIN_INVITE_BINDING_SECRET`を設定し、Previewを再ビルドする。
3. G4で招待1回の限定E2Eを実施。その際、パスワード入力前にClaudeが`amr`（`otp`の想定）とcookieの有無（値は記録しない）を確認する。

## Completion

- status -> review_required
- next_owner -> chatgpt
