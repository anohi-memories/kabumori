# N3 — 観測専用DB＋独立 News Discovery Function＋限定 Web Search（v2）

- 作成: 2026-09-28（G1〜G4 外の直接作業。worktree `kabumori-n1-news-sources`、branch `claude/n1-news-source-inventory-20260928`）
- 方針変更（N3 v2、ユーザー指示）: 「AI call 0 / Web Search 0」は撤回。**無料・公式ソースで大半を取り、普通の報道でしか拾えないものだけ限定 Web Search** で補う。数百回/日の常時検索には戻さない。
- 位置づけ: **観測専用**。`important-news-monitor`・breaking_market・headline trigger・shadow・Fact/Voice・app copy・Push・X には接続していない。既存の Web Search ルーティング・Luna/Sol・usage metering も変更していない。
- **production 変更なし**: migration 未適用・deploy なし・Cron なし・secret 作成なし・実検索なし（ローカルに API キーが無いため mock のみ）。

## 1. 4 層アーキテクチャ

```text
Layer 1  公式・一次情報（Tier A、無料、定点巡回）   → NewsSignal (DIRECT_SOURCE)
Layer 2  Discovery Source（GDELT、任意・失敗許容）  → NewsSignal (DISCOVERY_ONLY)
Layer 3  限定 Web Search（予算・上限・テーマ別クールダウン） → NewsSignal (SEARCH_DISCOVERY)
           ├ 通常: 5 レーンのローテーション（各レーン 6 時間に 1 回）
           └ トリガー: 市場異常 / Discovery signal（無料層で説明できない時だけ）
Layer 4  将来の有料ニュース API（NewsSourceAdapter の差し替え点のみ用意。契約なし）
                         ↓
              News Signal Pool（news_discovery_* テーブル）→ 将来の Event Pool / Recall 比較
```

コード（`supabase/functions/_shared/news_discovery/` と `supabase/functions/news-discovery-observer/`）:

| ファイル | 役割 |
|---|---|
| `source_registry.ts` | Source Registry。policy = DIRECT_SOURCE / DISCOVERY_ONLY / **SEARCH_DISCOVERY** / DISABLED。DISABLED は `disabled_scope` で **no_access**（AI 処理まで禁止）と **no_direct_fetch**（直接取得禁止・検索結果に出るのは可）を区別 |
| `pipeline.ts` | `DiscoveryRun`：feed 取得と検索結果が**同じ** normalize → dedupe → topic/entity → ticker → 保存の経路を通る |
| `search_config.ts` | 検索量を決める数値の**唯一の置き場**（soft 30 / hard 48 / レーン / トリガー条件 / モデル） |
| `web_search.ts` | WebSearchProvider（OpenAI Responses web_search 版・独立実装）、予算、計画、実行、URL 検証 |
| `supabase_store.ts` | `NewsSignalStore` の Supabase 実装（RPC 経由）＋ `SupabaseSearchBudget` |
| `news-discovery-observer/` | 観測専用 Edge Function（認証、source 解決、run 記録、ログ） |

`NewsSignalStore` は Memory / JsonFile / Supabase の 3 実装。pipeline は DB 実装に依存しない。

## 2. DB（migration `20260928120000_news_discovery_observer.sql`、**未適用**）

先頭に `SOURCE CANDIDATE ONLY` と明記。新規オブジェクトはすべて `news_discovery_` 接頭辞で、既存テーブル（`important_news_candidates`、`important_news_monitor_runs`、`ai_usage_events`、shadow、`stocks_master`）には触れない。

### テーブル（7）

| テーブル | 内容 |
|---|---|
| `news_discovery_runs` | 1 回の実行。source 数・成功/失敗・HTTP 数・取得/正規化/重複/保存・topic/ticker・**search_count / denied / results / useful / duplicates**・ai_calls・web_search_calls・error_summary |
| `news_discovery_run_sources` | run × source。policy・outcome（ok/partial/failed/refused）・`requests`（via・結果コード・HTTP 状態・所要時間）・件数 |
| `news_discovery_search_config` | 検索予算の**正本**（1 行）。soft 30 / hard 48 / レーン間隔 360 分 / テーマ・クールダウン 180 分 / 再検索 1 回。`search_config.ts` と一致することをテストで確認 |
| `news_discovery_searches` | 1 回の検索（予約→完了）。lane・reason・search_key・triggered_by・親検索・query・結果数・新規・有用・重複・制限媒体・破棄・未検証 URL・トークン |
| `news_discovery_signals` | signal 本体（insert のみ）。§3 |
| `news_discovery_signal_tickers` | ticker 紐付け（本体と分離）。status・**confirmation_basis**・match_types・aliases・confidence・辞書版 |
| `news_discovery_signal_entities` | 固有表現（本体と分離） |

