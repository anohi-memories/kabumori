# Claude Task 1

- task_id: market-report-shared-platform-phase1-data-packet-shadow-20260917
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
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
