# Claude Task 1

- task_id: market-report-shared-platform-phase1-data-packet-shadow-20260917
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: 設計監査で確定した次世代共通市場レポート基盤のPhase 1として、AIを使わない `market_data_packet` のshadow実装を準備する。既存X朝刊/X大引け/アプリ朝刊/アプリ大引けの本番動作は一切切り替えず、共通の市場事実packetを安全に生成・保存できる土台だけを実装する。

## Approved design / source of truth

前タスク `market-report-shared-platform-design-audit-20260916` はK1 PASS。

設計書:
- `docs/market-report-shared-platform/DESIGN.md`

採用方針:

```text
market_data_packet
    ↓
market_report_packet
    ├─ X summary
    ├─ app market report
    └─ portfolio report(userごと)
```

Phase 1では **`market_data_packet` まで**。
`market_report_packet`、X切替、アプリ表示切替、マイポート生成はまだ実装しない。

ユーザー決定:
- Yahooは当面の暫定データソースとして使用可。ただしprovider/source_url/observed_at/freshness/proxy表記をpacketへ必ず保持し、将来差し替え可能にする。
- TOPIX代替に1306.Tを使う場合、表示・schema上は必ず `TOPIX連動ETF（1306）` と明示し、TOPIXそのものとして扱わない。
- 将来のアプリ既定タブは `市場全体` を第一候補とする。
- Xは将来300〜450字程度、材料多い日は最大500字程度を基本候補とする。Phase 1ではX本文を変更しない。

