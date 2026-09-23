# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (H1 release readiness audit complete; docs candidate on branch; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-release-readiness-audit-and-roadmap-20260923`
  - Read-only release readiness audit complete; deliverable on review branch.
  - P0 potential public caller-auth exposure found in important-news-monitor; no invocation or production mutation. Stop for C1.

- Codex slot 2: `ready` — `x-autopost-phase0-disposable-global-uniqueness-migration-proof-20260923`
  - X自動投稿基盤audit C2 PASS後のPhase0。
  - posting_windows / scheduled_posts / publish_claims のlegacy global UNIQUEを外しbrand-scoped uniquenessだけを残せるか、disposable PostgreSQLでmigration/rollback proofする。
  - production apply / DDL / deploy / Cron / X投稿はすべて禁止。
  - ON CONFLICT依存があれば同一migration候補内の最小修正可否を精査。大きくなるならSTOP。
  - Recommended model: GPT-6 Luna。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 GPT-6 source PR #9 is merged; approved exact migration and only `important-news-monitor` deployment are complete. Natural Cron runs were read-only observed; no qualifying candidate. Migration-history timestamp and Function version-label discrepancies are disclosed; neither was repaired.
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
