# Codex Task

- task_id: x-multibrand-phase3c-oauth-start-void-rpc-fix-20260912
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: terra
- purpose: 会社員AIラボOAuth開始POSTがDB/Vault書込み成功後に400 `X_OAUTH_CONNECTION_FAILED` を返すバグを最小修正し、OAuth開始レスポンスを正常化する。Claude slot 2から正式移管。投稿・live化は行わない。

## Read first

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CLAUDE_TASK.md`
- `docs/multibrand/ARCHITECTURE.md`
- Phase 3C commit `4f1ae53`
- `supabase/functions/x-oauth-connect/index.ts`
- `supabase/migrations/20260910190000_add_ai_lab_oauth_connection_rpc.sql`

Fresh-check `origin/main` と他slot。Claude slot 2は本workstreamから移管済みで、同領域を並行変更しない。

## Confirmed production state

2026-09-12 DashboardからOAuth開始POSTを1回実行:
- body: `{"handle":"kaishain_ai_lab"}`
- Dashboard secret key `apikey` 経路
- UI response: HTTP 400 / `X_OAUTH_CONNECTION_FAILED`

しかし本番read-only確認では開始処理が成功済み:
- `ai_salaryman_lab_x` social account作成済み
- handle `kaishain_ai_lab`
- `connection_status=authorization_pending`
- `publish_enabled=false`
- access/refresh token refなし
- brand `ai_salaryman_lab`: `is_active=true`, `publish_mode=dry_run`
- OAuth state 1件作成済み（10分期限、現在期限切れ）
- PKCE verifier Vault secret 1件作成済み
- X login / consent / token exchange / `/2/users/me` は未実行

## Root cause to verify

`begin_ai_salaryman_lab_oauth_connection(...)` はSQLで `returns void`。
`x-oauth-connect/index.ts` の共通 `rpc()` は成功レスポンスでも常に `await response.json()` する。

void RPC成功後の空body/204をJSON parseして通常Errorとなり、`safeCode()` が `X_OAUTH_CONNECTION_FAILED` に変換して400を返した可能性が極めて高い。

まずローカル/モックでこの挙動を再現し、推測ではなく確認すること。

## Scope

最小修正のみ。

1. `rpc()` または開始RPC専用経路を修正し、void/empty successful responseを正常成功として扱う。
2. JSONを返す既存RPC（consume等）の戻り値処理を壊さない。
3. HTTP非2xxでは従来どおりfail-closed。
4. secret/tokenをログ・エラー・fixtureへ露出しない。
5. expiredな既存OAuth stateは再利用しない。
6. 必要なら期限切れstate/PKCE secretの扱いを調査するが、無関係なcleanup実装は広げない。
7. 新しいOAuth開始POSTを実行するのは、修正・テスト・deploy確認後。ユーザー本人Xログイン/同意に到達したら停止する。

## Tests required

最低限:
- void RPC / 204 or empty success => success
- JSON RPC success => JSONが従来どおり返る
- non-2xx => `OAUTH_CONNECTION_DB_WRITE_FAILED`
- OAuth start returns authorization_url/scopes rather than generic 400
- scopes remain `tweet.read users.read offline.access`
- no posting scopes
- `publish_enabled=false`, `dry_run` invariants維持
- existing Edge Function regression tests all pass (baseline 690)
- `deno check` / `git diff --check`

## Production authorization

このバグ修正について、`x-oauth-connect`のみの本番deployは、実装差分がvoid RPC response handlingの最小修正に限定され、テスト合格後であれば許可する。

Deploy後:
- 本番Functionをread-back/byte compare
- `verify_jwt=false`維持確認
- 他Function/Cron/DB schema/RPC/secrets/Kabumori token不変確認

OAuth開始の再試行は1回だけ。成功レスポンスの`scopes`と`authorization_url`を確認したら、X認可画面でユーザー本人操作待ちとして停止する。

## Explicitly prohibited

- X投稿API
- Cron追加/変更
- `publish_mode=live`
- `publish_enabled=true`
- Kabumori token変更
- mio接続
- x-test-post変更/deploy
- 無関係なDB migration/RPC変更
- token/secret/JWTのReport・Git・ログ露出
- ユーザーのXパスワード/2FA/同意代行

## Completion

修正・deploy・OAuth開始レスポンス正常化まで完了したら:
- TASK `review_required`
- `next_owner: chatgpt`
- `.agent/CODEX_REPORT.md` 更新
- feature/main管理同期

Report必須:
- task_id
- root_cause
- changed_files
- tests
- commit_hash
- push
- production_deploy/version/byte_compare
- oauth_start_retry_result
- current social account/brand state
- X login/consent status
- production_changes
- forbidden_changes_zero
- safety_checks
- next_recommendation