### 制約（DB 側でも方針を強制）

- **発見専用は metadata だけ**: `policy <> DIRECT_SOURCE` ⇔ `discovery_only`。discovery_only なら summary・image・表示可タイトルは不可。restricted_publisher は discovery_only のときだけ。
- **弱い alias 単独で確定しない**: `status='confirmed'` ⇔ `confirmation_basis` あり。`strong_match` には EXACT/STRONG が必須。`weak_with_context` / `multiple_weak` は WEAK のみの時だけ。
- **AI は検索の一部としてだけ**: `ai_calls <= search_count`。
- **重複除去の安全条件**: title・URL に unique 制約を**付けない**。一意なのは id（source＋external id、無ければ URL キー＋タイトル指紋）と `(source_id, external_id)` のみ。
  - 同じ source の同名文書は必ず残る（官邸のミサイル指示・Federal Register 同名通知）。
- `published_at`（時刻）と `published_date`（日付のみ）を分け、source が出さない時刻は作らない。

### 索引

- signals：canonical_url、url_key、(title_fingerprint, fetched_at)、fetched_at、(source_id, fetched_at)、topics GIN、search_id、`(source_id, external_id)` unique（external_id あり時のみ）
- 関連テーブル：tickers (ticker_code, status)、entities (type, value)
- searches：(search_day, status)、(search_key, reserved_at)
- runs：started_at

### RLS・権限

- 全 7 テーブルで RLS 有効、ポリシーなし。
- `anon` / `authenticated` には何も与えない。`service_role` は **SELECT のみ**で、INSERT/UPDATE/DELETE 権限は誰にも無い。
- 書き込みは 7 つの `SECURITY DEFINER`（`search_path = ''`）関数だけで行い、実行権限は service_role のみ。
  - begin_run / find_duplicates / insert_signals / recent_for_grouping / finish_run / reserve_search / complete_search
- `reserve_search` は `pg_advisory_xact_lock` で直列化する。上限判定 → 理由別の判定 → 予約（拒否も記録）の順。**同時実行でも hard cap を超えない**（§6 で実証）。
- 予算設定（`news_discovery_search_config`）を変えられるのは migration の所有者だけ。service_role は変更できない。

## 3. news_signals の主な列

id / fingerprint、source_id、source_type、policy、discovery_only、restricted_publisher、search_id、discovered_via（`feed:*` / `gdelt:*` / `search:LANE:reason`）、source_url、canonical_url、url_key、external_id、title、title_fingerprint、**title_display_allowed**、summary_hint（≤280、発見専用は null）、published_at / published_date / published_at_precision、source_updated_at、**detected_at**（GDELT の seendate / 検索時刻）、**fetched_at**、language、country、publisher、topics、needs_verification、same_event_group、image_url / image_usage_allowed、raw_reference、created_at。

Recall 比較（ChatGPT 検知 vs 新基盤検知）に必要な **detected_at / published_at / fetched_at / source / topic / ticker** はすべて保存する。

## 4. Observer Function（`news-discovery-observer`）

- **認証**: 専用ヘッダ `x-news-discovery-observer-secret` を定数時間で比較。
  - secret（`NEWS_DISCOVERY_OBSERVER_SECRET`）が未設定なら**全呼び出しを 503 で拒否**（fail closed）。**secret は作成していない**。
  - POST のみ受け付ける。
- **入力**: `sources`（最大 50）、`include_gdelt`、`gdelt_queries`（≤2）、`max_items_per_source`（≤200）、`trigger_type`、`search: { enabled, scheduled, anomalies[≤10] }`。
- **既定 source**: 有効な DIRECT のみ。
  - GDELT は既定で使わない（`include_gdelt` で明示時のみ）。
  - EDINET（キー未取得）と米国務省（observer UA に 403）は拒否として記録する。
