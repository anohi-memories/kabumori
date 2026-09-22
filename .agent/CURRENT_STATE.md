# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-22 JST (H1 PR7 merge C1 PASS/done; holdings/watch split + Important News detail partition on main; visual polish deferred)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `done` — `kabumori-mobile-holdings-watch-news-detail-merge-retry-20260922`
  - C1 PASS. PR #7 merged/closed at `b2fb3971`; merged main state verified.
  - 銘柄 empty-query view is split into `保有 | 監視` with counts/default/empty states while integrated search remains intact.
  - Important News keeps distinct event/status facts in 詳しい内容 and suppresses generic market filler; no display-time AI.
  - Known limitation: richer facts absent from Fact-passed Japanese verified_text still require a future producer/app-copy improvement if needed.
  - Production/backend/EAS/App Store mutation 0. H2/G1/G2 implementation untouched.
  - Colors/icons visual polish remains deferred.
  - Recommended next model: Luna.

- Codex slot 2: `done` — `social-mobile-app-phase16-server-side-x-history-learning-adapter-candidate-20260922`
  - C2 PASS。server-side trusted Auth/workspace/X identity/token-ref resolution、明示同意、bounded read-only X history adapter source candidateまで完了。
  - raw投稿恒久保存なし、unconfirmed persona proposalのみ、default Edge entrypointはdisabled。
  - production mutation 0。次はdisposable Vault/RLS/token-boundary proofが必須。
  - production deploy / real X history / persona persistence / live publish は別TASK。
  - Recommended next model: Luna。


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
