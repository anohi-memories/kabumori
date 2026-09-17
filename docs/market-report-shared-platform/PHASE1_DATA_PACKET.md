# Phase 1 — `market_data_packet.v1`（shadow）

- task_id: `market-report-shared-platform-phase1-data-packet-shadow-20260917`
- 設計: [DESIGN.md](DESIGN.md) §4（packet）/ §9 案B（保存）
- 位置づけ: **shadow のみ**。AI・X・Push を使わず、既存の X朝刊 / X大引け / アプリ朝刊 / アプリ大引けは何も参照していない。本番反映（migration・deploy・Cron）は K1 承認後の別タスク

## 構成

| 種類 | パス | 役割 |
|---|---|---|
| migration | `supabase/migrations/20260919100000_market_report_data_packets_phase1.sql` | `market_report_cycles` / `market_data_packets`、整合性トリガ、RPC 3本、RLS・権限 |
| Edge Function | `supabase/functions/market-report-data-packet/index.ts` | `Deno.serve` だけ |
| | `handler.ts` | 認証、営業日判定、claim → 取得 → 組み立て → 検証 → complete / fail |
| | `session_logic.ts` | JPX / NYSE の取引日・セッション計算（Intl でタイムゾーン変換、夏時間対応） |
| | `packet_schema.ts` | 型、metric 定義表、`deriveDataQuality`、`validateMarketDataPacket` |
| | `yahoo_daily.ts` | Yahoo 日足 → metric（1分足は使わない） |
| | `mic_metrics.ts` | MIC `market_metrics` → metric |
| | `packet_builder.ts` | packet 組み立て（純粋関数）、news_refs、content hash |
| tests | `*_test.ts`（4本）＋ `test_fixtures.ts` | 35件 |
| DB proof | `docs/market-report-shared-platform/phase1_db_proof.sql` | 使い捨て PostgreSQL 用の検証スクリプト（最後に ROLLBACK） |

## 実行の流れ

1. `X-Cron-Secret` を既存の `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` と照合（`personalized-reports` と同じ方式。新しい secret は作らない）
2. `market_holidays` を読み、JPX 営業日か、大引けは 15:30 以降か、朝刊は 09:00 前かを判定。外れたら何も書かずに `skipped`
3. `claim_market_report_cycle` で `(report_type, trading_date)` を claim。`already_completed` / `in_progress` / `attempts_exhausted` なら何もせず終了
4. Yahoo 日足・MIC・重要ニュース（id とメタデータのみ）を並列取得
5. packet を組み立て、`validateMarketDataPacket` で検証
6. 検証 OK → `complete_market_report_cycle`（ok / partial なら cycle 完了、blocked なら packet を残して再試行可能）
   検証 NG・例外 → `fail_market_report_cycle`（コードと HTTP ステータスだけ保存）

`dry_run: true` は claim も書き込みもせず packet を返すだけ（K1 承認後の本番確認用）。

## packet の形

```text
schema_version  "market_data_packet.v1"
report_type     morning | close
trading_date    JPX 取引日（JST）
as_of           実行時刻
session         jpx_session_date（close=当日 / morning=前営業日）, us_session_date, nyse_calendar_covered
metrics[]       key, label, kind, value, previous_close, change, change_pct, currency, unit,
                session_date, expected_session_date, observed_at, fetched_at,
                provider, source_url, basis, freshness, quality, is_proxy, proxy_for, required, gap_reason
news_refs       status, window_start（前営業日 15:30 JST）, items[]（ref_id とメタデータのみ。本文・見出しは持たない）
calendar_refs   status=unavailable, gap_reason=no_verified_source
data_quality    status(ok|partial|blocked), required_missing, stale, unavailable, proxies, intentional_gaps, notes
source_summary  provider ごとの取得状況
generated_at
```

`freshness` と `gap_reason` の組み合わせは validator が固定する:

| freshness | value | gap_reason |
|---|---|---|
| `fresh` | あり | `null` |
| `stale` | あり（観測日付きで残す） | `stale_observation` |
| `unavailable` | **必ず null**（推測で埋めない） | 必須（`fetch_failed` / `identity_mismatch` / `expected_session_not_available` / `session_not_closed` / `invalid_value` / `no_observation` / `no_verified_source`） |

`data_quality.status`: 必須 metric が1つでも fresh でなければ `blocked`、任意 metric の stale / unavailable やニュース取得失敗があれば `partial`、それ以外は `ok`。`no_verified_source` の意図的な欠落は `partial` の理由にしない。

## 実装したデータ

