# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-18 JST (H1 daily plan writer Phase2 ready; H2 Phase4 review_required; G1 review_required)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `ai-lab-daily-content-plan-writer-phase2-20260918`
  - Phase1 consumer/selection candidateはC1 PASS。
  - 次は、ちゃ/将来のアプリ内AIがstructured daily planを安全にSupabaseへ登録するservice-side writer、version/activation/idempotency/validationをdisposable DBで証明する。
  - production migration/RPC/deploy、`x-test-post`変更はまだ行わない。

- Codex slot 2: `review_required` — `social-mobile-app-phase4-membership-rls-validation-20260918`
  - `brand_memberships`中心のtenant isolation candidateをdisposable DBで検証済み/確認待ち。
  - production DB/RLS/grant/RPC/migration/deploy変更0の境界。

- Claude slot 1: `review_required` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - shared market_report_packet候補とX/app consumer gate実装のK1 review待ち。
  - `x-test-post`を含むため、H1 writer Phase2は`x-test-post`を変更せず競合回避する。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - K2 PASS・main反映済み。自然OFF確認は別read-only観測。

## Parallel safety

- H1は `daily_content_plans` writer/schema/validation candidateのみ。`x-test-post`、market-report、social-mobile、OAuth/Vaultには触れない。
- H2はsocial-mobile membership/RLS candidate。H1の`daily_content_plans` objectsを触れない。
- G1はmarket-report schema/functions/`x-test-post`/personalized-reports領域。
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- AI Lab daily content plan consumer/selection source candidateはC1 PASSだが、base migrationとconsumer deployは未本番反映。
- daily plan writerはまだ未実装。本Phaseでservice-side writer contractとdisposable DB proofを作る。
- social mobile production schemaには一般user→brand membership/RLS不足があり、production Supabase data sourceはまだON禁止。
- AI Lab Vault-backed refreshは本番反映済み。自然slot結果はread-only観測事項。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
