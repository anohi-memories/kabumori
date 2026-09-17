# Codex Task

- task_id: x-ai-lab-vault-token-refresh-runtime-preflight-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: C1でread-only production preflightを確認済み。残る唯一の本番gateである「Supabase Edge runtimeから既存`SUPABASE_DB_URL`へ直接接続でき、Vault writerに必要なeffective DB role/EXECUTE権限が成立するか」を、token/Vault/X投稿を一切変更しないisolated no-write runtime probeで実証する。

## C1 review — 2026-09-17

**PASS for read-only preflight / production deploy still NOT approved.**

確認済み:
- approved integration candidate: `a7ffba4930a9eff3885ab29254f9858b80e71170`
- production secrets metadata上、`SUPABASE_DB_URL` / `X_CLIENT_ID` / `X_CLIENT_SECRET` は既存名でpresence確認済み。値は未読。
- production `x-test-post` はcandidate未deployの現行runtimeのまま。
- deployed `x-oauth-connect` のrefresh方式は confidential-client HTTP Basic + `grant_type=refresh_token` でcandidateと整合。
- production DB metadata上、`vault.update_secret(...)` は存在し、`service_role` EXECUTE=true、`authenticated`/`anon`=false。
- DB/schema/RPC/grant/Vault/token/OAuth/Cron/X投稿の変更は0。

未証明のためproduction deployをまだ許可しない点:
- Edge runtime実環境から`SUPABASE_DB_URL`でdirect Postgres接続できるか。
- 接続時の`current_user`/effective roleがcandidateのVault writer要件を満たすか。
- connection/pooling/IPv4/IPv6上の即時blockerがないか。

## Goal

本番data/tokenを一切書き換えず、isolated runtime probeだけでdirect-DB gateを閉じる。

## Authorized approach

原則として既存`x-test-post`や既存Functionを変更しない。

1. fresh `origin/main` とH2/G1/G2を確認。既存Function/file overlapがあればSTOP。
2. 一時的なisolated Edge Function（例: `ai-lab-db-preflight`）を新規作成してよい。
3. probeは既存`SUPABASE_DB_URL`の**presenceだけ**を参照し、値をlog/response/reportへ絶対に出さない。
4. probeが行ってよいSQLはread-only metadataのみ:
   - `select current_user`
   - `select has_function_privilege(current_user, 'vault.update_secret(uuid,text,text,text,uuid)', 'EXECUTE')`
   - 必要最小限のconnection metadata（server version等、秘密でないもの）
5. `vault.update_secret`自体は**呼ばない**。`vault.decrypted_secrets`も読まない。token/ref/valueを読まない。
6. response/reportには boolean/role名/接続成功可否など非秘密情報だけを残す。
7. probe後は結果を記録し、production refresh candidate本体はdeployせずC1へ戻す。

## Prohibited

- production `x-test-post` candidate deploy
- production Vault/token mutation
- `vault.update_secret`実呼び出し
- Vault secret/decrypted secret/token/ref/valueの読取・出力
- 実refresh token request
- OAuth再認可
- manual/synthetic X post
- failed row retry/backfill
- Kabumori/Mio変更
- OAuth scope変更
- DB schema/migration/RPC/RLS/grant変更
- Cron/posting window変更
- `supabase db push`
- 既存Functionのdeploy/上書き

## Required verification

- temporary probeのみが新規deploy対象であること
- probe runtimeからdirect DB connection成功/失敗を確認
- `current_user`を確認
- `has_function_privilege(...vault.update_secret...)` true/false確認
- secret値/token/Vault値の出力0
- DB write 0 / Vault write 0 / X write 0 / OAuth action 0
- 他Function version/updated_at不変
- probe source hash/read-back可能なら一致確認

## Completion

`.agent/CODEX_REPORT.md`先頭に以下を追加:
- probe function名/version
- direct connection 成否
- `current_user`
- Vault writer EXECUTE privilege boolean
- pooling/connectivity上の観測事項
- production changes（temporary probe deploy以外）=0
- secret/token/Vault値 output=0
- 次のproduction deploy可否判断に必要な残課題

完了後 this TASKを `status: review_required`, `next_owner: chatgpt` に更新し、fresh `origin/main`確認後STOPしてC1待ち。

**このTASKでも`x-test-post`本番deploy・token mutationは行わない。**

## Runtime preflight completion — 2026-09-17

- Temporary `ai-lab-db-preflight` was deployed with JWT verification enabled, executed once via GET, source-read-back verified, and then deleted.
- The Edge runtime connected through `SUPABASE_DB_URL` successfully as `postgres`; `has_function_privilege(...vault.update_secret..., 'EXECUTE')` returned `true`; only read-only metadata SQL ran.
- Existing production Functions were unchanged and no secret/token/Vault value was output. The candidate `x-test-post` deployment remains separately unauthorized.
- See `.agent/CODEX_REPORT.md` for the probe hash, connectivity observations, cleanup, and remaining C1 approval boundary.
