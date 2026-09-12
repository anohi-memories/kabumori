# Market Intelligence Core — Phase 0 設計文書

- 作成日: 2026-09-12
- 位置づけ: 通常のH1/H2/CODEX_TASK運用とは別の直接依頼（ユーザーからの直接指示）。既存の `.agent/tasks/*`・`HANDOFF.md`・他workstreamの作業内容には触れていない。
- スコープ: **調査＋正式設計のみ**。DB migration適用、production write、Edge Function deploy、Cron変更、secrets変更、X投稿、Push変更、OAuth変更、既存Function変更は一切行っていない。
- 対象repo: `anohi-memories/kabumori`

## 0. 目的（再掲）

株価・金利・為替・中央銀行・企業IR・政治・地政学など、株価に影響し得る情報を継続収集し、

Raw Sources → Normalized Facts → Current Market State → Current Stock State → Scenario/Forecast Input → (かぶモリ重要ニュース／Personalized朝刊／Personalized大引け／個別銘柄分析／個人投資分析／Excel export)

という共通基盤（Market Intelligence Core、以下 **MIC**）を構築する。既存の各機能はPhase 0では一切変更しない。

---

## 1. Existing architecture audit（既存資産の監査結果）

4系統の並行read-only監査（important-news-monitor／x-test-post＋周辺／DBスキーマ全体／共有ユーティリティ・push・sync）で確認した事実を統合する。

### 1.1 important-news-monitor（`supabase/functions/important-news-monitor/`）

- **収集レーン**: 4本、各レーンが独立quotaを持つ（[fetch_resource_limit_logic.ts](supabase/functions/important-news-monitor/fetch_resource_limit_logic.ts)）。
  - `tdnet` — TDnet公開HTML一覧ページを正規表現パースでスクレイピング（`https://www.release.tdnet.info/inbs/I_list_{page}_{YYYYMMDD}.html`）。構造化APIではない。開示PDF本文も`npm:unpdf`で抽出し、日本語キーワード正規表現で重要行のみ要約化。
  - `company_ir` — 銘柄ごとのIR RSS/JSON feed（`important_news_company_ir_sources`テーブルにopt-in登録）。
  - `market_macro` — BOJ・Fed・USTR・UN Peace&Security・EIAの**公式RSS**のみ。認証不要、14日鮮度窓、許可ドメイン固定。
  - `breaking_market` — OpenAI Responses API + `web_search`ツール（`gpt-5.6-luna`）。ドメイン許可リスト固定（reuters/apnews/bloomberg/nikkei/mof.go.jp/boj.or.jp/federalreserve.gov/ustr.gov/whitehouse.gov等）。**重要**: モデルが申告した`source_url`は、`web_search_call.action.sources`に実際に現れたURLでない限り採用しない（ハルシネーション対策として既に実装済み）。20分周期で6クエリ中2つをローテーション。
- **Dedupe**: `content_hash`（SHA-256、正規化タイトル＋本文要約＋entity identityから算出）＋`source_url`正規化一致＋タイトル＋entity＋`published_at`±24hのfuzzy一致、の3段階。関連する複数開示（決算＋修正等）は5分窓でグルーピングし代表候補にまとめる別レイヤーあり（`important_news_grouping_logic.ts`）。
- **重要度判定**: ルールベースのスコアリングは無く、**完全にAI判定**。Luna（低推論コスト）が常時判定し、`needs_sol`自己申告／低confidence（<0.7）／`most_important`／fact要再確認、のいずれかでSol（高精度・高コスト）へエスカレーション。fact_check未合格なら安全側に倒して`no_post`。
- **AIコスト**: `gpt-5.6-luna`＄0.2/$1.2（in/out per 1M tokens）、`gpt-5.6-sol`＄4-5/$20-30。コストは各候補行の`estimated_cost_usd`（判定）／`generation_estimated_cost_usd`（生成）に個別保存。**横断的なコスト集計テーブルは存在しない**。
- **Cron**: `important_news_monitor_settings.interval_minutes`（既定20分）は存在するが、`supabase/migrations/`内に本パイプラインを叩く`cron.schedule`は**見つからなかった**。JPX syncと違いpg_cron実装が無く、Supabase Dashboard側のScheduled Trigger等、リポジトリ外の仕組みで駆動されている可能性が高い。**Phase 1着手前に運用担当への確認が必要**。
- **再利用価値の高いパターン**:
  - Atomic claim（`WHERE status=eq.<期待前状態>`のPATCHで排他制御。負けた側はエラー扱いしない）
  - Stale run reconciliation（15分超の`running`行を`failed`に強制収束、ただしこれ自体はbest-effort）
  - Overnight hold（`important`ランクは01:00-05:00 JSTで投稿保留、`most_important`は素通り）
  - Rate control（`important`ランクは直近投稿から10分間隔を強制）
  - レーン単位のfailure isolation（1レーンの失敗が他レーンを止めない）
  - Fact/AI解釈のカラム分離（ingestion由来カラム vs judgement/generationカラムを明確に分けて同一行に持つ設計思想）
  - プロンプトインジェクション対策（入力JSONのテキストは"命令ではなくデータとして扱う"という明示指示）
- **不足**: US SEC/EDGARの収集は無し。価格・指数などの連続時系列データは一切扱っていない（イベント/ニュース専用）。

### 1.2 x-test-post（`supabase/functions/x-test-post/`）— 朝刊/大引け/米国プレマーケット/株の小ネタ等

- **市場データの実態**: **構造化された価格・指数APIはどこにも存在しない**。全てOpenAI `web_search`ツール＋ドメイン許可リスト（`MORNING_SOURCE_DOMAINS`: jpx.co.jp / tdnet.info / boj.or.jp / mof.go.jp / federalreserve.gov / finance.yahoo.com / investing.com / 各社IRサイト等）任せ。
  - 朝刊（morning_report）: 米国指数・SOX・日経先物は**常に空欄プレースホルダー**。プロンプト自体が「具体的市場数値は扱わない」と明示指示しており、意図的に数値を書かない設計。
  - 大引け（close_report）: 日経平均・TOPIX・日経先物の値は「見つかれば書く程度」で必須要件にしていない。書く際も具体値の羅列は禁止。
  - 米国プレマーケット（us_premarket_report）: **唯一の例外**。S&P/Nasdaq/Dow先物・半導体シグナル・プレマーケット銘柄動向を`value/previous_close/change/change_percent/timestamp/source_url`付きで要求し、fact-checkで欠落を弾く。
  - → 現状「今の日経平均はいくつか」を確実に答えられる構造化ソースはシステム内に存在しない。これはMIC最大のギャップの一つ。
