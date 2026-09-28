# ChatGPT広域監視とのRecall比較検証方法（N1）

- 作成: 2026-09-28（N1 調査。設計のみ）
- 前提: ユーザーは別途 ChatGPT で「1時間ごとの株式材料・重要ニュース監視」を利用している。**Claude はその実データを取得できないため、本文書に ChatGPT の実績値は一切含めない**（捏造しない）。本文書は比較の**手順とフォーマット**のみを定める。

## 0. 目的

- ChatGPT 監視が見つけたニュースを「正解集合（reference set）」の一部とし、新基盤（無料feed主体）が
  1. 取れたか（hit）
  2. 取れなかったか（miss）
  3. どの source を足せば取れたか（fix candidate）
  を**事象単位**で記録する。
- 目標値「重要ニュースの約95%を無料・低コスト経路で発見」は**保証値ではなく、このベンチマークで測る目標値**として扱う。

## 1. 正解集合の作り方（ChatGPT だけに依存しない）

ChatGPT 監視の結果は取りこぼし・誤りを含み得るため、正解集合は**複数の入口の和集合を人手で確定**する。

| 入口 | 内容 | 役割 |
|---|---|---|
| R1: ChatGPT 監視ログ | ユーザーが毎時の出力をそのまま保存（コピペ可） | 広域発見の主参照 |
| R2: 既存 monitor の published / important 以上 | `important_news_candidates`（read-only） | 既存基盤の実績 |
| R3: 市場異常 | 当日の大きな値動き（日経・USD/JPY・WTI・米10年債・VIX 等）から逆算した「原因ニュース」 | ChatGPT と既存の両方が落とした事象の発見 |
| R4: 日次の人手レビュー | 翌朝の主要紙1面・経済面の見出し | 最終確認 |

- 1事象を複数記事で報じるのが普通なので、**記事単位ではなく event（事象）単位**で数える。
- event の同一判定: 「主体（国・企業）＋行為＋対象＋日付」が同じなら同一 event。

## 2. 記録フォーマット

### 2.1 event 台帳（1行 = 1事象）

| 列 | 型 | 説明 |
|---|---|---|
| `event_id` | text | `YYYYMMDD-連番` |
| `event_title` | text | 事象の要約（日本語、30字程度） |
| `category` | enum | japan_macro / us_global_macro / geopolitics / energy_commodity / semis_ai / japan_company / disaster / other |
| `materiality` | enum | market_wide_critical / market_wide_high / sector / single_stock |
| `first_public_at` | timestamptz | 最速の一次公表時刻（分かる範囲で。推定なら `estimated=true`） |
| `first_public_source` | text | 最初に公表した媒体・機関 |
| `chatgpt_found` | bool / null | ChatGPT 監視ログにあったか（ログが無い時間帯は null） |
| `chatgpt_seen_at` | timestamptz / null | ログ上の時刻（毎時出力の時刻） |
| `new_found` | bool | 新基盤の記事プールに該当記事があったか |
| `new_first_seen_at` | timestamptz / null | **新基盤が実際に取得した時刻**（`fetched_at`）。記事の published_at で代用しない |
| `new_source` | text / null | 最初に拾った source_key |
| `existing_found` | bool | 既存 monitor（TDnet / market_macro / breaking / trigger）で候補化されたか |
| `latency_min` | int / null | `new_first_seen_at - first_public_at`（分） |
| `web_search_needed` | bool | 新基盤で Web Search を使った（使うべきだった）か |
| `miss_reason` | enum / null | §2.2 |
| `fix_candidate` | text / null | 足せば取れた source / alias / ルール |
| `notes` | text | |

### 2.2 miss_reason（機械集計できる理由コード）

| code | 意味 | 対応の方向 |
|---|---|---|
| `no_source` | 該当分野の source を巡回していない | catalog から source 追加 |
| `source_blocked` | source はあるが 403/404/timeout/429 | 取得方式・頻度・UA を見直し |
| `source_slow` | 取れたが遅延が大きい（例: 60分超） | 高頻度 source を追加・巡回間隔 |
| `not_in_feed` | サイトには出たが RSS に載らなかった（カテゴリ違い・件数上限） | 別カテゴリ feed / sitemap |
| `item_cap_truncated` | 取得はしたが parser の件数上限で落ちた | 件数上限・差分取得 |
| `filtered_rule` | ルールベース filter で落ちた | filter 修正（負例も確認） |
| `entity_unmatched` | 記事はあるが銘柄紐付けに失敗 | alias 追加 |
| `triage_rejected` | 軽量AI一次判定で落ちた | プロンプト・閾値（既存 Luna/Sol は変更しない） |
| `dedupe_merged_wrong` | 別事象として扱うべきものを統合した | dedupe 規則 |
| `terms_excluded` | 規約上使えない source にしか無かった | 許諾取得 or Web Search 補完 |
| `paywall_only` | 有料媒体にしか無かった | Web Search 補完／対象外 |
| `web_search_only` | 無料経路では原理的に取れない | 限定 Web Search の対象として許容 |

### 2.3 比較サマリ（週次）

