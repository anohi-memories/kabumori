# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-19 JST (H1 done; H2 social-mobile X connect UI shell ready; G1 natural shadow wait; G2 Phase9 OAuth blocker fix pending)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `done` — `important-news-hourly-cadence-simplify-20260919`
  - C1 PASS。production `important-news-fetch` command gateのみ更新済み。
  - 9/19〜9/23はJST偶数時00分のみ（12回/日）、9/24以降はJST毎時00分のみ（24回/日）。
  - 朝刊/大引け前後の20分刻み増強は撤回済み。judgement/generation/publish、market-report/MIC Cron、Edge Function、OAuth/Vault/X/Push変更0。

- Codex slot 2: `ready` — `social-mobile-app-phase10-x-connect-ui-shell-20260919`
  - 自動投稿アプリ側を優先。Accounts画面のX接続CTA、接続状態、deep-link受け口、client adapter境界を実装する。
  - G2のPhase9 server candidateはK2 blocker修正待ちのため、H2は `apps/social-mobile/**` のみ。RPC/migration/Edge Functionへは触れない。
  - production default data sourceはmock維持。本番変更0。

- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `ready` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - Phase8 tenant/Auth/profile/cleanupはK2 PASS済み。
  - 次はX OAuth account onboardingのread-only audit → safe candidate実装。
  - K2前のproduction OAuth/Vault/deploy/schema applyは禁止。

## Parallel safety

- H1はproduction `important-news-fetch` Cronのcommand gateのみ。schedule、他Cron、Edge Function、schema、OAuth/Vaultには触れない。
- H2はsocial-mobile `brand_memberships` / tenant RLS production rolloutのみ。H1の`daily_content_plans` objects、G1のmarket-report objectsを触れない。
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