- **Publish claims**（[20260903120000_add_publish_claims.sql](supabase/migrations/20260903120000_add_publish_claims.sql)）: `unique(post_type, date_jst)`制約そのものをロックとして使う設計（`ignore-duplicates`でinsertし、0行返れば「他が既に握っている」と判定）。TOCTOUレースを解消する良いパターンで、MICのジョブ冪等性にそのまま転用できる。
- **posting_windows / scheduled_posts / post_execution_logs**: 汎用スケジューリング基盤。`claim_due_post()`が全post_typeの`plan_*`関数を呼んだ上で`FOR UPDATE SKIP LOCKED`で1件ずつ払い出す設計。ただしこの基盤自体を叩く`cron.schedule`もDB内には無い（外部スケジューラ想定）。
- **JPX銘柄マスタ同期**（`stocks-master-sync`/`stocks-new-listing-sync`）: `data_j.xlsx`（JPX公式Excel、構造化）＋新規上場ページ（HTML、正規表現スクレイピング）。両方とも`pg_cron`＋`net.http_post`＋`X-Cron-Secret`で毎日実行、共有アドバイザリロック（`begin_stocks_master_write_run`）で排他制御、行数フロア・上場廃止上限などの安全ガード付き。**MICの新規ソース取り込み関数のテンプレートとして最適**。

### 1.3 共有ユーティリティ

- `_shared/kabumori_voice.ts` — 実行コードではなくプロンプト文字列群（かぶモリの人格・文体指示）。MICのFact記述には不要だが、将来「AI Interpretation」をかぶモリ文体で語る場面（Excel向けサマリ文等）があれば再利用候補。
- `_shared/x_oauth2_post.ts` — X API v2への汎用401-retry付きOAuth2投稿ビルディングブロック（`requestXWithAuthRefresh`）。MIC自体はPhase 0でX投稿しないため直接利用はしないが、将来「重要な市場状態変化をXに投稿する」機能を作る際に再利用可能。
- `send-push-notifications` — Phase 0調査時点ではコード上のコメントに基づき「未デプロイ」と記載していたが、2026-09-12時点でproduction v4としてACTIVE稼働済み（Phase 1A着手時にユーザーより訂正）。`notifications`＋`device_push_tokens`を読みExpo Push APIで送信するのみで、何が重要かの判断は一切持たない。MICが将来`notifications`に書き込めば自動的に使える設計である点は変わらない。

### 1.4 既存DBスキーマ（全48 migration監査）

- ユーザー/銘柄系: `stocks_master`（静的マスタのみ、価格カラム無し）、`profiles`、`tracked_stocks`、`alert_settings`、`notifications`（`unique(user_id, tracked_stock_id, source_type, source_id)`でdedupe済み）、`device_push_tokens`、`admin_users`＋`private.is_admin()`。
- ニュース系: `important_news_candidates`他（1.1参照）。
- レポート系: `morning_report_settings/runs`、`close_report_settings/runs`、`us_premarket_report_settings/runs`、`useful_tips`系、`publish_claims`、`posting_windows`、`scheduled_posts`、`post_execution_logs`。
- **市場データの生値は`close_report_runs.nikkei_data/topix_data/nikkei_futures_1545_data/market_data`等、レポート実行ごとのJSONBブロブとしてのみ存在**。正規化された時系列テーブルは無い。
- **AIコスト/トークンは5つ以上のテーブルに重複したカラムとして分散**（`post_execution_logs`, `useful_tip_verifications`, 3つの`*_report_runs`, `important_news_candidates`のjudgement/generation各カラム）。精度も`numeric(12,6)`と`numeric(12,8)`で不統一。横断集計テーブルは無い。
- **Cron実体は`pg_cron`で2件のみ**（`kabumori-stocks-master-sync`＝06:03 JST、`kabumori-stocks-new-listing-sync`＝06:08 JST）。重要ニュース監視やレポート生成・`claim_due_post()`ディスパッチはDB内`cron.schedule`が無く、外部スケジューラで駆動されている可能性が高い。
- `market_holidays`（JPX/NYSE共通、`(market, holiday_date)`）はあるが、日中の取引セッション（JPXの11:30-12:30昼休み等）や共通`is_trading_day()`関数は無く、各`plan_*`関数が個別にインライン実装している。
- `public.market_contexts`テーブルは定義はあるが読み書きしている箇所が見つからず、**未使用/廃止候補**（MICで同名を再利用する場合は要事前確認）。
- 命名/権限規約: 新規テーブルの書き込みは`service_role`限定、`authenticated`は`private.is_admin()`経由の管理画面read（一部update）のみ、`anon`は原則全面revoke。`updated_at`はトリガーで自動更新。singleton設定は`id boolean primary key default true`パターン。

### 1.5 再利用可否まとめ

| 対象 | 分類 | 備考 |
|---|---|---|
| Atomic claim（status遷移PATCH） | 再利用可能 | ジョブ実行の排他制御にそのまま応用 |
| `publish_claims`のunique制約ロック | 再利用可能 | ingestion runの冪等性に応用 |
| content_hash + fuzzy dedupe | 再利用可能（拡張） | `market_events`のdedupeに応用、entity/期間はカテゴリごとに調整要 |
| Stale run reconciliation | 再利用可能 | ingestion_runsテーブルに同パターン適用 |
| JPX sync（構造化API＋advisory lock＋監査ログ＋安全ガード） | 再利用可能（テンプレート） | 新規の構造化ソース取り込み関数の雛形にする |
| 2段階AI判定（Luna→Sol escalation） | 再利用可能（拡張） | Market State更新のAI呼び出し戦略に流用 |
| Fact/AI解釈のカラム分離思想 | 部分再利用 | 概念は流用、実装は正規化テーブル（facts表 vs state表）に発展させる |
| `kabumori_voice.ts` | 部分再利用 | Excel/レポート向け文体生成が必要になった場合のみ |
| `x_oauth2_post.ts` | 将来再利用 | Phase 0/1では未使用 |
| AIコスト計算ロジック（3箇所重複） | 要新規統合 | 4つ目の重複を作らず、共有コストレジャーを新設 |
| 構造化な株価/指数取得処理 | **新規必要** | 既存に存在しない（最大のギャップ） |
| US SEC/EDGAR収集 | **新規必要** | 既存に存在しない |
| 取引セッション/昼休みモデル | **新規必要** | `market_holidays`はあるがセッション粒度は無い |
| 横断AIコストレジャー | **新規必要** | 既存は行ごとに分散 |

