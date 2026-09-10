# Claude Task 2

- task_id: x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet
- purpose: Codex H1から引き継ぎ、会社員AIラボの実X OAuth接続を安全に開始し、ユーザー本人のXログイン・同意後にVault token保存とread-only identity verificationまで完了する。X投稿・live化・Cron変更は行わない。

## Handoff from Codex H1 — 2026-09-10

このworkstreamはCodex slot 1からClaude slot 2へ移管する。Codex側ではこれ以上継続しない。

- feature branch: `feature/multibrand-foundation`
- latest implementation commit/push: `a8414d9` (`Accept dashboard secret key for OAuth start`)
- production deployed function: `x-oauth-connect` のみ
- tests: 全Edge Functionテスト **688 passed**、型検証OK
- DB/Cron/他Edge Function/投稿設定: 今回の直近変更なし
- 会社員AIラボOAuth開始POSTに限り、Dashboard secret keyの `apikey` を許可
- Dashboard secret keyはcallback/token読取/X投稿には使用しない
- Dashboardの `x-oauth-connect` テスト画面で body `{"handle":"kaishain_ai_lab"}` とsecret key header設定まで完了
- **まだ Send Request は押していない**
- よって現時点でOAuth state / Vault / social_accountsへの新規書込み、X API呼出し、Xログインは未実行

## Approved production scope

このPhase 3Cについて、以下はユーザー/ChatGPT承認済み。

許可:
- OAuth接続用の必要最小限expand-only migrationと本番適用
- `x-oauth-connect` Edge Functionの作成・本番deploy
- 会社員AIラボ用 `social_accounts` 行の作成・設定
- OAuth state / PKCE / connection metadataの本番DB書込み
- Supabase Vaultへの会社員AIラボAccess Token / Refresh Token保存
- X `GET /2/users/me` のread-only本人確認
- OAuth開始POSTに限りDashboard secret key `apikey` を認証経路として利用

禁止:
- X投稿API呼出し
- Cron追加/変更
- `publish_mode=live`
- `publish_enabled=true`
- Kabumori既存tokenの変更・移行
- Kabumori投稿パイプライン変更
- `mio`接続/有効化
- Instagram / Threads
- Secret値をGit/Report/ログ/通常テーブル/ChatGPTへ露出

接続成功後も会社員AIラボは `dry_run` / `publish_enabled=false` を維持する。

## Read First / Safety

開始前に必ず確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CLAUDE_TASK.md`
- `.agent/tasks/CODEX_TASK.md`
- `docs/multibrand/ARCHITECTURE.md`
- `docs/multibrand/PHASE1.md`
- Phase 3A commit `34cb78c`
- Phase 3B commit `d04d36d`
- latest Phase 3C commit `a8414d9`

`origin/main`と他slot TASKをfresh-checkし、同じmigration/RPC/Edge Function/workflow/production設定を別slotが変更中なら開始しない。

## Current production state

引き継ぎ時点:

- `x-oauth-connect`: 本番deploy済み
- Phase 2 / Phase 3B / Phase 3Cの対象migration: 必要分は本番適用済みとのCodex報告
- AIラボ: まだOAuth未開始、接続完了していない
- Kabumori: `live` 維持、既存account/token未変更
- Cron: 既存8件のまま。追加・変更なし
- X API / Vault token保存 / Xログイン: 未実行

作業開始時にread-onlyで事実確認する。推測で書込みを進めない。

## Next operation

1. Supabase Dashboardの `x-oauth-connect` テスト画面で、会社員AIラボ用のOAuth開始POSTを実行する。
2. bodyは引き継ぎ時設定の `{"handle":"kaishain_ai_lab"}` を使用する前に、対象が正しい会社員AIラボのXハンドルであることを確認する。誤りが疑われる場合は送信しない。
3. 成功レスポンスのauthorization URLを確認する。Secret値は表示/記録しない。
4. 対象brand/account、redirect URIがSupabase Function callback、scopeが `users.read offline.access` であることを確認する。
5. Xログイン・認可画面へ到達したら**必ず停止**し、ユーザー本人の操作を待つ。パスワード・2FA・同意クリックは代行しない。
6. ユーザー本人の認可後に再開し、callback結果を検証する。
7. token本体はVaultだけに保存し、通常テーブルにはopaque ref/非秘密metadataだけを保持する。
8. `GET https://api.x.com/2/users/me` のみでread-only identity verificationする。
9. 最終状態として `identity_verified`、`publish_mode=dry_run`、`publish_enabled=false`、Vault参照のみをread-only確認する。
10. X投稿0件、Cron変更0件、Kabumori token変更0件、mio操作0件を確認して停止する。

## User interaction boundary

X認可画面でのログイン・2FA・同意はユーザー本人のみが行う。

