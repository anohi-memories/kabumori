# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-14 JST
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`
- active_workstream:
  - Codex slot 1: `in_progress` — `x-multibrand-phase3k-ai-lab-first-live-test-20260916`。2026-09-16 JSTの段階テスト開始指令に従い、Phase Aのfresh-checkとAI Lab限定OAuth write-scope対応可否を確認中。まだscope変更・OAuth再認可・publish有効化・実投稿・window有効化は行っていない。
  - Codex slot 2: `ready` — `broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914`。重要ニュース収集・app visibility・通知scope。最新TASKは`x-test-post`、OAuth、Vaultを明示的に除外。
  - Claude slot 1: `review_required` — `broad-news-phase4-natural-push-observation-20260913`。read-only観測のみで本番変更0件。収集→分類→判定→X公開は自然データで確認（ホルムズ海峡付近での商船攻撃 `coverage_severity=high` / `[geopolitics, shipping_logistics]`、TDnetの浜岡原発報告書で企業IRにも複数カテゴリ付与を確認）。統合producerの正のenqueueとPush到達は**未観測**（`all_useful` でも市場ニュースは業種一致必須、企業ニュースは銘柄登録必須で該当なし）。新規に3件の未解決事象を特定: サウジ原油パイプライン復旧見通しの収集取りこぼし（web_searchがrawCandidateCount 0、ゲート除外ではない）/ 2026-09-14 朝刊レポートが `REPORT_FACT_FAILED` で欠落（リトライなし）/ X投稿本文の `generation_failed` 4件。以降の作業はCodexへ引き継ぐ前提でReportに引き継ぎ章を記載。監視タスクと予約タスクは停止・削除済み。
  - Claude slot 2: `done` — Phase 3C OAuth workstream transferred to Codex slot 1; do not modify same OAuth/Vault/x-oauth-connect area in parallel
- multibrand_work:
  - Phase 1 `719249f` K2 approved
  - Phase 2 `5806e85` C1 approved
  - Phase 3A `34cb78c` C1 approved
  - Phase 3B `d04d36d` C1 approved
  - Phase 3C implementation: base `4f1ae53`, void RPC fix `926f29a`; production `x-oauth-connect` v13 ACTIVE / verify_jwt=false
  - AI Lab scopeは `tweet.read users.read offline.access` のread-onlyを維持。Kabumori recoveryのみ既存投稿経路に必要な `tweet.write media.write offline.access` を含む
  - first connection verifies `/2/users/me` username matches `kaishain_ai_lab` before Vault token save
  - 2026-09-12 initial Dashboard Send Request returned HTTP400 `X_OAUTH_CONNECTION_FAILED`; fix was deployed to `x-oauth-connect` v11 and read back byte-identical
  - read-only production verification confirmed OAuth start RPC actually succeeded before the 400: `ai_salaryman_lab_x` exists, handle `kaishain_ai_lab`, `connection_status=authorization_pending`, `publish_enabled=false`; brand is `is_active=true/publish_mode=dry_run`; one OAuth state and one PKCE Vault secret were created; no access/refresh token ref yet
  - that OAuth state is now expired; do not reuse it
  - likely root cause: SQL `begin_ai_salaryman_lab_oauth_connection` returns void while Edge Function `rpc()` always calls `response.json()` after success, causing empty-response JSON parse failure and generic 400 after DB write
  - void/empty RPC success handling fixed and tested; JSON RPC behavior preserved
  - AI Labは `identity_verified`、Vault refsあり、brand `dry_run` / `publish_enabled=false` を維持
  - AI Labのlive化・publish有効化、手動X投稿、Cron変更、mio操作は引き続き禁止
- kabumori_oauth_recovery:
  - branch `codex/kabumori-x-oauth-recovery-20260913`; commits `ed4c8c0`, `13cb948`
  - production `x-oauth-connect` v13 ACTIVE。12 runtime files read-back完全一致、他Function version不変
  - 本番RPC migration 2件適用済み。3 RPCはSECURITY DEFINER / 空search_path / service_roleのみEXECUTE
  - legacy token storeは現行client secret由来鍵で復号可能だったため、共有secret変更による復号失敗仮説は否定
  - 実X handleはユーザー確認により `yume_daka`。DB誤登録 `kabumori` を訂正し、本人以外はtoken保存前にreject
  - 本人再認証後、token endpoint 2xx、暗号化保存、再読込・復号、`GET /2/users/me`本人確認pass
  - OAuth経路のX post/media callは各0。publish claimsはtotal 11 / published 4のまま。9/13 failed rowは人工retryなし
  - AI Lab identity/Vault refs/dry_run/publish無効は不変。Cron/scheduler/x-test-post/Pushは変更なし
- parallel_work:
  - Codex H1 Phase 3KはAI LabのOAuth write readiness→1件制御投稿→成功時のみ10枠有効化を段階実施。現在はPhase A fresh-check中。H2/G2は対象を明示的に分離しており競合なし。
  - Claude slot2 must not touch same area until H1 completes
  - Codex slot2の現行Phase5 TASKは`x-test-post` / OAuth / Vaultを対象外としており、H1との競合なし
  - existing uncommitted changes belong to other workstreams and must not be modified/staged/committed
- known_issue:
  - multibrand migrations `20260910170000/180000/190000` objects exist in production but migration history may not record them; do not use blind `supabase db push`
  - 2026-09-09 morning_greeting legacy Storage receipt HTTP400 is a separate unresolved issue
  - 2026-09-14 morning personalized report failed Fact check (`REPORT_FACT_FAILED`: packetに無い「指数→保有銘柄」の因果表現) and was not saved; 生成は1回のみでリトライなし。`personalized-reports` は現在v13
  - `important_news_app_copy_targets` / `visible_market` はアプリ表示・日本語コピー生成にも業種一致条件を課すため、通知条件の緩和は表示・日本語化と一体で設計する
  - `CLAIM_PENDING_NOTIFICATIONS_FAILED:504` が2026-09-14未明に3回目。monitor/dispatcherのDB読み取り失敗を5経路で観測（実害は未確認、滞留0）
  - `net._http_response` は約6時間で消えるためエラーの長期傾向を追えない
  - 2026-09-14 20:40 JST `Houthis seize 2 strategic Red Sea islands`（breaking_market）が `coverage_severity=emergency` / `emergency_class=chokepoint_disruption` と判定され、20:50 に `important_news` Push が1件 sent。**Phase 4で未観測だった「市場全体ニュースの正のenqueue→Push到達」を実データで初確認**（業種一致なし、emergency bypass経路）
  - 同一事象の先行記事（09-14 17:20、同じく emergency）はPushされておらず、重複Pushは発生していない
  - 2026-09-15 の朝刊 08:35 / 大引け 17:15 はいずれも `completed` / Fact `passed` で保存・Push sent。9/14 の朝刊・大引け2件連続Fact不合格からは回復したが、Fact不合格時のリトライが無い点は未対応
  - `status='generation_failed'` は累計142件（`NEWS_GENERATION_FACT_RETRY_FAILED` 64 / `NEWS_GENERATION_FACT_FAILED` 59 / `NEWS_GENERATION_VOICE_FAILED` 17 / `NEWS_GENERATION_LOCAL_FACT_FAILED` 2、09-01〜09-15）。日次では 09-14 が失敗18/公開1、09-15 が失敗12/公開4 で、**X投稿用本文の生成失敗が公開数を上回る**。Push・アプリ表示には影響しないがX投稿の取りこぼしとして要対応（次タスク候補）

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
