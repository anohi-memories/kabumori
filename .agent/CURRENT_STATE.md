# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (C1 PASS on GPT-6 Luna upgrade; PR #8 final freshen/merge queued; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `kabumori-pr8-gpt6-news-portfolio-final-merge-20260923`
  - C1 PASS on GPT-6 Luna upgrade.
  - Official model id/pricing verified: `gpt-6-luna`, $0.10 input / $0.50 output per 1M tokens for standard short-context pricing.
  - Important News app-copy draft/Fact and Personalized Reports draft/Fact use GPT-6 Luna on PR #8.
  - GPT-6 Luna cost estimator entries/tests are included.
  - PR #8 required Vercel status is success and PR is git-mergeable.
  - Current main advanced 25 commits from the old merge base, but none touch the 11 approved PR #8 files.
  - Next H1 freshens PR #8 onto latest main and merges if required checks remain green.
  - No production deploy/migration/backfill yet. Production mutation 0.
  - Recommended model: Luna.

- Codex slot 2: `ready` — `social-mobile-app-phase20-production-history-access-rpc-rollout-20260923`
  - Phase19 C2 PASS後のproduction security-boundary rollout。
  - exact `read_social_mobile_history_access_token(uuid,text)` migrationだけを本番適用し、SECURITY DEFINER/search_path/ACLをread-backする。
  - Vault plaintext読取 / history-learning Function deploy / real X history は禁止。
  - Recommended model: Sol。


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