| event | ChatGPT発見 | 新基盤発見 | 既存発見 | source | latency(分) | miss_reason |
|---|---:|---:|---:|---|---:|---|
| （例）原油急騰の原因報道 | ✔ / ✘ / 不明 | ✔ / ✘ | ✔ / ✘ | cnbc_world | 12 | — |

集計指標:

- **Recall（新基盤）** = 新基盤発見 event / 正解集合 event（materiality 別、category 別に分ける）
- **無料経路 Recall** = Web Search を使わずに発見した event / 正解集合 event（← 95% 目標はこれ）
- **Web Search 補完後 Recall** = 上記＋限定 Web Search で発見
- **latency 中央値 / p90**（category 別）
- **ChatGPT との差分**: 新基盤のみ発見 / ChatGPT のみ発見 / 両方 / 両方なし
- **miss_reason 分布**（上位3つが次の改善対象）

## 3. 手順

1. **ログ収集（ユーザー作業）**: ChatGPT 監視の毎時出力を、時刻付きでそのまま保存する（1日1ファイル）。形式は自由。Claude は内容を要約・転記する際に**出典時刻を改変しない**。
2. **新基盤の記録**: 記事プールの `fetched_at`（初回取得時刻）を必ず保持する。これが無いと latency を測れない（既存 shadow 調査でも同じ問題が起きた：`first_seen_at` 不在で過去事例の判定が不能）。
3. **event 台帳作成（日次・15〜30分）**: R1〜R4 から event を起こし、各列を埋める。
4. **週次集計**: §2.3 の指標を算出し、miss_reason 上位を N2+ の改善バックログへ。
5. **最低期間**: 2週間（平常日＋指標発表日＋週末を含む）。重大イベント（戦争・急騰・災害）が期間中に無い場合は、**過去の重大事例のリプレイ**（§4）で補う。

## 4. 過去事例リプレイ（重大イベントが少ない期間の補完）

- 既存の取りこぼし事例（docs/news-coverage/REDESIGN.md、SHADOW_COVERAGE_GAP_RESEARCH_2026-09-20.md）: 9/12 北朝鮮ミサイル、9/9〜9/13 ホルムズ・タンカー、9/11 フーシ派、9/4 為替介入、9/26 ホルムズ再開提案（Al Jazeera 07:33 JST）等。
- リプレイで確認できるのは「その source の記事が**その時刻に公開されていたか**」までであり、「新基盤が**その時刻に取得できたか**」ではない。**リプレイ結果は `new_first_seen_at` を空にし、`replay=true` で区別**する（published_at で代用しない）。

## 5. 判定上の注意

- ChatGPT のログにない＝事象がない、ではない。ChatGPT のログ欠落時間帯は `chatgpt_found = null`。
- ChatGPT が「見つけた」と言っても一次情報が確認できない event は、正解集合に入れる前に人手で確認（誤報・古いニュースの混入を除く）。
- 95% は**全 event の平均ではなく materiality 別に見る**。market_wide_critical の取りこぼし1件は single_stock の10件より重い。critical は別枠で「取りこぼし0件を目標、1件ごとに原因分析」とする。
- 新基盤が「発見」しても、規約上表示できない source のみでの発見は `terms_excluded` と併記し、アプリ表示可能性を別に評価する。

## 6. 成果物（N2 以降で作るもの）

- event 台帳のスプレッドシート（または DB 新規テーブル。migration は別途承認）
- 週次集計 SQL / スクリプト
- miss_reason → 改善 backlog のテンプレート

## 追記（N3 v2、2026-09-28）: 限定 Web Search 導入後の miss_reason

N3 v2 で Layer 3（限定 Web Search）を導入したため、§2.2 に次の理由コードを追加して集計する（既存コードは維持）。新基盤の実装は n3_observer_db_function.md。

| code | 意味 | 確認する記録 |
|---|---|---|
| `source_gap` | 該当分野の無料 source が無い（§2.2 の `no_source` と同義。以後はこちらを使う） | registry |
| `search_not_triggered` | 検索すべき状況だったが、トリガー条件に当たらなかった / 説明済みと誤判定した | `news_discovery_searches` に該当 search_key が無い、または plan の skipped |
| `query_gap` | 検索は実行されたが、レーンの query が事象を拾わなかった | searches.result_count / useful_signal_count |
| `delayed_source` | 取れたが遅い（`source_slow` と同義） | signals.fetched_at − first_public_at |
| `policy_blocked` | 規約上使えない媒体（no_access）にしか無かった | searches.policy_blocked_count |
| `dedupe_error` | 別事象を重複として統合した（`dedupe_merged_wrong` と同義） | run の duplicates と signal の対応 |
| `classification_error` | topic / ticker の付与漏れ・誤り（`entity_unmatched` を含む） | signal_topics / signal_tickers |
| `budget_exhausted` | soft budget / hard cap で検索が拒否された | searches.status='denied'、deny_reason |

時刻比較は `news_discovery_signals.fetched_at`（新基盤の初回取得）と、`detected_at`（GDELT / 検索の検知時刻）を使う。`published_at` で代用しない。