---

## 2. Data source matrix（情報源マトリクス）

Phase 0時点の調査結果。◎=第一候補、○=fallback、△=要検討/未確定、✕=非推奨。

### A. Market prices

| 対象 | 第一候補 | Fallback | 種別 | 認証 | 費用 | 更新頻度目安 | 備考 |
|---|---|---|---|---|---|---|---|
| 日経平均/TOPIX/日経先物 | △要決定 | OpenAI web_search（現行踏襲） | — | — | — | 5-20分 | **リアルタイム/準リアルタイムを無料公式で再配布できる構造化APIが存在しない**。JPXは指数データを有償提供。決定事項: (a)有償ベンダー契約、(b)EOD/delayed値のみで妥協、(c)現状通りAI web_search抽出（信頼性低・ToSグレー）のいずれかをユーザー側で選択要（リスク参照）。 |
| S&P500/Nasdaq/Dow/SOX/VIX | stooq.com（CSV、無料、非公式） | OpenAI web_search | Web CSV | 不要 | 無料 | 5-20分 | 非公式だが実運用で広く使われる。ToS確認要。CBOEがVIX公式値を持つが構造化API有償枠あり。 |
| USDJPY/EURUSD | Frankfurter API（ECB参照レート） | exchangerate.host | 構造化API | 不要 | 無料 | 15-60分 | ECBは1日1回更新のみ（日中値動きには不十分）。日中値が必要ならFX専業ベンダー要検討。 |
| 米国2年債/10年債 | **FRED API**（DGS2, DGS10） | Treasury.gov直接CSV | 構造化API | 無料キー登録 | 無料 | 日次 | 公式・高信頼。timestamp明確。 |
| 日本国債利回り | 財務省「国債金利情報」CSV | 日本相互証券(BB)参照値 | 構造化CSV | 不要 | 無料 | 日次 | 公式一次情報。 |
| WTI | **EIA API** | stooq | 構造化API | 無料キー登録 | 無料 | 日次〜週次 | 公式（米エネルギー省）。 |
| Brent | EIA API（国際部門） | stooq | 構造化API | 無料キー登録 | 無料 | 日次〜週次 | ICE公式は有償。 |
| Gold | LBMA daily fix | stooq | 構造化 | 要登録 | 無料 | 日次 | ロンドン地金市場協会公式値。 |
| Bitcoin | CoinGecko API | Coinbase API | 構造化API | 不要（レート制限あり） | 無料 | 5-15分 | センチメント用途、必須ではない。 |

**重要な未解決事項**: 日経平均・TOPIX・日経先物・S&P/Nasdaq/Dow/SOXの「日中リアルタイムに近い値」を合法的かつ安定的に得る手段が、Phase 0調査の範囲では無料の公式構造化APIとして存在しない。この部分は**Risks/unresolved questions（23章）で改めてユーザー判断を仰ぐ**。

### B. Central banks / macro

| 対象 | 第一候補 | 種別 | 備考 |
|---|---|---|---|
| 日銀 | BOJ RSS（既存流用） | 構造化RSS | 既にimportant-news-monitorで取得済み。MICは同じフィードを共有取得に統合。 |
| Fed/FOMC | Fed RSS（既存流用）＋FRED API | 構造化 | 声明文はRSS、数値系列はFRED。 |
| ECB | ECB press RSS＋ECB SDW API | 構造化 | Statistical Data Warehouseは無料構造化API。 |
| 米CPI/PCE/雇用統計/ISM/GDP | **FRED API** | 構造化API | ほぼ全て公式系列として存在（CPIAUCSL, PCEPI, PAYEMS, ISM系, GDP等）。 |
| 日本CPI/景気指標/GDP | e-Stat API（政府統計） | 構造化API | 無料キー登録。内閣府GDP速報も対象。 |
| 政策金利/金利見通し | 各中銀公式発表＋FRED/e-Stat系列 | 構造化＋RSS | — |

### C. Corporate events

| 対象 | 第一候補 | 種別 | 備考 |
|---|---|---|---|
| TDnet全般 | 既存TDnetスクレイパー流用 | HTML scrape（構造化API非公開） | 既存資産をそのまま共有ソースとして再利用。 |
| 決算/業績修正/配当/自己株買い/M&A/TOB/大口受注/増資/分割/優待/経営陣変更 | TDnet本文＋既存カテゴリ分類ロジック | 同上 | `news_candidate_logic.ts`のカテゴリenumを土台に拡張。 |
| 米SEC EDGAR（8-K/10-Q/10-K/earnings/guidance/buyback） | **SEC EDGAR Full-Text Search API + submissions API** | 構造化API | 無料・無認証・公式一次情報。**既存に無い＝新規実装必須**。 |

### D. Politics

| 対象 | 第一候補 | 種別 | 備考 |
|---|---|---|---|
| 米政権要人発言/関税/輸出規制/半導体政策/中国政策/制裁 | 既存breaking_marketの許可ドメイン＋OpenAI web_search（拡張） | AI-assisted search | whitehouse.gov/ustr.gov/commerce.gov/bis.doc.gov等の一次ソースを優先。SNS投稿を一次ソースにする場合は公式アカウント・本人性・timestamp・削除/訂正リスクを必ず検証（実装は既存の「モデルの申告URLでなく実際に訪問したURLのみ採用」パターンを踏襲）。 |
| 日本政府経済政策 | 内閣府/財務省/経産省RSS | 構造化RSS | — |

### E. Geopolitics

