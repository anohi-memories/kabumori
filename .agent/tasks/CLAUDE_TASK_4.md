# Claude Task 4

- task_id: x-admin-password-recovery-invite-flow-20260925
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: X管理画面にWeb用の「パスワードを忘れた」「初回招待/パスワード設定」「リカバリ後の新パスワード設定」導線を実装し、Supabase Authのlocalhostフォールバック依存を解消する。まずsource/Netlify Previewまで。production Supabase URL Configuration変更はこのTASKでは行わない。

## Background

現在のSupabase Auth production設定:
- Site URL: `http://localhost:3000`
- Redirect URLs: `kabumori://reset-password` のみ
- `kabumori://reset-password` はモバイルアプリ用であり削除禁止
- Web Adminには現時点で `/login` と `/unauthorized` はあるが、`/forgot-password` / `/reset-password` の受け皿がない

Observed behavior:
- password recovery mail itself is delivered
- recovery link falls back to localhost when no valid Web redirect exists
- localhost destination currently reaches no valid Admin reset page
- new admin invite can also lack a usable Web password setup destination

PR #15 context:
- latest reviewed/fixed head: `de354e7ff9f647435a3c42a87629be1e735794eb`
- C2: PASS-WITH-FIX for source/Preview
- PR #15 remains unmerged because authenticated live QA is still outstanding
- this TASK may build on the current PR #15 branch only if doing so is clean and explicit; any auth-flow source change invalidates the old reviewed head and will require a fresh Codex review before merge

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read current G4/C2 PR #15 history
5. Fresh fetch origin/main and PR #15
6. Confirm dedicated independent G4 worktree
7. Confirm no overlap with:
   - G3 Phase1I files
   - H2 PR #32 personalized-reports review
   - G1/G2 mobile/report work
8. Inspect current Admin Supabase browser/server client helpers, proxy.ts, login flow, auth callback handling, env usage, tests and Netlify config
9. Do not mutate production Supabase Auth URL Configuration in this task

## Goal A — forgot-password entrypoint

Add `/forgot-password` to Admin.

Requirements:
- email input only
- use Supabase password recovery API
- construct the reset redirect from the current trusted Admin origin, not a hardcoded localhost
- target Web reset route: `/reset-password`
- never expose service_role
- never log email/token/session values
- success response must not reveal whether an account exists
- safe generic UI message after request
- sensible loading/error states
- login page should expose a visible “パスワードを忘れた” link

Do not weaken existing /login auth behavior.

## Goal B — reset-password receiver

Add `/reset-password`.

It must safely handle Supabase recovery/invite authentication material according to the current Supabase SSR/browser-client model used by this repo.

Required:
- establish/recognize the recovery session using the supported Supabase flow
- require a valid recovery/invite session before allowing password update
- new password + confirmation
- enforce at least the project-supported minimum and reasonable client-side validation without inventing a weaker policy
- call `updateUser({ password })` only after a valid session exists
- fixed/non-sensitive error messages
- no token/session/hash logging
- after success, sign out or otherwise prevent stale recovery state from being silently reused, then send user to `/login`
- direct unauthenticated visit to /reset-password without a valid recovery/invite context must fail closed and offer restart via /forgot-password

Do not expose password in URL/query/log/storage.

## Goal C — invite / first-password flow

Support Admin users created by Supabase invitation.

Preferred behavior:
- invite/recovery link can land on the same `/reset-password` page
- user sets an initial password there
- do not create a separate weaker authorization path
- do not auto-add anyone to `admin_users`
- password setup alone must never grant Admin authorization

The Admin app must continue to enforce `admin_users` after login.

## Goal D — proxy / public route boundary

Review `src/proxy.ts` and protected layout behavior.

Required:
- `/login`, `/forgot-password`, and the recovery receiver needed for `/reset-password` must be reachable without an already-valid normal Admin session
- protected Admin pages remain protected
- recovery route must not become a general bypass into protected content
- unauthorized/non-admin users must still fail closed after login
- no redirect loop on Netlify
- malformed/tampered auth material must fail closed

