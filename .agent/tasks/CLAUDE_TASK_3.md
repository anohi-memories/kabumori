# Claude Task 3

- task_id: x-social-mobile-account-deletion-correction-phase4b-20260929
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: H2 C2 FAILとなったDraft PR #52のaccount deletion設計を、P1/P2 findingsをまとめて修正する。局所パッチではなく、削除lease/state・cross-product consent・credential ownership・idempotent revoke/retryを一貫した設計として直す。

## Review source

- PR #52 reviewed head: `12146c4ab2bc635a2781b673146e1f8ad8350258`
- H2 verdict: FAIL
- production_mutation=0
- H2 report: latest section in `.agent/CODEX_REPORT_2.md`

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 report.
2. Continue in isolated G3 worktree; do not use H2 worktree.
3. Fresh fetch origin/main and inspect PR #52 divergence before changes.
4. Read current Supabase skill/docs first.
5. Re-check current official X revoke and Apple revoke guidance.
6. No production mutation.

## Must fix

### R1 — durable deletion state across reconnect / purge / auth-delete gap

Current transaction-local advisory locks are insufficient.

Required:
- introduce a durable per-user deletion state / lease / tombstone that survives HTTP/transaction boundaries.
- every relevant writer that could recreate/rotate social credentials or workspace/account state must fail closed while deletion is active, including at least:
  - X OAuth begin
  - X OAuth complete
  - posting credential refresh/rollout writers
  - posting/account creation paths relevant to this user
- deletion finalization must guard purge -> auth-user-delete gap.
- reconnect after credential snapshot must not create unrevoked new credentials.
- auth delete failure/retry must not allow workspace/account recreation.
- define explicit terminal/recoverable states and operator recovery.
- add end-to-end disposable DB/source tests for the exact R1 interleavings reproduced by H2.

### R2 — cross-product shared Auth deletion

Current social-mobile deletion deletes shared Supabase Auth and cascades Kabumori profile/data.

Required product decision in source:
- DO NOT silently delete Kabumori main-app data.
- choose one safe model:
  A. social-mobile-only deletion that removes social workspace/X data but retains shared Auth/main-app account, OR
  B. explicit global account deletion flow with full cross-product disclosure/consent and coordination.
- default to the least destructive design if product-wide consent is not explicitly established.
- UI copy and backend behavior must match exactly.
- no hidden cascade.
- document cross-product impact and remaining Kabumori-side coordination.

### R3 — ambiguous/shared Vault secret references

Required:
- before external revoke/purge, fail closed if any candidate secret ID is referenced by another workspace/account/OAuth/refresh record.
- bind deletion to a stable exact credential set.
- no cross-tenant secret deletion even under corrupt/legacy schema-valid state.
- add negative fixtures for shared/corrupt secret reference.

### R4 — missing X credential material false-success

Required:
- distinguish:
  - truly never-connected / no active X grant => deletion may proceed without revoke
  - connected account with missing required stored credential material => fail closed / operator recovery
- never record revoke complete if required token material is unexpectedly absent.
- preserve retry/idempotency.

### R5 — Apple single-use authorizationCode retry

Required:
- do not require replaying a consumed Apple authorizationCode after a later purge/auth failure.
- persist a safe durable checkpoint that Apple revoke completed, or explicitly require obtaining a fresh same-user authorizationCode on resume.
- retries must be truthful and recoverable.
- never ignore Apple revoke failure.
- UI state must not retain unusable code and present normal retry as valid.

### R6 — Edge CORS / platform support

Required:
- add correct OPTIONS/CORS behavior for web if web deletion is intended.
- if Apple browser deletion cannot satisfy the native authorizationCode requirement, disable/label that path truthfully.
- clearly declare supported deletion platforms/methods.
- no fake web support.

## Additional H2 issue — client context pinning

- deletion confirmation/reauth state must be pinned to exact user/session.
- if session/user changes between confirmation and submit, deletion must fail and require fresh reauth/confirmation.
- add regression test.

