# TOPIX（指数）を Yahoo から直接取る件 — 調査と、既定 OFF の候補実装

- 作成: 2026-10-14 JST（新F2のチャット。返却先: かぶモリアプリG2のちゃ、完了確認 L2）
- 状態: ソースのみ（PR #201 に続く Draft PR）。本番の deploy・DB・Secret・Cron・有料 API・X 投稿・通知・EAS は実施していない
- ブランチ: `claude/f2-topix-direct-20261014`（PR #201 の HEAD `6977ca3c` から分岐。PR #201 のブランチは変更していない）

## 1. 結論

| 質問 | 答え |
|---|---|
| Yahoo から TOPIX 指数を取れたか | **確かめていない**。Yahoo の規約が自動取得を禁じているため、実際の API には問い合わせていない（下の2）。この環境からは Yahoo のサイトにも届かない |
| 使えた銘柄コード | なし（未検証）。候補は `^TOPX` と `998405.T` の2つ。公開情報では、どちらも Yahoo のチャート API で使えるという確証は無い（下の3） |
| 実装 | TOPIX 指数を `topix` という別の指標として扱う仕組みを、**既定 OFF** で入れた。OFF のときは、保存されるデータも文章の指示も今と同じ |
| 本番で使えるか | まだ使えない。TOPIX の表示には JPX 総研のライセンスが要り、Yahoo からの自動取得は Yahoo の規約で禁止されている |

## 2. 規約・権利（技術検証の前に確認）

公式ページはこの環境のネットワーク設定で直接開けなかった（`legal.yahoo.com`・`finance.yahoo.co.jp`・`www.jpx.co.jp` は名前解決できない）。検索結果に出た公式ページの本文で確認した。契約の判断の前に、利用者が公式ページを直接見ること。

| 対象 | 確認できたこと | 出典 |
|---|---|---|
| Yahoo（米国 Yahoo Inc.。今の `^N225` を取っている `query2.finance.yahoo.com` の提供元） | 利用規約で、自動化された手段でサービスからデータを取得すること（"access or collect data … using any automated means"）を、事前の許可なしに禁じている | https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html 、https://guce.yahoo.com/terms?locale=en-US |
| Yahoo!ファイナンス（日本。LINEヤフー。`998405.T` の表示ページ） | 「掲載している株価やその他のデータを、プログラム等を用いて機械的に取得する行為（スクレイピング等）」を禁止。注記事項で「株式情報の転用、販売は固く禁じます」。共通利用規約に再利用の禁止 | https://support.yahoo-net.jp/PccFinance/s/article/H000011276 、https://finance.yahoo.co.jp/feature/promotion/caution 、https://www.lycorp.co.jp/ja/company/terms/ |
| TOPIX（JPX 総研） | 第三者への配信・提供、商業的な利用にはライセンスが必要。ホームページ等への掲載は料金がかかることがある。自分で市場の動きを見るための利用は不要 | https://www.jpx.co.jp/markets/indices/licence/index.html （窓口 index-license@jpx.co.jp） |
| 日経平均（日本経済新聞社） | サイト・アプリでの表示は日経とのライセンス契約が前提。終値を継続的に出す場合も「確認書」の提出が求められる | https://indexes.nikkei.co.jp/nkave/license/ 、https://indexes.nikkei.co.jp/nkave/archives/file/license_agreement_jp.pdf |

- 依頼の「規約上許される範囲でのみ技術検証」に従い、Yahoo への実際の問い合わせはしていない（1回でも自動取得にあたる）
- **今の日経平均（`^N225`）と米国の指数も、同じ Yahoo の経路で取っている**。Yahoo の規約と日経の表示ライセンスの問題は TOPIX だけのものではない。米国の指数（ダウ・S&P500・ナスダック・SOX）の表示条件は今回は未調査

## 3. 銘柄コードについて分かっていること（公開情報だけ。実際の応答は未確認）