Add tests for route classification and redirect behavior.

## Goal E — trusted redirect origin

Do not hardcode a deploy-preview host if avoidable.

Implement a safe strategy:
- derive redirect origin only from trusted request/app origin or an explicit public Admin base URL configuration already present/approved
- HTTPS required outside localhost development
- reject malformed/external/untrusted redirect origin inputs
- no open redirect via query/header/cookie
- preview and future production origin should both be supportable without source edits

Document exact Supabase Redirect URL entries that will be required after review.

Do NOT change production Site URL or Redirect URLs in this task.

## Goal F — Netlify Preview validation

Create/update a PR or PR #15 branch as appropriate and obtain Netlify Deploy Preview.

Verify on exact candidate head:
- /login renders
- /forgot-password renders
- /reset-password direct visit fails safely when no recovery context exists
- protected / and /posts remain fail-closed
- no 404 / 5xx / redirect loop
- Next.js Runtime handles new routes
- no secret-bearing build output

Do not send a real password-recovery email unless explicitly authorized later.
Do not use or record user passwords/tokens.

## Goal G — tests

At minimum:
- forgot-password generic success/no-account-enumeration behavior
- trusted redirect origin builder
- rejects external/open-redirect attempts
- reset page requires recovery/invite session
- password mismatch/invalid length fails locally
- updateUser called only with valid recovery session
- success cleanup/redirect
- invite path uses same safe receiver
- non-admin password setup does not grant admin
- existing login/proxy/admin gate regressions
- selected-brand / brand-boundary regressions from PR #15 if working on that branch
- tsc --noEmit
- lint
- build
- git diff --check
- targeted secret scan

No real Auth mutation in automated tests; use mocks/fakes.

## Supabase configuration handoff — document only

Produce exact operator instructions for the later reviewed rollout.

Must distinguish:
1. Mobile redirect that must remain:
   - `kabumori://reset-password`
2. Web Admin Preview redirect:
   - exact Netlify preview reset URL for the final candidate
3. Future Web Admin production reset URL
4. Site URL migration away from `http://localhost:3000`

Do not apply any of them yet.

## Security requirements

- no service_role in browser/client bundle
- no token/password/session logging
- no account enumeration
- no open redirect
- no auto-admin grant
- no RLS/Auth policy weakening
- password setup does not imply authorization
- recovery links are single-purpose and fail closed outside their intended context
- preserve mobile reset redirect support

## Forbidden

- production Supabase Site URL change
- production Redirect URLs change
- Auth user password mutation
- adding/removing `admin_users` rows
- production DB/schema/RLS/RPC change
- service_role exposure
- merge PR #15 or any auth PR
- Vercel production deploy
- Netlify production config mutation
- DNS/custom-domain change
- X OAuth/Vault/token/post mutation
- G1/G2/G3 source changes

## Production mutation budget

0.

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

Report:
- fresh main / base branch / PR
- exact candidate head
- auth-flow architecture
- changed files
- public/protected route behavior
- recovery/invite handling
- trusted redirect-origin model
- tests/counts
- Netlify Preview URL/status
- exact Supabase URL Configuration handoff, not applied
- production mutation=0
- remaining risks
- next recommendation

Because this is an Auth/security change, expect independent Codex review before any merge or Supabase URL Configuration mutation.

STOP for K4.

## Report

