# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (C1 PASS on PR #8 merge; next H1 queued for full Important News GPT-6 model unification; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `kabumori-important-news-full-gpt6-model-unification-20260923`
  - C1 PASS on PR #8 final merge.
  - PR #8 is merged/closed at main `cd7ad8994d6e20c752735a52b0d933e1c2bb0a16`; resulting Vercel status is success.
  - Important News app-copy V2, Portfolio validator fix, GPT-6 Luna app-copy, and GPT-6 Luna Personalized Reports are on main.
  - Remaining Important News runtime paths still on GPT-5.6 are importance judgement/escalation, breaking-market AI search, and Important News post-generation.
  - Next H1 inventories all remaining GPT-5.6 references under `important-news-monitor` and upgrades active paths to GPT-6 Luna / GPT-6 Sol with pricing/tests.
  - No Supabase production deploy/migration/backfill yet. Production mutation 0.
  - Recommended model: Luna.

- Codex slot 2: `ready` — `social-mobile-app-phase22-live-history-dependency-gate-default-off-20260923`
  - Phase21 C2 PASS済み。production history-learning FunctionはACTIVE v1 / verify_jwt=true / disabled dependencyのまま。
  - 次はlive dependency wiringを追加するが、server-only feature gate default OFFのままproduction deployする。
  - access-token RPC invocation / Vault plaintext / real X history / persona persistence はまだ禁止。
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
