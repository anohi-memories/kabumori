# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-22 JST (H1 source-backed news producer + Portfolio freshness candidate review_required; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-important-news-producer-detail-and-portfolio-freshness-diagnosis-20260922`
  - Real-device QA still finds Important News 詳しい内容 too shallow; app-only partitioning is insufficient when richer source facts exist only outside verified Japanese text.
  - H1 pushed an Important News producer/app-copy V2 candidate with source-backed additional event facts and no display-time AI; C1 review is required.
  - Portfolio freshness root cause is confirmed in production: 9/18 close snapshot exists with 9/18 prices, but the report failed local validation on `CONTAINS_LATIN_WORD:ＵＦＪ`; 9/17 is the latest completed Fact-passed close report.
  - Validator candidate is narrowly scoped and has no active G1 file conflict; no production backfill/deploy/mutation occurred.
  - 9/18 is the latest cash-market trading day at this time; 9/21–23 are JPX cash-market holidays.
  - Production mutation 0. Visual colors/icons remain deferred.
  - Recommended model: Luna.

- Codex slot 2: `done` — `social-mobile-app-phase17-disposable-vault-token-boundary-proof-20260922`
  - C2 PASS。fake-only disposable PostgreSQLでowner/account/access-token binding、cross-tenant/forged-ref fail-closed、ACL/search_path、cleanupを実証。
  - production mutation 0。実Supabase Vault拡張そのものは未使用なので、次はproduction-shaped access-only internal reader設計/読取preflightが必要。
  - production deploy / real X history / persona persistence / live publish は別TASK。
  - Recommended next model: Luna。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 source-backed news producer + Portfolio validator candidate is review_required; production mutation 0; no producer deploy/migration/RPC.
- H2/G1/G2 implementation files are untouched by this H1.
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- AI Lab daily content plan schema + writer RPCはproduction反映済み。consumer/selection source candidateはC1 PASSだが、`x-test-post` consumer deployは未本番反映。
- social mobile Phase5で `brand_memberships` + tenant RLSをproductionへ手動適用しpostflight C2 PASS済み。Phase6で実Auth/mobile read QAへ進む。
- social mobile production data sourceはPhase5完了後も実Auth/mobile read QAまでは既定ONにしない。
- AI Lab Vault-backed refreshは本番反映済み。自然slot結果はread-only観測事項。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。正本と索引が矛盾する場合はTASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
