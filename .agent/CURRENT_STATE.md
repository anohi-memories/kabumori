# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (H1 GPT-6 Important News exact migration and only-function deploy complete; scheduled Cron observed; no candidate)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-important-news-gpt6-production-rollout-20260923`
  - Approved exact migration applied; both CHECK constraints read back with GPT-6 IDs.
  - Only `important-news-monitor` deployed; `verify_jwt=false`; SHA `4450ee09…e4b7`. Latest metadata says v64 but same SHA and source bundle `source/62`; discrepancy disclosed.
  - Natural Cron runs succeeded through 09:20 UTC; no new candidate/usage row, so GPT-6 persistence remains unverified. Migration history version differs from repo timestamp; no repair.

- Codex slot 2: `ready` — `x-autopost-foundation-audit-multibrand-netlify-roadmap-20260923`
  - Phase23 C2 PASSでsocial-mobile history-learningは一区切り。
  - 次はX自動投稿基盤全体をread-only棚卸しし、複数ブランド/複数Xアカウント完成、Supabase中核化、Netlify Free管理画面移行までの実装ロードマップを確定する。
  - Production mutation / deploy / migration / Cron変更 / Netlify作成 / Vercel変更は禁止。
  - Recommended model: GPT-6 Luna。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 GPT-6 source PR #9 is merged; approved exact migration and only `important-news-monitor` deployment are complete. Natural Cron runs were read-only observed; no qualifying candidate. Migration-history timestamp and Function version-label discrepancies are disclosed; neither was repaired.
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