| key | 表示名 | 取得元 | 朝刊 | 大引け | 備考 |
|---|---|---|---|---|---|
| `nikkei225` | 日経平均 | Yahoo `^N225` 日足 | 必須（前営業日終値） | 必須（当日終値） | |
| `topix_proxy_1306` | TOPIX連動ETF（1306） | Yahoo `1306.T` 日足 | 必須 | 必須 | `is_proxy=true` / `proxy_for=TOPIX`。validator がラベル `TOPIX` を拒否 |
| `dow` / `sp500` / `nasdaq_composite` / `sox` | NYダウ / S&P500 / ナスダック総合 / SOX | Yahoo `^DJI` `^GSPC` `^IXIC` `^SOX` 日足 | 任意 | 任意 | 直近に引けた NYSE セッション |
| `usdjpy` | ドル円 | MIC `USDJPY`（Frankfurter / ECB 日次参照レート） | 必須 | 必須 | `basis=ecb_daily_reference_rate`、`quality=trusted_free`（公式値ではない） |
| `us2y` / `us10y` | 米国債利回り | MIC FRED | 任意 | 任意 | |
| `jgb2y` / `jgb10y` | 日本国債利回り | MIC MOF | 任意 | 任意 | 2026-09-17 時点で観測日 08-31 → `stale` |
| `wti` / `brent` | 原油 | MIC EIA | 任意 | 任意 | |

Yahoo は**暫定の非公式取得元**。`provider=yahoo_chart` / `quality=unofficial_delayed` を metric ごとに持ち、将来差し替えても packet の形は変わらない。

### Yahoo の判定

- 取得: `range=1mo&interval=1d`。**1分足は使わない**（DESIGN.md §1.5）
- 識別: `symbol` / `currency` / `exchangeTimezoneName` / `instrumentType` が期待と一致しなければ `identity_mismatch`（`^TPX` が CBOE の別銘柄だった事例への対策）
- 引け確定: 期待セッションの日足があり、かつ「それより後の日足がある」または「`regularMarketTime` がそのセッション日の引け時刻（JPX 15:30 / NYSE 16:00）以降」
- 前日の終値で当日分を埋めることはしない（`expected_session_not_available`）。場中は `session_not_closed`

## 意図的に残した欠落

| 項目 | 理由 |
|---|---|
| 日経平均先物 | Yahoo の `NKD=F` は CME のドル建て先物で、大阪取引所の日経225先物ではない。検証できる取得元がない |
| 東証グロース市場250指数 | 指数そのものの取得元がない。ETF（2516）は識別を確定できていない |
| 業種別騰落 | 取得元未調査 |
| 経済指標カレンダー | 取得元未調査 |

## DB の不変条件（migration で強制）

- `(report_type, trading_date)` で cycle は1行
- `market_data_packets` は UPDATE / DELETE / TRUNCATE をトリガで拒否（所有者でも不可）
- `current_data_packet_id` は一度設定したら変更不可。設定できるのは同じ cycle の ok / partial packet だけ
- `completed` の cycle は他の状態に戻せない
- packet の `schema_version` / `report_type` / `trading_date` / `data_quality.status` は payload と一致必須、cycle とも一致必須
- claim 中の token を持つ呼び出しだけが complete / fail できる。stale（既定15分）の running は次の claim が引き継ぎ、古い token は書けない
- 再試行は既定3回まで
- RLS 有効・ポリシーなし。anon / authenticated は権限なし、service_role は SELECT のみ、書き込みは RPC 経由だけ

## 本番化（K1 承認後の別タスク）

1. fresh-check と他スロット競合確認
2. rollback-contained の事前テスト → `supabase db query --linked -f supabase/migrations/20260919100000_market_report_data_packets_phase1.sql` で単体適用（`supabase db push` 禁止）→ テーブル・トリガ・RPC・権限の read-back
3. `market-report-data-packet` を `--no-verify-jwt` で deploy → download して byte 比較、他 Function の version 不変確認
4. `dry_run: true` で朝刊・大引けを1回ずつ確認（書き込みなし）
5. Cron 2本を追加（朝刊 07:50 JST = `50 22 * * 0-4`、大引け 16:15 JST = `15 7 * * 1-5`）。Vault の既存 secret を名前で参照
6. 2週間 shadow 観測: 日次で `data_quality.status`、blocked 理由、X / アプリが使った値との一致を確認

## ロールバック

- Cron を止める → 生成が止まる（既存経路は元々参照していないので影響なし）
- Function は削除または旧版のまま放置で可
- テーブルは残してよい。削除が必要な場合は `market_report_cycles.current_data_packet_id` の FK を外してから両テーブルと RPC・トリガ関数を drop（packet は不変トリガがあるため、`drop table` で消す）
