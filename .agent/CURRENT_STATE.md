# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-19 JST (H1 important-news hourly cadence simplify ready; H2 social mobile Phase6 ready; G1 idle until 2026-09-24 natural shadow)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `important-news-hourly-cadence-simplify-20260919`
  - 9/19〜9/23の2時間おきは維持。
  - 9/24以降は朝刊/大引け前後の20分刻み増強を撤回し、終日毎時00分のみ（24回/日）へ簡素化する。
  - 変更対象は production `important-news-fetch` Cron 1本のcommand gateだけ。

- Codex slot 2: `ready` — `social-mobile-app-phase6-auth-mobile-read-qa-20260918`
  - Phase5 production membership/RLS rolloutはC2 PASS済み。
  - 次は実Auth/no-membership/canary membership/mobile adapter read QA。
  - canaryはuser↔brand mappingを一意・明示的に確認できる場合だけ1件。曖昧なら0件。
  - production default `EXPO_PUBLIC_DATA_SOURCE=supabase` はまだONにしない。
  - Dashboard手動applyのmigration history未記録はrepair/reconcileせず既知事項として維持。

- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

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