- **Web Search**: **既定オフ**。`search.enabled=true`、かつ `OPENAI_API_KEY` がある時だけ実行する。キーが無い場合は `SEARCH_PROVIDER_NOT_CONFIGURED` を記録してスキップする。
- **run の状態**:
  - DIRECT が全部失敗 → `failed`
  - 一部失敗 → `completed_with_errors`
  - **GDELT や検索の失敗は run を悪化させない**（error_summary には残す）
- **DB の失敗時**:
  - begin 失敗 → 500。取得はしない。
  - 保存失敗 → run を `failed` で閉じて 500。バッチは RPC 単位で原子的。再試行しても ON CONFLICT で安全。
- **stocks_master**（既存、読み取りのみ・ページング）:
  - 読めなくても run は続け、ticker 紐付け無しで `ALIAS_INDEX_UNAVAILABLE` を記録する。
- **ログ**（構造化 JSON）:
  - 内容は run_id、source_id、要求結果、取得、正規化、重複、保存、ticker、topic、所要時間。検索は search_id、lane、結果数、有用数。
  - **記事タイトル・本文・secret は出さない**（§6 で確認）。
- 重要度判定・Fact・Voice・app copy・X・Push は一切しない。

## 5. 限定 Web Search（Layer 3）

### 予算（config: `search_config.ts`、DB 正本: `news_discovery_search_config`）

| 項目 | 初期値 | 意味 |
|---|---:|---|
| daily_soft_budget | 30 | これを超えたら通常ローテーションは止め、トリガーだけ許す |
| daily_hard_limit | 48 | すべての検索の絶対上限（JST 日単位） |
| lane_rotation_interval_minutes | 360 | 各レーンは 6 時間に 1 回まで（5 レーン → 最大 20 回/日） |
| search_key_cooldown_minutes | 180 | 同じテーマ（anomaly:WTI、signal:war:Iran 等）は 3 時間再検索しない |
| max_escalations_per_key_per_day | 1 | 情報不足時の追加検索は 1 回まで |
| max_trigger_searches_per_run / max_scheduled_searches_per_run | 2 / 1 | 1 回の実行で使える検索数 |

すべて固定仕様ではない。Recall・月額・件数・重複率を見て `news_discovery_search_config` の 1 行を更新して変える（コードの既定値も合わせる）。

### レーン（1 社 1 検索はしない。広い query で複数ニュースをまとめて発見）

| レーン | 対象 |
|---|---|
| WORLD | 戦争・軍事衝突・ミサイル・テロ・政変・制裁・海峡封鎖・国際危機 |
| MARKET | 株式急変・中銀サプライズ・金利・為替・商品 |
| ENERGY | 原油・LNG・OPEC・中東供給・製油所・タンカー／海運障害 |
| JAPAN | 日本企業の工場火災・生産停止・リコール・障害・サイバー攻撃・不正・行政処分・提携・新製品（日本語 query） |
| TECH | 半導体・AI・輸出規制・データセンター・メモリ価格・大規模障害 |

### トリガー検索の条件

1. **市場異常**：`search.anomalies`。
   - 対応銘柄：WTI / BRENT / NATURAL_GAS / GOLD / VIX / USDJPY / US10Y / NIKKEI_FUTURES / SOX / COPPER（レーンへ対応付け）。
   - 直近 180 分に**そのレーンの公式 signal があれば「説明済み」として検索しない**。
   - 異常の検知そのもの（価格データ）は未実装。market_anomaly_news_trigger.md の段階案どおり、入力インターフェースだけ用意した。
2. **Discovery signal**：GDELT 等の発見専用 signal が次のいずれかの topic を持ち、公式 signal で同じ事象を確認できない時。
   - 対象 topic：war / sanctions / disaster / cyber / supply_chain / recall
3. **エスカレーション**：トリガー検索で有用 signal が 0 件なら、レーンの fallback query で 1 回だけ再検索する。それ以上はしない（`needs_verification` のまま残す）。

### 結果の扱い（Web Search はレーダーであり、最終ソースではない）

- 検索結果のページは**取得しない**。
- 保存するのは URL・ドメイン・発見タイトル・検知時刻・query・レーン・理由だけ。
  - 要約・画像・モデルが示した公開時刻は保存しない。
  - `published_at` は null、`detected_at` = 検索時刻。
