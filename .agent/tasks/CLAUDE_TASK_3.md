# Claude Task 3

- task_id: x-social-mobile-account-lifecycle-release-phase4-20260928
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Auth Phase 3の次として、公開前に必要なアカウント管理・アカウント削除・プライバシー/法務導線を棚卸しし、安全なsource/UI設計を実装する。production user deletionやAuth設定変更は行わない。

## Accepted source

- Auth Phase 3 PR #50 merged to main as `ff46c397018a215c53b091feaae86076b37489a7`
- Phase 3 verdict: PASS
- no additional review required for Phase 3
- production_mutation=0

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Phase 3 report
2. Independent G3 worktree/checkout.
3. Fresh fetch `origin/main`; branch from latest main including PR #50.
4. Read current official Apple App Review / account deletion / Sign in with Apple guidance and current Supabase Auth docs before making lifecycle decisions.
5. Confirm no overlap with G4 posting/backend files.
6. Read current schema/Edge/Auth code to identify what user-owned data would need deletion or retention.
7. If safe deletion requires a new privileged backend boundary, implement source-only candidate and mark independent review mandatory; do not deploy.

## Product goal

A signed-in user should have a truthful account/security area that explains:
- current login methods
- password/security actions
- X posting connection remains separate
- privacy policy / terms links if configured
- how account deletion works
- what will be deleted vs retained
- what is still unavailable before production setup

No fake deletion success.

## Scope A — release compliance inventory

Inventory current source and identify:
- account deletion availability
- privacy policy URL/config
- terms URL/config
- support/contact entry
- Sign in with Apple implications if social login is offered
- data categories linked to the authenticated user/workspace
- tables/storage/credentials that would need delete/anonymize/retain handling
- whether deletion can be self-service safely today

Document source-supported facts only; do not invent legal text or retention policy.

## Scope B — account/security UX

Extend the existing account/login-methods/security area where appropriate.

Possible user-facing entries:
- login methods
- password reset
- posting-X connection link
- privacy policy
- terms
- support/contact
- account deletion

Rules:
- missing URLs/config => show unavailable/setup-pending truthfully or omit according to product UX
- no hard-coded placeholder URLs presented as real
- no provider token/secret exposure
- no unlink unless already safe and explicit

## Scope C — account deletion contract design

Determine the safest architecture for self-service account deletion.

Requirements:
- authenticated exact-user binding
- re-authentication / recent-auth requirement where appropriate
- exact workspace/ownership handling
- do not delete another user's workspace/data
- explicitly handle multi-member workspace edge cases
- revoke/disable posting capability before destructive deletion where needed
- clean or revoke X posting credentials/Vault references safely
- define what happens to scheduled posts/history/logs
- define idempotency/retry behavior
- audit/log outcome without secrets
- fail closed on partial/ambiguous state

Prefer an Edge Function / server-side privileged boundary over exposing service_role or privileged DML to the client.

No production deploy.

## Scope D — source-only candidate implementation

If the deletion architecture is clear and can be implemented safely:
- add source-only server boundary
- add client request flow with explicit confirmation
- do not actually execute against production
- add tests using local/fake/disposable data

If the schema/ownership contract is not clear enough:
- do not force an implementation
- produce a precise blocker report and only implement the non-destructive UX/config pieces

## Scope E — privacy/terms config

Create a safe configuration layer for:
- privacy policy URL
- terms URL
- support URL/contact

Validation:
- https only for web URLs
- no secrets
- invalid/missing => unavailable, never guessed
- operator diagnostics may show status codes/booleans, not sensitive values

Do not write policy text unless an existing canonical policy exists in repo/project sources.

## G4 separation

Do not modify:
- post body/edit backend
- post detail interaction
- dispatcher RPCs
- post execution logs access
- posting retry/regenerate/approve UI

If overlap is unavoidable, STOP and report exact file/reason.

## Tests

Add focused tests for:
- config validation
- account deletion exact-user binding
- reauth/recent-auth gate if implemented
- multi-member workspace denial/handling
- posting authority/credential cleanup ordering
- idempotent repeated deletion request
- no raw token/secret exposure
- no cross-user/cross-workspace deletion
- truthful unavailable UI when backend/config missing

Run:
- full social-mobile tests
- data-view tests
- typecheck
- lint
- Expo web + iOS export
- relevant Edge/DB tests if candidate backend added
- git diff --check
- secret scan

## Production constraints

Do NOT:
- delete a real user
- delete production data
- deploy deletion Edge Function
- mutate production DB/RLS/RPC/Auth
- change provider console config
- change redirect allowlist/SMTP
- make a real X post
- expose service_role

production_mutation=0.

## Review policy

