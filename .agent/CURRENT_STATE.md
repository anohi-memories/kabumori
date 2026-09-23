# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (PR #9 freshened; merge held by required Vercel build-rate limit; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-important-news-gpt6-schema-source-merge-20260923`
  - C1 PASS on PR #9 source-only candidate.
  - PR #9 adds one narrow forward migration permitting GPT-6 Luna/Sol in `judgement_model` and `generation_model` while preserving GPT-5.6 historical values.
  - Candidate runtime uses GPT-6 Luna for judgement first-pass, breaking-market search, and post generation; GPT-6 Sol for existing escalation only.
  - GPT-6 pricing/accounting and unknown-model fallback are updated; GPT-5.6 rates remain historical-only.
  - Candidate verification: targeted 173/0, full Important News 424/0, changed logic/test checks and diff-check passed.
  - At C1 the prior head's Vercel check was successful; after freshening, the required Vercel check failed on the new head due to a 24-hour rate limit. Main drift since the merge-base is control files only; no implementation overlap.
  - PR #9 was freshened to `ebe3c588ec4edb080848d706d8ec5cf8ada42b1d` on main `4d27304d4dce804c2ae5226fa338252e17f4560a`; all 424 tests pass.
  - Required Vercel check failed with a 24-hour build rate limit. Merge was not attempted/bypassed. Wait for quota reset or C1 direction, then rerun required check and merge only if it passes.
  - Production mutation 0.
  - Recommended model: Luna.

- Codex slot 2: `ready` — `social-mobile-app-phase23-dedicated-qa-one-shot-history-learning-20260923`
  - Phase22 C2 PASS済み。次はdedicated QA user/accountでexactly-one live history-learning QA。
  - live実行直前にユーザーの明示同意が必須。genericなOK/すすめてはlive Vault/X read同意として扱わない。
  - 成功/失敗にかかわらず1回だけ実行し、直後にgateをOFFへ戻す。
  - publish/persona persistence/raw-history persistenceは引き続き禁止。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 GPT-6 source PR #9 is freshened but merge is held for the required Vercel rate-limit failure; no production migration/deploy/RPC.
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
