# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (PR #8 freshened onto latest main and merged as cd7ad89; Supabase production rollout remains unperformed)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-pr8-gpt6-news-portfolio-final-merge-20260923`
  - PR #8 merged and closed as `cd7ad8994d6e20c752735a52b0d933e1c2bb0a16`; all 11 approved files on main match freshened candidate `ab593c74fe6825ffbf9ba8ef2bed004a5b92b731`.
  - GPT-6 Luna, Important News producer V2, and Portfolio validator fix are on main; required Vercel check passed.
  - Main merge triggered an automatic Vercel Production build (success). No Supabase Edge Function deploy, DB migration, or report backfill was performed.
  - Remaining production rollout requires the exact migration apply, both Function deploys, and a safe 9/18 close regeneration/backfill decision.
  - Stop for C1.
  - Recommended model: Luna.

- Codex slot 2: `ready` — `social-mobile-app-phase21-production-history-learning-disabled-deploy-20260923`
  - Phase20 C2 PASS済み。access-token RPCはproduction適用済み・ACL read-back済み。
  - 次は `social-mobile-history-learning` Functionのdisabled entrypointだけをproduction deployする。
  - service-role live wiring / RPC invocation / Vault plaintext / real X history はまだ禁止。
  - Recommended model: GPT-6 Sol Medium。


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
