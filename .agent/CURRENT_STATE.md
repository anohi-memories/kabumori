# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (H1 caller-auth source/config candidate ready for C1; production unchanged)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-important-news-monitor-caller-auth-remediation-candidate-20260923`
  - PR #12 contains source-only caller-auth validation and a Vault-backed header candidate for exactly the four existing monitor Cron jobs.
  - Targeted auth/wiring/migration tests: 7/7 passed; Deno check for caller-auth helper passed. Full regression suite / disposable SQL execution not run.
  - Production migration, Vault write, Function secret/config change, and deploy are all 0; each requires separate approval. Keep `verify_jwt=false`.

- Codex slot 2: `done` — `x-autopost-phase0b-publish-claim-brand-scope-and-migration-reconciliation-20260923`
  - C2 PASS。publish_claim clientをtrusted brand_id必須・brand-scoped conflict/updateへ変更するsource candidate完成。
  - 4 planner RPCのscheduled_posts ON CONFLICTもbrand-scoped化するforward migration candidate完成。
  - disposable PostgreSQLで2ブランド共存、same-brand duplicate rejection、planner idempotency、rollback、SECURITY DEFINER/search_path/EXECUTE維持を確認。
  - tests: targeted 35/35 PASS、x-test-post full regression 403/403 PASS、publish_claim module deno check PASS、git diff check PASS。
  - production mutationは0。source/history driftはblind replay/history repair禁止、forward-only fail-closed reconciliation方針。
  - 次のproduction gate順序: compatible x-test-postを先にdeploy→runtime確認→fresh preflight→exact migration apply→read-back。deploy/applyはまだ未承認。
  - Recommended model for production gate: GPT-6 Sol Medium。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 caller-auth source/config candidate is in PR #12; production migration, Vault/secret configuration, and Function deploy are not approved and remain unapplied.
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
