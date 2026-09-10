# Codex Task

- task_id: x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: terra
- purpose: 複垢化Phase 3Cとして、会社員AIラボの実Xアカウントを既存共通X Appへ安全にOAuth接続し、tokenをSupabase Vaultへ保存、read-only identity verificationまで完了する。X実投稿・live化・自動投稿開始は行わない。

## Explicit ChatGPT approval — 2026-09-10

Phase 3Cについて、以下を**明示承認する**。従来の「important-news-monitorのみ本番deploy可」という限定より、本TASKの範囲に限ってこの承認を優先する。

承認する本番操作:

- OAuth接続用の必要最小限のexpand-only migration追加および本番適用
- `x-oauth-connect` Edge Functionの追加および本番deploy
- 会社員AIラボ用 `social_accounts` 行の作成・設定
- Supabase Vaultへの会社員AIラボOAuth Access Token / Refresh Token保存
- OAuth state / PKCE / connection metadataの必要な本番DB書込み
- X `GET /2/users/me` によるread-only本人確認

この承認は以下を**含まない**。引き続き禁止:

- X投稿APIの呼び出し
- 会社員AIラボの `publish_mode=live`
- `publish_enabled=true`
- 会社員AIラボ向けCron追加・有効化
- Kabumori既存tokenの変更・移行
- Kabumori既存投稿パイプラインの変更
- `mio` の接続・有効化
- Instagram / Threads対応
- Secret値をGit / Report / ログ / 通常テーブル / ChatGPTへ露出すること

OAuth認可画面でのXログイン・同意はユーザー本人が行う。Codexはパスワード・2FAコードを要求・保存しない。本人操作が必要な時点で停止し、対象アカウント、redirect URI、scopeを明示して案内する。

接続成功後も会社員AIラボは必ず `publish_mode=dry_run` / `publish_enabled=false` を維持し、read-only本人確認までで停止する。Phase 3Dへは進まない。

## Background / handoff

このworkstreamの続き。

- 初期安全調査: `feature/multibrand-foundation` commit `56244c7`
- 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`
- Phase 1 ローカル再現: commit `719249f`、K2承認済み
- Phase 2 brand-aware基盤: commit `5806e85`、C1承認済み
- Phase 3A 会社員AIラボdry-run基盤: commit `34cb78c`、C1承認済み
- Phase 3B OAuth/Vault接続準備: commit `d04d36d`、C1承認済み

Phase 3Bで以下まで完成済み。

- `social_accounts` にVault access/refresh secretのopaque UUID参照、connection status、verified identity metadata
- brand/account-aware OAuth state、state hash、PKCE verifier Vault ref、expiry/consumed管理
- tamper / unknown / expired / consumed / account mismatch fail-closed
- read-only identity verificationは `GET https://api.x.com/2/users/me` のみ
- Kabumori legacy `oauth_token_store` は未変更
- 688 tests passed、local DB reset PASS、SAFE、local cron.job=0

## Read First / Start Safety

開始前に必ず確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CODEX_TASK.md`
- `docs/multibrand/ARCHITECTURE.md`
- `docs/multibrand/PHASE1.md`
- Phase 3A commit `34cb78c`
- Phase 3B commit `d04d36d`

`origin/main` と他slot TASKをfresh-checkし、同じmigration / RPC / Edge Function / workflow / production設定を別slotが変更中なら開始しない。

実装は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation` を正とする。既存kabumori checkoutの未コミット差分は触らない。

## Phase 3C goal

**会社員AIラボの実X OAuth接続とVault token登録、read-only本人確認まで。投稿はしない。**

### A. production-safe connection path

Phase 3Bで準備したOAuth/Vault配管を実接続可能な形に仕上げる。

- 既存共通X App (`oauth_client_ref=default`) を使う
- callback URL / scopes / PKCE / stateを現行Kabumoriと整合させる
- 会社員AIラボ専用 `social_account` を明示的に対象指定する
- callbackでbrand/account identityを再検証し、別ブランドへtokenを紐付けない
- Access Token / Refresh Token本体はSupabase Vaultのみへ保存
- 通常テーブルにはVault secret idと非秘密metadataのみ保存
- token値をログ・例外・Report・Gitへ出さない