- If only UI/config/docs changes are made and no new privileged deletion boundary is introduced: no automatic independent review.
- If a new account-deletion Edge/RPC/privileged data boundary is added: independent review is mandatory before merge/deploy.
- Codex capacity is constrained; use a separate-room Claude **Opus5.5（高）** reviewer in an independent worktree first.

## Completion / K3

Report:
- release compliance inventory
- account/security UX changes
- privacy/terms/support config design
- exact deletion architecture
- whether deletion backend candidate was implemented
- data cleanup/retention assumptions explicitly marked
- changed_files
- tests
- production_mutation=0
- G4 overlap
- whether independent review is actually required
- recommended next release step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.


## Paused by user — 2026-09-28

- user requested G3/G4 to be closed at a clean stopping point.
- this TASK is **not completed** and must not be treated as PASS/done.
- current accepted base remains Auth Phase 3 merged main `ff46c397018a215c53b091feaae86076b37489a7`.
- no completion Report was present at close time.
- preserve any existing G3 branch/worktree/local changes; do not discard, stage, commit, or merge them merely because the slot is closed.
- if an active Claude session sees this update, stop creating new changes, preserve its current checkpoint, and report any uncommitted work before exit.
- resume only after ChatGPT assigns a new explicit G3 TASK or reactivates this task as `ready`.
- recommended model on resume: **Opus5.5（高）**.


## Resume checkpoint

- resume the same Phase 4 task from the preserved G3 worktree `/Users/yuya/Developer/kabumori-g3-phase1d`.
- branch: `claude/g3-account-lifecycle-p4`.
- preserve all existing uncommitted changes; do not reset, discard, or overwrite them.
- fresh-fetch origin/main before continuing and inspect divergence before any integration.
- finish the existing source-only implementation, tests, docs, and PR preparation only.
- no production mutation, deploy, migration apply, or real account deletion.
- because this task introduces a privileged account-deletion boundary, independent review is mandatory before merge.
- recommended model: Opus5.5（高）.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- branch/head:
  - `claude/g3-account-lifecycle-p4` @ `12146c4ab2bc635a2781b673146e1f8ad8350258`
  - **Draft PR #52**（https://github.com/anohi-memories/kabumori/pull/52）
  - base は main `249df4c`（一時停止前のチェックポイント。未コミット変更はすべて保持したまま fast-forward で取り込み、その上に1コミット）
- production_mutation=0:
  - 本番に対しては、カタログを読むだけの SELECT を3回実行した（データ行は読んでいない）。
  - 書き込み・マイグレーション適用・デプロイ・ユーザー削除・Auth/コンソール変更・X投稿はいずれもなし。
- CI: Vercel は「Deployment rate limited」（方針上ブロッカーではない）。

### release compliance inventory（詳細: `apps/social-mobile/docs/account-lifecycle-phase4.md` §1–3）
- **Apple の要件**（2026-09-28 に公式を確認）:
  - 5.1.1(v): アカウントを作れるアプリはアプリ内での削除が必須。無効化だけでは不可。時間がかかる場合は所要時間と完了の通知が必要。
  - Sign in with Apple 利用者は REST API でのトークン失効が必要。
  - 5.1.1(i): プライバシーポリシーのリンクが必須。1.5: 問い合わせ先が必須。4.8: ソーシャルログインを出すなら同等の選択肢が必須。
- **Supabase**: ユーザー削除は service_role を使うサーバー側でのみ可能。
- **変更前の状態**:
  - social-mobile のアカウント削除: なし。
  - social-mobile のプライバシーポリシー/規約/問い合わせ: なし。正本となる文面も repo に存在しない（Kabumori の web ページは Kabumori 専用の内容）。
  - Apple ログイン: 未有効（bundle id 未設定）。
  - social-mobile 用の Storage: なし。
- **本番（読み取り確認）の事実**:
  - `brand_memberships` は本番に**存在する**。phase4 資料と G4 Phase 3 STOP 報告の「未適用」は、この点について古い情報。
  - `social_mobile_content_settings` と `post_queue_*_v2` は存在しない。
  - `brands` / `social_accounts` / `scheduled_posts` を参照する外部キーは、`brand_memberships` と `daily_content_plans` 以外すべて NO ACTION。
  - そのため auth ユーザーだけを削除すると、`u_` ワークスペース・X アカウント行・Vault のトークン・X の認可が残る。

### account/security UX changes
- 「ログイン方法」画面に2つのカードを追加:
  - 「サポートと規約」: プライバシーポリシー/利用規約/お問い合わせ。未設定なら「準備中」。
  - 「アカウントの削除」: 削除画面への入口。
