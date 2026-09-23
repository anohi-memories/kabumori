# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (C1 PASS on PR #9 merge; production GPT-6 Important News rollout queued; source merged, deploy/migration still pending)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `kabumori-important-news-gpt6-production-rollout-20260923`
  - C1 PASS on PR #9 final merge.
  - PR #9 is merged/closed at main `83d994634f9b4891b8d939723939187b76bedaed`; Vercel on resulting main is success.
  - GPT-6 source routing and the narrow metadata CHECK migration are on main.
  - Production still has not applied the migration and has not deployed the reviewed `important-news-monitor`.
  - Next H1 is the controlled production rollout: exact single migration only, read back constraints, deploy only `important-news-monitor`, then observe natural runtime. No manual traffic/X post.
  - Personalized Reports deploy and 9/18 close regeneration remain separate and untouched.
  - Recommended model: GPT-6 Sol Medium.

- Codex slot 2: `ready` — `social-mobile-app-phase23-dedicated-qa-one-shot-history-learning-20260923`
  - Phase22 C2 PASS済み。次はdedicated QA user/accountでexactly-one live history-learning QA。
  - live実行直前にユーザーの明示同意が必須。genericなOK/すすめてはlive Vault/X read同意として扱わない。
  - 成功/失敗にかかわらず1回だけ実行し、直後にgateをOFFへ戻す。
  - publish/persona persistence/raw-history persistenceは引き続き禁止。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 GPT-6 source PR #9 is merged; exact production migration is awaiting explicit user authorization after the apply guard rejection. No production mutation.
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
