# Claude Task 3

- task_id: x-social-mobile-account-deletion-concurrency-fix-phase4c-20260929
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: H2 final acceptanceで残った1件のP1 concurrency holeとDeno test typing defectだけをfocused修正し、PR #52を最終受け入れ可能にする。

## Review source
- PR #52 reviewed head: `002d24ac99df2fbdf4e2423c1428ccb488a79f29`
- H2 verdict: FAIL
- production_mutation=0

## Required correction
- first-onboarding writerとdeletion acquireが、critical pointに入る前に同じper-user serialization primitiveを取得すること。
- onboardingが先に始まり未commitのケースでも、deletionが「workspaceなし」と誤認して先にpurge/finalizeしないこと。
- deletionが先のケースでは、onboardingは安全に待機/拒否されること。
- lock orderを統一し、deadlockを避けること。
- deletion成功後は当該user由来のorphan brand/account/membership/credentialが0であること。
- 既存OAuth挙動は必要最小限だけ変更すること。

## Required tests
1. onboarding starts first and remains uncommitted -> deletion starts
2. deletion starts first -> onboarding starts
3. after reported deletion success, zero orphan rows
4. no deadlock in tested protocol
5. existing R1-R6/client pin regression remains green

## Deno typing fix
- `supabase/functions/social-mobile-account-delete/delete_logic_test.ts` のTS2353を修正。
- default checked `deno test` をPASSさせる。

## Verification
- disposable Postgres full behavior/ACL/race/reconnect/cleanup
- checked Deno tests/check
- social-mobile full tests
- data-view
- typecheck/lint
- Expo web+iOS export
- diff check
- secret/token/log scan
- relevant mutation tests

## Production constraints
No migration apply, Edge deploy, real deletion, Vault mutation, real X/Apple revoke, Auth/provider console changes, or real X post.

`production_mutation=0`.

## Completion / K3
Report exact fixed PR #52 head, common lock design, changed files, both race proofs, orphan invariant, checked Deno tests, full regressions, production_mutation=0, and readiness for one final H2 focused acceptance.

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- exact fixed PR #52 head:
  - `4bc819555c07c8792f5b78ea29aa6b9a35694042`（Draft PR #52、branch `claude/g3-account-lifecycle-p4`）
  - reviewed head `002d24a` に1コミットを追加したもの。
- production_mutation=0:
  - マイグレーション適用、Edge デプロイ、実際の削除、Vault の変更、X/Apple の実失効、Auth/コンソールの変更、X 投稿はいずれもなし。
  - 本番への問い合わせも行っていない。

### common lock design
- **共通の直列化手段**: 導出したワークスペース ID に対するトランザクション単位の advisory lock（`hashtextextended('social_mobile_workspace:' || u_…)`、関数 `social_mobile_account_deletion_workspace_lock`）。
- **作成側**:
  - guard trigger が、`u_` ワークスペースへの `brands` / `brand_memberships` の INSERT（初回オンボーディングとメンバーシップ作成の地点）でこのロックを取る。
  - ロック取得後に、新しい snapshot で tombstone を読む。
  - READ COMMITTED 以外でのワークスペース作成は `SOCIAL_MOBILE_WORKSPACE_CREATION_REQUIRES_READ_COMMITTED` で拒否する（新しい tombstone が見えないため）。
  - 既存の OAuth RPC（begin/complete）は**変更していない**。
- **削除側**:
  - `acquire` は、削除用のユーザーロックの直後、snapshot や行ロックより前に同じロックを取る。
  - lease を使う各段階（`hold`）と operator の操作も同じロックを取る。
- **ロック順（全経路で統一）**: 削除用ロック → workspace ロック → 行 / `auth.users` のロック。
  - 作成側は、FK の key-share ロックより前に workspace ロックを取る。そのため循環せず、deadlock は起きない。
- **finalize の不変条件**: 両方のロックを持った状態で、ワークスペースの行（brands / memberships / social_accounts / oauth_states）が1件も無いことを再確認し、そのうえでログインと tombstone を削除する。行が残っていれば `WORKSPACE_REAPPEARED` で operator に回す。

