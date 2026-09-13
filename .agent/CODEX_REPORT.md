# Codex Report

- task_id: kabumori-x-oauth-recovery-20260913
- result: review_required — Kabumori本人OAuth再認証、暗号化token置換、refresh-only proof、本番read-backまで完了
- next_owner: chatgpt
- implementation_branch: `codex/kabumori-x-oauth-recovery-20260913`
- commit_hashes: `ed4c8c038e88274e59460997fa75e3f4721dfbf7`, `13cb948`
- push: `origin/codex/kabumori-x-oauth-recovery-20260913` へpush済み
- production_deploy: `x-oauth-connect` v13 ACTIVE / `verify_jwt=false`; 12 runtime filesをdeploy後にread-backし完全一致
- production_migrations:
  - repo `20260912232914_add_kabumori_oauth_recovery_rpc.sql` / production history `20260912235802`
  - repo `20260913000926_correct_kabumori_x_handle.sql` / production history `20260913010947`

## Root cause

- 2026-09-13 `morning_greeting` は既存refresh tokenでX token endpointがHTTP 400を返し、`X_TOKEN_REFRESH_FAILED:400` で失敗した。
- 本番開始probeでlegacy token storeは現行 `X_CLIENT_SECRET` 由来鍵により復号可能だった。このため「client secret変更 → legacy復号失敗 → server-secret fallback」の第一仮説は否定された。
- 旧refresh失敗のX response bodyは既存実装が保存していないため、`invalid_grant` 等の厳密なsubtypeは未確定。事実として確認できる範囲では、保存済みrefresh tokenがX側で無効だった。
- 初回再認証ではDBの誤登録handle `kabumori` と実アカウントが一致せず、token保存前に `X_IDENTITY_HANDLE_MISMATCH` で安全停止した。ユーザー確認で実X handleは `yume_daka` と判明し、固定allowlist・DB row・Kabumori専用RPCを訂正した。

## Changed files

- `supabase/functions/x-oauth-connect/index.ts`
- `supabase/functions/x-oauth-connect/start_logic.ts`
- `supabase/functions/x-oauth-connect/account_config.ts`
- `supabase/functions/x-oauth-connect/legacy_token_store.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery.ts`
- `supabase/functions/x-oauth-connect/rpc_test.ts`
- `supabase/functions/x-oauth-connect/account_config_test.ts`
- `supabase/functions/x-oauth-connect/kabumori_recovery_test.ts`
- `supabase/functions/_shared/brand/oauth_connection_test.ts`
- `supabase/migrations/20260912232914_add_kabumori_oauth_recovery_rpc.sql`
- `supabase/migrations/20260913000926_correct_kabumori_x_handle.sql`

## Implementation

- OAuth開始は既存admin JWTまたはDashboard secret-keyのPOST開始専用経路のみ。
- Kabumori/AI Labを固定allowlistで分離。AI Labは既存read-only scope、dry_run、Vault保存を維持。
- KabumoriはPKCE、random state、expiry、一回限りconsume、`GET /2/users/me` のhandle照合を通過してからlegacy token storeへAES-GCM暗号化保存。
- fresh refresh tokenを即時に一度rotateし、同じ保存先から再読込・復号後に `GET /2/users/me` で同一本人を再確認。
- Kabumori専用RPC 3件は `SECURITY DEFINER`、空の `search_path`、service roleのみEXECUTE。brand/account/handleを固定し、publish設定を変更しない。
- OAuth Function runtimeにはX投稿・media upload endpointを実装していない。

## Tests

- 対象テスト: 15 passed / 0 failed。
- Supabase Edge Function全テスト: 705 passed / 0 failed。
- `deno check --config supabase/functions/x-oauth-connect/deno.json supabase/functions/x-oauth-connect/index.ts`: pass。
- `git diff --check`: pass。
- 2つのmigrationをローカルPostgresのBEGIN/ROLLBACK内で検証。handle guard、state consume、本人完了、RPC ACL、空search_pathを確認し、永続テストデータ0件。
- Supabase advisors: 今回追加した3関数はmutable search_path / anon / authenticated SECURITY DEFINER警告の対象外。既存の別オブジェクトに関する警告は本タスクで変更していない。

## Production proof

- callback: success / `connection_status=identity_verified`。
- refresh-only proof:
  - X token endpoint 2xx
  - rotated tokenを暗号化保存
  - 同じruntimeで再読込・復号成功
  - `GET /2/users/me` で `yume_daka` 本人を再確認
  - X post API 0 call
  - media upload API 0 call
- `oauth_token_store` は2026-09-13 10:15 JST頃に更新され、有効期限は同日12:15 JST頃。暗号文と16文字base64 IVのみ保存されていることをread-only確認。
- `kabumori_x`: handle=`yume_daka`、`identity_verified`、platform user id設定済み、既存publish_enabled=trueを維持、Vault token refsなし。
- OAuth stateは2回ともconsume済み、unconsumed 0。初回handle mismatchではtoken metadata不変。
- publish claimsは開始前後ともtotal 11 / published 4。最新の9/13 morning_greeting claimは従来のfailedのままで、人工retryや新規投稿は行っていない。
- `ai_salaryman_lab_x` のidentity、Vault refs、`publish_enabled=false`、brand `dry_run` は開始前後で不変。
- Cron、scheduler、`x-test-post`、他Edge Function、他ブランド、Push領域は変更なし。

## Remaining issues

- 旧refresh tokenがX側で無効になった厳密な理由は、旧400 response bodyが記録されていないため確定不能。
- 自然Cron経路での次回投稿到達はまだ発生していない。手動投稿は禁止のため実施していないが、同じrefresh・保存・復号経路はrefresh-only proofで検証済み。

## Safety checks

- 手動X投稿0件、手動candidate/scheduled row注入0件、Cron変更0件。
- AI Lab token/Vault row変更0件、live化0件、publish有効化0件。
- secret/token/code/verifier値はGit・Report・DB平文列・Function responseへ記録していない。Dashboard secret keyはPOST開始専用の組み込み操作だけで使用。
- 本番DDLは上記2migrationのみ。通常の一括db push、`--include-all`、migration history修復は未実施。

## Next recommendation

`C1` で本報告と実装branchをレビューする。次回の自然投稿でpublish到達を確認し、旧9/13 failed rowは人工再実行しない。