Claudeは:
- Xパスワードや2FAコードを要求しない
- credentialをチャットへ貼らせない
- OAuth authorization URL到達後は本人操作待ちで停止する

## Completion criteria

- OAuth開始が会社員AIラボaccountに対して実行済み
- ユーザー本人認可を経てcallback成功
- tokenはSupabase Vaultにのみ保存
- read-only `/2/users/me` で意図した会社員AIラボidentityを確認
- `identity_verified`
- `publish_mode=dry_run`
- `publish_enabled=false`
- Kabumori既存token/投稿挙動変更なし
- X投稿0件
- Cron追加/変更0件
- mio操作0件
- tests/safety checks維持
- Phase 3Dへ進まない

完了・停止時はこのTASK末尾に `## Report` を追加し、`status: review_required`、`next_owner: chatgpt` にしてGitHubへ同期する。

ReportにはSecret値/Token値/Vault secret本体を絶対に記録しない。

## Progress（2026-09-11 中断時点・status: in_progress のまま）

ユーザー指示により翌日へ持ち越し。OAuth開始（Dashboard Send Request）は**未実行**。

- 開始前のread-only確認で見つかった問題と対処（ユーザー承認済み）:
  1. scope不足: X公式で `GET /2/users/me` は `tweet.read` と `users.read` の両方が必要。旧コードは `users.read offline.access` のみで、同意後の本人確認が必ず失敗する状態だった → `tweet.read users.read offline.access` に修正（read-only、投稿scopeなし）
  2. 取り違え防止: 初回接続は照合用user idが無く、ブラウザでログイン中の任意のXアカウント（例: kabumori）を会社員AIラボとして保存しうる状態だった → `/2/users/me` の `username` を登録ハンドルと照合（大文字小文字無視）し、不一致なら `X_IDENTITY_HANDLE_MISMATCH` でVault保存前に失敗させる
  3. ハンドル: `kaishain_ai_lab` で正しいことをユーザー確認済み
- 実装: `feature/multibrand-foundation` commit `4f1ae53`（`a8414d9`の上）。Edge Functionテスト **690 passed / 0 failed**（688＋新規2）、`deno check` exit 0
- 本番deploy: `x-oauth-connect` **v4 ACTIVE / verify_jwt=false**（ユーザーがターミナルで実行。自動モードの判定でClaudeからのdeployはブロックされたため）。本番から再ダウンロードした7ファイルが `4f1ae53` と**バイト一致**を確認。deploy前のv3は `a8414d9` とバイト一致（ロールバック先）
- 誤投稿経路: `plan_daily_posts` はブランド有効かつ有効な `posting_windows` がある場合のみ計画する。会社員AIラボには投稿枠が0件のため、OAuth開始で `is_active=true`・`dry_run` になっても予定は作られない。ただし本番の `claim_due_post` はブランド非対応のままなので、x-test-postのブランド対応deploy前に会社員AIラボの投稿枠を追加してはならない
- 開始前の本番ベースライン（read-only）: cron.job 8件 / `oauth_token_store` 1行（updated_at 2026-09-10 14:50:01 UTC）/ `social_accounts` は `kabumori_x` のみ / 会社員AIラボ `disabled` / OAuth state 0件 / Vaultの `ai_salaryman_lab%` 0件 / かぶモリ以外の予定・実行ログ 0件
- 安全: 複垢worktreeにCodex作業中（2026-09-10 22:10）に作られた本番link情報 `supabase/.temp/linked-project.json` が残り `check-safe-env.sh` がUNSAFEだったため、scratchpadへ退避（削除ではない）し `SAFE` を回復。deploy用・検証用の本番link付き一時ディレクトリは削除済み
- 気づき（未対処・別タスク候補）: 複垢migration 3件（`20260910170000`/`180000`/`190000`）は本番にオブジェクトが存在するが `supabase_migrations.schema_migrations` に記録が無い
- X投稿0件、Cron変更0件、Kabumori token変更0件、mio操作0件（ここまで）

### 明日の再開手順

1. ユーザーがSupabase Dashboardの `x-oauth-connect` テスト画面でbody `{"handle":"kaishain_ai_lab"}` / POSTを確認して Send Request
2. 応答の `scopes` が `tweet.read users.read offline.access` であることを確認
3. `authorization_url` をシークレットウィンドウで開き、@kaishain_ai_lab でログインして許可（Send Requestから10分以内。X側でコールバックURL未承認エラーが出たら停止し、X Developer Portalに `https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/x-oauth-connect/callback` を登録）
4. callback表示のJSONを確認後、Claudeがread-onlyで `identity_verified` / `publish_mode=dry_run` / `publish_enabled=false` / Vault参照のみ / ベースラインからのKabumori・Cron・X投稿不変を検証してReport
