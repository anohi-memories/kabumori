# Claude Task 1

- task_id: market-report-shared-platform-phase1-shadow-rollout-20260917
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: K1 PASS済みの `market_data_packet.v1` Phase 1実装を、本番consumerを一切切り替えずにproduction shadowとして安全にrolloutし、朝刊/大引けの自然観測を開始できる状態にする。

## Approved source of truth

前タスク `market-report-shared-platform-phase1-data-packet-shadow-20260917` はK1 PASS。

承認済み実装:
- implementation commit: `e0d24ce3dc35267101ed3d569f694169f37d2430`
- migration: `supabase/migrations/20260919100000_market_report_data_packets_phase1.sql`
- new Edge Function: `supabase/functions/market-report-data-packet/**`
- docs: `docs/market-report-shared-platform/PHASE1_DATA_PACKET.md`
- DB proof: `docs/market-report-shared-platform/phase1_db_proof.sql`
- tests: Deno 35/35 PASS + disposable PostgreSQL proof 10/10 PASS

Phase 1はAIなしのshadow市場事実packetのみ。
既存X朝刊/X大引け/アプリ朝刊/アプリ大引けは、このrollout後もこのpacketを参照しない。

## Parallel safety — 最重要

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK.md`
7. fresh `origin/main`
8. approved implementation commit `e0d24ce3...` がmainに含まれていること

必ずisolated clean worktree/cloneを使用。
既存未コミット変更は他workstream所有物として触らない。

### Known other slots at assignment time

- H1: AI Lab OAuth 401 recovery。OAuth/VaultのAI Lab credentialのみを扱う想定。このG1はAI Lab/Kabumori/Mio OAuth/token/account stateを一切変更しない。
- H2: important-news URL removal deployはdone。
- G2: morning-greeting image cost gate rolloutはreview_required。workflow/script領域。このG1は `.github/workflows/**` / `scripts/morning-greeting-image*` を触らない。

同じmigration / RPC / Edge Function / Cron / production settingを他slotが触っていたらSTOP。
特に `market-report-data-packet`、`market_report_cycles`、`market_data_packets`、今回追加するCron名が他workstreamと重複していないことをfresh-checkする。

## Goal

本番にshadow基盤だけを導入し、既存consumerへ影響0のまま自然データ観測を開始する。

完了条件:
1. migrationを安全に単体適用
2. DB object/RLS/grants/RPC read-back一致
3. `market-report-data-packet` のみdeploy
4. runtime source byte一致
5. dry-runでmorning/close各1回、安全性確認
6. shadow Cronを朝/大引けに追加
7. Cron/Function/DBが既存X・アプリ・Pushを呼ばないことを確認
8. 自然観測に必要な診断手順をReportへ残す

## Authorized production actions

このG1に限り、以下を許可する。

### A. Migration apply

対象は **この1ファイルのみ**:
- `supabase/migrations/20260919100000_market_report_data_packets_phase1.sql`

手順:
1. fresh `origin/main` とapproved source一致確認
2. productionに対して rollback-contained 事前proofを行う
   - `BEGIN`
   - migration本体相当をtransaction内で検証
   - table/constraint/trigger/RPC/RLS/grant確認
   - 意図的rollback
   - production stateが元に戻っていることをread-back
3. proof PASS後だけ、migrationファイル1本を安全なsingle-file手段で適用
4. apply後にDB objectをread-back

絶対禁止:
- `supabase db push`
- migration history repair/reconcile
- 他migration適用
- server-assigned versionを推測して合わせる

repoの既知のmigration-history乖離はこのタスクで修復しない。

### B. Edge Function deploy

対象のみ:
- `market-report-data-packet`

要件:
- worktree-local `supabase/config.toml` / project ref / `pwd` / HEAD / origin/main をdeploy直前に確認
- 現行projectが正しいことを確認
- JWT設定は実装/既存scheduler方式に合わせ、意図しないverify_jwt変更をしない
- 必要なら `--no-verify-jwt`。ただし実装側の `X-Cron-Secret` gateを維持
- deploy後に Function version/status/verify_jwt/updated_at read-back
- production Function sourceをdownload (`--use-api`) し、runtime filesをdeploy sourceとbyte比較
- 他Edge Functionのversion/updated_atが意図せず変わっていないことを確認

### C. Dry-run

migration + Function deploy後、**書き込みを伴わない `dry_run:true` 経路が実装済みであることをsourceで確認してから**実施。

- morning dry-run 1回
- close dry-run 1回

dry-runがDB packet insertやcycle state mutationを起こす実装なら、勝手に実行せずSTOPしてK1へ戻す。

dry-runで確認:
- OpenAI 0
- X API 0
- Push/Expo 0
- `x-test-post` invoke 0
- `personalized-reports` invoke 0
- `important-news-monitor` invoke 0
- source lineage / proxy label / freshness / qualityが想定どおり
- 1306は必ず `TOPIX連動ETF（1306）`

### D. Shadow Cron

production Cronを2本追加してよい。

推奨時刻:
- morning: 07:50 JST = `50 22 * * 0-4` UTC
- close: 16:15 JST = `15 7 * * 1-5` UTC

要件:
- 既存Cron名と衝突しない固有名
- endpointは `market-report-data-packet` のみ
- existing scheduler secretをVaultから参照し、secret本文を出力しない
- bodyは report_type を明示
- Cron作成後、job名/schedule/commandのsecret-free部分だけread-back
- Cron作成自体が既存X/アプリCronを変更しない

重要:
**16:15 JSTで当日closeがYahoo `regularMarketTime`上確定済みかは未観測。**
初回自然closeが blocked `session_not_closed` でも即座に時刻を勝手に変更しない。まず観測事実として記録し、K1へ戻す。

## Observation contract

rollout完了後は自然実行を待つ。
人工的なproduction packet生成やbackfillはしない。

最低限、自然実行で後から追えるように以下をReportへSQL/確認手順として残す:
- `market_report_cycles` の report_type / trading_date / cycle_status / attempt_count / timestamps
- current packetの `data_quality.status`
- required_missing / stale / unavailable / intentional_gaps
- Yahoo `session_date` / `observed_at` / `fetched_at` / `freshness`
- content_hash
- X/アプリの既存利用値との比較方法

このタスク終了時点で自然実行がまだ来ていなくてもrollout自体は完了可能。ただし「自然観測待ち」を明記する。

## Safety invariants

今回のproduction rolloutでも絶対に維持:
- AI / OpenAI call = 0
- X投稿 = 0
- Push = 0
- existing consumer切替 = 0
- existing X/app behavior change = 0
- `x-test-post` source/deploy = 0
- `personalized-reports` source/deploy = 0
- `important-news-monitor` source/deploy = 0
- OAuth/Vault token mutation = 0（Cron secretは名前参照のみ）
- user settings変更 = 0
- app UI変更 = 0
- X本文変更 = 0

## Prohibited

- `supabase db push`
- migration history repair/reconcile
- approved migration以外のDB schema変更
- `x-test-post` / `personalized-reports` / `important-news-monitor` deploy
- OpenAI/manual AI invoke
- X post/manual resend
- Push/manual notification
- OAuth scope/token/handle changes
- AI Lab/Mio/Kabumori credential changes
- existing Cron schedule変更
- packet consumer切替
- Phase 2 `market_report_packet` 実装開始
- X大引け修正をこのtaskに混ぜる

## Verification

最低限:
1. fresh main / source commit確認
2. production rollback-contained migration proof PASS
3. single-file migration apply成功
4. tables/constraints/triggers/RPC/RLS/grants read-back一致
5. Edge Function deploy成功
6. runtime source byte一致
7. other Function untouched
8. dry-run morning/close PASS（安全なら）
9. Cron 2本のみ新規追加・read-back
10. existing X/app/news Functions/Cron unchanged
11. secrets printed = 0
12. AI/X/Push calls = 0
13. `git diff --check`
14. control/report metadata以外の不要source変更 = 0

## Completion

完了時:
- `.agent/tasks/CLAUDE_TASK_1.md` にReport追記
- status: `review_required`
- next_owner: `chatgpt`
- production apply/deploy/Cron evidenceを記録
- migration history乖離をそのまま明記
- 自然morning/close観測待ちを明記
- fresh `origin/main` を確認してcontrol/report metadataだけ安全にpush
- STOPしてK1待ち

Report必須:
- task_id
- result
- model_used
- source_base / deploy_source
- migration rollback-proof結果
- exact migration apply方法 / read-back
- Function before/after version / JWT / byte-compare
- dry-run結果
- Cron names/schedules
- existing consumer unchanged proof
- AI/X/Push 0 proof
- production changes一覧
- migration history note
- changed_files
- commit/push
- natural observation pending
- remaining risks
- next recommendation
