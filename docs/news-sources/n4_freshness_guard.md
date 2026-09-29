# N4 鮮度ガード（production canary 前）

作成: 2026-09-30 / branch `claude/n4-freshness-guard-20260930`（base main `fac3da6`、URL 修正 f11fa84 を `80dfa1e` として cherry-pick）

## 目的

初回の production observer 実行で、feed に残っている古い backlog（BEA の 2013 年のリリースなど）を新着として保存しないようにする。

## 仕様

| 項目 | 内容 |
|---|---|
| 対象 | `SourceDefinition.max_item_age_days`。DIRECT_SOURCE は 30（`DIRECT_MAX_ITEM_AGE_DAYS`）。DISABLED / GDELT（DISCOVERY_ONLY）/ web search は `null`（判定しない） |
| 判定に使う時刻 | published_at（date-only を含む）。無い場合は updated_at。detected_at は使わない |
| 判定 | `now - 有効時刻 > 30日` のとき `stale` として除外する。ちょうど 30 日は残す。30 日 + 1 秒で除外する |
| date-only | その日付が世界のどこかでまだ続いている最後の時刻（日付 + 36 時間 UTC）を基準にする。1 日早く除外することはない |
| 時刻なし・解析できない時刻 | 残す（`no_published_at` を付ける） |
| 未来の時刻 | 残す（従来どおり `future_timestamp` を付ける） |
| 記録 | `filtered` に含めて数え、さらに `stale_filtered` として別に数える（source ごとのログ、totals、observer の execution JSON）。migration も DB 列の追加もなし |

## ローカルでの実データ観測（2026-09-29 15:07 UTC）

- 環境は前回の N4 と同じ：使い捨て PG17、fixture の stocks_master 23 件、PostgREST shim。
- Web Search provider は設定しない。OpenAI と *.supabase.co への通信はブロックする。

| | Run 1 | Run 2 |
|---|---|---|
| HTTP / status | 200 / completed | 200 / completed |
| 所要時間 | 42.6 s | 37.7 s |
| 取得 | 525 | 525 |
| filtered（うち stale） | 208（77） | 208（77） |
| 正規化 | 317 | 317 |
| 重複 | 0 | 317 |
| 保存 | 317 | 0 |
| deadline | 未到達 | 未到達 |

- 前回の DIRECT 正規化は 394 件（444 件から GDELT の 50 件を除いた数）。今回は 317 件で、差の 77 件は前回「30 日超」と数えた 77 件と一致する。
- GDELT は外部側の 429 で取得できなかった。retry はしていない。鮮度ガードとは関係がない。
- stale の内訳：us_bea 46、us_eia_today_in_energy 10、us_eia_press 10、us_fed_press 9、jp_esri 1、us_ustr 1。
- 保存した 317 件はすべて 30 日以内。最も古いものは jp_esri の 2026-09-01 05:00 UTC（28.4 日前）。
- 除外したもののうち最も新しいのは us_eia_today_in_energy の 2026-08-28（32.0 日前）。最も古いのは us_ustr の 2009-07-20。
- BEA：scheme なしの古い link（`www.bea.gov/news/2026/gdp-advance-estimate-…`、221 日前）は https に補完したうえで stale として除外した。invalid_url は 0 件。保存された BEA の 2 件は正しい host だった。
- 時刻なしの保存は 0 件。published_at が無いのは 43 件（SEC 8-K 40、JMA 2、USGS 1）で、いずれも updated_at で判定され 30 日以内だった。
- Federal Register（date-only）の 20 件はすべて 2026-09-29 で、保存された。
- 未来の時刻は 1 件（官邸、+2.6 h）。従来どおり保存し、`future_timestamp` を付けた。
- 不正な URL 0。ESRI の「同じ URL で別タイトル」の 1 組は N2 の規則どおり（既知）。
- production への接続 0、OpenAI 0、Web Search 0。ローカルの DB・shim・鍵は削除済み。