## Preserve passed boundaries

Do not regress:
- verified bearer token derives uid
- no uid from request body
- recent-auth gate
- anon/authenticated cannot execute privileged RPCs
- PUBLIC execute revoked
- safe search_path
- audit contains no raw ID/token/secret
- shared/admin/running/refreshing guards
- unknown FK dependent abort
- no production mutation.

## Tests required

Reproduce all H2 markers and make them pass safely:
- reconnect after credential snapshot
- reconnect after purge before auth deletion
- shared secret cross-tenant
- missing credential material
- Apple revoke then downstream failure then retry
- CORS preflight
- session-switch after confirmation

Run:
- full social-mobile tests
- Deno tests/check
- disposable Postgres behavior/ACL/race/rollback
- typecheck/lint
- Expo web+iOS export
- git diff --check
- secret/token/log scan
- mutation tests.

## Production constraints

No:
- migration apply
- Edge deploy
- real user/data deletion
- real Vault mutation
- real X revoke
- real Apple revoke
- provider/Auth console changes
- real X post

production_mutation=0.

## Completion / K3

Report:
- exact fixed PR #52 head
- resolution of R1–R6 + client-context issue
- chosen cross-product deletion model
- durable deletion state machine/lease design
- credential ownership invariant
- X/Apple retry semantics
- CORS/platform behavior
- changed_files/tests
- production_mutation=0
- whether ready for one final H2 acceptance review

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- exact fixed PR #52 head:
  - `002d24ac99df2fbdf4e2423c1428ccb488a79f29`（Draft PR #52、branch `claude/g3-account-lifecycle-p4`）
  - reviewed head `12146c4` に1コミットを追加したもの。
  - origin/main は24コミット進んでいるが、変更ファイル・supabase 配下とも重なりはない。
- production_mutation=0:
  - マイグレーション適用、Edge デプロイ、実データ/実ユーザーの削除、Vault の変更、X/Apple の実失効、Auth/コンソールの変更、X 投稿はいずれもなし。
  - 本番への問い合わせも、今回は行っていない。
- CI: 前回同様、Vercel の rate limit のみ（方針上ブロッカーではない）。

### resolution of R1–R6 + client-context issue
- **R1（永続的な削除状態）**:
  - 新設テーブル `social_mobile_account_deletions`（ユーザーごとの tombstone + lease）。
  - 状態は started → x_revoked → purged → finalize で行を削除。問題があれば operator_required。
  - 対象テーブル11個（brands, brand_memberships, social_accounts, social_account_oauth_states, x_account_refresh_state_v2, x_account_refresh_rollout, scheduled_posts, publish_claims, published_content_fingerprints, post_execution_logs, posting_windows）に、INSERT/UPDATE の guard trigger を追加。
    - 削除中の `u_` ワークスペースへの書き込みはすべて `SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS` で拒否する。
    - 例外は、現在の lease を持つ削除処理自身だけ（トランザクション内の設定で識別。lease はランダムでサーバー外に出ない）。
    - 既存のオンボーディング RPC（begin/complete）は**改変していない**。
  - X の失効は、DB が「今の Vault の中身の SHA-256」と一致する報告だけを受け付け、purge の直前に再確認する。ずれがあれば operator に回す。
  - finalize は、ログインの削除と tombstone の削除を同じトランザクションで行う。
  - H2 の2つの再現シナリオ（`H2_RECONNECT_AFTER_CREDENTIAL_SNAPSHOT`, `H2_PURGE_AUTH_DELETE_GAP`）は、**本物の onboarding マイグレーションを適用した**使い捨て DB で、拒否されることを確認した。
  - 本番 DB と同じ構造の同時実行テストも追加した（同じユーザーで acquire を2つ同時に実行 → 片方は in_progress。削除開始前に割り込んだ再接続 → 開始の確定後に拒否される）。
  - operator による復旧: retry / x_revoked_out_of_band / cancel。