| 対象 | 第一候補 | 種別 | 備考 |
|---|---|---|---|
| 戦争/停戦/制裁/海峡封鎖/ミサイル/石油施設/台湾/中東/ウクライナ/中国/北朝鮮/海運 | UN Peace&Security RSS（既存流用）＋OpenAI web_search（reuters/apnews/bloomberg許可リスト） | 構造化RSS＋AI-assisted search | 「単なる戦況」ではなく市場影響Factのみ選別する既存の判定思想（importance_judgement）を流用。 |

原則の適用順位: **一次情報（政府/取引所/企業/中央銀行）＞structured API＞信頼できる報道**。AIによるニュース内容の捏造・補完は禁止（既存パターンの「web_searchが実際に訪問したURLのみ採用」を全カテゴリで踏襲）。

---

## 3. Reusable components（再利用可能コンポーネント）

- Atomic claim state machine（`important-news-monitor`, `x-test-post`）
- `publish_claims`のunique制約ロックパターン
- content_hash + 正規化URL + fuzzy一致のdedupe戦略
- Stale run reconciliation（15分閾値の考え方）
- JPX sync：構造化ソース取り込みの安全ガード付きテンプレート（advisory lock, snapshot audit, row-count/delist guard）
- 2段階AI判定（Luna常時→Sol条件付きエスカレーション）
- レーン単位のfailure isolation
- Overnight hold / rate control（投稿タイミング制御の考え方はingestion側のバックオフにも応用可）
- `market_holidays`テーブル（JPX/NYSE、そのまま共有）
- `private.is_admin()`＋RLS規約（service_role書込み／admin read／anon全面revoke）
- プロンプトインジェクション対策の指示文パターン

## 4. Missing components（新規に必要なもの）

- 構造化な価格/指数/FX/金利/コモディティの正規化時系列ストア（`market_metrics`）
- US SEC EDGAR収集
- 取引セッション（JPX昼休み等）を含む`is_trading_day()`/セッション判定の共有関数
- 横断的なAIコストレジャー（`ai_usage_events`）
- ソースカタログ（`source_registry`）— どのカテゴリをどのソースでどの頻度で取るかの単一正本
- Market State / Stock State の現在値＋履歴テーブルとその更新アルゴリズム
- Scenario/Forecast構造とその検証可能な履歴化
- Excel export用のview/RPC群
- 「常に最新の一つのドキュメント」を生成するview/RPC

---

## 5. Proposed DB schema（提案スキーマ、Phase 0では未作成）

既存規約（`service_role`書込み限定、`updated_at`トリガー、check制約によるenum、`private.is_admin()`経由のadmin read、singleton設定は`id boolean primary key default true`）に合わせて設計。**以下はSQL案であり、Phase 0では一切適用しない。**

