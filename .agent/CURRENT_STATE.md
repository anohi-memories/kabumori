# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-18 JST (H1 AI Lab daily content plan production rollout done; H2 social mobile Phase6 ready; G1 review_required)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `done` — `ai-lab-daily-content-plan-production-rollout-20260918`
  - Phase1/Phase2 daily content plan schema + writer RPCをproductionへexact apply済み。RPC/ACL/RLS/postflight、ROLLBACK付きbounded smokeも確認済み。
  - `x-test-post` consumer deploy、Cron、X/OAuth/Vault変更は0。次工程はG1競合解消後のconsumer deployと実plan登録。

- Codex slot 2: `ready` — `social-mobile-app-phase6-auth-mobile-read-qa-20260918`
  - Phase5 production membership/RLS rolloutはC2 PASS済み。
  - 次は実Auth/no-membership/canary membership/mobile adapter read QA。
  - canaryはuser↔brand mappingを一意・明示的に確認できる場合だけ1件。曖昧なら0件。
  - production default `EXPO_PUBLIC_DATA_SOURCE=supabase` はまだONにしない。
  - Dashboard手動applyのmigration history未記録はrepair/reconcileせず既知事項として維持。

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

- AI Lab daily content plan schema + writer RPCはproduction反映済み。consumer/selection source candidateはC1 PASSだが、`x-test-post` consumer deployは未本番反映。
- social mobile Phase5で `brand_memberships` + tenant RLSをproductionへ手動適用しpostflight C2 PASS済み。Phase6で実Auth/mobile read QAへ進む。
- social mobile production data sourceはPhase5完了後も実Auth/mobile read QAまでは既定ONにしない。
- AI Lab Vault-backed refreshは本番反映済み。自然slot結果はread-only観測事項。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