- 開発ビルドの診断に `legal:` と `account-deletion:` の状態コードを追加。
- 新しい削除画面 `account-deletion`:
  - 削除されるもの・残るもの（X に公開済みの投稿は削除されないこと、監査記録が残ること）と、即時かつ元に戻せないことを表示。
  - ①本人確認: 自分のログイン方法のうち今使えるもので再ログイン。同じユーザーでなければログアウトさせて中止。
  - ②「削除する」と入力。
  - サーバーが確定した場合だけ完了の通知を出し、この端末のログインを解除。
  - ビルドで有効にしていない間は「準備中」と表示し、問い合わせ先が設定されていればリンクを出す。

### privacy/terms/support config design
- 設定値: `EXPO_PUBLIC_PRIVACY_POLICY_URL` / `EXPO_PUBLIC_TERMS_URL` / `EXPO_PUBLIC_SUPPORT_URL` / `EXPO_PUBLIC_SUPPORT_EMAIL`（`src/domain/legal-links.ts`、`src/lib/legal-config.ts`）。
- 次のものは使えないものとして扱う: https 以外、userinfo・port 付き、example.com などの仮ホスト、localhost、`.test`、IP、ドットの無いホスト、token/key/secret/signature などを含むクエリや fragment。
- 問い合わせ先は、https のページを優先し、無ければメールアドレスを使う。
- 診断は状態コードのみで、設定値は出さない。規約などの文面は作っていない（正本が無いため）。

### exact deletion architecture（詳細: docs §4）
- Edge `social-mobile-account-delete`（JWT 検証 ON）の事前チェック（副作用なし）:
  1. 呼び出し元のトークンで `/auth/v1/user` を引いてユーザーを特定する。本文にユーザー ID は持たせない。
  2. 確認用の定数 `DELETE_MY_ACCOUNT` が必須。
  3. 直近のログインが必須（`sub` 一致かつ `amr` の最新時刻が 600 秒以内）。
  4. Apple 利用者は、Apple の鍵が設定されていなければ拒否。新しい authorizationCode も必須。
- DB 側（service_role のみ実行可、ユーザーごとの advisory lock、各段階は冪等）:
  1. `begin`: ブロック条件は ADMIN_ACCOUNT / OWNS_OTHER_WORKSPACE / WORKSPACE_NOT_SELF_SERVICE / SHARED_WORKSPACE / WORKSPACE_ROLE_MISMATCH / POSTING_IN_PROGRESS / CREDENTIAL_REFRESH_IN_PROGRESS。通過したら**まず投稿権限を停止**（ワークスペースを inactive/disabled、`publish_enabled=false`、refresh rollout を off、pending の投稿を failed）。
  2. `credentials`: begin 後に限り、本人の `u_` ワークスペースのトークンだけを返す。
  3. X の失効（refresh → access の順）。失敗したらここで停止（投稿は停止済みで、再試行しても安全）。
  4. Apple の失効: code を交換し、返ってきた id_token の sub が本人の Apple identity と一致する場合だけ失効させる。
  5. `purge`: 外部キーの順に削除し、Vault のシークレット、最後にワークスペースを削除。想定外に参照している行があれば全体を中止。
  6. auth ユーザーを削除（404 も成功扱い）。
- 監査はユーザー ID の SHA-256 と固定コードのみ。ほかのユーザーのワークスペースや共有ワークスペースには触れない。

### whether deletion backend candidate was implemented
- **はい（source-only の候補）**:
  - `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`（未適用）
  - `supabase/functions/social-mobile-account-delete/{index,delete_logic,apple_revoke}.ts`（未デプロイ）
- アプリ側は `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true` の時だけ削除を実行する。未設定なら「準備中」。

### data cleanup/retention assumptions（明示）
- 投稿の予約・履歴・実行記録・claims・fingerprints は**すべて削除する**。仮定: 法的な保持義務が無い（オーナー/法務の判断が必要）。
- 監査記録（ハッシュ + コード + 日時）は**残す**。仮定: 保持期間は未定。
- Supabase のバックアップ/ログはアプリの管理外。仮定: プライバシーポリシーで説明する。
- X に公開済みの投稿は削除しない（画面で明示）。
- 同じ auth ユーザーの Kabumori 本体側データは、`profiles` の cascade で消える。

### changed_files（`249df4c..12146c4`）
- アプリ（`apps/social-mobile/`）:
  - 変更: `.env.example`, `src/app/_layout.tsx`（ルート1行）, `src/app/login-methods.tsx`, `src/lib/auth-client-flows.ts`, `src/providers/auth-provider.tsx`
  - 新規: `docs/account-lifecycle-phase4.md`, `src/app/account-deletion.tsx`, `src/domain/account-deletion.ts`, `src/domain/legal-links.ts`, `src/lib/legal-config.ts`, `tests/account-deletion.test.mjs`, `tests/legal-links.test.mjs`
  - テスト更新: `tests/auth-boundary-regression.test.mjs`（ハーネスへのモジュール追加と挙動テスト）, `tests/multi-provider-auth-contract.test.mjs`
