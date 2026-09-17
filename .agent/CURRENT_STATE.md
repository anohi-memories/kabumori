# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-17 JST (H1 production deploy review_required; H2 social mobile app Phase2 ready)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `x-ai-lab-vault-token-refresh-production-deploy-20260917`
  - refresh helper candidate `f22e2ca` + focused fail-closed fix `09a199a` はC1 PASS。
  - 2xxのみsuccess、401のみrefresh 1回、401以外non-2xxは即fail、uncertainはno-refresh/no-resend。
  - focused 13/13、x-test-post + `_shared/brand` regression 469/469。
  - candidate `a7ffba4` は実Vault writer/persistence adapter、rotation concurrency guard、completion/idempotency外周維持を実装・検証済み。
  - 本番secret名、`vault.update_secret` のservice_role限定権限、現行OAuth Basic+refresh方式に加え、隔離probeでEdge runtimeのdirect `SUPABASE_DB_URL`接続成功、effective role=`postgres`、Vault writer EXECUTE=`true`をread-only確認済み。probeは検証後削除。
  - exact candidate `a7ffba4` を`x-test-post`のみへdeploy済み（ACTIVE v113、`verify_jwt=false`）。他Function・DB・Vault・OAuth・Cron変更なし。
  - deploy直後に利用可能な自然AI Lab slotはなく、既存Cron経路での次回自然観測待ち。手動投稿・retry/backfill・manual refresh・OAuth再認可は未実施。

- Codex slot 2: `ready` — `social-mobile-app-phase2-auth-data-20260917`
  - Phase1 shellはC2 PASS・main反映済み。
  - Phase2は `apps/social-mobile/**` を中心に、Supabase client/Auth session境界、active account context、mock/Supabase repository adapter、既存multibrand schemaのread-only mappingを進める。
  - production migration/RLS/RPC/db push、SNS OAuth、X/Instagram/Threads実投稿、Storage/AI/Push/課金はまだ行わない。
  - tenant ownership/RLSが不足する場合はclient filterで誤魔化さず、blocked stateと不足要件をC2へ返す。

- Claude slot 1: `ready` — `market-report-shared-platform-phase2-consumer-cutover-20260917`
  - Phase1 `market_data_packet.v1` shadow rolloutは本番稼働済み。
  - Phase2は `market_report_packet.v1` とX/app共通consumer candidate。K1前のproduction consumer switchは禁止。

- Claude slot 2: `done` — `morning-greeting-image-cost-gate-rollout-20260917`
  - 朝の挨拶OFF時のOpenAI画像生成/Storage書込skipゲートはmain反映・K2 PASS済み。
  - 翌朝05:30 JSTの自然確認は別read-only観測。

## Parallel safety

- H1はAI Lab refresh integration/preflight担当。OAuth/Vault/x-test-post認証経路を扱うがproduction mutation/deployは禁止。
- H2は `apps/social-mobile/**` とread-only schema inventory中心。production DB/schema/RPC/RLS、OAuth/Vault/x-test-postには触れない。
- G1はmarket report packet / x-test-post morning-close / personalized-reports領域。OAuth/Vault/social account stateへ触れない。
- G2はdone。
- 同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数slotで同時変更しない。
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues

- AI Lab通常`brand_post`はOAuth再認可後1回成功後、次slotで401再発。恒久復旧は未成立。
- refresh helperとintegration candidateはC1レビュー待ち。runtime preflight後、承認済みcandidateを`x-test-post`のみへv113 deploy済み。自然slot観測とC1確認待ち。token mutation/OAuth再認可は未実施。
- social mobile appはPhase1 shell完了。Phase2でAuth/session、active account、Supabase adapter、既存schema mappingへ進む。production schema/RLS不足があれば適用せずC2へ返す。
- multibrand migrations `20260910170000/180000/190000` objectsはproductionに存在するがmigration history不整合の可能性があるためblind `supabase db push`禁止。
- 2026-09-09 morning_greeting legacy Storage receipt HTTP400は別件。
- 重要ニュースX生成にはFact/Voice系generation_failedが残る。

## 更新ルール

- 各専用TASKが正本。`ACTIVE_TASK.md` / `CURRENT_STATE.md` は索引・短い現在地であり、矛盾時は専用TASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