- `998405.T` は Yahoo!ファイナンス（日本・LINEヤフー）の表示用のコード。今使っている Yahoo（米国）のチャート API とは会社もデータも別。`yfinance`（同じチャート API を使う）で `998405.T` が「見つからない」と返ったという利用者の報告がある（https://pythonland.tech/yfinance-stock-data-fetch.html 、古い例 https://github.com/joshuaulrich/quantmod/issues/57 ）
- `^TOPX` は、Yahoo のチャート API で使えるという情報も、使えないという情報も見つからなかった
- リポジトリには `^TPX` が米国の別の銘柄（USD・東京の取引時間ではない）を返した記録がある（`x-test-post/close_report_data_logic.ts`）。また Yahoo（米国）の `TOPIX` は無関係の投資信託のコード（https://finance.yahoo.com/quote/TOPIX/ ）。似たコードが別の銘柄になる前例があるので、名前だけでは信用しない

使えた場合に返る形は、日経平均と同じチャート API の日足のはず（`meta.symbol`・`currency`・`exchangeTimezoneName`・`instrumentType`・`regularMarketTime`、日ごとの終値）。精度・遅延・更新時刻は実物で確かめるまで分からない。今の日経平均では、終値は小数4桁で丸めて保存し、表示は小数2桁、前日比は2日分の終値から計算（小数2桁）。

## 4. 実装（既定 OFF）

### 取得（`market-report-data-packet`）

- Secret `KABUMORI_MARKET_DATA_TOPIX_SOURCE`
  - 未設定・空・`off`・それ以外の値 → OFF。`topix` 指標を作らず、Yahoo にも問い合わせない。保存するデータパケットは今とまったく同じ（内容のハッシュも同じ）
  - `yahoo:^TOPX` または `yahoo:998405.T`（この2つだけ）→ その銘柄の日足を1回取り、`topix` 指標にする。診断に `topix_source` を記録
- `topix` 指標: 名前「TOPIX（東証株価指数）」、単位はポイント（円ではない）、ETF の代わりではない（`is_proxy=false`）、必須ではない（無くても朝刊・大引けは止まらない）
- Yahoo の応答が「その銘柄コード・円・東京時間・指数（INDEX）」でなければ使わない（`identity_mismatch`）。1306 の応答や ETF、米ドルの銘柄は TOPIX にならない
- その日の終値が無い・まだ引けていない・取得失敗のときは欠損（`expected_session_not_available` / `session_not_closed` / `fetch_failed`）。前の日の値や 1306 には戻さない
- データパケットの検査: 「TOPIX（東証株価指数）」の名前は `topix` だけ。`topix` が ETF・円の値になっていたら不合格
- 試し取り（dry run・DB に書かない）では、リクエストで候補を指定できる: `{"mode":"close","dry_run":true,"topix_source":"yahoo:^TOPX"}`。Yahoo が返した銘柄の中身（コード・通貨・時間帯・種類・最後の3日の終値）を `topixProbe` で返す。通常の実行はリクエストの指定を無視し、Secret だけを読む

### 分析（`market-report-analysis`）

- データパケットに `topix` があれば、日経平均と同じく東京市場の事実として扱う。市場の方向は日経平均と TOPIX の両方で判定（両方上昇なら「上昇」、逆なら「まちまち」）
- 日経平均と日付が違う TOPIX は使わない（「TOPIX（指数）は日経平均と同じ日の値が無かったため使っていません」）
- 取れなかったときは「TOPIX（東証株価指数）は取得できませんでした」。Phase 2 の「TOPIX（指数）は…使っていません」とは重ねない
- 生成の指示: TOPIX があるときだけ「TOPIX 指数そのもの。単位はポイント。1306 の円の値と混同しない。同じ日付のときだけ比べる」を足す。無いときは Phase 2 と同じ指示
- ガード: TOPIX があるときは「TOPIX」と書いてよい。ただし TOPIX の値・前日比・方向は入力と照合し、違えば削除（`WRONG_VALUE`・`WRONG_DIRECTION`・`VALUE_NOT_IN_INPUT`）。1306 の値を TOPIX として書いた文も削除。TOPIX が無いときに TOPIX の値を書いた文は、今までどおり削除

### 表示

- アプリ「参考資料」と共通のお話の指標の行: 東京市場の、日経平均のすぐ後に TOPIX（`src/lib/market-report-view.ts`、`_shared/market_report_story.ts`）
- X の整形（`x-test-post`）は変えていない。X の本文には、モデルが書いた TOPIX の文だけが出る

### 変えていないもの

