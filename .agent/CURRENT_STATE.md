# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-21 JST (H1 search diagnostics candidate review_required; H2 Phase13 ready; G1 idle; G2 done)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `important-news-phase1-search-diagnostics-instrumentation-candidate-20260921`
  - Local-only privacy-minimal telemetry candidate is implemented on `codex/h1-search-diagnostics-instrumentation-20260921` (code commit `9394c27a90b590f95ff8253212cc72843212a90b`).
  - Deno: 17 tests passed; type checks passed; production mutation 0.
  - Awaiting C1; raw prompt/headline/query/response are not added to telemetry storage.

- Codex slot 2: `ready` — `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
  - Phase12 source candidate C2 PASS済み。
  - 次は `social-mobile-brand-dry-run` だけをproduction deployし、専用QA fixtureでexactly one real AI previewを実行する。
  - real X post / media upload / scheduled_posts write / publish_enabled=true / Cron / schema変更は禁止。
  - Recommended model: Luna。Auth/RLS/runtime安全性の具体的blocker時のみSol検討。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 shadow observation + source-rights researchはreview_required。production mutation 0; requested 6/12/24h windows未充足、recall parity未証明。新sourceなし、paid/live fallbackを維持。
- H2はsocial-mobile Phase10 production migration / x-oauth-connect-user deployのみ。Portal/real OAuth/X postは別ゲート。G1のmarket-report objectsを触れない。

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
