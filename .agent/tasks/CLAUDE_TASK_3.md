# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-rollout-stage1-20260929
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: accepted account-deletion sourceをproductionへStage 1反映する。**migrationの単一ファイル適用・read-back・Edge Function deploy・source identity確認・非破壊smokeまで**。実ユーザー削除、実X/Apple revoke、アプリ機能有効化はまだ行わない。

## Accepted basis

- PR #52 accepted head: `4bc819555c07c8792f5b78ea29aa6b9a35694042`
- squash merge: `136dcd2b35b161ccc4769da15b05e796f095e881`
- final H2 source verdict: PASS
- production preflight result: `READY_FOR_ROLLOUT_WITH_OPERATOR_GATES`
- runbook: `apps/social-mobile/docs/account-deletion-rollout-runbook.md`
- migration:
  `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`
- expected sha256:
  `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657`

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 preflight Report
   - latest H2 PASS report
   - rollout runbook
2. Fresh independent G3 worktree from latest `origin/main`.
3. Read current Supabase skill/changelog/docs.
4. Confirm no G4/H-slot overlap on same migration/Edge/Auth boundary.
5. Recompute migration SHA and require exact match.
6. Re-run all sanitized pre-apply read-only checks from runbook.
7. If any STOP condition fires, **do not apply**.

## Stage 1A — production migration apply

Apply only the exact accepted migration file.

Rules:
- single-file only
- atomic transaction
- lock timeout + statement timeout
- **never `db push`**
- never migration repair
- no unrelated migration
- no manual SQL edits during apply

Immediately after apply run the full read-back checks from the runbook.

Required PASS:
- expected function inventory/body identity
- owners as expected
- safe search_path
- anon/authenticated EXECUTE denied
- service-role execute surface only where intended
- state/audit table protections correct
- all expected guard triggers present/enabled
- no unexpected trigger/FK/object collision
- isolation assumptions unchanged

If read-back differs:
- STOP
- do not deploy Edge
- use only the documented rollback/recovery plan when safe
- do not improvise destructive cleanup.

## Stage 1B — Edge Function deploy

Only after Stage 1A PASS.

Deploy:
`social-mobile-account-delete`

Requirements:
- JWT verification remains enabled
- no secret values printed/logged
- required configuration names checked, values not exposed
- do not add missing Apple production configuration in this task
- Apple path remains fail-closed if not configured

After deploy:
- confirm deployed source corresponds to accepted main source
- perform safe source/byte identity comparison where supported
- verify function status/metadata
- verify CORS/OPTIONS and unauthorized/invalid-request behavior only
- smoke checks must be non-destructive.

## Allowed smoke checks

Allowed:
- OPTIONS/CORS
- missing/invalid Authorization => safe reject
- malformed/non-destructive request => safe reject
- feature remains disabled in app

Forbidden:
- valid disposable-user deletion
- auth user deletion
- Vault mutation
- X revoke
- Apple revoke
- X post
- enabling `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED`

Real E2E belongs to Stage 2.

## Safety constraints

- Do not expose secrets/tokens/passwords/Authorization headers.
- Do not change provider consoles.
- Do not change X/Apple credentials.
- Do not modify Kabumori main-app account-delete in this room/task.
- Do not touch unrelated migrations/functions.
- Do not broaden to posting backend.
- Protect other slots/worktrees.

## Completion / K3

Report:
- result: PASS / STOP / ROLLED_BACK
- fresh main commit
- pre-apply recheck result
- exact migration SHA
- apply status
- production read-back result
- rollback performed? yes/no
- Edge deploy status/version/identity confirmation
- non-destructive smoke results
- production mutations actually performed
- explicit confirmation that no real user deletion / X or Apple revoke / feature activation occurred
- remaining Stage 2 E2E/operator/legal gates
- safety_checks
- next_recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Because this is a production DB/Auth/Vault/Edge boundary, after K3 PASS ChatGPT should route one focused H2 production-verification review before Stage 2 activation.

推薦モデル：**Opus5.5（高）**

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- **result: PASS**（Stage 1A の適用・読み戻し、Stage 1B のデプロイ・同一性確認・非破壊の動作確認まで、すべて合格）
- fresh main commit: 開始時 `d07c100`（`39aa203` で in_progress 化）
- ユーザーの確認: 本番を変更する直前に、ユーザーから明示的に承認を得た（「実行する（①→②）」）。
- 機密情報の扱い: 前回の方針（sanitized publication）に従い、本番のセキュリティ上の詳細はリポジトリに記録していない。

### pre-apply recheck result
- 手順書 §2 の読み取り確認（sanitized）を18項目実施し、すべて preflight の時と変わらなかった。確認した主な内容:
  - 実行ロールの権限、分離レベル、衝突の有無、11テーブルの RLS と trigger 権限
  - 既存トリガーとその関数の md5、外部キーの数、ワークスペースを作る経路
  - オンボーディング RPC の md5、INSERT policy / grant、Storage、cron
- migration の履歴は、`20260928160000` が未適用（remote が空）のままだった。Edge 関数も未デプロイだった。
- ほかのスロットや開いている PR で、同じ migration / Edge / Auth の境界に触れるものは無かった。

### exact migration SHA / apply status
- `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`
  - sha256: `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657`（一致）
