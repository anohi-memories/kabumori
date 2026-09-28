# News Signal Pool — DB schema 案（N2。**未適用・migration なし**）

- 作成: 2026-09-28（N2。G1〜G4 外の直接作業）
- 位置づけ: N2 の観測器（`supabase/functions/_shared/news_discovery/`）が今はメモリ / JSON ファイルに保存している内容を、承認後に Postgres へ移すための**設計案**。
- **この文書は migration ではない**。適用には別タスクでのレビューと承認が必要。
- 既存テーブル（`important_news_candidates`、`important_news_monitor_runs`、`stocks_master` ほか）は**変更しない**。すべて新規テーブルで、expand-only。

## 0. 方針

1. 観測専用。アプリ・X・Push・既存 monitor はこれらのテーブルを読まない（RLS で service_role のみ）。
2. 保存するのは **source policy が許す範囲だけ**。
   - DIRECT_SOURCE：見出しと 280 字以内の要約ヒント。
   - DISCOVERY_ONLY（GDELT）：URL・ドメイン・見出し（照合用）・言語・国・検出時刻。本文と画像は保存しない。
   - 本文は保存しない。画像はダウンロードしない。
3. `published_at` と `fetched_at` を必ず分ける。`published_at` は source が明示したときだけ入れる（精度 `datetime` / `date` を併記）。
4. 重複判定のキーはコード（`store.ts`）と同じ規則を DB の制約と索引で再現する。
5. 除外は PROJECT_RULES「候補選定と除外ログ」に従い、理由コード付きで `news_source_run_items` に残す。

## 1. テーブル

### 1.1 `news_source_runs`（1回の巡回 × 1 source）

| 列 | 型 | 説明 |
|---|---|---|
| id | uuid pk | |
| run_group_id | uuid | 同じ巡回サイクルの束 |
| source_id | text not null | registry の `source_id` |
| request_url_hash | text | GDELT のクエリ URL などを識別（URL 本体は記録してよいが秘密を含まない） |
| discovered_via | text | `feed:<id>` / `gdelt:<query key>` |
| started_at / finished_at | timestamptz | |
| http_status | int | |
| outcome | text check in ('ok','not_modified','SOURCE_DISABLED','SOURCE_NOT_ENABLED_FOR_N2','SOURCE_REQUIRES_API_KEY','TIMEOUT','NETWORK_ERROR','HTTP_ERROR','RATE_LIMITED','EMPTY_RESPONSE','MALFORMED_RESPONSE') | `fetcher.ts` の分類と同じ |
| bytes | int | |
| raw_items / filtered / normalize_failed / normalized / duplicates / kept | int | `SourceStats` と同じ |
| etag / last_modified | text | 条件付き GET 用 |

索引: `(source_id, started_at desc)`。

### 1.2 `news_signals`（正規化済み signal。1行 = 1記事/1文書）

| 列 | 型 | 説明 |
|---|---|---|
| id | text pk | `fingerprint`（sha256。source_id ＋ external_id、無ければ URL キー＋タイトル指紋） |
| source_id | text not null | |
| policy | text check in ('DIRECT_SOURCE','DISCOVERY_ONLY') | DISABLED は保存しない |
| source_type | text | |
| source_url | text not null | |
| canonical_url | text not null | |
| url_key | text not null | スキーム・www 無視の重複キー |
| external_id | text | guid / document_number / accession / docID |
| title | text not null | DISCOVERY_ONLY は照合用。**表示禁止** |
| title_fingerprint | text not null | 正規化タイトルの sha256 先頭32桁 |
| summary_hint | text check (char_length(summary_hint) <= 280) | DISCOVERY_ONLY は常に null |
| published_at | text | `YYYY-MM-DD` または ISO（精度は次列）。source 未提示なら null |
| published_at_precision | text check in ('datetime','date') | |
| published_ts | timestamptz generated | precision=datetime のときだけ値（検索・並べ替え用） |
| updated_at_source | timestamptz | Atom `updated` 等 |
| detected_at | timestamptz | GDELT seendate（公開時刻ではない） |
| fetched_at | timestamptz not null | 初回取得時刻（ベンチマークの `new_first_seen_at`） |
| language / country / publisher | text | |
| topics | text[] not null default '{}' | |
| same_event_group | text | 代表 signal の id |
| image_url | text | image_usage_allowed の source だけ。N2 では常に null |
| image_source | text | |
| image_usage_allowed | boolean not null default false | |
| discovery_only | boolean not null | |
| discovered_via | text not null | |
| needs_verification | text[] not null default '{}' | Web Search 候補の理由（検索はしない） |
| raw_reference | jsonb | feed URL と item 番号 |
| created_at | timestamptz default now() | |

制約・索引:

- `unique (source_id, external_id) where external_id is not null`
- `(canonical_url)`, `(url_key)`, `(title_fingerprint, fetched_at desc)`, `(fetched_at desc)`, `gin (topics)`
- 同一 source が同じ URL を別タイトルで再利用する例（ESRI）があるため、**`url_key` に unique 制約は付けない**。重複判定はアプリ側の規則（下記）で行う。

### 1.3 `news_signal_entities`

