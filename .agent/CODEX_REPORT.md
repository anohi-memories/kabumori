# Codex Report

- task_id: x-multibrand-phase3c-oauth-start-void-rpc-fix-20260912
- result: review_required — 最小修正・テスト・本番deploy/read-back完了。deploy後のOAuth開始再試行はDashboard操作待ち。
- next_owner: chatgpt
- implementation_branch: `codex/oauth-start-void-rpc-fix-20260912`
- commit_hash: `926f29a1d4ee2ec492ed3d7197ab356e74a8fa49`
- push: `origin/codex/oauth-start-void-rpc-fix-20260912` と `origin/feature/multibrand-foundation` にpush済み
- production_deploy: `x-oauth-connect` v11 ACTIVE / `verify_jwt=false`; deploy後read-backで9 runtime filesをsourceとbyte compareし一致確認
- oauth_start_retry_result: 未実行。利用可能な実行環境に認証済みDashboardのFunction invoke操作がなく、認証情報の移送も行わないため停止。期限切れの旧stateは再利用しない。
- current_social_account_brand_state: 最終read-only確認では `ai_salaryman_lab_x` が `authorization_pending` / `publish_enabled=false`、brandは `is_active=true` / `publish_mode=dry_run`。access/refresh token refなし。deploy前後で状態不変を確認。
- X_login_consent_status: 未実施。新しいauthorization_url取得後、本人がXログイン・同意する段階で停止予定。
- production_changes: `x-oauth-connect`のみv10→v11 deploy。DB/RPC/schema、Cron、secrets/Vault contents、他Edge Functionは変更なし。
- forbidden_changes_zero: X投稿、Cron変更、live化、publish有効化、Kabumori token変更、mio接続、x-test-post変更はゼロ。

## Root cause

PostgRESTのRPC応答は関数の戻り型に応じて返り、void型関数ではJSON documentがない。`begin_ai_salaryman_lab_oauth_connection` は `RETURNS void` だが、旧Edge Functionの共通RPC helperは全成功応答へ `response.json()` を実行していた。空bodyのJSON parse失敗が開始済み処理を汎用400へ変換する経路を確認し、空/204成功を許容する最小修正を実装した。JSON応答RPCは従来どおりJSON parseし、HTTP非2xxはfail-closedを維持。

## Changed files

- `supabase/functions/x-oauth-connect/index.ts`
- `supabase/functions/x-oauth-connect/rpc.ts` (new)
- `supabase/functions/x-oauth-connect/start_logic.ts` (new)
- `supabase/functions/x-oauth-connect/rpc_test.ts` (new)

## Tests

- 追加テスト: 204/空body成功、JSON応答維持、非2xxのfail-closedとbody非漏えい、OAuth authorize URL/scopes/安全設定を確認。対象テスト9件pass。
- Supabase Edge Function全テスト: 695 passed / 0 failed（baseline 690）。
- `deno check` (index.tsおよび追加module): pass。
- `git diff --check`: pass。
- authorization scopeは `tweet.read users.read offline.access` のまま。posting scopeなし、`dry_run` / `publish_enabled=false`を維持。

## Production safety checks

- 対象Function以外の7 Edge Functionsはdeploy前後で不変。
- DB/Cron read-only baselineはdeploy前後で不変（Cron count 10、OAuth state count 1、unexpired state 0、AI Lab Vault secret count 1）。
- `x-oauth-connect` v11の9 runtime filesを本番からread-backし、source commitとbyte-for-byte一致。
- X API、OAuth start retry、token exchange、本人確認は未実施。secret値は取得・表示・記録していない。

## Next recommendation

既存Dashboardの認証済み画面から `POST {"handle":"kaishain_ai_lab"}` を一度だけ再試行し、authorization_urlが返ればユーザー自身のブラウザで開く。secret値は共有しない。X認可画面到達後に停止し、以降の本人ログイン・同意を待つ。