```sql
-- 5.1 ソースカタログ（データソースの単一正本、Excelの"Data Sources"シートの元にもなる）
create table public.mic_source_registry (
  id uuid primary key default gen_random_uuid(),
  source_key text unique not null,          -- 'fred_dgs10', 'jpx_tdnet', 'sec_edgar_8k' 等
  category text not null check (category in (
    'market_price','macro','corporate_jp','corporate_us','politics','geopolitics'
  )),
  display_name text not null,
  endpoint_url text,
  source_kind text not null check (source_kind in ('structured_api','rss','html_scrape','ai_search')),
  requires_auth boolean not null default false,
  cost_tier text not null default 'free' check (cost_tier in ('free','freemium','paid')),
  update_frequency_minutes integer,
  reliability_notes text,
  is_primary boolean not null default true, -- false = fallback
  is_active boolean not null default false, -- Phase 0では全てfalse
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5.2 Facts: 単発の出来事（既存 important_news_candidates の思想を汎用化。ニュース投稿固有カラムは持たない）
create table public.market_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz,                  -- 事象発生時刻（不明ならnull）
  published_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  event_type text not null check (event_type in (
    'price_move','rate_decision','macro_release','earnings','guidance','buyback',
    'ma_deal','regulatory','sanction','geopolitical','political_statement','other'
  )),
  category text not null,
  subcategory text,
  country text,
  region text,
  entity_type text check (entity_type in ('company','government','central_bank','index','commodity','currency','other')),
  entity_id text,                           -- ticker or entity_key
  ticker text,
  sector text,
  title text not null,
  summary text not null,
  source_name text not null,
  source_url text not null check (source_url ~ '^https://'),
  source_type text not null,                -- mic_source_registry.source_key を参照
  source_timestamp timestamptz,
  importance text check (importance in ('low','medium','high','critical')),
  market_direction text check (market_direction in ('bullish','bearish','neutral','mixed','unclear')),
  confidence numeric(4,3) check (confidence between 0 and 1),
  fact_status text not null default 'unverified' check (fact_status in ('unverified','verified','needs_review','retracted','corrected')),
  raw_payload jsonb,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  dedupe_key text,                          -- 正規化URL等、fuzzy一致補助
  duplicate_of uuid references public.market_events(id),
  superseded_by uuid references public.market_events(id), -- correction/retraction用
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_events_dedupe_check check ((fact_status = 'retracted') = (superseded_by is not null) or superseded_by is null)
);
create unique index market_events_content_hash_uidx on public.market_events(content_hash) where duplicate_of is null;
create unique index market_events_source_url_uidx on public.market_events(source_url) where duplicate_of is null;
create index market_events_entity_time_idx on public.market_events(entity_id, published_at desc);

-- 5.3 Facts: 時系列数値（価格・指数・金利・FX・コモディティ）
create table public.market_metrics (
  id bigint generated always as identity primary key,
  metric_key text not null,                 -- 'nikkei225','topix','usdjpy','us10y','wti' 等
  value numeric not null,
  unit text not null,
  observed_at timestamptz not null,
  source text not null,                     -- mic_source_registry.source_key
  source_url text,
  metadata jsonb,
  ingested_at timestamptz not null default now()
);
create unique index market_metrics_dedupe_uidx on public.market_metrics(metric_key, observed_at, source);
create index market_metrics_latest_idx on public.market_metrics(metric_key, observed_at desc);

-- 5.4 Current State: 市場全体の「今」（versioned key、履歴はhistoryテーブルへ）
create table public.market_state_current (
  id boolean primary key default true check (id),
  updated_at timestamptz not null default now(),
  as_of timestamptz not null,
  regime text,
  risk_score numeric(5,2),
  volatility_state text,
  rates_state text,
  fx_state text,
  semiconductor_state text,
  japan_state text,
  us_state text,
  geopolitical_state text,
  bullish_factors jsonb,
  bearish_factors jsonb,
  key_risks jsonb,
  catalysts jsonb,
  next_24h_focus jsonb,
  next_7d_focus jsonb,
  source_event_ids uuid[],
  model_used text,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(12,8),
  fact_status text not null default 'ai_interpretation' -- 常にAI解釈であることを明示
);

-- 5.5 State history（過去判断の検証可能性を担保、上書きしない）
create table public.market_state_history (
  id uuid primary key default gen_random_uuid(),
  as_of timestamptz not null,
  snapshot jsonb not null,                  -- market_state_current の全カラムを保存時点でコピー
  reason_for_update text,
  triggered_by text check (triggered_by in ('scheduled_check','material_change','manual')),
  created_at timestamptz not null default now()
);

-- 5.6 銘柄単位の現在状態
create table public.stock_state_current (
  stock_id uuid primary key references public.stocks_master(id),
  ticker text not null,
  updated_at timestamptz not null default now(),
  as_of timestamptz not null,
  short_term_view text,
  medium_term_view text,
  sensitivity_fx text,
  sensitivity_rates text,
  sensitivity_sector text,
  company_specific_factors jsonb,
  bullish_factors jsonb,
  bearish_factors jsonb,
  key_risks jsonb,
  invalidation_conditions jsonb,
  source_event_ids uuid[],
  model_used text,
  confidence numeric(4,3),
  fact_status text not null default 'ai_interpretation'
);

create table public.stock_state_history (
  id uuid primary key default gen_random_uuid(),
  stock_id uuid not null references public.stocks_master(id),
  as_of timestamptz not null,
  snapshot jsonb not null,
  reason_for_update text,
  created_at timestamptz not null default now()
);

-- 5.7 Scenario / Forecast（検証可能な履歴、上書きしない）
create table public.market_scenarios (
  id uuid primary key default gen_random_uuid(),
  as_of timestamptz not null,
  scope text not null check (scope in ('market','sector','stock')),
  scope_ref text,                            -- sector名 or ticker（marketならnull）
  scenario_type text not null check (scenario_type in ('base','bull','bear')),
  probability numeric(4,3) check (probability between 0 and 1),
  conditions jsonb,
  catalysts jsonb,
  invalidation jsonb,
  market_impact text,
  affected_sectors jsonb,
  affected_stocks jsonb,
  source_event_ids uuid[],
  source_state_id uuid,                      -- market_state_history.id or stock_state_history.id
  model_used text,
  superseded_by uuid references public.market_scenarios(id),
  created_at timestamptz not null default now()
);

-- 5.8 横断AIコストレジャー（既存5テーブルの分散を新規分は一本化。既存テーブルはPhase 0では変更しない）
create table public.ai_usage_events (
  id bigint generated always as identity primary key,
  feature text not null,                     -- 'mic_market_state_update' 等
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  web_search_calls integer not null default 0,
  cost_usd numeric(12,8) not null,
  related_table text,
  related_id text,
  created_at timestamptz not null default now()
);

-- 5.9 Ingestion run監査＋claim（JPX syncとpublish_claimsのハイブリッド）
create table public.mic_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.mic_source_registry(source_key),
  run_window text not null,                  -- '2026-09-12T06:00Z' 等、重複実行防止キー
  status text not null default 'running' check (status in ('running','completed','failed','skipped_inactive')),
  fetched_count integer,
  new_count integer,
  duplicate_count integer,
  error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index mic_ingestion_runs_claim_uidx on public.mic_ingestion_runs(source_key, run_window);
```

**RLS方針（既存規約踏襲）**: 全新規テーブルは`service_role`のみ書込み。`authenticated`は`private.is_admin()`経由でread-only（将来、管理画面や個人投資分析に必要な範囲のみ拡大）。`anon`は全面revoke。`ai_usage_events`はadminのみread（コスト情報のため）。

---

## 6. Current-state architecture（現在状態の更新方式）

```
Raw Sources
  → Fetch（source_kind別: structured_api / rss / html_scrape / ai_search）
  → Normalize（コード側、正規化タイトル・URL・数値単位統一）
  → Dedupe（content_hash / dedupe_key、mic_ingestion_runsで実行単位のclaim）
  → market_events / market_metrics へ格納（= Facts、AI未介入）
  → 差分判定（コード側、閾値ベース。詳細は7章）
  → 重要な変化がある場合のみ AI再評価（Luna→条件付きSol）
  → market_state_current 更新 + market_state_history へスナップショット追記
  → stock_state_current / history も同様（entity_idがtickerに紐づく場合）
```

`market_state_current`はsingleton（`id boolean primary key default true`）で「今」を1レコードに保持し、更新の都度`market_state_history`へ全カラムのスナップショットを追加する。これにより「その時点で何を判断していたか」を後から検証できる。

## 7. Event normalization / Fact validation / Dedupe・versioning戦略

- **Normalize**: タイトルNFKC正規化・空白圧縮、URL正規化（utm等除去・ソート・末尾スラッシュ統一）— `news_candidate_logic.ts`の`normalizeText`/`normalizeSourceUrl`をそのまま汎用モジュール化して共有。
- **Dedupe**: `content_hash`（SHA-256、正規化タイトル＋summary＋entity）による厳密一致＋`source_url`一致＋fuzzy（同entity＋タイトル類似＋published_at±時間窓、カテゴリごとに窓を可変にする：企業開示は24h、速報系は数十分）。
- **Fact validation**: 一次情報（政府/取引所/企業/中央銀行）＞structured API＞報道の優先順位。AI web_search経由の場合は「モデルが実際に訪問したURLのみ採用」（既存breaking_market_source_fetchersのパターンを全カテゴリに一般化）。
- **Versioning/correction**: `market_events.superseded_by`で訂正・撤回をチェーン化。過去のレコードは物理削除・上書きしない。`fact_status`に`corrected`/`retracted`を持たせ、AI解釈側（`market_state_current`）が古いFactを参照していた場合は次回material-change判定で再評価対象に含める。
- **予測の非上書き原則**: `market_scenarios`は`superseded_by`のみで連鎖し、行自体は不変。`as_of`必須。

