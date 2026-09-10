# Claude Task 2

- task_id: x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910
- owner: claude
- slot: claude-2
- status: ready
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
