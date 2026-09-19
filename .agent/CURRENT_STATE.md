# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-20 JST (H1 shadow cron auth continuation approved; H2 done; G1 natural shadow wait; G2 done)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `important-news-phase1-live-shadow-rollout-20260920`
  - Shadow migration + `important-news-shadow` v1 are user-reported applied/deployed; legacy pipeline unchanged.
  - User explicitly approved one new dedicated `important_news_shadow_cron_secret` in Function env + Vault, shadow-only auth redeploy, one 30m authenticated shadow Cron, then 10m after 2 natural safe runs.
  - Service-role Cron auth and existing-secret reuse are forbidden. Secret must never appear in Git/logs/URLs/Reports.
  - PR from H1 branch to main is approved; auto-merge is forbidden. C1 review required.
  - Legacy search reduction/cutover remains unapproved. MIC remains read-only/additional-trigger only.
  - Recommended model: Sol.

- Codex slot 2: `ready` — `social-mobile-app-phase10-production-oauth-rollout-20260920`
  - C2 PASS済みPhase9をproductionへ段階導入する。
  - 対象はapproved migration apply + x-oauth-connect-user deploy/postflightまで。
  - X Developer Portal変更・real OAuth round-trip・real X postは別ゲート。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1はproduction `important-news-fetch` Cronのcommand gateのみ。schedule、他Cron、Edge Function、schema、OAuth/Vaultには触れない。
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
