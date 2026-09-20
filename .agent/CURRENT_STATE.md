# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-20 JST (H1 GDELT diagnosis complete, awaiting C1; H2 Phase12 done; G1 natural shadow wait; G2 done)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `important-news-phase1-gdelt-timeout-diagnosis-and-fallback-candidate-20260920`
  - 27/27 natural shadow runs completed over 4h40m; 6h window is still left-censored. GDELT timed out on all 5 hourly polls (~15s) and was cooldown-skipped 22 times; other ten sources remained healthy.
  - External current/bounded queries both received HTTP 429; root cause is low-confidence and no code/runtime candidate was adopted.
  - 07:00 single GDELT failure produced no search; 07:10 JMA sparse/high-signal condition independently caused 1 search event / 2 calls / estimated $0.02112360.
  - Production mutation 0; preserve hourly cooldown and all fallbacks. Exact proposal: evidence-limited natural observation only. Stop for C1.
- Codex slot 2: `done` — `social-mobile-app-phase12-general-user-content-profile-and-dry-run-20260920`
  - Phase11 real OAuth QA C2 PASS済み。
  - 次は `social_mobile_user_v1` profile、tenant-safe settings/posting defaults、general-user dry-run generation、最小mobile preview。
  - real X post / media upload / publish_enabled=true / Cron / production deploy はまだ禁止。
  - Recommended model: Luna。shared pipelineの具体的な設計矛盾が出た時だけSol検討。


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