| 列 | 型 |
|---|---|
| signal_id | text fk → news_signals(id) on delete cascade |
| kind | text check in ('country_or_region','institution','chokepoint','commodity','company_alias') |
| value | text |
| primary key | (signal_id, kind, value) |

### 1.4 `news_signal_tickers`

| 列 | 型 | 説明 |
|---|---|---|
| signal_id | text fk | |
| ticker_code | text not null | `stocks_master.ticker_code`（FK は付けない：上場廃止後も履歴を残す） |
| status | text check in ('confirmed','candidate') | weak alias のみは candidate |
| match_types | text[] | EXACT_COMPANY_NAME / STRONG_ALIAS / WEAK_ALIAS / TICKER_CODE |
| matched_aliases | text[] | |
| in_title | boolean | |
| score | numeric(3,2) | |
| alias_dictionary_version | text | 辞書の版（誤検出の追跡用） |
| primary key | (signal_id, ticker_code) | |

索引: `(ticker_code, status)`。将来の「保有銘柄ニュース」は `tracked_stocks` との join（`holdings.ts` の `holdingNewsCandidates` と同じ規則。confirmed のみ、DISCOVERY_ONLY は除外）。

### 1.5 `news_source_run_items`（除外ログ）

| 列 | 型 | 説明 |
|---|---|---|
| id | bigserial pk | |
| run_id | uuid fk → news_source_runs | |
| item_index | int | |
| outcome | text check in ('kept','duplicate','filtered','invalid_url','empty_title') | |
| reason_code | text | 例: `jma_routine_telegram`, `canonical_url`, `normalized_url`, `source_external_id`, `title_fingerprint` |
| signal_id / duplicate_of | text | |
| created_at | timestamptz | |

本文・見出し全文は入れない（理由コードと ID のみ）。

### 1.6 `company_aliases`（v0 の辞書を DB へ移す場合）

| 列 | 型 |
|---|---|
| ticker_code, alias, alias_kind, strength (EXACT_COMPANY_NAME/STRONG_ALIAS/WEAK_ALIAS), origin (stocks_master/generated/known_alias_v0/edinet/wikidata/manual), context_terms text[], negative_terms text[], reviewed_by, valid_from, valid_to, dictionary_version |

v0 はコード内の `KNOWN_ALIASES_V0` と `stocks_master` からの自動生成で足りる。DB 化は辞書が数百件を超えた段階でよい。

## 2. 重複判定の規則（コードと同じ）

実データ（2026-09-28）で見つかった誤統合を踏まえた規則。

1. 同じ `source_id` ＋ `external_id` → 重複。
2. `canonical_url` または `url_key` が一致し、**別 source であるか、同じ source で同じタイトル** → 重複。
   - 同じ source が同じ URL を新しいタイトルで出した場合は新しい signal（ESRI の指標ページで実例あり）。
3. タイトル指紋の一致は、**別 source のときだけ**、かつ 72 時間以内・正規化後 15 文字以上のときだけ重複とする。
   - 同じ source の同名文書は別物として残す。実例：Federal Register の同名通知が 4 件、官邸の「弾道ミサイル発射に関する総理指示」は毎回同じタイトル。
   - 統合すると新しいミサイル発射を取りこぼすため、ここは安全上もっとも重要な規則。

## 3. 保持期間・権限

- `news_signals`：90 日（ベンチマーク期間＋余裕）。DISCOVERY_ONLY の `title` は 30 日で null 化する案。
- `news_source_runs` / `news_source_run_items`：30 日。
- RLS：全テーブル enable、policy なし（service_role のみ）。`authenticated` / `anon` に grant しない。
- 容量見積り：1 日 約 2,000〜3,500 signal（N1 推計）× 90 日 ≒ 20〜30 万行。1 行 1〜2KB として数百 MB 未満。

## 4. 移行手順案（承認後）

1. expand-only migration（上記テーブルのみ）。既存テーブルに触れない。
2. `NewsSignalStore` の Postgres 実装を追加（`store.ts` のインターフェースはそのまま）。
3. 新規 Edge Function（例: `news-discovery-observer`）から呼ぶ。**Cron 登録は別承認**。
4. ベンチマーク（news_recall_benchmark.md）用に `fetched_at` を event 台帳と突き合わせる SQL を用意。

## 追記（N3、2026-09-28）: 実装済みの差分

本案をもとに migration `supabase/migrations/20260928120000_news_discovery_observer.sql` を作成した（**未適用**）。本案からの主な変更点は次のとおり。詳細は n3_observer_db_function.md §2。

- テーブル名：すべて `news_discovery_` 接頭辞にした（本番ニュースのテーブルと取り違えないため）。
- 追加テーブル：`news_discovery_search_config`、`news_discovery_searches`（限定 Web Search の予算と記録）。`company_aliases` は作らず、v0 はコード内の辞書のまま。
- 権限：テーブルへの書き込みは誰にも許さず、書き込みは SECURITY DEFINER 関数（service_role のみ実行可）だけで行う。
- 公開時刻：`published_at`（時刻）と `published_date`（日付のみ）を別列にした。
- ticker：`confirmation_basis` を追加した。
- signal：`restricted_publisher` と `search_id` を追加した。
- 除外ログ：`news_source_run_items` は作らず、source 単位の `news_discovery_run_sources.requests` と件数で代替した。item 単位の除外ログが必要になったら追加する。
