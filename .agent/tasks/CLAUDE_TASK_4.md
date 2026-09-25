# Claude Task 4

- task_id: x-admin-pr33-rebase-stabilize-auth-review-prep-20260925
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: open PR #33（Web Admin password recovery / invite flow）をfresh mainへ安全に追従させ、現在のmerge conflictを解消し、既存Admin/Auth/brand境界を壊さずにsource/Preview候補として再安定化する。production Auth URL設定・merge・本番反映はこのTASKでは行わず、K4後に独立Codexレビューへ渡せる状態まで仕上げる。

## Current known state

PR #33:
- title: `feat(admin): Web password recovery and invite flow (G4)`
- branch: `g4/admin-password-recovery-20260925`
- current head: `dd66921a1578d6b54e707e5dce81eaa6ab1701af`
- state: open
- commits: 5
- changed_files: 11
- additions: 1198
- mergeable: false
- mergeable_state: dirty

Implemented already:
- `/forgot-password`
- `/auth/confirm`
- `/reset-password`
- login page password-reset entry/notice
- generic recovery response to avoid account enumeration
- fixed-origin redirect construction / no arbitrary next redirect
- recovery/invite-only confirmation flow
- recent email-link AMR requirement for reset
- sign-out after password update
- Admin authorization remains separate through `admin_users`

Prior source tests:
- auth/lib tests 46/46
- tsc/lint/build/diff PASS
These must be rerun after conflict resolution.

## Mandatory startup

1. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use a dedicated independent G4 worktree/checkout.
3. Fresh fetch `origin/main` and PR #33.
4. Confirm H1 is reviewing universal OAuth files only and there is no overlap with `apps/admin/**`.
5. Inspect exact PR #33 vs current main conflict set before changing anything.
6. Preserve all post-PR15 production Admin behavior now on main:
   - multibrand selector
   - admin_users gate
   - Kabumori/AI Lab brand isolation
   - Netlify/Vercel runtime behavior
7. Do not touch G3/H1 OAuth/Vault/migration files.

## Scope A — conflict analysis

Determine exactly why PR #33 is dirty against current main.

For every conflict:
- identify whether main or PR #33 owns the newer semantic behavior
- preserve both when non-conflicting
- do not blindly choose ours/theirs
- especially inspect login/auth/layout/proxy/runtime files changed since PR #33 branched

Produce a concise conflict map in the Report.

## Scope B — integrate PR #33 onto fresh main

Update the PR branch safely so it is based on current main semantics.

Required invariants:
- no regression to PR #15 multibrand Admin behavior
- `admin_users` remains the only Admin authorization gate
- password reset/invite never grants Admin authorization
- no service_role in browser/client
- no password/token in URL/log
- no account enumeration
- no open redirect
- normal password-login session cannot access reset-password flow
- recovery/invite link is short-lived / appropriately recent per existing design
- callback types outside allowed recovery/invite fail closed
- sign-out after password update remains
- existing mobile `kabumori://reset-password` flow outside apps/admin is untouched

## Scope C — tests

At minimum rerun:
- all `apps/admin/src/lib/*.test.ts`
- targeted recovery/invite tests
- existing PR #15 multibrand/admin boundary tests
- `npx tsc --noEmit`
- lint
- build
- `git diff --check`
- targeted secret/credential scan

Add adversarial tests if needed for:
- arbitrary `next`/redirect URL
- recovery email enumeration
- normal-login session trying `/reset-password`
- expired/stale recovery session
- wrong token type
- reused callback
- query/fragment credential leakage
- non-admin reset success followed by Admin route access denial

## Scope D — Netlify Preview

If current repo policy allows automatic PR Preview after branch update:
- verify exact updated PR head deploys successfully to Netlify
- unauthenticated `/forgot-password`, `/auth/confirm`, `/reset-password`, `/login` behavior
- no 404/5xx/redirect loop
- do not perform destructive Auth mutation merely for Preview QA

If one real recovery E2E requires production/real Auth configuration not already safely available, STOP and report the exact operator gate. Do not change Site URL/Redirect URLs in this task.

## Explicitly forbidden

- PR #33 merge
- Vercel production deploy
- Supabase Site URL / Redirect URL mutation
- Auth user/admin_users mutation
- DB/RLS/RPC/migration changes
- service_role exposure
- G3/H1 OAuth/Vault/token-refresh changes
- X API call/post/media
- important-news/common-search work
- unrelated cleanup

## Production mutation budget

- DB/schema/RLS/RPC: 0
- Auth config/user mutation: 0
- Edge deploy: 0
- X/OAuth/Vault: 0
- production Admin deploy: 0
- business-data mutation: 0

Netlify PR Preview caused by normal branch update is allowed.

## Completion / K4

Report:
- fresh main/head
- exact conflict map
- resolution decisions
- final PR head
- changed files
- tests/counts
- multibrand/Admin regression result
- security invariants
- Netlify Preview result
- production mutation=0
- remaining operator gates
- whether independent Codex Auth/security review is ready

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

