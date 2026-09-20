# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-20 JST (H1 coverage-gap source research C1 PASS/done; per-slot details below)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `done` — `important-news-phase1-shadow-coverage-gap-expansion-candidate-20260920`
  - C1 PASS. Coverage-gap source research completed with production mutation 0.
  - No new source passed acceptance; all legacy paid/live fallbacks remain enabled.
  - Durable research artifact merged via PR #2, merge commit `f0eb3e9ef2ff23cff6ffcec85191949e40d8cf3a`.
  - TDnet/Japan IR, North Korea/J-Alert, shipping/chokepoints, China/systemic, and abrupt-market lanes remain unresolved for independent replacement measurement.
  - Recommended model for next observation/research: Luna.

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

- H1はcoverage-gap source researchを完了。production mutation 0; shadow/legacy Cron、Function、schema、OAuth/Vaultは変更なし。採用sourceなし、paid/live fallbackを維持。
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