- **R2（プロダクトをまたぐ削除）**: 下記「cross-product deletion model」を参照。
- **R3（共有・曖昧な Vault 参照）**:
  - 削除開始時に、正確な credential set（アカウントごとのシークレット ID + 検証用 verifier の ID）を束縛する。
  - 同じ ID の二重利用、他のワークスペース/アカウント/OAuth state/refresh lease からの参照、自分の lease の不一致があれば、外部呼び出しの前に `CREDENTIAL_OWNERSHIP_AMBIGUOUS` で拒否する。
  - credentials と purge の段階でも再確認する。
  - 検証用の否定データ3種: 他人と共有しているシークレット、access と refresh が同じ ID、他人のトークンを verifier に使っているもの。
- **R4（X の資格情報の欠落）**:
  - 失効が必要と判定する条件: シークレット ID がある、platform_user_id がある、または connected / identity_verified のいずれか。
  - 失効が必要なのに素材が欠けていれば `operator_required CREDENTIAL_MATERIAL_MISSING`。スキップや成功扱いはしない。
  - 一度も接続していないアカウントは、失効なしで進める。Edge 側でも防御的に、素材の無いアカウントを失効済みとして記録しない。
- **R5（Apple の使い捨てコード）**:
  - 失効に成功したら `apple_revoked_at` を永続的なチェックポイントとして記録し、再試行では Apple の処理を飛ばす（コードも不要）。
  - チェックポイントが無ければ、同じユーザーの新しいコードを事前に要求する（副作用なし）。
  - アプリは試行のたびにコードを破棄し、Apple 関連の失敗後は本人確認をやり直させる。
- **R6（CORS とプラットフォーム）**:
  - OPTIONS に 204 と CORS ヘッダーで応答し、すべての応答に CORS を付ける（http.ts）。
  - 対応範囲を明示: iOS はすべての方法、Android と web はメール/X/Google。Apple 利用者のログイン削除は「iPhoneアプリから」と表示する。
- **クライアントの文脈固定**:
  - 本人確認で、正確な {userId, sessionId(JWT session_id)} を取得し、確認をそれに固定する。
  - 画面では、現在のセッションと一致しないと確認済み扱いにしない。
  - provider はリクエストの前に不一致を `SESSION_CHANGED` で拒否する。
  - 回帰テストあり（別ユーザー、同じユーザーの新しいセッション、どちらもリクエストが送られないこと）。

### chosen cross-product deletion model
- 最も破壊的でない形: **scope = `social_and_login` は Kabumori 本体のデータ（profiles）が無い場合だけ、それ以外は `social_only`**。
  - `social_and_login`: ログイン（auth.users）と social のデータを削除する。
  - `social_only`: social のデータだけ削除し、共有ログインと Kabumori のデータは残す。Kabumori アカウントの削除は Kabumori アプリから行うよう案内する。
- preview（サーバーが判定）→ 画面の表示 → `expected_scope` の一致確認 → finalize が auth.users の行をロックして profiles を再確認し、同じトランザクションで削除する。
- 途中で Kabumori のデータが現れた場合は、ログインを残して `MAIN_APP_ACCOUNT_PRESENT` とし、結果の文言もそれに合わせる。隠れた cascade は無い。
- Apple の失効は、ログインを削除する場合だけ行う。
- 残る Kabumori 側との調整（G1/G2）: Kabumori の `account-delete` は、`brand_memberships` を持つユーザーを拒否するか、先にこの削除を実行するべき。

### durable deletion state machine / lease design
- lease は 30〜900 秒（既定 300）。すべての段階で `hold()` が lease を検証し、失敗時は `LEASE_LOST`。ユーザーごとの advisory lock で各トランザクションを直列化する。
- Edge は失敗時に lease を解放し、lease は時間切れでも自然に切れる。再試行は DB の状態から再開し、チェックポイント済みの外部操作は繰り返さない。
- 応答が失われた場合:
  - `social_and_login` の再試行は `AUTH_REQUIRED` になり、画面では「削除が完了している可能性」を表示する。
  - `social_only` の再試行は、そのまま冪等に完了する。
