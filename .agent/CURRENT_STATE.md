# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-18 JST (H1 AI Lab daily plan selection fix review_required; H2 social mobile Phase4 ready)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `ai-lab-daily-content-plan-selection-fix-20260918`
  - C1 blocker修正済み。slot未指定itemを決定的に割り当て、safe itemなしはhardened persona fallback。production migration/deployは未実施。C1待ち。

- Codex slot 2: `ready` — `social-mobile-app-phase4-membership-rls-validation-20260918`
  - Phase1〜3はC2 PASS済み。
  - Phase3で一般user→brand membership/RLS不足を確認し、production Supabase data sourceはまだON禁止。
  - Phase4は `brand_memberships` 中心のmembership/RLS設計をdisposable DBで検証し、member/non-member/anon/admin × brand A/Bのpolicy matrixとcross-tenant isolationを証明する。
  - production DB/RLS/grant/RPC/migration/deploy変更0でC2へ返す。本番適用は別承認。

- Claude slot 1: `review_required` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - shared market_report_packet候補とX/app consumer gate実装のK1 review待ち。consumer production switchはまだ行わない。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - K2 PASS・main反映済み。自然OFF確認は別read-only観測。

## Parallel safety

- H1はAI Lab content-plan/generation領域。H2はsocial-mobile membership/RLS candidateとdisposable DB検証。
- G1はmarket-report schema/functions/x-test-post/personalized-reports領域。H2はそれらを変更しない。
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- social mobile production schemaにはbrand relationはあるが、一般user→brand membershipとtenant RLSが未成立。
- `EXPO_PUBLIC_DATA_SOURCE=supabase` のproduction有効化は禁止中。Phase4でdisposable DB proof後に本番適用判断。
- multibrand migrations `20260910170000/180000/190000` objectsはproductionに存在するがmigration history不整合の可能性があるためblind `supabase db push`禁止。
- AI Lab Vault-backed refreshは本番反映済み。自然slot結果はread-only観測事項。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