### B. required production changes

実接続に必要な最小限の本番変更のみ許可する。

許可:
- Phase 2/3Bで承認済みのexpand-only schemaを本番へ安全に適用すること（必要なものだけ、適用前に対象migrationを再確認）
- OAuth開始/callbackに必要なEdge Functionを本番deployすること
- 会社員AIラボ用 `social_accounts` 行を作成/設定すること
- OAuth state / connection metadataを本番DBへ書くこと
- OAuth callback後に会社員AIラボのtokenをVaultへ保存すること
- read-only `GET /2/users/me` で本人確認すること

禁止:
- Kabumoriの既存token移行/変更
- X投稿API呼び出し
- `publish_mode=live`
- `publish_enabled=true`
- 会社員AIラボ向けCron追加/有効化
- `mio` 接続
- Instagram / Threads

### C. user interaction boundary

Xログイン・認可同意はユーザー本人操作が必須。

Codexは以下を行う。

1. OAuth開始URLを安全に生成するところまで進める
2. redirect URI、scope、対象brand/accountを明示確認する
3. ユーザー本人のログイン/認可が必要な時点で停止し、必要操作を短く案内する
4. ユーザー操作後に再開した際、callback結果を検証し、token保存・identity verificationを完了する

Xのパスワードや2FAコードを要求・保存しない。

### D. identity verification

OAuth callback後、X投稿せず接続先が正しい会社員AIラボアカウントか確認する。

- `GET https://api.x.com/2/users/me` のみ
- platform user id / handle等の非秘密identityを期待値と照合
- mismatchならconnection_statusを安全側へ倒し、publish解放しない
- 成功しても `publish_mode=dry_run`、`publish_enabled=false` を維持

### E. tests / validation

- 既存688テストを維持し、追加テストも全pass
- OAuth state/account混線、Vault ref、identity mismatchの既存テスト維持
- 本番deploy前に `git diff --check`
- feature branchへcommit/push
- 本番変更を行う直前に `origin/main` fresh-check
- 本番変更後は対象schema/Edge version/connection statusをread-only確認
- X投稿が0件であることを確認

## Safety invariants

- Secret値はVault以外へ保存しない
- Secret値をChatGPT/Report/Git/ログへ出さない
- Kabumori本番投稿パイプラインを変更しない
- Kabumori legacy tokenを変更しない
- 会社員AIラボは接続後もdry_run + publish disabled
- 自動投稿Cronは作らない/変更しない
- 実X投稿は絶対に行わない
- `mio` はdisabledのまま

## Completion Criteria

1. 必要なPhase 3Cコード/migrationがfeature branchでcommit/push済み。
2. 必要なexpand-only schema/connection functionだけが本番へ安全に反映済み。
3. 会社員AIラボ専用social accountがKabumoriと分離されている。
4. ユーザー本人のX OAuth認可を経てtokenがVaultに保存されている。
5. 通常テーブル/Git/ログ/Reportにtoken本体が存在しない。
6. read-only `/2/users/me` で意図した会社員AIラボのidentityを確認済み。
7. 接続後も `publish_mode=dry_run` / `publish_enabled=false`。
8. Kabumori token/投稿挙動に変更なし。
9. X投稿0件、会社員AIラボCron追加0件。
10. tests pass、必要な安全確認pass。
11. Phase 3D（投稿解放）へ勝手に進まない。
12. 完了時 `review_required` / `next_owner: chatgpt` にしてC1へ回す。

## Report

`.agent/CODEX_REPORT.md` に以下を記録する。

- task_id
- result
- changed_files
- migrations_applied
- edge_functions_deployed
- oauth_flow_result（Secret値なし）
- vault_result（Secret IDも必要以上に露出しない）
- verified_x_identity（非秘密情報のみ）
- tests
- commit_hash / push
- production_changes
- publish_mode / publish_enabled final state
- x_posts_performed
- cron_changes
- safety_checks
- user_action_required / completed
- remaining_issues
- Phase 3D readiness
- next_recommendation
