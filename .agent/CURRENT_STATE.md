# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-17 JST (H1 refresh candidate)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `x-ai-lab-vault-token-refresh-candidate-20260917`
  - dispatcher復旧済み。
  - AI LabのみOAuth再認可済み。
  - 2026-09-17 16:23 JSTの自然slot 6は1回成功し、X post id 1件 / fingerprint 1件。
  - その次の17:34 JST自然slot 7で `X_REQUEST_FAILED:401` が再発。x_post_id追加なし / fingerprint追加なし / retry/backfillなし。
  - H1 read-only調査で、slot6成功→slot7 401は同じ固定Vault-backed経路で再現。AI Lab runtimeはrefresh無効・legacy fallbackなし。
  - AI Lab専用refresh/rotation candidate `ed796ba` とmock testsを作成。production deploy/token mutation/OAuth再々認可は未実施。C1 review_required。

- Codex slot 2: `done` — `kabumori-news-url-removal-production-deploy-20260917`
  - `important-news-monitor` v55へ、通常重要ニュースX本文の外部URL除去を本番反映済み。
  - source URL metadataは保持。
  - 次の自然重要ニュース投稿でURLなし本文をread-only観測するだけで、本タスク完了をブロックしない。

- Claude slot 1: `ready` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - Phase1 `market_data_packet.v1` shadow rolloutは本番稼働済み。
  - Phase2は `market_report_packet.v1` を1 cycle 1回生成し、X朝刊/大引けとアプリ市場部分を同じshared packetへ寄せるcandidateを作る。
  - K1前のproduction consumer switchは禁止。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - 朝の挨拶OFF時にOpenAI画像生成/Storage書込をskipするゲートはmain反映・K2 PASS済み。
  - 翌朝05:30 JSTの自然実行確認は別read-only観測であり、このslotは空き。

## Parallel safety

- H1はAI Lab OAuth/Vault/x-test-post認証経路のrefresh candidateを担当。production deploy/token mutationはC1後のみ。
- G1はmarket report packet / x-test-post morning-close / personalized-reports領域。OAuth/Vault/social account stateへ触れない。
- H2/G2はdone。新タスクを割り当てる場合も、同じファイル・DB migration/RPC・Edge Function・workflow・production設定を他slotと同時変更しない。
- push前にfresh `origin/main`を確認する。
- 既存の未コミット変更は他workstream所有として触らない。

## Known issues

- AI Lab通常`brand_post`はOAuth再認可後に1回成功した後、次slotで401再発。恒久復旧は未成立。
- multibrand migrations `20260910170000/180000/190000` objectsはproductionに存在するがmigration history不整合の可能性があるため、blind `supabase db push`は禁止。
- 2026-09-09 morning_greeting legacy Storage receipt HTTP400は別件。
- 重要ニュースX生成にはFact/Voice系generation_failedが残っており、Push/アプリ表示とは分離して後続対応候補。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