- 適用方法: `begin; set local lock_timeout='5s'; set local statement_timeout='60s'; <上記ファイル>; commit;` を `supabase db query --linked --file` で1回だけ実行した。エラーは無く、1トランザクションで完了した。
- `db push`、migration repair、ほかの migration、SQL の手直しは、いずれもしていない。

### production read-back result
- 手順書 §4 の読み戻しは、すべて PASS:
  - 21関数の md5 が期待値表と一致、owner は postgres、search_path は `""`。
  - anon / authenticated の EXECUTE は0件、service_role の EXECUTE は意図した10関数だけ。
  - 状態テーブルと監査テーブルは RLS 有効で、どのクライアントロールにも権限なし。
  - guard trigger が11テーブルすべてで有効、行数は0。
- 変わっていないこと:
  - 既存のトリガー、外部キーの構造、オンボーディング RPC の md5、分離レベルの設定、ワークスペースを作る経路（レビュー済みの RPC 1つだけ）、関数 owner の権限。
  - 新しく増えたオブジェクトは、すべてこの migration のものだけだった（関数21・trigger11・テーブル2と、それに付くインデックスなど）。
- rollback performed: **no**（不要だった）。

### Edge deploy status / identity
- `social-mobile-account-delete`: ACTIVE、**verify_jwt=true**、version 1、entrypoint は `index.ts`。
- `config.toml` と project_id を確認した G3 専用の作業用フォルダからデプロイした。アップロードされたのは、`index.ts` / `http.ts` / `delete_logic.ts` / `apple_revoke.ts` の4ファイルだけ（テストファイルは含まない）。
- デプロイ後、別の scratch ディレクトリに download して、4ファイルとも受け入れ済みのソース（= `4bc8195`）と**バイト単位で一致**することを確認した。
- 設定: 名前だけを確認し、値は表示・記録していない。Apple の本番設定は追加していないので、Apple の経路は最初から拒否する状態のまま。
- ほかの関数のバージョンは変わっていない。

### non-destructive smoke results
| # | request | result |
| --- | --- | --- |
| 1 | OPTIONS (preflight) | 204、CORS の allow-origin / allow-headers / allow-methods あり |
| 2 | POST、Authorization なし | 401（ゲートウェイ） |
| 3 | POST、不正な JWT | 401（ゲートウェイ） |
| 4 | POST preview、公開用 anon キー（ユーザーではない） | 401 `AUTH_REQUIRED`（関数） |
| 5 | POST delete、公開用 anon キー（ユーザーではない） | 401 `AUTH_REQUIRED`（削除処理には入らない） |
| 6 | POST、不正な action | 400 `ACTION_REQUIRED` |
| 7 | GET | 405 `METHOD_NOT_ALLOWED` |
- smoke の後も、状態テーブルと監査テーブルは0行（削除処理は一度も始まっていない）。
- 公開用キーは変数で扱い、出力や記録には残していない。

### production mutations actually performed
1. migration `20260928160000` の適用（新しい関数21、テーブル2、guard trigger 11）
2. Edge 関数 `social-mobile-account-delete` の新規デプロイ（version 1）
- ほかの変更はしていない。

### explicit confirmation
- 実ユーザーの削除: **なし**
- X の失効 / Apple の失効: **なし**
- Vault の変更: **なし**
- X 投稿: **なし**
- `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` の有効化: **なし**（アプリ上は「準備中」のまま）
- Kabumori の `account-delete`、provider のコンソール、X / Apple の認証情報: **変更なし**

### remaining Stage 2 / operator / legal gates
- **H2 による本番の検証レビュー**（K3 の PASS 後に集中的に行う）。
- **Stage 2 の E2E**（使い捨てアカウントだけ、手順書 §7）:
  1. 一度も接続していないユーザー
  2. かぶモリの profile を持つユーザー（social_only）
  3. X 接続済みユーザー（失効を確認）
  4. Apple ログインのユーザー（Apple の設定を追加した後）
  5. 応答の喪失と再試行
  6. 無関係なデータが変わっていないこと
- 機能の有効化は、E2E（1〜3・5・7）が通り、legal gate が揃った後。
- legal / オーナーの判断: プライバシーポリシー・規約・問い合わせ先、監査の保持期間、履歴の扱い、「X に公開済みの投稿は残る」という文言の確認。
- 調整: Kabumori の `account-delete` との整合（G1/G2）。
- 範囲外の既存所見への非公開での対応（preflight で報告済み）。

### safety_checks
- migration の sha256 を適用の直前にも照合した。1ファイル・1トランザクションで、lock / statement timeout を設定した。
- 適用後の読み戻しと、変わっていないことの確認を行った。
- デプロイ元フォルダの確認（`config.toml` と project_id）、ソースのバイト一致、verify_jwt の確認を行った。
- 動作確認は非破壊のものだけ。確認後に状態が0行であることも確かめた。
- 秘密情報（キー、トークン、ヘッダー、secret の値）は表示・記録していない。

### next_recommendation
- ChatGPT は、本番の検証として H2 に集中レビューを1回割り当てる（DB / Auth / Vault / Edge の境界）。
- その PASS 後に Stage 2（使い捨てアカウントでの E2E）へ進む。Apple を提供する場合は、先に本番の Apple 設定を別途承認のうえ追加する。
- STOP for K3。