## 8. AI invocation strategy（AI呼び出し戦略）

既存`importance_judgement_logic.ts`の二段階（Luna常時→Sol条件付き）をMarket State更新に一般化する。

```
Fetch → コードでnormalize → dedupe → importance判定（ルールベース優先）
  → 前回 market_state_current との差分判定（コード、数値比較のみ）
  → 差分が閾値を超える場合のみ Luna で状態文章化
    → Lunaが「要再評価/低confidence/重大」と判断した場合のみ Sol へエスカレーション
  → 差分が閾値未満なら AI呼び出し無し（market_state_current.updated_atも更新しない）
```

AIを使わない部分（既存踏襲）: 数値比較、騰落率、timestamp、stale判定、dedupe、source validation、閾値判定、metric計算。
AIを使う部分: Eventの意味整理、複数Factの関係整理、Market State文章化、個別銘柄影響分析、シナリオ生成。

Facts（`market_events`/`market_metrics`）とAI Interpretation（`market_state_*`/`stock_state_*`/`market_scenarios`）はテーブルレベルで完全分離。全てのAI生成レコードに`model_used`・トークン数・`fact_status='ai_interpretation'`相当のマーカーを必須化。

## 9. API cost-control strategy

- 既存の3箇所重複したコスト計算関数（`importantNewsModelCost`/`lunaCost`/`modelCostUsd`）と同じ轍を踏まないよう、MIC専用の共有コストモジュール（`_shared/mic_ai_cost.ts`想定）を1つだけ新設し、`ai_usage_events`に一本化して記録する。
- 差分判定を必ずAI呼び出しの前段に置き、「20分ごとに世界中の情報を丸ごと再送」を構造的に不可能にする（差分が無ければLuna/Solどちらも呼ばない）。
- 日次/週次のコスト集計は`ai_usage_events`への単純GROUP BYで可能（既存の分散カラムを跨いだUNIONが不要になる）。
- 将来的な予算上限アラートは、既存の`*_settings`シングルトンパターン（`is_active`フラグ）を踏襲し、`mic_settings.daily_cost_limit_usd`のような閾値カラムを追加する形で対応可能（Phase 0では設計のみ）。

## 10. Market-state update algorithm

1. 新規`market_events`/`market_metrics`が閾値内（例: 指数±0.5%以上、金利±5bp以上、新規`market_events.importance in (high,critical)`）で発生。
2. 該当カテゴリ（fx_state/rates_state/japan_state等）に対応する既存`market_state_current`の値と比較。
3. 差分が閾値超なら、関連`market_events`/`market_metrics`をLunaに渡し当該ステートフィールドのみ再生成。
4. Lunaが`needs_sol`相当を返す、または複数カテゴリに跨る重大変化（`most_important`級イベント）の場合はSolへエスカレーション。
5. 更新後、`market_state_current`をUPDATEし、旧内容を`market_state_history`にINSERT（トリガーで自動化可能）。
6. `source_event_ids`に根拠となった`market_events.id`を必ず記録（AI Interpretationの追跡可能性を担保）。

## 11. Stock-state update algorithm

- 起点は`market_events.ticker`が非nullのイベント、または`tracked_stocks`で監視されている銘柄に関連するイベント。
- 個別銘柄は全銘柄を常時更新せず、(a) 直接関係するイベントが発生した銘柄、(b) `market_state_current`の変化がセクター感応度の高い銘柄に波及する場合、に限定して更新（コスト抑制）。
- `stock_state_current`の`sensitivity_fx/rates/sector`は初期値をルールベース（セクターマスタや財務特性）で設定し、AIは差分説明・シナリオ生成部分のみ担当する設計を推奨（Phase 1詳細設計時に確定）。

## 12. Scenario/forecast model

`market_scenarios`テーブル（5.7）でBase/Bull/Bear各シナリオを`probability/conditions/catalysts/invalidation/market_impact/affected_sectors/affected_stocks`付きで保存。`as_of`必須、上書きせず`superseded_by`で連鎖。後日検証は「当時のscenario行」と「その後の実際のmarket_events/metrics」を`as_of`以降で突き合わせることで可能になる（検証用viewはPhase 2で設計）。

## 13. Excel export architecture

DB直接エクスポートではなく、Excelシート構成に対応する**view**を用意し、ChatGPT/将来のExcel生成処理が単純なSELECTで必要データを得られるようにする。

| Excelシート | 対応view/RPC（案） | ソース |
|---|---|---|
| Market Summary | `v_mic_market_summary` | `market_metrics`の最新値＋前回値をLAG窓関数で比較 |
| Important Events | `v_mic_important_events` | `market_events`（importance高いもの、直近N日） |
| Macro / Rates / FX | `v_mic_macro_rates_fx` | `market_metrics`（category=macro/fx/rates） |
| Corporate Events | `v_mic_corporate_events` | `market_events`（event_type=earnings/guidance/buyback/ma_deal等） |
| Geopolitics / Politics | `v_mic_geopolitics_politics` | `market_events`（event_type=geopolitical/political_statement） |
| Stock States | `v_mic_stock_states` | `stock_state_current`＋`stocks_master`join |
| Scenarios | `v_mic_scenarios` | `market_scenarios`（最新かつsuperseded_by is null） |
| Data Sources | `v_mic_data_sources` | `mic_source_registry`＋直近`mic_ingestion_runs`の実行状況 |

Excel生成自体（`.xlsx`ファイル出力）はPhase 0では作らない。将来はこれらのviewを読む専用Edge Function（またはChatGPT側のCode Interpreter経由でSupabase REST/RPCを叩く）で実装可能。

## 14. 「常に最新の一つのドキュメント」の実現方式

DB（Facts＋Current State）を正本とし、そこから**RPCで1つのJSONドキュメント**を生成する方式を推奨する。

