# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-20 JST (H1 shadow observation/match audit C1 PASS/done; H2 Phase11 review_required; G1 natural shadow wait; G2 done)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `done` — `important-news-phase1-shadow-observation-and-match-audit-20260920`
  - C1 PASS. Read-only audit completed with production mutation 0.
  - Reviewed window: 9 natural runs, 31 unique candidates / 31 first_seen, 0 paid shadow searches / $0.
  - 0 live matches is not matcher failure evidence; same-window important/most_important live events were 0 and prior high-importance rows were mostly TDNET outside the shadow window.
  - Recall parity remains NOT PROVEN. Keep all legacy paid fallback; no matcher loosening or live cutover.
  - Continue natural 10-minute shadow observation. Recommended model for future observation/audit: Luna.

- Codex slot 2: `ready` — `social-mobile-app-phase11-x-portal-and-real-oauth-qa-20260920`
  - Phase10 C2 PASS済みbackendを使い、X Developer Portal設定確認と専用non-admin QA user + dedicated test X accountで1回のreal OAuth round-tripを行う。
  - real X post/media upload/publish_enabled=trueは禁止。成功後のQA fixture cleanupは別承認。
  - Recommended model: Luna。具体的なOAuth/DB/Vault blockerが出た時だけSol検討。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1はread-only shadow observation/match auditで完了。production mutation 0; shadow/legacy Cron、Function、schema、OAuth/Vaultは変更なし。
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
