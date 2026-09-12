# Claude Task 2

- task_id: x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910
- owner: claude
- slot: claude-2
- status: done
- next_owner: codex
- priority: high
- recommended_model: Sonnet
- purpose: 会社員AIラボの実X OAuth接続。2026-09-12、Claude利用上限によりCodex slot 1へ正式移管。Claude側では同じ `x-oauth-connect` / OAuth / Vault領域を並行変更しない。

## Transfer to Codex H1 — 2026-09-12

Phase 3Cの続きをCodex slot 1へ移管する。以後このClaude slotでは同workstreamを変更しない。

### Completed before transfer

- feature branch: `feature/multibrand-foundation`
- `x-oauth-connect` v4 本番ACTIVE / `verify_jwt=false`
- implementation commit: `4f1ae53`
- scopes: `tweet.read users.read offline.access`（read-only。投稿scopeなし）
- `/2/users/me` のusernameを登録handle `kaishain_ai_lab` と照合し、別アカウントならVault保存前にreject
- tests: 690 passed / 0 failed
- X投稿 / Cron変更 / live化 / publish有効化 / Kabumori token変更 / mio操作: 0

### 2026-09-12 OAuth start attempt

ユーザーがSupabase DashboardからPOST body `{"handle":"kaishain_ai_lab"}`、Dashboard secret key `apikey`でSend Requestを実行。

UI response:
- HTTP 400
- `{"error":"X_OAUTH_CONNECTION_FAILED"}`

しかしChatGPTによる本番read-only確認で、開始RPC自体は成功していたことを確認:
- `social_accounts.ai_salaryman_lab_x` 作成済み
- handle: `kaishain_ai_lab`
- connection_status: `authorization_pending`
- publish_enabled: `false`
- access/refresh token ref: 未設定
- `brands.ai_salaryman_lab`: `is_active=true`, `publish_mode=dry_run`
- OAuth state 1件作成済み（10分期限、現在は期限切れ）
- PKCE verifier用Vault secret 1件作成済み
- X login / consent / token exchange / `/2/users/me`: 未実行

### Root cause hypothesis confirmed from code shape

`begin_ai_salaryman_lab_oauth_connection(...)` はPostgres側で `returns void`。
一方 `x-oauth-connect/index.ts` の共通 `rpc()` は、HTTP成功後に常に `await response.json()` を実行する。

したがってvoid RPCが204/空bodyで成功した後、JSON parseで通常Errorが発生し、`safeCode()` が汎用 `X_OAUTH_CONNECTION_FAILED` に変換して400を返している可能性が極めて高い。実際、本番DB/Vaultには同時刻の開始処理結果が残っているため、RPC成功後のレスポンス処理で落ちた挙動と整合する。

### Safety state at transfer

- 既存OAuth stateは期限切れなので再利用しない
- 期限切れPKCE secret/stateのcleanupは今回のバグ修正と分けて安全に判断する
- 再度Send Requestする前にvoid RPCレスポンス処理を修正・テスト・deployする
- 接続成功後も `publish_mode=dry_run` / `publish_enabled=false`
- X投稿、Cron追加/変更、`publish_mode=live`、`publish_enabled=true`、Kabumori token変更、mio接続は禁止

Codex H1の新TASKを正本として継続する。