- 個別レポート（`personalized-reports`・`personalized-analysis-worker`）の 1306 の比較指標
- `x-test-post` の旧経路（`^TPX` を使わない処理）と、記録用の列 `topix_data`（1306 のまま）
- PR #201 の内容（ニュース選別・文体・A案・Fact・X・アプリ）

## 5. テスト（すべてオフライン。新しいテストは `--deny-net` で通過）

| 対象 | 結果 |
|---|---|
| `market-report-data-packet/topix_index_test.ts`（新規） | 13 passed |
| `market-report-analysis/topix_index_test.ts`（新規） | 10 passed |
| `market-report-data-packet` 全体 | 55 passed / 0 failed |
| `market-report-data-packet`＋`market-report-analysis`＋`x-test-post` 共通経路＋`personalized-reports`（型検査あり） | 598 passed / 0 failed |
| `_shared`（`--no-check`） | 613 passed / 0 failed |
| アプリ `tests/app/` | 552 passed / 0 failed |
| `x-test-post` 全体 | 532 passed / 4 failed（morning_greeting の曜日枠。main でも同じ） |
| `tsc`（`src/`） | 既知の CSS 型の2件だけ |

テストの TOPIX の値（3,412.56 など）は**テスト用に作った数値**で、実際の TOPIX ではない。

確かめたこと: OFF のときデータパケット・ハッシュ・指示が変わらない／`^TOPX`・`998405.T` の両方で正しい値・前日比・騰落率・日付になる／1306 の応答・ETF・米ドル・別の時間帯・別のコードは TOPIX にならない／終値が無い・引け前・取得失敗は欠損で、1306 に戻らない／朝刊は前営業日、大引けは当日で、日経平均と同じ日付／日付が違えば比べない／存在しない TOPIX の値は削除／PR #201 の朝刊 10/2・大引け 10/6 の見本に TOPIX の文を1つ足して本番と同じ処理に通すと、削除0件・生成1回＋Fact 1回で、アプリの指標の行に TOPIX が出る

## 6. 本番に反映するには（どれも別の承認。今回は何もしていない）

1. **権利の判断（利用者）**
   - TOPIX: JPX 総研にライセンスを問い合わせる（質問は `F2_PHASE2_TOPIX_AND_COLUMN.md` §2）
   - Yahoo: 自動取得の許可が無い限り、Yahoo は TOPIX の取得元にできない。許可を取るか、契約できる取得元（J-Quants Pro・JPX のデータ配信など）を選ぶ。別の取得元にする場合も、`topix` 指標の形はそのまま使え、取得部分だけを足せばよい
   - 日経平均と米国の指数の今の取得・表示も、同じ観点で確認する
2. **銘柄コードの確認**（1 で許された場合だけ）: PR #201 とこの PR を merge → `market-report-data-packet` を deploy → dry run を `^TOPX` と `998405.T` で1回ずつ（DB には書かない。Secret も変えない）→ `topixProbe` が「そのコード・JPY・Asia/Tokyo・INDEX」で、終値が TOPIX の公表値と一致するかを見る
3. **ON にする**: `market-report-analysis` を deploy（この PR の分析側）→ Secret `KABUMORI_MARKET_DATA_TOPIX_SOURCE=yahoo:<確認できたコード>` → 次の 07:50（朝刊）か 16:15（大引け）のデータパケットに `topix` が入る → 読み戻し（`topix` の値・日付、`report_diagnostics`、文章の TOPIX の記述、`fact.removed_units`）。アプリの並びは Mac の Metro を新しい main で起動し直す
4. **戻す**: Secret を消すか `off` にする（deploy 不要）。保存済みのデータはそのまま

費用: Yahoo への問い合わせが1回増えるだけで、AI の呼び出し回数は変わらない。

## 7. 残課題

- 上の権利の判断（TOPIX・Yahoo・日経平均・米国の指数）
- 実際の Yahoo の応答での確認（コード・精度・遅延・更新時刻）。この環境ではできない
- 個別レポートの比較指標（1306）を TOPIX に変えるかは別の判断
- 新旧 slot の扱い: 新F2の前の TASK は L2 で done。この件を TASK として正式に登録する場合は、旧 TASK の archive・HISTORY_INDEX の更新・新旧 slot の競合確認を先に行う（今回は `.agent` / `.agent_v2` を変えていない）