- **URL 検証**：モデルが返した URL は、検索ツールが実際に返した sources か引用（url_citation）にある時だけ採用する。それ以外は `rejected_unverified` として数える。
- **制限媒体**:
  - `no_access`（Al Jazeera・FT・ダイヤモンド：AI/TDM 禁止を明記）の結果は**保存せず破棄**し、件数だけ数える。
  - `no_direct_fetch`（NHK・時事・朝日・毎日・Yahoo!・BBC・CNBC・NYT・東洋経済 等）は `restricted_publisher=true`、`restricted_publisher_needs_primary` のフラグ付きで保持する。本文取得・表示はしない。
  - 事実確認は公式・一次情報で行う（将来 Fact 生成へ渡す際の前提）。
- 検索結果も公式 signal と**同じ重複除去**を通る（公式と同じ URL は重複として数える）。

### 計測（「30 回検索して有用 2 件」を見つけられるように）

`news_discovery_searches` に 1 検索 1 行で次を記録する。

- 予約・拒否（理由）・失敗（コード）
- result_count、new_signal_count、**useful_signal_count**（topic か確定 ticker を持つ新規 signal）、duplicate_count
- restricted_count、policy_blocked_count、rejected_unverified_count
- model_calls、web_search_calls、input_tokens、output_tokens

run にも集計値を持つ。**1 有用 signal あたりの検索数**は `sum(1) / sum(useful_signal_count)` で出せる。

## 6. ローカル検証結果（2026-09-28、production 書き込みなし）

Docker が無いため Supabase ローカルスタックは使えなかった。代わりに、既存の検証方式（`supabase/tests/*_run.sh`）に合わせて、Homebrew PostgreSQL 17 の**使い捨てクラスタ**で検証した（`/private/tmp` の Unix ソケットのみ）。検証後、クラスタとローカル専用 secret は削除した。

### migration 検証（`supabase/tests/news_discovery_observer_run.sh` → `NEWS_DISCOVERY_MIGRATION_PROOF_PASSED`）

1. **適用**：superuser でない owner で、anon / authenticated / service_role を再現した環境にクリーン適用できた。7 テーブル・7 関数。
2. **既存テーブル不変**：既存テーブルを模した土台（fixture）の定義・制約・ACL・RLS・関数・行数の指紋が、適用の前後で一致した。
3. **振る舞い**（`news_discovery_observer_behavior.sql`、T1〜T9 すべて合格）：
   - 権限：anon と authenticated は SELECT・EXECUTE とも拒否。service_role は直接 INSERT も設定変更も拒否。
   - 保存：3 件を保存。ticker 1・entity 1 は本体とは別テーブルに入り、官邸の同名文書 2 件は両方残った。
   - 再試行：同じバッチを再送すると保存 0 件・衝突 2 件で、関連行も増えなかった。
   - 重複判定：TypeScript と同じ規則だった（別 source の URL → 重複、同じ source の URL 再利用 → 新規、別 source の同名タイトル → 重複、同じ source の同名タイトル → 新規、期間外 → 新規）。
   - 途中の 1 行が制約違反なら、バッチ全体が取り消された。
   - 制約：弱い alias の確定、根拠なしの確定、`ai_calls > search_count` をいずれも拒否。
   - 検索予算：クールダウン、ソフト予算、ソフト予算超えでもトリガーは可、上限超え、完了の二重記録なし、再検索は 1 回まで、親の無い再検索は拒否。
   - finish_run は 1 回だけ有効で、終了済みの run には保存できない。
4. **同時実行**：上限まで残り 1 枠の状態で 2 つの予約を同時に送ると、**許可はちょうど 1 件**だった。
5. **ロールバック**：`news_discovery_*` だけが消え、既存の指紋は一致した。再適用もクリーンだった。

### Function の実地確認（Function → ローカル PostgREST 代替サーバ → 使い捨て DB）

`supabase/tests/news_discovery_postgrest_shim.ts` は 127.0.0.1 で待ち受け、許可した RPC と stocks_master の読み取りだけを中継する。