- **正本**: `market_events` / `market_metrics` / `market_state_current` / `stock_state_current`（DB）
- **提供形態（推奨）**: `mic_latest_brief(as_of timestamptz default now())` RPC — 上記テーブルを集約した1つのJSONオブジェクトを返す。ChatGPTからは1回のRPC呼び出しで「今の市場全部」を取得できる。
- **人間閲覧用**: 同じRPCの結果をMarkdownに整形する薄いレンダリング層（Edge FunctionまたはDB関数）を追加すれば、「1枚のMarkdownとして見たい」という要望にも応えられる。ただしMarkdown自体を正本にはしない（正本は常にDB）。
- **将来**: 管理画面（`apps/admin`）に「Market Intelligence Brief」ページを追加し、上記RPCの結果を表示すれば、非エンジニアでも常時最新版を閲覧できる。

## 15. 更新頻度（カテゴリ別、Cronコスト考慮）

| カテゴリ | 推奨頻度 | 理由 |
|---|---|---|
| price/futures/fx | 5-20分（**取引時間帯のみ**、JPX/NYSE/CME各セッションをゲート） | 24時間ポーリングは無駄。セッション判定関数（新規、8.2参照）でゲート。 |
| rates（国債利回り等） | 15-60分、ただし実際は日次更新が大半 | FRED/財務省とも日次更新のため過剰ポーリング不要。 |
| TDnet/IR | 5-20分 | 既存important-news-monitorの20分周期をそのまま共有ソースとして利用。 |
| central bank | event-driven / 10-30分 | 既存BOJ/Fed/ECB RSSの頻度を踏襲。 |
| politics/geopolitics | 10-30分 | 既存breaking_marketの20分ローテーションを踏襲・拡張。 |
| AI Market State更新 | **material change時のみ**（内部的には15-30分ごとに差分チェック、AI呼び出しはトリガー時のみ） | 8章のAI invocation strategy参照。 |

Cronジョブ数は「fetch系」と「state評価系」を分離し、fetch系はカテゴリごとの`mic_ingestion_runs`単位で独立、state評価系は1本の低頻度チェックジョブ（差分判定のみ、AI呼び出しは条件付き）に集約することを推奨。既存の2本の`pg_cron`ジョブに新たに追加する場合も、`X-Cron-Secret`＋advisory lock方式（JPX syncと同一）を踏襲する。

## 16. Security / RLS

- 新規テーブルは全て`service_role`書込み限定。
- `authenticated`は`private.is_admin()`経由のread-onlyから開始し、個人投資分析等で必要になった場合のみ、狭いview経由で一般ユーザーにも段階的開放（`tracked_stocks`と`stock_state_current`をjoinしたview等）。
- `anon`は全面revoke（既存規約通り）。
- `ai_usage_events`はコスト情報のためadmin限定read、一般`authenticated`には非公開。
- secrets（新規に追加する構造化APIキー: FRED/EIA/e-Stat等）は既存の`Deno.env.get`規約に従い、cron認証は既存の`X-Cron-Secret`パターンを継続。

## 17. Cron/event schedule（まとめ）

15章の頻度表を踏まえ、Phase 1では以下の粒度でCronを分離することを推奨（Phase 0では未作成）:

- `mic-fetch-prices`（取引時間帯ゲート付き、5-20分）
- `mic-fetch-macro`（15-60分、または日次）
- `mic-fetch-corporate-jp`（TDnet共有、5-20分）
- `mic-fetch-corporate-us`（SEC EDGAR、15-30分）
- `mic-fetch-politics-geopolitics`（10-30分）
- `mic-evaluate-market-state`（15-30分、差分判定のみ・AI呼び出しは条件付き）

## 18. Observability

- `mic_ingestion_runs`を全fetch系ジョブで共通利用し、`apps/admin`の既存「システム状態」カードと同じ思想で「ソースごとの最終成功時刻」を可視化する管理画面拡張をPhase 2以降で検討。
- `ai_usage_events`の日次集計を管理画面に表示し、想定外のコスト急増を早期発見できるようにする。
- 既存のstale-run reconciliationパターンを`mic_ingestion_runs`にも適用し、異常終了したrunを自動収束させる。

## 19. Failure/retry policy

- レーン/ソース単位のfailure isolation（既存`runNewsSourceProviders`パターン踏襲）: 1ソースの失敗が他ソースの取り込みを止めない。
- Ingestion runは`mic_ingestion_runs`のunique制約（`source_key, run_window`）でclaimし、二重実行を防止（`publish_claims`と同じ思想）。
- Stale run（15分等の閾値、カテゴリごとに調整）は次回実行前にbest-effortで`failed`に収束。
- AI呼び出し失敗時は`market_state_current`を更新せず、旧stateを維持したまま次回サイクルで再評価（安全側に倒す＝既存の「fact_check未合格ならno_post」思想と同じ）。

## 20. Migration strategy

- **Phase 0**（本ドキュメント）: 設計のみ。DB変更ゼロ。
- **Phase 1**: 新規migrationは全て**追加のみ**（既存テーブルへのALTERは行わない）。新規テーブルは`is_active=false`相当の安全側デフォルトで作成し、最小構成（例: FRED経由の金利データ＋SEC EDGAR）から段階的に稼働確認する。既存Functionは一切変更しない。
- **Phase 2**: ソースを拡充し、Market State AI評価層を稼働。Excel export view群を整備。
- **Phase 3**: 既存`important-news-monitor`/`x-test-post`が段階的にMICを参照するよう接続（22章のロードマップ参照）。この段階で初めて既存Functionへの変更が発生するため、別途承認プロセスを経る。

## 21. Rollback strategy

- Phase 0はDB変更ゼロのためロールバック対象自体が存在しない。
- Phase 1以降も新規テーブル・新規関数の**追加のみ**とするため、ロールバックは新規オブジェクトのDROPのみで完結し、既存パイプラインへの影響はゼロに保てる設計とする。
- MIC全体のON/OFFは既存の`*_settings`シングルトンパターン（`mic_settings.is_active`のようなカラム）を用意し、`apps/admin`の既存トグルUIパターン（`system-toggle.ts`のallowlist方式）でそのまま制御可能にする（Phase 1で実装）。

## 22. Phase 1 / Phase 2 / Phase 3 ロードマップ

