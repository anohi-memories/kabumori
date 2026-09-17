# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-17 JST (H1 AI Lab daily content plan Phase1 ready; H2 social mobile Phase3 ready)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `ai-lab-daily-content-plan-generation-control-phase1-20260917`
  - 会社員AIラボを「APIが題材まで自由生成」から「ちゃ/将来のアプリ内AIが登録した翌日用content planを最優先し、APIは文章化だけ担当」へ切り替えるPhase1 candidate。
  - planあり: topic/context/key_points/must_include/must_avoidを正本として逸脱禁止。AI一般論・便利Tipsへの勝手な転換を防ぐ。
  - planなし: 現行persona範囲の無難なfallbackを維持。
  - storageは将来Mio/social-mobileにも再利用可能なbrand-neutral設計を検討するが、このH1でconsumer wiringするのはAI Labのみ。
  - production migration / x-test-post deploy / Cron / OAuth / Vault / token / manual X投稿は禁止。C1でsource/schema確認後にrollout判断。

- Codex slot 2: `ready` — `social-mobile-app-phase3-schema-rls-inventory-20260917`
  - Phase1 shell・Phase2 Auth/data foundationはC2 PASS済み。
  - Phase3はproduction multibrand/SNS schema・ownership・RLSをread-only auditし、安全なtenant境界とPhase4最小変更案を確定する。
  - production DB/RLS/RPC/grant/deploy変更0で完了する。

- Claude slot 1: `review_required` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - shared `market_report_packet.v1` candidate、X/app consumer gate付き実装まで完了報告あり。
  - K1 review前。consumer production switchはまだ行わない。
  - `x-test-post` を含むため、G1が再開/in_progressになった場合はH1と同時編集しない。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - K2 PASS・main反映済み。翌朝05:30 JSTの自然OFF確認は別read-only観測。

## Parallel safety

- H1はAI Lab `brand_post` の題材選択・生成prompt/content-plan候補を担当。OAuth/Vault/refresh/X publish/idempotencyは変更しない。
- H2は `apps/social-mobile/**` とread-only DB/RLS inventory中心。H1のgeneration runtimeは変更しない。
- G1は現在review_required。再開時に`x-test-post`を触る場合はH1と競合するため同時作業禁止。
- G2はdone。
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- AI Lab Vault-backed refresh candidateは`x-test-post` v113へ本番反映済み。次の自然slot結果はread-only観測事項で、異常時のみ別タスク化。
- AI Lab生成文章がAI一般論/便利Tipsへ寄り、個人開発日記というブランド主題から外れる品質問題がある。H1でcontent-plan優先制御を実装する。
- social mobile appはPhase3でtenant ownership/RLSを監査中。production data sourceはまだ既定ONにしない。
- multibrand migrations `20260910170000/180000/190000` objectsはproductionに存在するがmigration history不整合の可能性があるためblind `supabase db push`禁止。
- 重要ニュースX生成にはFact/Voice系generation_failedが残る。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
