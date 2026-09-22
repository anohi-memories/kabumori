# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-22 JST (H1 PR7 clean merge ready; holdings/watch split + Important News detail partition C1 PASS; visual polish deferred; H2 handled separately)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `kabumori-mobile-holdings-watch-news-detail-merge-20260922`
  - C1 PASS on PR #7 candidate.
  - 銘柄 empty-query view is separated into `保有 | 監視`; integrated search remains for non-empty query.
  - Important News verified-post detail now keeps distinct event/status facts beyond 要点 and suppresses generic market filler.
  - Known limitation: this is app-only; richer facts that exist only in English body_summary and not in verified Japanese text still require a later producer/app-copy improvement.
  - Next H1 freshens PR #7 onto latest main, reruns checks, and merges if no implementation conflict appears.
  - Production mutation 0; colors/icons visual polish deferred.
  - Recommended model: Luna.

- Codex slot 2: `ready` — `social-mobile-app-phase16-server-side-x-history-learning-adapter-candidate-20260922`
  - Phase15 C2 PASS後の次工程。
  - 明示同意後のみ、server側でAuth/owner workspace/verified X account/platform user/Vault access tokenをtrusted stateから解決するhistory-learning source candidateを作る。
  - production Vault read / X history API / deploy / publish はまだ禁止。
  - Recommended model: Luna。Auth/RLS/Vault/X token boundaryの具体的blocker時のみSol検討。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 holdings/watch + news detail candidate is review_required; production mutation 0; no producer deploy/migration/RPC.
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
