# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-17 JST (H1 integration candidate review_required)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `x-ai-lab-vault-token-refresh-integration-candidate-20260917`
  - refresh helper candidate `f22e2ca` + focused fail-closed fix `09a199a` はC1 PASS。
  - 2xxのみsuccess、401のみrefresh 1回、401以外non-2xxは即fail、uncertainはno-refresh/no-resend。
  - focused 13/13、x-test-post + `_shared/brand` regression 469/469。
  - candidate `a7ffba4` は実Vault writer/persistence adapter、rotation concurrency guard、completion/idempotency外周維持を実装・検証済み。C1レビュー待ち。
  - production deploy/token mutation/OAuth再認可はC1前は禁止。

- Codex slot 2: `done` — `kabumori-news-url-removal-production-deploy-20260917`
  - `important-news-monitor` v55へ通常重要ニュースX本文の外部URL除去を本番反映済み。
  - source URL metadataは保持。自然投稿read-only観測のみ別件。

- Claude slot 1: `ready` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - Phase1 `market_data_packet.v1` shadow rolloutは本番稼働済み。
  - Phase2は `market_report_packet.v1` とX/app共通consumer candidate。K1前のproduction consumer switchは禁止。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - 朝の挨拶OFF時のOpenAI画像生成/Storage書込skipゲートはmain反映・K2 PASS済み。
  - 翌朝05:30 JSTの自然確認は別read-only観測。

## Parallel safety

- H1はAI Lab refresh integration candidate担当。OAuth/Vault/x-test-post認証経路を扱うがproduction mutation/deployは禁止。
- G1はmarket report packet / x-test-post morning-close / personalized-reports領域。OAuth/Vault/social account stateへ触れない。
- H2/G2はdone。
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues

- AI Lab通常`brand_post`はOAuth再認可後1回成功後、次slotで401再発。恒久復旧は未成立。
- refresh helperとintegration candidateはC1レビュー待ち。production deploy/token mutation/OAuth再認可は未実施。
- multibrand migrations `20260910170000/180000/190000` objectsはproductionに存在するがmigration history不整合の可能性があるためblind `supabase db push`禁止。
- 2026-09-09 morning_greeting legacy Storage receipt HTTP400は別件。
- 重要ニュースX生成にはFact/Voice系generation_failedが残る。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
