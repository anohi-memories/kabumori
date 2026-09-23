# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (H1 caller-auth candidate freshened and fully verified; awaiting C1; production unchanged)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-important-news-monitor-caller-auth-finalize-20260923`
  - PR #12 is freshened on `118fb488`; final head `9dffce9`, 7 files. Vercel passed.
  - Targeted auth/wiring/migration tests: 7/7; full Important News suite: 431/431; disposable PostgreSQL migration/rollback proof passed.
  - Handler-wide Deno check reaches existing TS2322 in unchanged `_shared/x_oauth2_post.ts:66`; changed auth modules/tests check cleanly.
  - Production migration, Vault write, Function secret/config change, and deploy are all 0; each requires separate approval. Keep `verify_jwt=false`.

- Codex slot 2: `ready` — `x-autopost-phase0c-production-brand-scope-rollout-20260923`
  - Phase0b C2 PASS後のproduction gate。
  - rollout順序は compatible x-test-post deploy → runtime確認 → fresh schema/planner preflight → exact migration apply → postflight。
  - deploy/migration直前にユーザーの明示同意が必須。generic OK/すすめてはproduction mutation同意として扱わない。
  - Cron/OAuth/Vault/publish_enabled/Netlify/Vercelは変更禁止。X投稿も禁止。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 caller-auth source/config candidate is in PR #12; production migration, Vault/secret configuration, and Function deploy are not approved and remain unapplied. PR #11 remains open/draft/unmerged and was not touched.
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