| 実行 | 内容 | 結果 |
|---|---|---|
| run 1 | 公式 9 本＋拒否 2 本（Al Jazeera・EDINET）＋GDELT 1 クエリ＋検索有効（キーなし） | `completed`。HTTP 10 回。取得 226、定常電文を除外 29、正規化 197、重複 1、**保存 196**、topic 155。GDELT は **429**（run は悪化しない）。拒否は `SOURCE_DISABLED` / `SOURCE_REQUIRES_API_KEY` で記録。検索は `SEARCH_PROVIDER_NOT_CONFIGURED` でスキップ。ai_calls 0 |
| run 2 | 同じ公式 9 本の再実行 | `completed`。**重複 197・保存 0** |
| 認証 | secret なし / GET | 401 / 405 |
| 検索（スタブ provider、実検索なし） | 市場異常 WTI＋ローテーション | WTI は直前 run の EIA エネルギー signal で**説明済みとしてスキップ**。ローテーション（JAPAN）を 1 回実行し、結果 3 件を処理（下記）。予算 RPC で予約・完了し、ai_calls 1 = search_count 1 |
| 検索の再実行 | 同じ条件 | 同じテーマは `duplicate_search_key` で**拒否**。provider は呼ばれていない |

検索（スタブ provider）の結果 3 件の内訳:

- Al Jazeera：破棄
- NHK：`restricted_publisher` で保持。トヨタ 7203 に strong_match で確定、supply_chain
- 公開ドメイン：保持
- 未検証 URL：1 件を不採用

DB に保存した signal の内訳（run 1）:

- published_at（時刻あり）132、日付のみ 20、Atom の updated のみ 44、topic 付き 155
- ticker は候補 1 件（「山口政務官」→ 山口FG、弱い alias のため確定させない）

Function ログは 24 行（run 開始・終了、source 単位の件数のみ）。**記事タイトル・secret は 0 件**。

### 自動テスト

`deno test --no-check --allow-read=supabase supabase/functions/_shared/news_discovery/ supabase/functions/news-discovery-observer/` → **101 passed / 0 failed**（N2 の 55 件は維持）。

主な追加テスト:

- **DB adapter**：insert、衝突、ticker・entity の分離、不正応答、5xx の再試行、4xx は再試行しない、キーを漏らさない
- **Function**：全成功、一部失敗（403）、全失敗（500/429）、拒否 source、GDELT 429、重複だけの run、0 件、DB 失敗、DB 開始失敗、stocks_master 不可、認証、不正入力
- **Web Search**：URL 検証、provider の失敗分類、hard / soft / クールダウン / 再検索 1 回 / JST 日付、計画、制限媒体、重複、有用件数、既定オフ、provider なし、検索失敗で run を悪化させない
- **migration 静的検査**：`news_discovery_*` だけ作ること、既存テーブル名を出さないこと、RLS・権限、SECURITY DEFINER と search_path、DB の予算初期値 = config
- 本体の `deno check` と `deno lint` は通過

## 7. 障害時の振る舞い（source failure behavior）

| 事象 | 記録 | run |
|---|---|---|
| 403 / 404 / 5xx | `HTTP_ERROR`＋HTTP 状態（run_sources.requests と error_summary） | DIRECT の一部なら `completed_with_errors`、全部なら `failed` |
| 429 | `RATE_LIMITED` | GDELT なら状態は変えない |
| timeout / 通信断 | `TIMEOUT` / `NETWORK_ERROR` | 同上 |
| 壊れた応答 / 空応答 | `MALFORMED_RESPONSE` / `EMPTY_RESPONSE` | 同上 |
| 方針で拒否 | `SOURCE_DISABLED` / `SOURCE_REQUIRES_API_KEY` / `SOURCE_NOT_ENABLED_FOR_N2`（outcome=refused、通信なし） | 変えない |
| 検索の拒否 | `hard_cap` / `soft_budget` / `duplicate_search_key` / `escalation_limit` / `bad_parent`（searches に status=denied） | 変えない |
| 検索の失敗 | `PROVIDER_*`（searches に status=failed） | 変えない |
| DB の失敗 | 500。run を failed で閉じる（閉じられなければ running のまま残り、監視で検知） | failed |

## 8. コスト（Web Search 回数の試算）

料金は**実料金を確認できていない**（ローカルにキーが無く、請求も見ていない）。以下は回数の試算と、既存監査（docs/news-cost-optimization/AUDIT_AND_PLAN.md、2026-09-19）の**推定単価**を使った参考値。確定額ではない。実額は `news_discovery_searches` のトークン・回数と請求を突き合わせて出す。