- task_id: x-admin-password-recovery-invite-flow-20260925
- result: **source + Netlify Preview完了（review_required）**。Admin Webに`/forgot-password`・`/auth/confirm`・`/reset-password`を実装し、PR #33としてDeploy Preview上でlive QA済み。Supabase URL Configurationは**未変更**（handoffのみ）。認証/セキュリティ変更のためmerge前にCodex独立レビューが必要。
- model_used: Opus 5.5（TASK推奨 Opus5.5（高））
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`。実装はfeature branch `g4/admin-password-recovery-20260925`（upstream未設定にしてmainへの誤pushを防止）で行い、TASK更新はworktree本来のbranchから`main`へ。

### fresh main / base branch / PR

- 着手時fresh main: `be6727e`（in_progress push後 `dd19994`）。Report時点 `e22d067`。`apps/admin`と本TASKへの上流変更は0件。
- **base: `main`（PR #15のbranchには載せていない）**。理由: (1) TASK記載どおり認証変更をPR #15に載せるとC2レビュー済みhead `de354e7`が無効になる、(2) PR #15の変更ファイル（`(admin)/*`・`brand-selector`・`globals.css`・data modules等）と今回の変更ファイルが**1件も重ならない**（`globals.css`も既存クラスのみで回避）。
- **PR #33**: https://github.com/anohi-memories/kabumori/pull/33 （base `main`、MERGEABLE、未merge）
- 他slotとの重なりなし（G2/H2=personalized-reports、G3=x-test-post Phase1I）。

### exact candidate head

`e2e1ff52a99e37d108a0f9a1f024dc507a7bedaf`（3 commits: `db07f19` 実装 → `36b7a09` / `e2e1ff5` live QAで見つかったredirect問題の修正、下記）。

### auth-flow architecture

- `/forgot-password`（公開）: メールのみ入力。`resetPasswordForEmail(email, { redirectTo: <配信中origin>/auth/confirm })`。Supabaseの応答（成功・未登録・rate limit・5xx）は**すべて同一の汎用メッセージ**（アカウント列挙不可）。入力不正・origin不信・通信不能のみ別表示（いずれもアカウント非依存）。`<form>`を使わない（GET送信でURLへ値が漏れる経路を作らない、既存loginと同方針）。
- `/auth/confirm`（公開route handler）: PKCE `code` は`exchangeCodeForSession`、`token_hash`+`type=recovery|invite`は`verifyOtp`で**サーバー側で**セッション確立し、固定の遷移先へ307。`next`/`redirect_to`は一切解釈しない。その他のtype・エラーパラメータ・不正形式はfail closed。
- `/reset-password`（公開）: `getClaims()`で**検証済みJWT**の`amr`を確認し、**直近15分以内のメールリンク系認証（recovery/invite/otp/magiclink）**がある場合のみフォームを表示。通常のパスワードログインのセッション（`amr=password`）では表示しない＝開いたままのAdminセッションからリンク無しでパスワードを変えられない。`updateUser({ password })`成功後に`signOut()`し、`/login?reason=password_updated`へ（`location.replace`で履歴に残さない）。
- 暗黙フロー（Supabase既定の招待テンプレートはトークンをURLハッシュで渡す）: `/reset-password`のクライアント側フォールバックが`recovery`/`invite`のハッシュだけを受理し、**処理前にアドレスバーからハッシュを除去**、`setSession`後にページを再読込してサーバー側で再判定。
- `/login`: 「パスワードを忘れた」リンクと、更新完了後の案内表示を追加。
- セキュリティ判断はすべて`src/lib/password-recovery.ts`の純粋関数に集約（fakeでテスト可能）。

### changed files（PR #33、すべて`apps/admin/src`、追加のみ）

- `app/auth/confirm/route.ts`（新規）
- `app/forgot-password/page.tsx`・`forgot-password-form.tsx`（新規）
- `app/reset-password/page.tsx`・`reset-password-form.tsx`・`recovery-link-fallback.tsx`（新規）
- `app/login/page.tsx`（リンクと完了案内の追加のみ）
- `lib/password-recovery.ts`（新規、純粋ロジック）
- `lib/password-recovery.test.ts`・`lib/admin-route-boundary.test.ts`（新規）

`proxy.ts`・`lib/supabase/*`・`(admin)/layout.tsx`・`globals.css`は無変更。

### public/protected route behavior

- 公開: `/login`・`/forgot-password`・`/reset-password`・`/unauthorized`・`/auth/confirm`（いずれも`(admin)`グループ外）。
- 保護: `(admin)`配下（`/`・`/posts`・`/important-news`）は従来どおり`(admin)/layout.tsx`がsession＋`admin_users`を強制。`proxy.ts`はsession更新のみでredirectしないため、公開ルートへのredirect loopは構造的に発生しない。
- `admin-route-boundary.test.ts`で固定: `(admin)`外のページは許可リストの4件のみ／route handlerは`auth/confirm`のみ／layoutのsession・`admin_users`チェックが残っていること／proxyがredirectしないこと／リカバリ系ファイルがテーブルを読まない・`admin_users`に触れない・service_roleを使わない・logを出さない・`<form>`を使わない／`/auth/confirm`がリクエストから遷移先を取らず固定2宛先のみ。
- PR #15の`(admin)/layout.tsx`（`de354e7`）も上記の検査パターンをすべて満たし、`(admin)`外のページ・route handlerを追加しないことを確認済み → **両PRをmergeしても構造テストは成立**。

### recovery/invite handling

- パスワード設定は**Admin権限を一切付与しない**。成功後はsignOut→通常ログイン→layoutの`admin_users`判定（無ければ`/unauthorized`）。`admin_users`への追加処理は存在しない。
- 招待とリカバリは同じ受け口（`/auth/confirm`→`/reset-password`）を使い、弱い別経路は作っていない。
- token/code/session/password/emailのログ出力なし。パスワードはURL・query・storageに出さない。

### trusted redirect-origin model

- `redirectTo`のoriginは**実際にアプリを配信しているorigin（`window.location.origin`）のみ**。query/header/cookieからは取らない。https必須（loopbackのhttp開発のみ例外）、パス・query・fragment・認証情報付き・大小文字違いは拒否。宛先は固定`/auth/confirm`。
- previewと将来のproductionはソース変更なしで両対応（origin由来）。最終防御線はSupabase側のRedirect URL許可リスト。
- 新しいenv varは追加していない（Netlify envは既存の公開2件のまま）。

### live QAで発見・修正した問題（重要）

1. 初版（`db07f19`）: `/auth/confirm?next=https://evil.example` → `/reset-password?next=https%3A%2F%2Fevil.example`。遷移先は同一originの固定パスでオープンリダイレクトではないが、**元のクエリが引き継がれていた**。Next.jsは相対`Location`を返しており（`node_modules/next`の該当コードで確認）、Netlifyランタイムが元クエリを付け直していた。成功時には消費済みの`code`/`token_hash`が再設定ページのURL・履歴に残るところだった。
2. 1回目の修正（`36b7a09`、`request.url`から絶対URL）をlive検証したところ、**クエリは依然引き継がれ**、さらに**Locationがdeploy固有のpermalinkホスト（`<deploy-id>--shiny-kheer-77a154.netlify.app`）を指していた**。cookieはホスト単位のため、この修正のままだとセッションが`/reset-password`に届かず再設定が必ず失敗する回帰だった。
3. 最終修正（`e2e1ff5`）: 遷移先を「相対パス＋固定の自前クエリ」（`/reset-password?from=email-link`・`/forgot-password?reason=link_invalid`）に変更。live検証で**公開ホストのまま・元クエリ引き継ぎ無し**を確認（Netlifyは自前クエリを持つLocationには元クエリを付けないことを同Previewで実測）。テストで2定数と「route handlerはこの2宛先にしかredirectしない」ことを固定。

### tests/counts

feature branch head `e2e1ff5`、`apps/admin`でclean install済み環境：

- `node --experimental-strip-types --test src/lib/*.test.ts`: **47/47 pass**（既存12 + 新規35）。Auth呼び出しはすべてfake、実Auth変更なし。
  - 列挙対策（全Supabase応答→同一"sent"）、trusted origin（許可/拒否各種）、固定redirect・オープンリダイレクト拒否、recovery/invite以外のlink typeのfail closed、hashのrecovery/invite限定、fragment session確立、recovery context（password AMR拒否・15分失効・不正AMRのfail closed）、パスワード検証（空・短すぎ・72byte超・不一致）、無効入力/文脈無しでは`updateUser`を呼ばない、成功時`updateUser`→`signOut`の順序、失敗時の非完了、signOut失敗時も完了扱い、構造テスト8件。
- `npx tsc --noEmit`: PASS
- `npm run lint`: PASS（初回に出たreact purity指摘と`location.assign`警告は修正済み）
- `npm run build`（ダミー公開env）: PASS。新規3ルートはいずれも動的（`ƒ`）。
- `git diff --check`: PASS
- secret scan: PR差分に秘密値0件。ビルド成果物の`sb_secret`一致はsupabase-jsライブラリのキー形式判定コード（`startsWith("sb_secret_")`）の文字列リテラルのみで、値・JWTリテラルは0件。
- PR #15ブランチ上ではないため、selected-brand系の回帰は対象外（既存brand-boundaryテスト5件はmain上で継続PASS）。

### Netlify Preview URL/status

- `netlify/shiny-kheer-77a154/deploy-preview`: **SUCCESS**（head `e2e1ff5`）— https://deploy-preview-33--shiny-kheer-77a154.netlify.app
- live QA（head `e2e1ff5`）:
  - `/login` 200（「パスワードを忘れた」リンク表示）／`/forgot-password` 200／`/reset-password` 200（フォールバック表示）／`/unauthorized` 200
  - `/`・`/posts`・`/important-news`（未認証）→ 307 → `/login`、redirect 1回、loop無し
  - `/auth/confirm`: 無し→`/reset-password?from=email-link`／`?next=evil`→同左（next除去）／偽`code`・偽`token_hash`(recovery/invite)・`type=signup`・エラーパラメータ・`next`+`redirect_to`付き → すべて`/forgot-password?reason=link_invalid`。**すべて公開ホスト`deploy-preview-33--...`のまま**。
  - `/forgot-password`: 無効メール形式 → ローカルエラー表示、**Auth APIへのリクエスト0件**、`<form>`無し、URL変化無し。
  - `/reset-password`: 直アクセス・`?from=email-link`・エラーhash・`type=signup` hash・偽recoveryトークンhash → いずれもフォーム非表示、該当メッセージ、**hashはアドレスバーから除去**、Auth API呼び出し0件、`sb-`cookie設定0件。tampered session cookieでもSSRはフォールバックのみ。`Cache-Control: private,no-cache,no-store`。
  - consoleエラー0件。
- **実際の再設定メール送信・実パスワード変更は行っていない**（TASK指示どおり）。偽の`code`/`token_hash`で`/auth/confirm`を叩いた検証は、誰でも実行できる無効トークンの検証要求で、Auth状態は変化しない。

### exact Supabase URL Configuration handoff（**未適用**、レビュー後の操作者向け）

1. **モバイル用redirect（必ず残す）**: `kabumori://reset-password`
2. **Web Admin Preview用（今回の候補を実メールで検証する場合）**: `https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`
   - **deploy-preview用のワイルドカード（例 `https://deploy-preview-*--shiny-kheer-77a154.netlify.app/**`）は推奨しない**。このrepoはpublicで、fork PRのDeploy Previewが同じsite上に作られる設定の場合、第三者のコードが動くpreviewが許可リストに入ってしまうため。検証が必要なPRごとに完全一致で追加し、検証後に削除する運用を推奨。
3. **将来のWeb Admin production**: `https://<Admin本番ホスト>/auth/confirm`（本番ホストは現状Vercel上のadmin。移行先確定時に確定値を記入）
4. **Site URL**: `http://localhost:3000` → `https://<Admin本番ホスト>`（originのみ、パス無し）。モバイルはリクエストごとに`redirectTo=kabumori://reset-password`を指定し、それが許可リストにある限りSite URL変更の影響を受けない。
5. **招待メールについて（重要）**: Supabaseダッシュボードの「Invite user」は既定テンプレートだと招待後に**Site URLのルート**へ（hashトークン付きで）飛ぶ。ルート`/`は保護ルートのため`/login`へ転送され、`/reset-password`には届かない。次のいずれかが必要:
   - (推奨) Invite templateを `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite` に変更（サーバー側`verifyOtp`、別ブラウザでも有効）。**ただしモバイルアプリが招待機能を使っていないことを事前に確認すること**。
   - または Admin API の`inviteUserByEmail(email, { redirectTo: 'https://<Admin本番ホスト>/auth/confirm' })`で招待する。
   - **Reset Password templateはモバイルと共用のため変更しない**（`{{ .ConfirmationURL }}`のまま、リクエストごとのredirectToが効く）。
6. /forgot-password経由（PKCE）は**要求したのと同じブラウザでメールのリンクを開く必要がある**（画面にも案内済み）。

### production mutation = 0

Supabase Site URL / Redirect URLs / email template：未変更。Auth userのパスワード変更・`admin_users`変更・DB/RLS/RPC変更：0件。service_role露出：0件。Vercel production・Netlify production設定・DNS：変更0件。X/OAuth/Vault/token：変更0件。Netlifyへの操作はPR #33のDeploy Preview（GitHub連携による自動build）のみ。

### remaining risks

1. **`amr`の実際の値がlive未検証**: supabase-jsの型定義上の既定一覧に`recovery`/`invite`が無く、GoTrueがrecovery/invite由来セッションに記録する`amr.method`の実値（`recovery`/`invite`/`otp`のいずれか）を、実メール送信なしには確認できなかった。許可リストは`recovery`/`invite`/`otp`/`magiclink`。想定外の値だった場合は**フォームが出ずfail closed**（安全側）だが、再設定フロー自体が止まるため、承認済みの実メール検証で最初に確認すべき項目。
2. **成功経路（実メール→`/auth/confirm`→`/reset-password`→更新）はlive未検証**: `exchangeCodeForSession`がPKCE code verifier cookieをサーバー側で読めること、`verifyOtp`後のcookieがredirectに載ること（Next.jsのコードでは確認済み）を、実メールで確認する必要がある。
3. **Netlifyのredirect挙動への依存**: 「自前クエリを持つLocationには元クエリを付けない」ことは同Previewで実測したが、Netlify側仕様変更時に再発しうる。テストは定数を固定しているのみで、Netlify挙動そのものは検証できない。本番（Vercel）移行時も同様の確認を推奨。
4. 招待メールの既定テンプレートでは`/reset-password`に届かない（handoff 5）。テンプレート変更か`redirectTo`指定の招待が必要。
5. Supabaseプロジェクト側のパスワード最小長設定は未確認（クライアント下限8文字、サーバー側は`updateUser`が独自に強制し、違反時は固定メッセージ）。

### next_recommendation

1. **Codex独立レビュー（H枠）**: 認証/セキュリティ変更のため必須。重点: `amr`判定の妥当性、`/auth/confirm`の遷移先固定とNetlify挙動への依存、暗黙フローhash処理、列挙対策、構造テストの網羅性。推奨モデル: Sol（高）以上。
2. レビュー後、**承認された範囲でSupabase Redirect URLsに`https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`を一時追加**し、テスト用アカウント1件で実メールによるend-to-end検証（リカバリ＋招待）。特にremaining risk 1（amrの実値）と2（成功経路）を確認。検証後は一時エントリを削除。
3. その後にSite URL移行・本番Redirect URL・招待テンプレート変更を、本番ホスト確定と合わせて別TASKで実施。
4. PR #15とは独立してmerge可能（ファイル重複なし、構造テストも両立確認済み）。

## Completion (password recovery/invite flow — PR #33 preview QA done, Codex review required)

- status -> review_required
- next_owner -> chatgpt