### Phase 1（最小稼働）
1. `mic_source_registry` / `market_events` / `market_metrics` / `mic_ingestion_runs` / `ai_usage_events`を新規migrationで作成（既存テーブル無変更）。
2. 構造化API優先で着手しやすいソースから実装: **FRED（米金利・macro）**、**財務省JGB利回り**、**EIA（WTI/Brent）**、**SEC EDGAR（8-K等）**。いずれも無料・公式・structured APIで実装難易度が低い。
3. 既存TDnetスクレイパーのロジックを共有モジュール化し、MIC用`market_events`にも書き込めるようにする（important-news-monitor自体は変更しない＝並行write）。
4. 日経平均等「構造化ソースが無い」カテゴリは、23章のリスクをユーザーと合意した上で着手（AI web_search方式で暫定運用 or ベンダー契約）。

### Phase 2（AI解釈層）
5. `market_state_current`/`history`のAI評価パイプラインを稼働（差分判定→条件付きLuna/Sol）。
6. `stock_state_current`/`history`を`tracked_stocks`の銘柄から段階展開。
7. Excel export用view群（13章）を整備し、ChatGPT経由でのExcel生成を試験提供。

### Phase 3（既存機能との接続）
8. `x-test-post`の朝刊/大引け/米国プレマーケットが、独自にOpenAI web_searchで市場数値を探す代わりに`market_metrics`/`market_state_current`を参照するよう改修（この時点で初めて既存Functionへの変更が発生＝別途承認プロセス）。
9. `important-news-monitor`の`market_macro`/`breaking_market`レーンをMICの共有fetchに統合し、重複取得を解消。
10. `market_scenarios`を使った個別銘柄分析・個人投資分析機能を追加。
11. Push通知（`notifications`テーブル経由、既存`send-push-notifications`をそのまま活用）でMarket State急変時のアラートを配信。

---

## 23. Risks / unresolved questions（未解決事項・要ユーザー判断）

1. **日経平均/TOPIX/日経先物/S&P/Nasdaq/Dow/SOXのリアルタイム構造化ソースが存在しない**。既存`x-test-post`も同じ理由でこれらの具体値を意図的に書かない設計になっている。選択肢: (a)有償市場データベンダー契約、(b)EOD/delayed値のみで妥協、(c)現状同様AI web_search抽出（信頼性・ToSリスクあり）。**ユーザー判断が必要**。
2. **important-news-monitorの実際のCronトリガーがリポジトリ内に見つからない**（`pg_cron`エントリ無し）。MICのfetchスケジュール設計・重複排除を確定させる前に、運用担当（Supabase Dashboard設定等）へ確認が必要。
3. Yahoo Finance/Investing.comページをAI web_search経由で参照する既存手法のToS/ライセンスリスク。スケール前に法務確認を推奨。
4. カテゴリを大幅拡張すると、差分ベースの節約をしてもAI呼び出し総量が増える可能性。`ai_usage_events`ベースの日次予算上限アラートをPhase 1で早期導入すべき。
5. `public.market_contexts`テーブルが未使用/廃止候補に見える。MICで同名概念を再利用する前に、既存workstream側へ確認要（Phase 0では一切触っていない）。
6. `important-news-monitor`（market_macro/breaking_marketレーン）と`x-test-post`（各レポートのweb_search）が類似ドメインに対して独立にOpenAI web_searchを実行しており、重複コストが発生している可能性が高い。Phase 3での統合が本命の解決策だが、Phase 1でも「新規MIC fetchは共有元にする」ことで新たな重複を増やさないようにする。
7. JPX昼休み（11:30-12:30）等のセッション粒度が既存`market_holidays`だけでは表現できない。Phase 1で`is_trading_session()`関数の新設が必要。
8. SNS投稿を政治カテゴリの一次情報として扱う場合の検証基準（公式アカウント・本人性・timestamp・削除リスク）は本ドキュメントで方針のみ提示。実装時の具体的な検証ロジックはPhase 1詳細設計で確定させる。

---

## Phase 1A 実装ノート（2026-09-12）

本設計（5章）に基づき、「Factを安全に蓄積する土台」のみを実装した。production migration適用・Edge Function deploy・secrets設定・AI呼び出しは一切行っていない（詳細はPhase 1A完了報告を参照）。

- Migration: `supabase/migrations/20260912090000_add_market_intelligence_core_phase1a.sql`（`mic_source_registry` / `market_events` / `market_metrics` / `mic_ingestion_runs` / `ai_usage_events`の5テーブル、5章の設計を踏襲。`market_metrics`は当初案のJSONB中心からレビューを受け、`provider`/`fetched_at`/`is_delayed`/`delay_minutes`/`quality_tier`/`is_official`を明示カラム化）。
- Edge Function: `supabase/functions/market-intelligence-ingest/`（FRED / 財務省JGB / EIA / SEC EDGARの4アダプタ。コード未deploy）。
- 調査で判明した追加情報（本文は書き換えず、ここに追記）: `supabase/functions/personalized-reports/`（2章執筆時点では未存在、Phase 1A開始時のfresh-checkでorigin/mainに存在すると判明）が、Yahoo Finance chart API（`https://query2.finance.yahoo.com/v8/finance/chart/{symbol}`、非公式だが構造化JSON）から個別銘柄および日経平均/TOPIXの日次終値を取得している。2章で「無料の公式構造化APIが存在しない」としたのは日中リアルタイム値についての評価であり、日次終値についてはこの既存実装が部分的な解になり得る。Phase 1Bでの評価候補として記録する。

---

## 付録: 監査に使用した主なファイル

- `supabase/functions/important-news-monitor/*`（index.ts, official_source_fetchers.ts, breaking_market_source_fetchers.ts, market_macro_source_fetchers.ts, news_candidate_logic.ts, important_news_grouping_logic.ts, importance_judgement_logic.ts, post_generation_logic.ts, publish_logic.ts, rate_control_logic.ts, overnight_hold_logic.ts, stale_run_logic.ts 等）
- `supabase/functions/x-test-post/*`（index.ts, morning_report_logic.ts, close_report_logic.ts, us_premarket_logic.ts, report_material_logic.ts, publish_claim_logic.ts 等）
- `supabase/functions/stocks-master-sync/*`, `supabase/functions/stocks-new-listing-sync/*`
- `supabase/functions/_shared/kabumori_voice.ts`, `x_oauth2_post.ts`
- `supabase/functions/send-push-notifications/*`
- `supabase/migrations/*.sql`（全48件）
