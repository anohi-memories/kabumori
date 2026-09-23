# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-23 JST (C1 accepted GPT-6 schema blocker; next H1 queued for narrow migration + source candidate; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `kabumori-important-news-gpt6-schema-and-source-candidate-20260923`
  - C1 accepted the GPT-6 prototype diagnosis and schema blocker.
  - Existing CHECK constraints on `judgement_model` and `generation_model` allow only GPT-5.6 IDs, so direct GPT-6 runtime deployment would fail persisted writes.
  - Next H1 is authorized to create one narrow forward migration candidate permitting GPT-6 Luna/Sol while preserving GPT-5.6 historical rows, plus rebuild the already-tested GPT-6 source candidate on latest main.
  - Migration apply and Function deploy remain forbidden in that H1.
  - Prototype test evidence: targeted 172/0, full Important News 423/0 (--no-check), production mutation 0.
  - Recommended model: Luna.

- Codex slot 2: `done` — `social-mobile-app-phase22-live-history-dependency-gate-default-off-20260923`
  - C2 PASS。production `social-mobile-history-learning` はACTIVE v2 / verify_jwt=true。
  - live dependency wiringは実装・deploy済みだが、server-only gate `SOCIAL_MOBILE_HISTORY_LIVE_ENABLED` は absent/OFF。
  - exact `true` の時だけ live path。service-roleはON branchでのみ読まれ、tenant readsはuser bearer + anon/publishable key。
  - access-token RPC invocation 0、Vault plaintext read 0、real X history call 0、persona/raw-history write 0、publish mutation 0。
  - 次はPhase23: dedicated QAでexactly-one explicit-consent history-learning run。publish/persona persistenceは別承認。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 GPT-6 unification is stopped for C1 on model CHECK constraints; local prototype only, no producer deploy/migration/RPC.
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
