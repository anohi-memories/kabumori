# 旧 generic breaking 検索の縮小と shadow 停止（2026-10-06）

## 変更

| 項目 | 変更前 | 変更後 |
|---|---|---|
| generic breaking 検索 | 毎時 4 検索（固定3＋ローテ1）≒ 96回/日 | **1日4回**（JST 08/13/16/23時に各1検索） |
| BBC / Al Jazeera 見出しトリガー | 毎時 | 変更なし（毎時） |
| shadow 検索（Cron `important-news-shadow`, jobid 38, `*/10`） | 144回/日 | 停止（`cron.alter_job(38, active := false)`） |
| TDnet / 公式RSS / 重要度判定 / Sol 昇格 / Fact / Voice | — | 変更なし |

4スロット（`breaking_market_daily_schedule.ts`）:

| JST | topic | category |
|---|---|---|
| 08:00 | `japan_disaster_security_emergency`（国内災害・インフラ・安全保障） | disaster |
| 13:00 | `boj_monetary_policy`（日銀・金融政策） | boj |
| 16:00 | `japan_market_session`（日本市場の重大急変） | other_market_moving |
| 23:00 | `fx_intervention_mof`（為替介入・財務省） | fx |

- スロットは時刻になると due。課金された検索が1回あれば消費され、同日に再実行しない。
- HTTP 429 など**課金ゼロで失敗**した場合だけ、次の毎時 fetch で最大1回再試行する（スロットの H 時と H+1 時のみ）。
- 履歴の読み出しに失敗した場合は、スロット自身の時刻の fetch だけで実行する（取りこぼしも重複もしない側に倒す）。
- 12 topic のカタログと従来のローテーション（`selectBreakingMarketQueriesForCycle`）はコードに残してあり、`index.ts` の呼び出しを戻せば復帰できる。

## fetch を10分ごとに（同日追記）

報道から配信まで30分以内を目指し、fetch Cron（jobid 2）を毎時から `*/10` に変更。generic 検索は日次スロットで決まるため、fetch の頻度を上げても1日4回のまま。

- 再試行できる失敗は HTTP 429 / 5xx（課金されないと確実）のみ。タイムアウト・通信エラー（HTTP ステータスなし）は課金の可能性があるためスロットを消費し、再試行しない。
- 履歴が読めない場合、スロットは各時の最初の10分だけ実行（毎時 `:00` の fetch のみ）。
- 見出しトリガー（BBC / Al Jazeera）は RSS 無料＋判定 Luna（約 $0.0003/回）のみで、新しい見出しがあるときだけ呼ばれる。裏取り検索（`SECONDARY_VERIFY_MAX_PER_RUN`）は 0 のまま。
- 判定（7,27,47分）・生成（14,34,54分）・公開（5分ごと）の Cron は変更しない。

## 根拠（本番 read-only 実測）

- 直近8日の important / most_important の breaking 44件は、すべて見出しトリガー経由。generic 検索由来は0件。
- 2026-09-28〜10-03 の6日平均: `news_breaking_search` 93回/日・$1.28/日、`news_shadow_search` 約16回/日・$0.17/日、ニュース合計 $1.65/日。
- shadow は `important_news_shadow_runs` / `important_news_shadow_candidates` にだけ書く。本番の関数・view・trigger からの参照はなく（read-only 調査）、`important_news_candidates` への書き込み経路もない。`headline_trigger_logic.ts` が `SHADOW_SOURCES`（設定ファイル）を import しているだけで、shadow の実行結果は使っていない。

## ロールバック

- shadow 再開: `select cron.alter_job(38, active := true);`
- generic 検索を従来どおりに戻す: `index.ts` の `selectDailyBreakingMarketQueries(...)` を `selectBreakingMarketQueriesForCycle(BREAKING_MARKET_QUERIES, now, MAX_BREAKING_MARKET_SEARCHES_PER_FETCH, history)` に戻す。