### both race proofs（使い捨て PG17、本物の onboarding マイグレーション、偽データのみ）
1. **onboarding が先に始まり未 commit → 削除開始**（H2 の再現手順どおり）:
   - A が初回の `begin_social_mobile_x_oauth_connection` を実行し、3秒間 commit しない。
   - 1秒後に B が acquire → credentials → mark → purge → finalize を、別々の commit で実行する。
   - B の acquire は workspace ロックで A を待ち、A の commit 後に作成された workspace を snapshot して削除する。
   - 結果: `finalized=completed`、**orphans=0**（brands / memberships / social_accounts / oauth_states / tombstone / auth.users の合計が0）。`ONBOARDING_FIRST_RACE_PASS`。
2. **削除が先 → onboarding**:
   - B が acquire を実行し、2秒間 commit しない。その間に A が初回オンボーディングを開始する。
   - A はロックを待ち、B の commit 後に `SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS` で拒否される。workspace は作成されない。
   - その後、削除は完了まで進み、orphans=0。`DELETION_FIRST_RACE_PASS`。
- 追加の確認:
  - 全出力に deadlock が無いこと（`NO_DEADLOCK_PASS`）。
  - isolation のガード（`ISOLATION_GUARD_PASS`）。
  - 行の再出現時に finalize が完了を拒否し、ログインも残すこと（behavior）。
- 既存の BEHAVIOR / ACQUIRE_RACE / RECONNECT_RACE / CLEANUP もすべて PASS。

### orphan invariant
- 削除成功（finalize が completed）と報告する時点で、そのユーザー由来のワークスペース・アカウント・メンバーシップ・OAuth state・Vault 参照・tombstone は0件。
- これは finalize がロック下で強制し、2つのレースで検証している。

### checked Deno tests
- `delete_logic_test.ts` の TS2353 を修正した（override の型に `providers?` を追加）。
- 型チェックありの Deno テスト 17/17 PASS、`deno check` 全ファイルでエラー0件。
- 注意: この環境ではリポジトリ直下の `package.json` があるため、Deno が `npm:@types/node` を node_modules から探して失敗する。これは環境要因でコードとは無関係。`DENO_NO_PACKAGE_JSON=1 deno test --no-lock --allow-read supabase/functions/social-mobile-account-delete/` で実行した。H2 の環境では、既定の checked 実行で TS2353 だけが出ていた。

### full regressions
- social-mobile `npm test` 72/72、data-view 14/14、typecheck OK、lint OK、Expo export web/ios とも成功、`git diff --check` OK。
- 機密情報スキャン（追加行）ヒットなし、console 出力なし。
- R1〜R6 とクライアント固定のテストはすべて緑のまま。
- 変異テスト（DB）8件中7件を検出:
  - レビュー時のヘッド相当（作成時に workspace ロックを取らない）、acquire のロック削除、finalize の不変条件削除、isolation チェック削除、R1 の guard 無効化、R1 の古い snapshot の受け入れ、R3 の所有チェック無効化。
  - **検出されなかった1件**: lease 保持段階（hold）での workspace ロック削除。acquire の commit 後は tombstone が見えるため、作成側は必ず拒否される。このロックは正しさに必須ではなく、ロック順を統一するための冗長な防御として残している。

### changed_files（`002d24a..4bc8195`）
- `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`
- `supabase/tests/social_mobile_account_deletion_behavior.sql`
- `supabase/tests/social_mobile_account_deletion_run.sh`
- `supabase/functions/social-mobile-account-delete/delete_logic_test.ts`
- `apps/social-mobile/docs/account-lifecycle-phase4.md`

### readiness for one final H2 focused acceptance
- **はい**。指摘された P1 の並行性の穴と Deno の型の不具合だけに絞って修正し、双方向のレース・orphan 0・deadlock 無しを検証した。
- 最終確認をお願いしたい点:
  1. 作成地点が `brands` / `brand_memberships` の INSERT だけで網羅できているか（ほかにワークスペースを作る経路は無いか）
  2. READ COMMITTED 前提の妥当性（PostgREST の RPC は READ COMMITTED）
- STOP for K3。
