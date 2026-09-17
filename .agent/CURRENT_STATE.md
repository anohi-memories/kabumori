# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-18 JST (H1 daily plan writer Postgres proof review_required; H2 social mobile Phase5 ready; G1 review_required)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `ai-lab-daily-content-plan-writer-postgres-proof-20260918`
  - C1 blockerだった実PostgreSQL disposable proofを完了。Phase1+Phase2 migration、RPC/grant/security、state/idempotency、並列activation、consumer query、rollback dry-runを確認。
  - production migration/RPC/deploy、`x-test-post`変更は0。C1確認待ち。

- Codex slot 2: `ready` — `social-mobile-app-phase5-production-membership-rls-rollout-20260918`
  - Phase4 disposable DB proofはC2 PASS済み。
  - exact approved `brand_memberships` + tenant RLS candidateだけをproductionへ最小・可逆に反映するPhase5。
  - blind `supabase db push`は禁止。preflight → exact apply → postflight → admin compatibility → rollback readinessの順。
  - canary membershipはuser/brandがproduction既存relationから一意・明示的に特定できる場合のみ1件まで。曖昧なら0件でC2へ返す。
  - `EXPO_PUBLIC_DATA_SOURCE=supabase` はまだ既定ONにしない。

- Claude slot 1: `review_required` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - shared market_report_packet候補とX/app consumer gate実装のK1 review待ち。
  - `x-test-post`を含むため、H1 writer Phase2は`x-test-post`を変更せず競合回避する。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - K2 PASS・main反映済み。自然OFF確認は別read-only観測。

## Parallel safety

- H1は `daily_content_plans` writer/schema/validation candidateのみ。`x-test-post`、market-report、social-mobile、OAuth/Vaultには触れない。
- H2はsocial-mobile `brand_memberships` / tenant RLS production rolloutのみ。H1の`daily_content_plans` objects、G1のmarket-report objectsを触れない。
- G1はmarket-report schema/functions/`x-test-post`/personalized-reports領域。
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- H2は他slotのproduction migration適用と同時実行しない。競合時はwrite前にSTOP。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- AI Lab daily content plan consumer/selection source candidateはC1 PASSだが、base migrationとconsumer deployは未本番反映。
- social mobile Phase4では `brand_memberships` + direct SELECT + RLSをdisposable PostgreSQLで実証済み。Phase5でproduction rolloutへ進む。
- social mobile production data sourceはPhase5完了後も実Auth/mobile read QAまでは既定ONにしない。
- AI Lab Vault-backed refreshは本番反映済み。自然slot結果はread-only観測事項。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