## Parallel safety — 最重要

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK.md`
7. fresh `origin/main`
8. `docs/market-report-shared-platform/DESIGN.md`

必ずisolated clean worktree/cloneを使用する。
既存未コミット変更は他workstream所有物として触らない。

### 現在の他slot境界

H1は `x-test-post` / AI Lab hotfixを扱う可能性がある。
このG1は以下を**変更・deployしない**:
- `supabase/functions/x-test-post/**`
- OAuth / Vault / social_accounts
- AI Lab / Mio routing
- posting_windows / scheduled_posts / X dispatcher

H2は `important-news-monitor` のURL除去production deployを扱う可能性がある。
このG1は以下を**変更・deployしない**:
- `supabase/functions/important-news-monitor/**`
- news publish path

G2は morning greeting image cost gateを扱う可能性がある。
以下を触らない:
- `.github/workflows/morning-greeting-image.yml`
- `scripts/morning-greeting-image*`

同じDB migration / RPC / Edge Function / workflow / production設定を別slotと同時変更しない。
競合が見つかったらSTOPして具体的に報告する。

## Goal

Phase 1で実装するのは、既存consumerから完全に独立した **shadowの市場データ正本**。

要件:
- AI / OpenAI call = 0
- X投稿 = 0
- Push = 0
- 既存4経路の入力・生成・表示を変更しない
- 新packet生成失敗が既存X/アプリを止めない
- packetは構造化事実のみ
- 値と説明文を混ぜない
- metric単位でsource lineage / freshness / qualityを保持
- retryしても同一cycleの既存確定packetを上書きしない設計を優先

## Phase 1 scope

### A. Persistence

設計書の案Bを基準に、Phase 1に必要な最小テーブルを実装する。

最低限候補:

1. `market_report_cycles`
   - id
   - report_type: morning / close
   - trading_date
   - cycle_status
   - scheduled_for / started_at / completed_at / failed_at
   - current_data_packet_id nullable
   - diagnostics / error metadata
   - unique(report_type, trading_date)

2. `market_data_packets`
   - id
   - cycle_id
   - schema_version (`market_data_packet.v1`)
   - report_type
   - trading_date
   - as_of
   - generated_at
   - payload jsonb
   - content_hash / deterministic identity if useful
   - data_quality_status
   - immutable once inserted

`market_report_packets` はPhase 2用なので、Phase 1で不要なら作らない。設計上、今作る明確な理由がある場合だけ追加しReportで説明する。

### B. `market_data_packet.v1`

最低限、以下の形をコード上の型/validatorとして固定する。

```text
schema_version
report_type
trading_date
as_of
session
metrics
news_refs
calendar_refs
data_quality
source_summary
generated_at
```

metricは最低限:
- key
- label
- value
- previous_close / change / change_pct（取得可能な場合）
- currency / unit
- session_date
- observed_at
- fetched_at
- provider
- source_url
- freshness
- quality
- is_proxy
- proxy_for nullable
- gap_reason nullable

`unavailable` / `stale` / `proxy` / `partial` を曖昧にせず表現する。

### C. Data acquisition

Phase 1の目的は「共通化可能な事実packet」をshadowで作れること。

優先順:

#### 必須
- 日経平均 `^N225`
- TOPIX連動ETF（1306） `1306.T`
- USDJPY（信頼できる現在の既存取得経路が確認できる場合）

#### 既存MICから再利用候補
- 米国金利（FRED）
- JGB / 財務省系
- 原油（EIA）

MICに正常な既存データがある場合は再取得より再利用を優先する。ただし `mic_source_registry is_active=false` とingest稼働の不一致は既知なので、意味が不明な状態でsource semanticsを勝手に変更しない。

#### 検証できた場合のみ追加
- 米主要指数
- SOX
- 日経先物
- グロース市場指数
- 業種別騰落

信頼できる既存経路・identifier・session semanticsを確認できないものは、推測で実装せず `gap_reason` として残す。

### D. Morning / Close semantics

morningとcloseで「同じmetric名でも要求鮮度が違う」ことをschema/validatorで明確にする。

#### morning
前夜〜朝の市場状況を表現できる構造にする。
- 日本株は前営業日終値で可
- 米国市場は直近完了session
- FX/rates/commoditiesはas_ofに対するfreshnessを明示

#### close
- 日本株は当日確定終値が必須
- ^N225 / 1306.Tは **日足 + regularMarketTime相当のsession確認** を基準候補とする
- ただしH1が `x-test-post` のclose取得を修正するまで、このG1から `x-test-post` へコード共有・import・修正はしない
- packet側で日足取得helperを新規独立実装する場合も、将来共通化しやすいpure helperにする

重要:
Yahoo 1分足の「最終足が15:30以降」判定は採用しない。設計監査で、^N225は15:29、1306.Tは15:24が通常最終バーになり得ると確認済み。

### E. Shadow-only execution path

Phase 1ではconsumer切替をしない。

実装候補は新しい独立Edge Functionとする。例:
- `market-report-data-packet`

要件:
- service-role / scheduler向けに限定
- AIを呼ばない
- `x-test-post` / `personalized-reports` / important-news producerを呼ばない
- X/Pushを絶対に呼ばない
- idempotent
- 同一 report_type + trading_date で同じ確定packetを重複生成しない
- failure diagnosticsはsecret-free

名前は実装前にrepo命名規約を確認し、より適切なら変更可。

### F. Cron / production rollout

このG1では **source + migration + testsの実装まで** を基本とする。

K1前は禁止:
- production migration apply
- Edge Function deploy
- production Cron追加
- manual production invoke
- synthetic production packet作成

K1後の別rolloutでshadow本番化する。

ただしローカル/disposable PostgreSQLでmigration proofを行うのは可。

## Migration safety

このrepoはproduction migration historyに乖離がある。

絶対禁止:
- `supabase db push`
- migration history repair/reconcile
- 既存server-assigned versionを推測して合わせること

migrationを作る場合:
- 新規ファイル1本にPhase 1 objectだけを入れる
- disposable PostgreSQLでforward / rollback-contained proof
- RLS / grants / SECURITY DEFINERがある場合は明示テスト
- production applyはK1後の別タスク

## Security / access

- raw packetはpublic writableにしない
- client直アクセスが不要なPhase 1ではservice-role onlyを優先
- 将来アプリが読むRPC/viewはPhase 3で追加可能。今作らなくてよい
- source_urlにsecret/query credentialを含めない
- diagnosticsにheaders/token/keyを保存しない

## Tests

最低限:

1. `market_data_packet.v1` schema/validator
2. morning / closeのsession semantics
3. 日経・1306の正しいlabel/provider/proxy表現
4. 1306をTOPIXそのものとして表示しない
5. close当日日足 + session確認 success
6. previous-day data reject / gap化
7. stale data gap化
8. unavailable metricでもpacket全体を壊さずpartialにできるケース
9. 必須close metric欠落時はdata_quality blocked/failed相当
10. idempotency
11. insert-only / immutable packet contract
12. duplicate cycle prevention
13. OpenAI call 0
14. X API call 0
15. Push call 0
16. existing `x-test-post` source unchanged
17. existing `personalized-reports` source unchanged
18. existing `important-news-monitor` source unchanged
19. migration disposable PG proof
20. `git diff --check`

外部HTTPを使うunit testはfixture/mockを優先する。
実Yahoo read-only確認が必要なら、明示的にaudit用途として最小限に留める。

## Acceptance criteria

- 新しいPhase 1 shadow実装だけで `market_data_packet.v1` を生成できる
- morning / closeを同じ基盤で扱える
- metricごとにsource/timestamp/freshness/qualityが追える
- 1306 proxy表記が正しい
- unavailable項目を推測で埋めない
- AI call 0
- consumer切替 0
- existing X/app behavior changes 0
- production changes 0 before K1
- full tests pass
- rollback/rollout手順がReportに明記される

## Prohibited

- `x-test-post` source/deploy
- personalized-reportsのconsumer切替
- app UI変更
- `important-news-monitor` source/deploy
- X朝刊/X大引け本文変更
- X投稿
- OpenAI invoke
- Push
- OAuth/Vault/token
- Cron変更
- production DB apply
- `supabase db push`
- migration history repair
- Yahooを正式契約済みソースのように表現すること

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/tasks/CLAUDE_TASK_1.md` にReport追記
- implementation/docs/migration/testsをcommit/push
- fresh `origin/main` を確認してSTOP

Report必須:
- task_id
- result
- model_used
- source_base / final_head
- exact new architecture/files
- packet schema
- data sources actually implemented
- data gaps intentionally left unresolved
- migration design/proof
- tests
- AI/X/Push call proof = 0
- existing consumer source unchanged proof
- production_changes = 0
- changed_files
- commit/push
- rollout plan after K1
- remaining risks
- next recommendation

## Report

- task_id: `market-report-shared-platform-phase1-data-packet-shadow-20260917`
- result: **実装完了（shadow、本番反映なし）**。AI を使わない `market_data_packet.v1` の生成・保存基盤を、新規 migration 1本・新規 Edge Function 1本・テスト・設計補足で実装。既存4経路・アプリ・Cron・本番は変更なし
- model_used: Opus 5（`claude-opus-5`）
- source_base: `origin/main` `1667657`（着手時、TASK 投入コミット）→ 途中 `f648a4e`（MIC USDJPY Cron automation）に rebase
- final_head: 本 Report を含む push 後の `origin/main`（`git log` 参照）

### exact new architecture/files

- `supabase/migrations/20260919100000_market_report_data_packets_phase1.sql`（新規1本）
  - `market_report_cycles`（`unique(report_type, trading_date)`、status / attempt / claim_token / current_data_packet_id / diagnostics）
  - `market_data_packets`（insert-only、`unique(cycle_id, attempt)`、payload と識別列の一致 check）
  - トリガ: packet の UPDATE/DELETE/TRUNCATE 拒否、packet と cycle の一致、cycle の pointer 一回設定・completed 固定・識別列固定
  - RPC（SECURITY DEFINER / `search_path=''` / service_role のみ）: `claim_market_report_cycle` / `complete_market_report_cycle` / `fail_market_report_cycle`
  - RLS 有効・ポリシーなし。anon/authenticated 権限なし、service_role は SELECT のみ
  - `market_report_packets` は Phase 2 用のため**作っていない**
  - 当初 `20260918100000` で作成したが、作業中に upstream へ `20260919090000_mic_fx_phase1_automation_cron.sql` が入ったため、順序を保つため `20260919100000` に改名（SQL 内容は同一）
- `supabase/functions/market-report-data-packet/`（新規）
  - `index.ts`（`Deno.serve` のみ）/ `handler.ts`（認証・営業日・claim・取得・検証・complete/fail、依存注入でテスト可能）
  - `session_logic.ts`（JPX/NYSE セッション、Intl によるタイムゾーン変換）
  - `packet_schema.ts`（型・metric 定義表・`deriveDataQuality`・`validateMarketDataPacket`）
  - `yahoo_daily.ts`（日足＋`regularMarketTime`、1分足不使用）/ `mic_metrics.ts`（MIC 再利用）/ `packet_builder.ts`（純粋関数の組み立て・news_refs・content hash）
  - テスト 4本＋`test_fixtures.ts`
- `docs/market-report-shared-platform/PHASE1_DATA_PACKET.md`（構成・schema・データ・欠落・不変条件・rollout/rollback）
- `docs/market-report-shared-platform/phase1_db_proof.sql`（使い捨て DB 用の検証スクリプト、最後に ROLLBACK）
- 関数名は repo の kebab-case 規約（`personalized-reports` 等）に合わせて `market-report-data-packet`
- 認証は `personalized-reports` と同じ `X-Cron-Secret` ＋既存 `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`（新しい secret なし）

### packet schema

- top-level: `schema_version` / `report_type` / `trading_date` / `as_of` / `session` / `metrics` / `news_refs` / `calendar_refs` / `data_quality` / `source_summary` / `generated_at`
- metric: `key` / `label` / `kind` / `value` / `previous_close` / `change` / `change_pct` / `currency` / `unit` / `session_date` / `expected_session_date` / `observed_at` / `fetched_at` / `provider` / `source_url` / `basis` / `freshness`（fresh|stale|unavailable）/ `quality`（official|trusted_free|unofficial_delayed）/ `is_proxy` / `proxy_for` / `required` / `gap_reason`
- validator が固定する規則: unavailable は値を必ず null ＋ gap_reason 必須 / stale は値を観測日付きで残し `stale_observation` / fresh は gap なし・期待セッションと一致 / lineage（provider・source_url・session_date・fetched_at・quality）必須 / source_url に認証情報系パラメータ禁止 / `is_proxy` と `proxy_for` の整合 / ラベル `TOPIX` 禁止・`proxy_for=TOPIX` のラベルは `TOPIX連動ETF（1306）` 固定 / close は `jpx_session_date=trading_date`、morning は前営業日 / `data_quality` を metrics から再計算して一致
- `data_quality.status`: 必須が fresh でない→`blocked`、任意の stale/unavailable やニュース取得失敗→`partial`、他→`ok`。`no_verified_source` の意図的欠落は partial の理由にしない
- morning / close の差: 日本株は close=当日終値必須、morning=前営業日終値。米国は as_of 時点で直近に引けた NYSE セッション。MIC は `mic_metric_domain_map.expected_observation_lag_minutes`（無ければ 4,320分）で鮮度判定
- news_refs: 前営業日 15:30 JST 以降・Fact passed・非重複・severity medium 以上の `important_news_candidates` を **id とメタデータのみ**（本文・見出しは持たない）最大30件
- content hash: fetch 時刻を除いた事実（session・metrics・news id・quality）の SHA-256

### data sources actually implemented

| key | 取得元 | 朝刊 | 大引け |
|---|---|---|---|
| `nikkei225` 日経平均 | Yahoo `^N225` 日足 | 必須 | 必須 |
| `topix_proxy_1306` TOPIX連動ETF（1306） | Yahoo `1306.T` 日足（`is_proxy`） | 必須 | 必須 |
| `dow` / `sp500` / `nasdaq_composite` / `sox` | Yahoo `^DJI` `^GSPC` `^IXIC` `^SOX` 日足 | 任意 | 任意 |
| `usdjpy` ドル円 | MIC `USDJPY`（Frankfurter/ECB 日次参照、`quality=trusted_free`） | 必須 | 必須 |
| `us2y` / `us10y` | MIC FRED | 任意 | 任意 |
| `jgb2y` / `jgb10y` | MIC MOF | 任意 | 任意 |
| `wti` / `brent` | MIC EIA | 任意 | 任意 |

- Yahoo 米指数・SOX は read-only 監査で `symbol` / `currency=USD` / `exchangeTimezoneName=America/New_York` / `instrumentType=INDEX` / 日足と `regularMarketTime`（16:31〜17:15 NY）を確認できたため採用。実装でもこの4項目が一致しない応答は `identity_mismatch` で拒否
- ドル円は Yahoo `JPY=X` ではなく、タスク指示どおり既存経路の MIC を再利用。本番 MIC には 2026-09-16 観測の USDJPY が存在し、upstream `f648a4e` で Cron 化済み
- `mic_source_registry.is_active=false` と ingest 稼働の不一致には触れず、`market_metrics` の行をそのまま読む

### data gaps intentionally left unresolved

- 日経平均先物: Yahoo `NKD=F` は CME のドル建て先物で大阪取引所の日経225先物ではないため不採用（`no_verified_source`）
- 東証グロース市場250指数: 指数の取得元なし。ETF 2516 は識別を確定できず不採用（`no_verified_source`、大引けのみの枠）
- 業種別騰落・経済指標カレンダー: 取得元未調査（`intentional_gaps` と `calendar_refs.status=unavailable`）
- JGB は本番 MIC の最新観測が 2026-08-31 のため、現状は常に `stale`（値は観測日付きで保持、packet は partial）
- NYSE 祝日は `market_holidays` に 2026 年分のみ。範囲外は `nyse_calendar_covered=false` と `data_quality.notes` に記録

### migration design/proof

- 環境: ローカル Podman のキャッシュ済み `public.ecr.aws/supabase/postgres:17.6.1.165`（PostgreSQL 17.6）を `--rm`・ポートなし・ボリュームなしで起動。使い捨てパスワード。終了後に停止し、`podman ps --all` で 0 件を確認。クラウド・本番リソースは不使用
- forward: migration ファイルをそのまま psql で適用 → `COMMIT` まで成功
- proof（`phase1_db_proof.sql`、全 10 項目 PASS、最後に ROLLBACK）:
  1. RLS 有効・ポリシーなし、RPC 3本が SECURITY DEFINER かつ `search_path=""`、anon/authenticated の表・RPC 権限なし、service_role は SELECT のみ
  2. anon/authenticated の実行時 permission denied
  3. claim → ok packet で complete → 再 claim は `already_completed`、cycle 1行・packet 1行（冪等）
  4. 完了後の古い token で complete → `MARKET_REPORT_CYCLE_CLAIM_LOST`
  5. packet の UPDATE/DELETE/TRUNCATE、pointer 変更、completed の状態変更、識別列変更、重複 cycle の INSERT をすべて拒否（所有者権限でも）
  6. payload と識別列の不一致、cycle と report_type の不一致を拒否
  7. blocked packet → cycle blocked・pointer なし → 再 claim（attempt 2）→ fail → 再 claim（attempt 3）→ partial で completed、blocked packet も履歴として残る
  8. 試行上限 3 で `attempts_exhausted`
  9. running 中の2回目 claim は `in_progress`
  10. stale（2時間前）の running は次の claim が引き継ぎ、古い token は complete 不可
- rollback containment: 別の空 DB で、migration 本体（begin/commit 除去）＋ `select 1/0` を1トランザクションで実行 → トランザクション内では2テーブル存在、エラー後 ROLLBACK で両テーブル absent・関連関数 0
- 改名（`20260918100000` → `20260919100000`）はファイル名のみで SQL 内容は同一

### tests

- `deno test --allow-read supabase/functions/market-report-data-packet/` **35 passed / 0 failed**（型チェックあり）
- `deno check supabase/functions/market-report-data-packet/index.ts` PASS
- diff の空白チェック（`--check`）PASS
- タスク指定 20 項目との対応:
  1 schema/validator（packet_builder_test「validator rejects …」ほか）/ 2 morning・close セッション（session_logic_test、packet_builder_test morning）/ 3・4 日経・1306 のラベル・provider・proxy、TOPIX 表記禁止（yahoo_daily_test、packet_builder_test）/ 5 当日日足＋セッション確認 success（yahoo_daily_test、15:30 ちょうど合格・15:29 不合格含む）/ 6 前日データ拒否（yahoo_daily_test、packet_builder_test blocked）/ 7 stale の gap 化（MIC JGB）/ 8 任意 metric 欠落で partial / 9 必須欠落で blocked / 10 冪等性（handler_test already_completed、DB proof 3）/ 11 insert-only・不変（DB proof 5・7）/ 12 重複 cycle 防止（DB proof 3・5）/ 13〜15 OpenAI・X・Push 呼び出し 0（handler_test の全通信記録と許可ホスト検査、ソース走査）/ 16〜18 既存 source 不変（下記）/ 19 使い捨て PG proof（上記）/ 20 diff 空白チェック
- read-only 実データ監査（テスト外、書き込み・secret なし）: 実 Yahoo 日足で packet を組み立て
  - 9/16 大引け: 日経平均 63,923（前日比 +0.69%）、TOPIX連動ETF（1306）423.9（+0.62%）、米指数は 9/15 セッション、validator 問題 0、quality `partial`（JGB stale のみ）
  - 9/17 朝刊（as_of 07:50 JST）: 日本株は 9/16 終値、米指数は 9/16 セッション（NYダウ -1.21%、SOX +0.63%）、問題 0
  - 9/17 14:17 JST に大引けとして実行: 日経・1306 とも `session_not_closed` で **blocked**（場中の値を終値として採用しないことを実データで確認）

### AI/X/Push call proof = 0

- `handler_test.ts` がすべての fetch を記録し、通信先が `query2.finance.yahoo.com` と Supabase REST だけであること、OpenAI / X / Expo / Edge Function 呼び出しがないこと、書き込みが `claim` と `complete`（失敗時 `fail`）の RPC だけであることを検証
- 同テストで、関数ソース（コメント除く）に OpenAI・gpt・X API・Expo・notifications・`x-test-post`・`personalized-reports`・`important-news-monitor` への参照や import がないことを走査
- 本タスク中に OpenAI・X・Push を手動で呼んだことはない

### existing consumer source unchanged proof

- `origin/main` との差分統計を `supabase/functions/x-test-post` / `personalized-reports` / `important-news-monitor` / `send-push-notifications` / `_shared` / `src` / `.github` / `scripts` に限定して取得 → **出力なし**
- アプリ UI・X 本文・Cron 定義・既存 migration の変更なし

### production_changes = 0

- 本番 migration 適用、Edge Function deploy、Cron 追加・変更、手動 invoke、合成 packet 作成、ユーザー設定変更、X 投稿、Push、OAuth/Vault 操作はいずれも **0**
- 本番への操作は read-only のみ: `market_metrics` / `mic_metric_domain_map` / `market_holidays` / `important_news_candidates` の列・値確認 SQL
- 外部は Yahoo 公開チャート API の GET のみ（銘柄識別の監査と実データ監査）

### changed_files

- `supabase/migrations/20260919100000_market_report_data_packets_phase1.sql`（新規）
- `supabase/functions/market-report-data-packet/index.ts` / `handler.ts` / `session_logic.ts` / `packet_schema.ts` / `yahoo_daily.ts` / `mic_metrics.ts` / `packet_builder.ts`（新規）
- `supabase/functions/market-report-data-packet/session_logic_test.ts` / `yahoo_daily_test.ts` / `packet_builder_test.ts` / `handler_test.ts` / `test_fixtures.ts`（新規）
- `docs/market-report-shared-platform/PHASE1_DATA_PACKET.md` / `phase1_db_proof.sql`（新規）
- `.agent/tasks/CLAUDE_TASK_1.md`（status と本 Report）

### commit/push

- 着手: `Mark Claude slot 1 market data packet shadow in_progress`（push 済み）
- 提出: 実装・migration・テスト・docs・本 Report を1コミットで `origin/main` へ push（push 後に fresh `origin/main` を確認して STOP）

### rollout plan after K1

1. fresh-check と他スロット競合確認（同じ migration / Function / Cron を触るスロットがないこと）
2. 本番 rollback-contained 事前テスト（begin ＋ migration 本体 ＋ 検証 ＋ `RAISE EXCEPTION` ＋ rollback）
3. `supabase db query --linked -f supabase/migrations/20260919100000_market_report_data_packets_phase1.sql` で単体適用（`supabase db push`・履歴修復は禁止）→ テーブル・制約・トリガ・RPC・RLS・権限の read-back
4. worktree から `market-report-data-packet` を `--no-verify-jwt` で deploy → download して byte 比較、他 Function の version / updated_at 不変確認
5. `dry_run: true` で朝刊・大引けを各1回（書き込みなし）確認
6. Cron 2本追加: 朝刊 07:50 JST（`50 22 * * 0-4`）、大引け 16:15 JST（`15 7 * * 1-5`）。Vault の既存 cron secret を名前参照
7. 2週間の shadow 観測: 日次で cycle status、`data_quality`、blocked 理由、Yahoo の `regularMarketTime` 確定時刻、X / アプリが実際に使った値との一致
- rollback: Cron 停止で生成停止（既存経路は参照していないため影響なし）。テーブルは残置可。削除する場合は cycles の pointer FK を外して両テーブル・RPC・トリガ関数を drop（手順は PHASE1_DATA_PACKET.md）

### remaining risks

- Yahoo は非公式・契約なしの取得元。仕様変更や遮断で必須 metric が unavailable になり得る（その場合は blocked で止まり、推測値は入らない）
- 大引け 16:15 実行時点で `regularMarketTime` が 15:30 以降に更新されているかは、実データ監査では「後続の日足あり」の経路で確認しており、**当日 16:15 のリアルタイム確認は未実施**（shadow 観測で確認）。単体テストでは 15:30 合格 / 15:29 不合格を固定済み
- ドル円は ECB 日次参照レートで、日中の値ではない。大引け時点では前営業日の参照値になる（`basis` で明示）
- JGB の MIC 観測が 8/31 で止まっており、常に stale
- NYSE 祝日データが 2026 年末まで。2027 年分の投入がないと `nyse_calendar_covered=false` になり、祝日が平日扱いになる
- 本物の2セッション同時 claim（行ロック競合）は DB proof では逐次で再現しており、並列実行での検証は未実施
- 認証 secret が push 用の名前を流用している（`personalized-reports` と同じ既存方式）。専用 secret に分けるかは K1 判断

### next recommendation

- K1 承認後、上記 rollout を**別タスク**として実施し、2週間の shadow 観測で「X / アプリが使った値との一致率」と「blocked の発生理由」を記録する
- 並行して、MIC 担当へ JGB 取り込みの停止（8/31 以降なし）と `mic_source_registry.is_active` の意味の確認を依頼
- 2027 年の NYSE 祝日データ投入を別途タスク化
- Phase 2（`market_report_packet` の shadow 生成）は、Phase 1 の shadow 観測で必須 metric の blocked 率が十分低いことを確認してから着手