Because this is Auth/security-sensitive, K4 should normally route one focused Codex review before merge.
Recommended Codex model after K4: Sol（高）.

## Report

- pending

## Report (execution)

- task_id: x-admin-pr33-rebase-stabilize-auth-review-prep-20260925
- result: **PASS** — PR #33をfresh mainへ追従（merge、force push無し）、競合1件を解消。PR #15入りのmain上でテスト・build・Netlify Preview QAすべてPASS。PR #33は**MERGEABLE**。Codex独立レビューに渡せる状態。
- model_used: Opus 5.5（TASK推奨 Opus5.5（高））
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`。PR作業はローカルbranch `g4/admin-password-recovery-20260925`（PR #33のbranch、G4作成）で実施し、TASK更新はworktree本来のbranchから`main`へ。

### fresh main / head

- fresh main（merge元）: `0735c63`（= `58e0773` + 本TASKのin_progressマーカー）。この間の`apps/admin`変更なし。
- PR #33 着手時head: `dd66921`（TASK記載どおり、5 commits、`mergeable: CONFLICTING` / `DIRTY`）
- 他slot: G3がuniversal OAuth作業中（`apps/admin`外）。`apps/admin/**`・PR #33と重なる作業は無し。

### exact conflict map

- 分岐点: `dd19994`（PR #33作成時のmain）。その後mainにはPR #15（multibrand Admin）がmerge済み。
- main側で分岐後に変わった`apps/admin`ファイル（20件）: `netlify.toml`、`(admin)/important-news|layout|page|posts`、`brand-selector.tsx`、`globals.css`、`actions/select-brand.ts`・`system-toggle.ts`、`active-brand.ts`、`admin-brands.ts`、`admin-context.ts`、`brand-boundary.test.ts`、`brand-query-isolation.test.ts`、`post-history.ts`、`recent-failures.ts`、`selected-brand(.test).ts`、`system-status.ts`、`today-scheduled-posts.ts`
- PR #33側のファイル（10件＋`netlify.toml`）: `app/auth/confirm/route.ts`、`app/forgot-password/*`、`app/reset-password/*`、`app/login/page.tsx`、`lib/password-recovery(.test).ts`、`lib/admin-route-boundary.test.ts`、および後から追加された再トリガー用の`netlify.toml`コメント（`6c2a838`/`dd66921`）
- **実際の競合: `apps/admin/netlify.toml`の1件のみ**。main側（PR #15の`f04c44a`）とPR #33側（`dd66921`）が、同じ末尾位置に「Deploy Preview再トリガー用コメント（実行時の影響なし）」をそれぞれ1行追加していた。
- login・proxy・`lib/supabase/*`はmain側で無変更。`(admin)/layout.tsx`はPR #15で変更されたが、PR #33は触れていない（自動merge）。

### resolution decisions

- `netlify.toml`: **mainの内容をそのまま採用**。PR #33側の行はPreviewを再ビルドさせるためだけのコメントで、merge commit自体がPreviewを再トリガーするため不要。結果、PR #33の`netlify.toml`差分は0になり、mainに対するPR差分は認証フローの10ファイル（追加のみ）だけになった。`[build]`/`NODE_VERSION`の実効設定はmainと同一。
- その他は自動merge結果をそのまま採用（両側が別ファイルのため、どちらかを選ぶ判断は発生していない）。PR #15のmultibrand動作（セレクタ、`admin_users`ゲート、ブランド分離）には一切手を入れていない。
- 方式: rebase＋force pushではなく、**mainをPR branchへmerge**して通常のfast-forward pushとした（履歴を書き換えない）。

### final PR head

`e6b93be`（`4b465a8` merge commit〔parents: `dd66921` / `0735c63`〕 → `e6b93be` テスト追加）。PR #33: OPEN、**MERGEABLE**（`UNSTABLE`はVercel checkのrate limit失敗によるもの）。

### changed files（このTASKでの変更）

- merge commit `4b465a8`（mainの取り込み、`netlify.toml`の競合解消）
- `apps/admin/src/lib/admin-route-boundary.test.ts`（敵対的ケースの構造テスト4件追加）

PR #33全体のmain比差分: `apps/admin/src`の10ファイル、追加のみ（+1,2xx行、削除0）。

### tests/counts（merge後のツリー、clean install）

- `node --experimental-strip-types --test src/lib/*.test.ts`: **73/73 pass**（main側PR #15までの34件 + PR #33の35件 + 今回追加4件）
  - 今回追加: 使用済み/再利用リンクはエラー経路でfailure宛先へ／パスワード設定成功後の遷移先は`/login`のみ（Adminルートへ直行しない＝非adminは`/unauthorized`で止まる）／暗黙フローのhashは`setSession`より前にアドレスバーから除去／公開の再設定画面はPR #15のmultibrandヘルパー（非adminを`/unauthorized`へ送る）に依存しない
  - 既存で網羅済み: 任意の`next`/redirect拒否、アカウント列挙対策、通常ログインセッション（`amr=password`）での再設定不可、15分失効、recovery/invite以外のtype拒否、クエリ/hash経由の認証情報漏えい防止
- `npx tsc --noEmit`: PASS / `npm run lint`: PASS / `npm run build`（ダミー公開env）: PASS（PR #15のルートとPR #33の3ルートが共存）
- `git diff --check`: PASS
- secret scan: client bundleのJWTリテラル0件、PR差分に秘密値0件

### multibrand/Admin regression result

- PR #15の既存テスト（brand-boundary / brand-query-isolation / selected-brand ほか）を含む全34件がmerge後もPASS。
- merge後のPR #33差分にPR #15のファイルは含まれない（main比で`apps/admin/src`の認証フロー10ファイルのみ）。
- Preview build（`e6b93be`）の共通CSSにPR #15のセレクタ用クラスが含まれることを確認（両PRの内容が同じbuildに入っている）。

### security invariants（確認結果）

- `admin_users`が唯一のAdmin認可ゲート: 維持（layout無変更、構造テストで固定）
- パスワード設定/招待でAdmin権限は付与されない: 維持（`admin_users`に触れるコードなし、成功後は`/login`へ）
- client側service_role: 0件
- URL/ログへのパスワード・トークン: なし（`<form>`不使用、console出力なし、hashは即除去、confirmの遷移先は自前クエリ付きの固定値）
- アカウント列挙: 不可（全応答で同一メッセージ）
- オープンリダイレクト: 不可（遷移先は固定2件、Preview上で`?next=`付きを実測）
- 通常ログインのセッションで再設定画面は使えない / 直近15分のメールリンク認証のみ: 維持
- recovery/invite以外のcallbackはfail closed: 維持（Preview上で`type=signup`等を実測）
- 更新後のsignOut: 維持
- モバイルの`kabumori://reset-password`フロー（`apps/admin`外）: 無変更

### Netlify Preview result（head `e6b93be`）

- `netlify/shiny-kheer-77a154/deploy-preview`: **SUCCESS** — https://deploy-preview-33--shiny-kheer-77a154.netlify.app
- `/login`・`/forgot-password`・`/reset-password`・`/unauthorized`: 200
- `/`・`/posts`・`/important-news`（未認証）→ `/login`（1回、loop無し）。tampered cookieでも`/login`へ
- `/auth/confirm`: 無し/`?next=evil` → `/reset-password?from=email-link`（next除去、公開ホストのまま）。偽`code`・偽`token_hash`（recovery/invite）・`type=signup`・エラーパラメータ・`next`+`redirect_to`付き → すべて`/forgot-password?reason=link_invalid`
- `/forgot-password`: 無効メール形式はローカルでエラー、Auth API通信0件
- `/reset-password`: 直アクセス・エラーhash・`type=signup` hash・偽recoveryトークンhash → フォーム非表示、hash除去、Auth API通信0件、`sb-`cookie 0件。tampered cookieでもフォールバックのみ。`Cache-Control: private,no-store`
- 404/5xx/redirect loop/consoleエラー: 0件
- 実際の再設定メール送信・Auth変更はしていない

### production mutation

**0件**（DB/schema/RLS/RPC、Auth設定/ユーザー、Edge deploy、X/OAuth/Vault、本番Admin deploy、業務データ）。PR #33はmergeしていない。Netlifyへの影響はPR branch更新による通常のPreview buildのみ。

### remaining operator gates（前回Reportから変更なし）

1. 実メールでのend-to-end確認には、Supabase Redirect URLsへ`https://deploy-preview-33--shiny-kheer-77a154.netlify.app/auth/confirm`の**一時追加**が必要（ワイルドカードは非推奨）。
2. その確認で最初に見るべき点: GoTrueがrecovery/invite由来セッションに記録する`amr`の実値（許可リスト: recovery/invite/otp/magiclink。想定外なら安全側でフォームが出ない）、および成功経路（PKCE code交換・cookie引き継ぎ）。
3. 招待メールは既定テンプレートだと`/reset-password`へ届かない（Invite templateの変更か`redirectTo`指定招待が必要。Reset Password templateはモバイルと共用のため変更しない）。
4. Site URL（`http://localhost:3000`）の移行は本番ホスト確定後。

### Codex独立レビューの準備状況

**準備完了**。レビュー対象はPR #33（head `e6b93be`）のmain比差分＝`apps/admin/src`の10ファイル。重点候補: `amr`判定の妥当性、`/auth/confirm`の固定宛先とNetlifyのredirect挙動への依存、暗黙フローhash処理、列挙対策、構造テストの網羅性。推奨モデル: Sol（高）。

## Completion

- status -> review_required
- next_owner -> chatgpt
