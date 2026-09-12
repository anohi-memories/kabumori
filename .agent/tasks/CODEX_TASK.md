# Codex Task

- task_id: kabumori-x-oauth-recovery-20260913
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: 2026-09-13朝の `morning_greeting` が `X_TOKEN_REFRESH_FAILED:400` で失敗したため、かぶモリX OAuth認証だけを安全に復旧する。投稿生成・scheduler・複垢化の他ブランド挙動は変更しない。

## User authorization

2026-09-13、ユーザーが「直して」と明示承認済み。

この承認で許可されるのは、かぶモリX OAuth復旧に必要な最小実装・テスト・対象Edge Function deploy・本人OAuth再認証フロー・read-only本人確認・refresh-only検証まで。

**Xへの手動投稿は許可しない。Cron変更も許可しない。**

## Confirmed production facts

read-only確認済み:

- 2026-09-13 `morning_greeting` は予定生成済み。
- scheduled_for: 2026-09-13 06:39:09 JST頃。
- claim: 正常。
- failure: `X_TOKEN_REFRESH_FAILED:400`。
- `publish_claims` も同じ `X_TOKEN_REFRESH_FAILED:400`。
- 今日用画像 `morning-greeting-assets/generated/2026-09-13.png` は存在。生成失敗ではない。
- legacy `oauth_token_store` の `expires_at` は 2026-09-12 22:47 JST頃、`updated_at` は20:47 JST頃。
- 2026-09-12 20:47 JST頃の interaction はX投稿成功。
- その後、会社員AIラボOAuthは 22:24 JST頃に `identity_verified` まで完了。
- `ai_salaryman_lab_x`: Vault access/refresh refsあり、publish_enabled=false。
- `kabumori_x`: publish_enabled=trueだが `connection_status=unconnected`、platform_user_idなし、Vault token refsなし。現行投稿はlegacy `oauth_token_store` / x-test-post経路。
- `x-test-post` は `oauth_token_store` を `X_CLIENT_SECRET` 由来AES keyで復号し、復号不能時は server secrets `X_OAUTH2_ACCESS_TOKEN` / `X_OAUTH2_REFRESH_TOKEN` へfallbackする。
- X API 401時、refresh endpoint `POST /2/oauth2/token` を呼び、非2xxなら `X_TOKEN_REFRESH_FAILED:<status>`。
- 現行ログはX refresh error bodyを保存しないため、400の `invalid_grant` 等の詳細は未確認。

## High-priority hypothesis to verify

時系列上、以下を必ず検証する:

1. 20:47 JSTにlegacy token storeが正常更新された後、22:24 JSTにAI Lab OAuthが完了し、翌06:40にKabumoriだけrefresh 400。
2. `x-test-post` と production `x-oauth-connect` が同名の `X_CLIENT_ID` / `X_CLIENT_SECRET` を参照している。
3. もし共有client credentialが途中で別X App用へ変更されていれば、legacy token storeの復号失敗→古いserver-secret fallback→refresh 400の連鎖が成立する。

ただし、secret値そのものを取得・表示・Git/Reportへ記録しない。変更履歴を安全に証明できない場合は推測と事実を分ける。

## Scope / preferred recovery

まず原因確認。復旧は以下の安全順位で行う。

### A. 既存tokenを安全に復旧可能な場合

- client credential不変かつ単純なrefresh token失効等と確認できるなら、Kabumori本人のOAuth再認証でfresh tokenを取得する。
- 必要scopeは現行投稿に必要な最小限: `tweet.read users.read tweet.write media.write offline.access` を基準に、実際のX API endpoint requirementsと既存機能を照合する。

### B. client credential共有衝突が原因の場合

- AI Lab用に共有 `X_CLIENT_ID` / `X_CLIENT_SECRET` を上書きすることは禁止。
- KabumoriとAI Labが別X Appを必要とする構成なら、brand/account別credentialへ分離する最小設計を行う。
- 既存AI Lab `identity_verified` / Vault token refs / dry_run / publish_enabled=false を壊さない。
- 大規模な複垢化リファクタへ広げない。

### Kabumori reauthorization safety

必要なら既存 `x-oauth-connect` を最小拡張してKabumori recoveryを扱ってよいが、以下を必須とする:

- admin-only start。
- PKCE + random state。
- callback state / expiry / one-time consume検証。
- authorization後 `GET /2/users/me` で登録handle `kabumori` と照合し、別アカウントならtoken保存前にreject。
- token/secret/code/verifierをログ・Report・Gitへ出さない。
- fresh tokenは **現行x-test-postが実際に読む安全な保存先** へ保存する。legacy storeを使うなら現行暗号化形式を維持する。
- AI Lab token/Vault rowsは変更しない。

## Refresh-only proof required

再認証後、投稿成功をテストするためにX投稿を行ってはいけない。

代わりに、同じclient/token保存経路を使う **refresh-only proof** を実施する:

- fresh refresh tokenでX token endpointが2xx。
- rotated tokenが安全に保存される。
- 保存後に同じ実行系で再読込・復号できる。
- `GET /2/users/me` read-onlyでKabumori本人を再確認。
- X post/media uploadは0回。

これで次回自然投稿時のrefresh経路まで確認する。

## Required procedure

1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/tasks/CODEX_TASK_2.md`, `.agent/tasks/CLAUDE_TASK.md` を読む。
2. origin/main fresh-check。H2はPush通知workstreamなので触らない。
3. clean isolated worktreeを使う。既存未コミット変更は触らない。
4. production read-onlyで上記factsを再確認。
5. production Edge Function version/sourceとGit sourceを確認。`x-test-post` / `x-oauth-connect` の実際のauth code pathを特定。
6. 原因を再現可能なテストで確認。
7. 最小修正を実装。無関係なposting/content/schedulerを変更しない。
8. tests / deno check / git diff --check。
9. deployが必要なら対象Functionだけ。deploy後source read-back/byte compare。
10. OAuth authorization URLが必要になったら、ユーザー本人操作が必要な時点で停止して明確に案内。パスワード/2FA/secretの共有を求めない。
11. callback後は本人確認 + refresh-only proof。手動X投稿はしない。
12. `.agent/CODEX_REPORT.md` 更新、TASKを `review_required / next_owner: chatgpt` に戻す。

## Explicitly prohibited

- 手動X投稿 / テスト投稿
- Cron変更
- scheduled_postsの人工INSERT
- morning_greeting/朝刊/大引け本文ロジック変更
- scheduler planner変更
- Push通知領域
- AI Labのlive化 / publish_enabled=true
- AI Lab token/Vault書換え（Kabumori復旧に不要）
- mio操作
- secret/token/password/2FAの表示・保存・Report記録
- productionでの破壊的DB変更
- migration history修復
- 無関係なEdge Function deploy

## Completion criteria

- `X_TOKEN_REFRESH_FAILED:400` の根因を事実/仮説で明確化。
- Kabumori本人OAuth tokenが安全に再発行・保存される。
- 別Xアカウント誤接続を防止。
- refresh-only proof 2xx + token再読込/復号 + `/2/users/me`本人確認pass。
- X投稿0件であること。
- AI Lab状態不変。
- Cron/scheduler/posting logic不変。
- commit/push/report完了。
- `review_required / next_owner: chatgpt`。