- Edge Function（新規）: `supabase/functions/social-mobile-account-delete/` の5ファイル
- マイグレーション（新規）: `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`
- DB 検証（新規）: `supabase/tests/social_mobile_account_deletion_{fixture,behavior}.sql`, `supabase/tests/social_mobile_account_deletion_run.sh`

### tests
- social-mobile `npm test` 71/71、data-view 14/14、typecheck OK、lint OK、Expo export web/ios とも成功、`git diff --check` OK。
- 機密情報スキャン（追加行 + 新規ファイル）ヒットなし。console 出力なし。
- Deno 13/13、`deno check` の index.ts OK。
- 使い捨て Postgres（ローカル socket、偽データのみ）で、動作・同時実行・後片付けがすべて PASS。内容:
  - 本人への厳密な束縛、ブロック6種、他ユーザーへの影響なし
  - 想定外の参照がある場合は中止し、全体を元に戻す
  - 冪等性、権限（anon/authenticated は実行不可、監査テーブルは読めない）、監査に生の ID が残らないこと
  - 同時に2回 purge しても、片方だけが実行されること
- アプリの挙動テスト（AuthProvider を実際に動かす）:
  - 200 かつ `{ok:true}` の時だけ成功扱い。失敗5パターンではログアウトしない。
  - 成功時は local のログイン解除と onboarding キーの削除を行う。
  - 本文にユーザー ID を含めない。
- 変異テスト 22/22 検出（DB 9、Edge 7、アプリ 6）。
- 未実施: ログイン後画面の表示確認（Supabase の接続設定が無く、ログイン後の画面に到達できないため）。実機 E2E。

### G4 overlap
- なし。開いている PR（G4 を含む）と変更ファイルの重複なし。
- 投稿・詳細・dispatcher・retry/regenerate/approve の UI や RPC には触れていない。
- purge が投稿関連テーブルの行を消すのは、本人の `u_` ワークスペースの行だけ。

### whether independent review is actually required
- **必須**。新しい特権境界（service_role の RPC、Vault の削除、auth admin での削除、X/Apple の失効）を追加したため。
- 推奨: 別 room の Claude **Opus5.5（高）** が独立 worktree でレビューする。
- 重点的に見てほしい点:
  1. 本番の関数の所有者が `vault.secrets` を削除できる権限を持つか
  2. X の revoke API の仕様（Basic 認証 + client_id）
  3. begin と dispatcher の競合（purge は running を再確認して拒否する）
  4. 削除する/残すデータの前提

### recommended next release step
1. 独立レビュー（上記）。
2. オーナー/法務が決めること:
   - 履歴と監査の保持期間
   - social-mobile 用のプライバシーポリシー・規約・問い合わせページ（文面はオーナーが用意）
3. 承認後に行うこと:
   - マイグレーションを1ファイルだけ適用し、読み戻しで確認する
   - Edge Function をデプロイし、バイト単位で一致を確認する
   - 使い捨てのテストアカウントで実機 E2E
   - `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true` と規約 URL を設定する
4. 別レーン（G1/G2）への提案: Kabumori の `account-delete` は、`brand_memberships` を持つユーザーを拒否するか、この境界に処理を委ねるべき。今のままでは、social-mobile も使ったユーザーのワークスペース・X の認可・Vault のシークレットが残る。


## Final K3 — Account lifecycle Phase 4

Verdict: **PASS for source-only implementation; independent privileged-boundary review mandatory before merge/apply/deploy**.

- PR #52 draft head: `12146c4ab2bc635a2781b673146e1f8ad8350258`.
- production_mutation=0.
- account/security UX, legal-link configuration, account deletion client flow, source-only deletion migration candidate and Edge Function candidate are implemented.
- privileged boundary includes service_role-only DB functions, Vault secret cleanup, auth admin user deletion, X revoke and Apple revoke.
- tests: social-mobile 71/71, data-view 14/14, Deno 13/13, disposable Postgres behavior/race/cleanup PASS, mutation checks 22/22; typecheck/lint/Expo web+iOS export/diff/secret scan PASS.
- production read-only verification confirms `brand_memberships` exists; older project notes saying it was unapplied are stale on that point.
- PR remains DRAFT and must not be merged before independent review.
- recommended independent reviewer: separate Claude Opus5.5（高） in an independent worktree.