| 検索/日 | 月間（30 日） | 参考額（既存監査の推定 1 回 $0.011〜0.02） |
|---:|---:|---|
| 10 | 300 | 約 $3.3〜6.0 / 月（推定） |
| 20 | 600 | 約 $6.6〜12 / 月（推定） |
| 30（soft） | 900 | 約 $9.9〜18 / 月（推定） |
| 48（hard） | 1,440 | 約 $15.8〜28.8 / 月（推定） |

- **想定 1 日検索数**：通常ローテーションが最大 20 回（observer を 72 分以内の間隔で回す場合）、トリガーが平常日 0〜10 回。**合計 20〜30 回/日**を想定し、上限は 48 回。
- 比較用：2026-09-19 監査時点の既存 breaking_market は約 280 回/日（現在値は cost-optimization 側の usage metering が正本）。
- 将来測る指標：signal 数、有用 signal 数、**有用 signal 1 件あたりの検索数**、検索結果の重複率。すべて DB で集計できる。

## 9. Recall 比較への準備

- 比較の手順と記録形式は news_recall_benchmark.md のとおり。N3 で必要な列（detected_at / published_at / fetched_at / source / discovered_via / topic / ticker / search_id）はすべて保存している。
- N3 v2 で追加した取りこぼし理由の対応は news_recall_benchmark.md の追記を参照（source_gap / search_not_triggered / query_gap / delayed_source / policy_blocked / dedupe_error / classification_error）。

## 10. 将来の有料 API の接続点

- `WebSearchProvider`（検索型）と、取得型の source（parser＋registry）の 2 系統が差し替え点。
  - 有料ニュース API は、registry に `DIRECT_SOURCE`（許諾が表示まで含む場合）か `DISCOVERY_ONLY` として追加し、parser を 1 つ足す。
  - pipeline・DB・dedupe・ticker は変更不要。
- 段階:

| 段階 | 内容 | 変更箇所 |
|---|---|---|
| Stage 2 | 検索予算を増やす、レーンを増やす、銘柄別検索を一部追加 | config の 1 行＋レーン定義 |
| Stage 3 | 通信社・国内ニュース API を契約 | adapter を 1 つ追加 |

## 11. 残課題

1. **実検索は未実施**（ローカルに `OPENAI_API_KEY` が無く、本番の secret は取得しない方針）。
   - 未確認の点：モデル名（`gpt-5.6-luna`、config）・`json_schema` と web_search の併用、`include: web_search_call.action.sources` の返り方。
   - 最大 5 回の実検索テストは、安全なキーがある環境で行う必要がある。
   - 「公式では取れず検索で取れた例」は、実検索が無いので**まだ無い**（fixture のみ）。
2. **GDELT は今回も 429**（N2 から継続）。既定オフのまま。
3. **市場異常の検知**（価格データ）は未実装。入力インターフェースのみ。
4. **Function の本番相当の実行は未確認**。
   - ローカルの PostgREST 代替サーバで確認しただけで、Supabase の実 PostgREST 仕様との差（RPC 引数名 `p`・Range・エラー形式）は Preview / ステージングで要確認。
   - `supabase/config.toml` がこの worktree に無いため、`verify_jwt` 等の Function 設定は未定義。deploy 時に決める必要がある。
5. **検索の計画は「無料層で説明済みか」を topic の重なりで判定している**。精度はベンチマークで評価する。
6. **保持期間**（schema 案では signals 90 日等）の削除ジョブは未実装。
7. **設定の二重管理**：budget の正本は DB、既定値は `search_config.ts`。一致はテストで検査している。
8. EDINET キー（ユーザー作業）、米国務省の 403、BoE・BLS の追加は N2 から継続。

## 12. 次の工程

- **Codex レビュー（推薦 Sol 高）を 1 回**。重点:
  - migration / RLS / SECURITY DEFINER / 予算 RPC のロック
  - Function の認証 / 失敗処理
  - WebSearchAdapter の URL 検証 / 制限媒体の扱い
  - 重複除去の安全条件 / 弱い alias
- レビュー通過までは、production migration・deploy・Cron・本番の自動検索・important-news-monitor 接続へ進まない。
- レビュー後の候補（別承認）:
  1. Preview かステージングで migration を適用し、Function を deploy して 1 回実行する
  2. 安全なキーで実検索を最大 5 回試す
  3. 低頻度の Cron（例：30〜60 分）
  4. 2 週間の Recall ベンチマーク
