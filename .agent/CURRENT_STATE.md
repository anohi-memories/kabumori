# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-22 JST (H1 holdings/watch split + Important News detail quality review_required; PR #7 open; production mutation 0)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-mobile-holdings-watch-split-and-news-detail-quality-20260922`
  - Real-device QA: 銘柄検索/Portfolio/UI統一は概ね改善。
  - PR #7 implements the holdings/watch split with integrated search preserved; C1 review required.
  - Important News production fields were traced read-only; PR #7 fixes the verified-post presentation partition using event facts and keeps thin-source fallback.
  - Detail now keeps source-backed event/status facts beyond 要点 and removes generic market filler; no warning-only detail is generated.
  - Producer source and production deploy are unchanged; app-only candidate, production mutation 0.
  - Colors/icons/visual polish explicitly deferred to a later task.
  - Recommended model: Luna.

- Codex slot 2: `done` — `social-mobile-app-phase15-conversational-proxy-ai-and-history-learning-candidate-20260922`
  - C2 PASS。会話型「代打AI」source candidate、確認済みpersona/settings mapping、明示同意付きmock X履歴学習まで完了。
  - raw投稿恒久保存なし、confirmed personaのみpreview反映、production mutation 0。
  - real X-history adapterはserver側でAuth/workspace/account/platform user/Vault tokenをtrusted stateから解決することが次工程の必須条件。
  - production rollout / real X history / LLM conversational invoke / live publish は別TASK。
  - Recommended next model: Luna。

- Claude slot 1: `idle` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - market-report-analysis v2 shadow deployはK1 PASS済み。consumer gateはOFF。
  - 2026-09-24の自然shadow出力まで待機。x-test-post/personalized-reports consumer cutoverは未承認。

- Claude slot 2: `done` — `social-mobile-app-phase9-x-oauth-onboarding-20260919`
  - K2 PASS。OAuth state二重hash・retry/idempotency blocker修正済み。
  - 以降のPhase9 workstreamはH2へ正式引き継ぎ済み。

## Parallel safety

- H1 holdings/watch + news detail candidate is review_required; production mutation 0; no producer deploy/migration/RPC.
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