- 詳細は `apps/social-mobile/docs/account-lifecycle-phase4.md` の §4–7。

### credential ownership invariant
- 候補となるシークレットは、「このワークスペースの、ちょうど1つの役割」にだけ属する。
- それ以外からの参照があれば、外部呼び出しの前に拒否する。purge は束縛した set のシークレットだけを削除する。

### X/Apple retry semantics
- X: refresh → access の順で、credentials が返した素材そのものを失効させ、その指紋を報告する。x_revoked の後は二度と失効を送らない。途中で失敗した場合は lease を解放し、再試行で残りから再開する。
- Apple: 失効後にチェックポイントを記録する（上記）。記録前に失敗した場合は、新しいコードで再試行する（正直に表示）。

### CORS/platform behavior
- 上記 R6 のとおり。web で使う場合は CORS を付けて応答する。

### changed_files（`12146c4..002d24a`）
- アプリ（`apps/social-mobile/`）: `docs/account-lifecycle-phase4.md`, `src/app/account-deletion.tsx`, `src/domain/account-deletion.ts`, `src/providers/auth-provider.tsx`, `tests/account-deletion.test.mjs`, `tests/auth-boundary-regression.test.mjs`
- Edge Function（`supabase/functions/social-mobile-account-delete/`）: `delete_logic.ts`, `delete_logic_test.ts`, `index.ts`, 新規 `http.ts`, 新規 `http_test.ts`
- マイグレーション: `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`（候補を全面改訂、未適用）
- DB 検証: `supabase/tests/social_mobile_account_deletion_{fixture,behavior}.sql`, `supabase/tests/social_mobile_account_deletion_run.sh`

### tests
- 使い捨て Postgres（PG17、ローカル socket、偽データのみ、非 superuser の owner）: BEHAVIOR / ACQUIRE_RACE / RECONNECT_RACE / CLEANUP すべて PASS。
  - 本物の onboarding マイグレーション（20260919120000 と 20260922003101）を適用したうえで検証した。
  - H2 の全マーカー（R1 の2件、R3、R4、R5）に加え、ACL、scope、guard の11テーブル、Vault のローテーション、想定外の依存データも確認した。
- Deno 17/17、`deno check` の index.ts OK。
- social-mobile `npm test` 72/72、data-view 14/14、typecheck OK、lint OK、Expo export web/ios とも成功、`git diff --check` OK。
- 機密情報スキャン（追加行 + 新規ファイル）ヒットなし、console 出力なし。
- 変異テスト 23/23 検出（DB 12、Edge 7、アプリ 4）。
  - 最初、アプリの「Apple のコードを保持したまま」の変異が検出されなかった。契約テストが indexOf の -1 を見落としていたため、存在の確認を追加して検出されるようにした。
- 未実施: ログイン後の画面の表示確認（Supabase の接続設定が無いため）、実機 E2E、本番の owner/ACL の読み戻し（適用前の gate）。

### whether ready for one final H2 acceptance review
- **はい**。R1〜R6 とクライアントの問題を1つの設計として修正し、H2 の再現シナリオを DB と Edge のテストで固定した。
- H2 に重点的に見てほしい点:
  1. guard trigger の網羅性（ほかに書き込みがあるテーブルは無いか）と、本番への追加の可否（G4/dispatcher 系のテーブルに trigger を付けるため）
  2. finalize が `auth.users` を SQL で削除すること（admin API を使わない理由: profiles の確認と同じトランザクションで行うため）と、本番の owner 権限
  3. 仮定: 投稿履歴と監査記録の保持期間（オーナー/法務の判断が必要）
- STOP for K3。
