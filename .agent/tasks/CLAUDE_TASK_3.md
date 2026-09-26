# Claude Task 3

- task_id: x-universal-oauth-refresh-production-stage0-2-20260926
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: reviewed universal X OAuth refreshをproductionへ段階反映し、AI Labの401障害を1アカウント限定で復旧確認する。

## Authorization

User approved proceeding on 2026-09-26 JST.

This task is limited to:
- Stage 0 read-only production preflight
- Stage 1 reviewed core migration only + reviewed x-test-post deploy with refresh gate OFF
- Stage 2 one controlled AI Lab recovery validation
- safe rollback / gate OFF on any anomaly

Not authorized:
- Phase1B–1I bulk activation
- generic all-account rollout
- Kabumori credential migration
- unrelated DB/Auth/Cron/Admin/important-news changes
- bulk replay of failed posts

## Reviewed source

- universal refresh source merged through PR #37
- merge: `777997a13c39c12ba409a0c6dc95cad18360038a`
- C1/K3 accepted
- Kabumori legacy path unchanged
- production mutation before this task: 0

## Mandatory startup

1. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md and H1/C1 report.
2. Read current Supabase changelog/docs relevant to migrations, Edge Functions and secrets.
3. Fresh fetch origin/main and require no semantic drift in reviewed refresh files.
4. Use independent G3 worktree.
5. Do not touch apps/admin/**, important-news/common-search, or H1 PR #33 files.
6. Never print token values, secret values, secret identifiers, Authorization headers, or raw sensitive provider bodies.

## Stage 0 — read-only preflight

Confirm:
- reviewed core objects are not already applied under another migration.
- required social_accounts / scheduled_posts schema and constraints still match review assumptions.
- AI Lab exact X account is publish-enabled, uses default OAuth client routing, and has both required credential references present and distinct.
- no credential reference is shared across accounts.
- Kabumori remains on its legacy credential path.
- live x-test-post baseline and refresh gate state are known.
- required server-side OAuth client configuration is available without revealing values.
- migration history and apply path are safe for the reviewed single core migration.

Any material drift => STOP with production mutation 0.

## Stage 1 — reviewed core + Edge deploy, gate OFF

Apply only:
`supabase/migrations/20260925140000_x_account_credential_refresh_core.sql`

Do not apply Phase1B–1I or unrelated migrations.

After apply, read back:
- functions/table/trigger definitions
- SECURITY DEFINER / search_path / owner
- EXECUTE and table grants
- no unintended PUBLIC access
- migration history
- new security/advisor findings attributable to this migration

If read-back differs materially from reviewed source => STOP before deploy.

Then deploy the exact reviewed `x-test-post` source from fresh main with refresh gate OFF.

Verify:
- deployed source/version corresponds to reviewed main
- gate remains OFF
- no real refresh occurred
- no credential write occurred
- Kabumori behavior/source remains unchanged

Mismatch => rollback Edge deployment if safe, keep gate OFF, STOP.

## Stage 2 — one controlled AI Lab recovery

Only if Stage 1 passes.

Immediately re-check exact AI Lab account binding and that no refresh/reconnect is already in progress.

Enable the reviewed refresh gate only for the controlled validation window.

Observe exactly one AI Lab due attempt. Do not replay historical failures or create duplicates.

Required proof:
- exact AI Lab account is the only account used
- at most one refresh request
- at most one safe retry of the intended X request
- account health state updates truthfully
- no other account is changed
- Kabumori credential path remains untouched

Hard stop and gate OFF on:
- invalid_grant / reauth-required outcome
- uncertain/network/timeout/server error
- second 401
- lease or account mismatch
- persistence/commit failure
- deadlock
- unexpected duplicate provider request
- any cross-account effect

No automatic retry after a hard stop.

After the single validation, return gate to OFF unless keeping it ON is proven to affect only this exact account and is separately justified. Generic Stage 3/4 enablement is not part of this task.

## Verification

Record only non-secret evidence:
- Stage 0 PASS/STOP
- exact migration applied and migration history entry
- ACL/search_path/owner read-back
- advisor result
- deployed x-test-post version/source identity
- gate before/during/after
- controlled AI Lab attempt result
- refresh count and X create/retry count
- account health before/after
- Kabumori unchanged
- cross-account mutation check
- rollback action if any
- actual production mutations performed
- whether AI Lab normal scheduling is recovered
- remaining risks

## Completion / K3

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K3.

## Report

- task_id: x-universal-oauth-refresh-production-stage0-2-20260926
- result: K3 ready — Stage 0 PASS / Stage 1 PASS / Stage 2 AI Lab 復旧確認 PASS。AI Lab の定常投稿は復旧済み（08:27・09:09・11:29 すべて成功）。ただしゲート運用に手順逸脱1件あり（下記 deviation）。
- model: Opus 5.5
- user_approval_in_chat: 2026-09-26 00:4x JST「Stage 1 と Stage 2 を両方進める」／10:26 JST「オンに戻して続ける」（ゲート継続）
- stage0 (read-only, 00:38 JST): PASS
  - core objects 未適用（table/9 functions absent）、v2 chain absent
  - social_accounts 必要9列あり、`UNIQUE (brand_id, platform)`、`platform='x'`、connection_status CHECK 5値、trigger なし
  - scheduled_posts 列/CHECK はレビュー前提どおり（social_account_id なし、attempt_count あり）
  - AI Lab: identity_verified / publish true / client default / access・refresh 参照あり・別物 / Vault 実体あり（値・ID は未表示）
  - 参照共有 0、brand あたり X アカウント最大 1
  - Kabumori: Vault 参照なし（legacy `oauth_token_store`/env のまま）
  - live x-test-post v120 = pre-G3 main `ad66e4d` と42ファイル byte 一致、verify_jwt=false
  - secret 名のみ確認: `X_CLIENT_ID`/`X_CLIENT_SECRET` あり、`X_VAULT_ACCOUNT_REFRESH` 未設定（gate OFF）
  - apply 経路: 本プロジェクト慣例どおり `supabase db query --linked -f`（`db push` / `migration repair` 不使用）
- stage1: PASS
  - migration: `supabase/migrations/20260925140000_x_account_credential_refresh_core.sql` のみ適用（sha256 `5839cf4f7ac7d2ff8f58bd75eace9a7eb20b409f2408ff49017f7aea655f2755`、`777997a` と同一）。Phase1B–1I 等は未適用。
  - migration history: 未記録（慣例どおり repair せず。`supabase_migrations.schema_migrations` に 20260925140000 なし）
  - read-back: 9 functions 全て SECURITY DEFINER / `search_path=""` / owner postgres。`pg_get_functiondef` md5 が使い捨て DB に同ファイルを適用した値と9件完全一致。service_role EXECUTE は6 RPC のみ、`x_legacy_post_account`/trigger 関数2つは postgres のみ。anon/authenticated EXECUTE 0。state table: RLS on、service_role SELECT のみ、anon/authenticated 権限なし。trigger 2件定義一致。
  - advisors (security): 10件、全て既存。新規オブジェクト起因 0。
  - deploy: x-test-post v121（`--use-api --no-verify-jwt`、worktree に config.toml/link を用意して shared checkout 誤デプロイを防止）。download して origin/main と43ファイル byte 一致、`vault_account_auth.ts`/`_shared/x_v2_account_refresh.ts` 含む、verify_jwt=false 維持（共有 config.toml は x-test-post を platform default=true にしてしまうため明示）。
  - gate OFF 維持、refresh 0、Vault 書き込み 0、アカウント/Kabumori store 変化なし（baseline 記録）。
- stage2:
  - 08:14:28 JST gate ON（`X_VAULT_ACCOUNT_REFRESH=enabled`）。直前再確認: AI Lab 参照・状態不変、refresh state 行なし。
  - 08:27 AI Lab: 08:28:01 claim → 08:28:06 succeeded。refresh 1回（state gen 0→1、`last_refreshed_at` 08:28:06 JST、`access_expires_at` +2h）、AI Lab の2つの secret の updated_at のみ同時刻に更新（rotated refresh token を保存）。X create は 401 → refresh → 再送1回の reactive 経路（proactive 期限情報は未保存だったため）。
  - 09:09 AI Lab: gate ON のまま実行され成功。refresh なし（gen=1 のまま、secret 更新なし）＝有効トークンで通常投稿。
  - 10:21:36 JST gate OFF（unset）。10:28:42 JST user 判断により gate ON に戻した（理由: access token 期限 10:28 以降、OFF だと 11:29 から再び 401 失敗が続く。ON の実影響は AI Lab のみ — Kabumori は legacy 経路で対象外、他の Vault アカウント `sa_bfdab0e0…` は publish_enabled=false のため Vault 読込前に `BRAND_X_ACCOUNT_DISABLED` で停止、AI Lab 以外に content dispatcher なし）。
  - 11:29 AI Lab: 11:30:01 claim → 11:30:05 succeeded。期限切れ後の2回目の refresh（gen 1→2、`access_expires_at` 13:30 JST）。
  - account health: 全期間 AI Lab `identity_verified` / `last_connection_error_code` null、state `idle`、uncertain/reauth/second 401/lease 不一致/commit 失敗/deadlock 0。
  - hard-stop 条件: 該当なし。
- cross_account_check: `sa_bfdab0e0…` の secret updated_at・行 不変、Kabumori アカウント行不変、Kabumori Vault 参照なしのまま。
- kabumori_check: 10:45 Kabumori tip が v121 で成功（10:46:06 X post created）。`oauth_token_store.updated_at` が 01:46:05 UTC（=10:46 JST）に更新されたのは Kabumori 自身の legacy refresh（コード無変更、時刻が Kabumori 投稿と一致。新経路は oauth_token_store を参照しない）。06:46 Kabumori morning_greeting は `MORNING_GREETING_IMAGE_NOT_FOUND`（当日画像が Storage に無い、X 呼び出し前、v120 と同一コード）で失敗 — 本変更と無関係。
- deviation (要レビュー): 計画は「08:27 の1回だけ観測してすぐ gate OFF」だったが、監視スクリプトが CLI 出力先頭の `Initialising login role...` で JSON 解析に失敗し続け、その後の確認も遅延（auto-mode 判定の一時エラー含む）したため gate OFF が 10:21 になった。この間 09:09 の AI Lab 投稿1件が gate ON で走った（refresh なしで成功、gate OFF でも同じ結果）。重複投稿・過去失敗の再実行はなし。監視は修正済み。
- production_mutations_performed: (1) core migration 1本適用 (2) x-test-post v121 deploy (3) secret `X_VAULT_ACCOUNT_REFRESH` set 08:14 → unset 10:21 → set 10:28（現在 ON） (4) 新経路による AI Lab token refresh 2回（08:28, 11:30）とそれに伴う AI Lab Vault 2 secret の更新・refresh state 行1行 (5) 通常スケジュールによる AI Lab X 投稿3件（08:27/09:09/11:29）。手動 invoke・過去投稿の再実行・Cron/設定/他データ変更なし。
- ai_lab_recovered: yes（gate ON 継続中。2時間ごとに次回投稿時の 401/期限で自動 refresh）
- current_state: gate ON、x-test-post v121、AI Lab state idle gen=2
- rollback: gate を unset すれば token request 0 に戻る（その場合 AI Lab は次の期限切れ以降 401）。Edge は v120 ソースを scratch に保存済み。適用済み core は呼び出し元がなければ不活性。
- remaining_risks:
  - gate ON は現状 AI Lab のみ影響だが、今後 Vault アカウントの publish を有効化するとそのアカウントも自動 refresh 対象になる（Stage 3/4 相当の判断が必要）
  - 監視: `x_account_refresh_state_v2` の refreshing 長時間化・uncertain/reauth、AI Lab の `last_connection_error_code`
  - 既知: reconnect と commit 同時実行時の fail-closed デッドロック、stuck refreshing は owner SQL、service_role の Vault 直接権限、migration history 未記録、`ai_lab_vault_token_source.ts` 未使用
  - Kabumori morning_greeting の当日画像欠落（別件）
- changed_files (this report): `.agent/tasks/CLAUDE_TASK_3.md`
- safety_checks: G3 専用 worktree のみ、apps/admin・PR #33・important-news 不接触、token/secret 値・secret ID・Authorization ヘッダーは一切表示・記録していない
- next_recommendation: ChatGPT K3 → gate 継続の可否と deviation の確認。問題なければ gate ON のまま AI Lab 監視を継続し、Stage 3/4（他アカウント）は別 TASK。
