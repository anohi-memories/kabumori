# Codex Task

- task_id: x-ai-lab-vault-token-refresh-production-preflight-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: C1 PASSしたAI Lab Vault refresh integration candidate `a7ffba4930a9eff3885ab29254f9858b80e71170`について、本番deploy前の環境・権限・接続方式をread-only中心に検証し、実deploy可能な状態かを判定する。まだproduction deploy・token/Vault mutation・実refreshは行わない。

## C1 review — 2026-09-17

**PASS — integration source candidate approved for preflight.**

確認済み:
- approved refresh helperが現行AI Lab `x-test-post` routeへcandidate統合されている。
- completion/idempotency guardは外周に維持。
- AI Lab固定 `ai_salaryman_lab` / `ai_salaryman_lab_x` / `kaishain_ai_lab` 境界を維持。
- Kabumori/Mio/legacy `oauth_token_store` fallbackなし。
- Vault persistenceはtransaction + advisory lock + expected refresh token比較でstale writerを拒否。
- access tokenは固定refへ更新、refresh tokenはrotation時のみ固定refへ更新。
- refresh/publish upper boundはrefresh最大1回、publish最大2回。uncertain completionはfail-closed。
- focused 30/30、full regression 474/474、candidate由来の新しいdeno check diagnosticなし、fmt/diff-check PASS。
- production deploy / Vault mutation / OAuth / DB schema / Cron / manual post変更0件。

## Remaining production gate

source設計は承認するが、production deploy前に以下を実証する必要がある:
1. production Edge runtimeで`SUPABASE_DB_URL`相当のdirect Postgres接続設定が利用可能か（値は表示しない。presence/usableだけ確認）。
2. 実際のEdge実行主体から`vault.update_secret(uuid,text,...)`を呼べる権限/DB roleか。
3. direct Postgres方式がSupabase Edge Function本番運用として接続制限・pooling・IPv4/IPv6・connection count上問題ないか。
4. current X OAuth client authentication方式とcandidateのrefresh request（Basic client auth + refresh_token grant）が現行AI Lab OAuth設定と一致するか。
5. candidate deploy後に必要となるenvironment/secrets追加がある場合、その変更範囲を明示する。

## Authorized work

- fresh `origin/main` / task/report/current state確認
- H2/G1/G2との競合確認
- production Function/runtime/env metadataのread-only確認
- secret値を取得せず、必要envのpresence確認
- production DB/Vault function privilege/read-only metadata確認
- transactionをcommitしない安全な接続性/権限preflightが可能なら実施（secret/token/Vault値を読まない・書かない）
- current `x-oauth-connect` のOAuth token exchange client-auth方式をsource/runtimeから確認
- deploy plan / rollback plan / exact environment requirements作成
- 必要ならcandidate sourceのlocal-only微修正とtests。ただしproduction deployは禁止

## Prohibited

- production `x-test-post` deploy
- production Vault/token ref mutation
- 実refresh token request
- OAuth再認可
- manual/synthetic X post
- failed row retry/backfill
- Kabumori/Mio変更
- OAuth scope変更
- DB schema/migration/RPC/RLS/grant変更
- Cron/posting window変更
- `supabase db push`
- secret/token/Vault値の表示・report記載

## Completion

preflight完了後:
- `.agent/CODEX_REPORT.md`先頭に結果を追加
- direct DB availability / effective DB role / `vault.update_secret` callable可否 / OAuth client-auth整合 / required env changes / deploy・rollback手順 / remaining riskを記載
- production deploy可能なら、その根拠を明示して`status: review_required`, `next_owner: chatgpt`
- preflight blockerがあれば、代替案とblast radiusを示して同じくC1へ戻す
- fresh origin/main確認後にmetadata同期、read-backしてSTOP

**このTASKではproduction deploy/token mutationを行わない。**

## Preflight completion — 2026-09-17

- Read-only production preflight completed.
- Existing secret names, Vault writer metadata/privilege, current Edge runtime versions, and Basic-client-auth + `refresh_token` OAuth compatibility were confirmed without reading values.
- Direct Edge runtime `SUPABASE_DB_URL` usability/effective-role and production direct-connection suitability remain unproven without a separately authorized no-write runtime test; no deploy is recommended until that gate is closed.
- See `.agent/CODEX_REPORT.md` for evidence, blast radius, and the unexecuted deploy/rollback plan.
