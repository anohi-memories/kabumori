# ニュース source カタログ（N1）

- 作成: 2026-09-28（N1 調査。G1〜G4 外の直接作業）
- 調査方法: 各 feed を **1回だけ** read-only 取得（HTTP 状態・最新項目時刻・日付欄の有無）、記事ページ1本で `og:image` / `article:published_time` / `canonical` を確認、利用規約は公式ページ優先で確認。大量クロールはしていない。
- 実測時刻: 2026-09-28 05:00〜06:00 UTC（14〜15時 JST、月曜。直近24時間は週末を含む）
- **Tier はこの文書での source 品質分類**であり、既存 monitor の重要度判定とは無関係。

## 0. 要約

- 調査 source 数: 評価行 **137**（個別媒体 約160）。**Tier A 26 / B 35 / C 42 / D 30 / 未評価 4**（§9）
- **最有力（Tier A）**: 米連邦の公式（FRB・BEA・BLS・SEC・White House・State・USTR・**Federal Register API**・EIA・USGS・NHC）、欧州公式（ECB・EC Press Corner・BoE）、日本公式（日銀・金融庁・気象庁・防衛省 ほか。§2 参照）、EDINET・NHTSA などの構造化 API。**いずれも「何が発表されたか」には強いが、「世界で何が起きたか」（戦争・事故・海上攻撃）には弱い。**
- **最大の論点は報道 source の規約**。技術的には大半の RSS が取れるが、
  - **明示的に禁止/非商用**: Al Jazeera（robots.txt と規約で商用・AI・TDM 禁止を明記）、CNBC、NYT、FT（AI 利用を明示禁止）、Dow Jones（MarketWatch/WSJ）、Google News RSS、UN News（UN サイト規約は personal, non-commercial）
  - **国内報道はほぼ全滅**: NHK・時事・朝日・毎日・Yahoo!ニュース・Google News・東洋経済・ダイヤモンド・株探・みんかぶは、公式規約で個人利用限定または営利利用禁止。読売・日経・共同・ロイター・ブルームバーグは公開 RSS なし（ライセンス前提）。**許諾なしで使える国内の総合速報 source は見つからなかった**
  - **不明確・許諾制（要問い合わせ）**: BBC（商用可否の明記なし、AI クローラーを robots で拒否）、ITmedia（アプリ組込は許諾制）、PR TIMES（営利利用は許可制）、日刊工業（事前連絡）、多くの業界媒体
  - **日本の公式は PDL1.0（CC BY 4.0 互換）で出典明記なら商用可**（財務省・金融庁・官邸・内閣府・消費者庁・EDINET・気象庁）。ただし日銀は独自規約で商用転載は事前相談、JPX RSS は商用二次利用不可、TDnet 閲覧サイトは robots で全拒否
  - **商用可を明記**: GDELT（学術・商用・政府用途で無制限、引用とリンク必須。ただし 5 秒に 1 回制限）、米連邦著作物（パブリックドメイン）、EU/英国公式（出典表示条件付き）
- **現在本番で使われている source にも規約リスクがある**（報告のみ、変更していない）: headline trigger / shadow の **Al Jazeera**（D）、**BBC**（C）、market_macro / shadow の **UN News**（C）、market_macro の **日銀**（商用転載は事前相談）、TDnet レーンの **TDnet 閲覧サイト**（robots 全拒否。先行調査で既出）。
- 既存の未接続提案ファイル `news_collection_scope_proposal.ts` の **財務省・官邸・JPX RSS は 404、防衛省 press RSS は 403**（N2 で使う場合は URL の再調査が必要）。

## 1. 評価の軸

「RSS がある」＝「商用アプリで使える」ではない。以下を**分けて**評価した。

| 軸 | 記号 | 意味 |
|---|---|---|
| 技術的取得 | tech | feed/API が 2026-09-28 に取得でき、時刻がある |
| 商用利用 | com | 商用アプリでの利用が規約上認められるか（allowed / unclear / prohibited） |
| 見出し＋URL | hl | 見出し・リンク・媒体名の表示が認められるか |
| 全文 | full | 本文の保存・表示（原則すべて不可、PD・CC BY 等のみ可） |
| 画像 | img | OG 画像等の表示（PD・CC でも写真は第三者権利が多い） |
| AI 処理 | ai | 見出しを AI 分類に使うことが規約上問題ないか（多くが未確認。明示禁止あり） |

Tier:

- **A**: 無料・高信頼・高頻度で本番基盤に積極採用したい（tech ○ かつ com allowed）
- **B**: 無料または安価で補助として有用（tech ○、com allowed だが速報性・網羅性が限定的、または軽微な条件あり）
- **C**: 規約・安定性・取得方式に注意（com unclear、403、時刻なし 等）。**許諾が取れれば昇格**
- **D**: コスト・規約・不安定性で現時点非推奨（com prohibited、有料のみ、閉鎖）

凡例: metadata 列は `pub/upd/can/img` = published_at / updated_at / canonical / thumbnail（og:image）の取得可否。○=確認済み、×=無し、–=未確認。`calls/日` は news_acquisition_architecture.md の巡回案での想定。

## 2. 日本（公式・市場）

各府省は 2024 年以降「政府標準利用規約 2.0」から **公共データ利用規約 第1.0版（PDL1.0、CC BY 4.0 互換）** へ移行しており、**出典明記で商用利用可**（ロゴ・第三者著作物・人物写真は対象外）。規約ページで確認済み: 財務省・金融庁・経産省・首相官邸・内閣府・消費者庁・EDINET・気象庁。

| source | operator | category | type | URL | 速度 | tech（2026-09-28） | pub/upd/can/img | ticker | com | hl/full/img | calls/日 | risk | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|
| 日本銀行 | 日本銀行 | 金融政策・統計 | RSS | https://www.boj.or.jp/rss/whatsnew.xml | 即時 | 200 / 09-27 23:50Z / 68件 | ○/×/–/共通画像 | × | **独自規約：商用目的の転載・複製は事前相談** | リンクは実務上可（明文なし）/相談/相談 | 48＋会合時 | item が PDF 直リンクのことあり。**既存 market_macro で使用中** | B（トリガー用途。見出し表示は日銀へ相談） |
| 財務省 | 財務省 | 財政・為替・国債 | RSS | https://www.mof.go.jp/news.rss （`rss/all.xml` は 404） | 日複数回 | 200 / 09-28 12:00 JST | ○/–/–/共通画像 | × | PDL（出典明記で可） | ○/○/第三者除く | 96 | 為替介入実績は news.rss に出ない→別ページ監視 | **A** |
| 金融庁 | 金融庁 | 金融規制・行政処分 | RSS | https://www.fsa.go.jp/fsaNewsListAll_rss2.xml | 平日日次 | 200 / 09-25 / 15件 | ○/–/–/○ | △（処分対象社名） | PDL | ○（フレーム表示不可）/○/第三者除く | 48 | 低 | **A** |
| 首相官邸 | 内閣官房 | 政府方針 | RDF | https://www.kantei.go.jp/index-jnews.rdf （`/jp/rss/index.rdf` は 404） | 日次 | 200 / 09-27 | ○/–/–/○ | × | PDL | ○/○/人物写真注意 | 48 | 低 | **A** |
| 内閣府 ESRI | 内閣府 | GDP・景気指標 | RSS | https://www.esri.cao.go.jp/rss-jp.xml | 公表時刻固定 | 200 / 09-25 | ○/–/–/共通画像 | × | PDL | ○/○/– | 24＋公表時 | 低 | **A** |
| 内閣府 | 内閣府 | 政策 | RDF | https://www.cao.go.jp/rss/news.rdf | 日次 | 200 / 09-25 | ○/–/–/共通画像 | × | PDL | ○/○/– | 24 | 低 | B |
| 気象庁 防災情報XML | 気象庁 | 地震・津波・火山・警報 | Atom | https://www.data.jma.go.jp/developer/xml/feed/extra.xml ・ eqvol.xml ・ regular.xml（高頻度・長期の2系統） | 分単位 | 200 / 09-28 05:13Z / extra 約1,700件/日 | ○/○/n/a/n/a | × | PDL | ○/○/– | 720〜1,440（条件付き GET） | 定常電文が大半。**2026-11-04 に出力文字コードが UTF-8 統一**。気象業務法：独自予報は許可制、警報の独自発表は禁止（気象庁警報の出典付き伝達は可） | **A** |
| EDINET API v2 | 金融庁 | 大量保有・公開買付・有報 | JSON API | https://api.edinet-fsa.go.jp/api/v2/documents.json | 平日随時 | 仕様書（2026-06-03 版）で確認、API は未呼び出し（無料キー要登録） | ○（提出日時）/–/–/n/a | **○（証券コード）** | PDL（提出書類自体の権利は要確認） | ○/要確認/– | 96 | 短時間大量アクセスは停止対象。画面スクレイピング禁止 | **A** |
| 消費者庁 | 消費者庁 | リコール・行政処分 | RSS | https://www.caa.go.jp/news.rss | 日次 | 200 / 09-28 | ○/–/–/× | △ | PDL | ○/○/第三者除く | 24 | recall.caa.go.jp の RSS は見つからず | **A** |
| 防衛省 | 防衛省 | 安全保障 | RSS | https://www.mod.go.jp/j/rss/news.xml （`press.xml` は 403） | 日1〜2回（遅い） | 200 / 09-25 / 148件（本調査）。別経路では 403 の回あり。記事ページは 403 | △（lastBuildDate 注意）/–/–/– | × | 要確認 | 要確認 | 12 | ミサイル速報には使えない（先行調査と同じ） | B（公式記録用） |
| 国土交通省 | 国交省 | 物流・自動車・災害 | RDF | https://www.mlit.go.jp/pressrelease.rdf ほか | 日次 | 200 / 09-28（時刻が固定値に見える） | △/–/–/– | △ | PDL の可能性（要確認） | 要確認 | 24 | 自動車リコール RSS なし | B |
| 厚生労働省 | 厚労省 | 医薬・雇用 | RDF | https://www.mhlw.go.jp/stf/news.rdf | 日次 | 200（**未来日付の項目あり**） | △/–/–/– | × | 要確認 | 要確認 | 24 | 時刻補正 | B |
| デジタル庁 | デジタル庁 | 政策 | RSS | https://www.digital.go.jp/rss/news.xml | 日次 | 200 / 09-25 | ○/–/–/– | × | 要確認 | 要確認 | 12 | 低 | B |
| 政府広報オンライン | 内閣府 | 政府広報 | RDF | https://www.gov-online.go.jp/rss/index.rdf | 日次 | 200 / 09-28 | ○/–/–/– | × | PDL（要確認） | ○（埋め込み不可）/要確認/– | 12 | 市場影響小 | B |
| e-Stat | 総務省 | 統計 | API | https://api.e-stat.go.jp/ （**RSS は 2023-09-30 終了**） | 公表時 | API（無料アプリ ID） | – | × | API 規約：クレジット表示で可 | – | 数回 | 既存 MIC で利用 | B（データ用） |
| 経済産業省 | 経産省 | 産業政策・輸出管理 | Atom | https://www.meti.go.jp/ml_index_release_atom.xml | – | 200 だが **最新 2026-06-19（約3か月停止）** | ○/○/–/– | × | PDL | ○/○/ロゴ除く | 0 | 静かな停止 | C（代替経路要調査） |
| 外務省 | 外務省 | 外交 | RSS | mofa.go.jp（URL 未特定） | – | **403** | – | × | PDL の可能性 | – | 0 | WAF。日本の IP から再確認 | D（確認まで） |
| JPX RSS（マーケットニュース・お知らせ・注意喚起・売買停止） | 日本取引所グループ | 市場運営 | RSS | https://www.jpx.co.jp/rss/markets_news.xml ほか（`rss/news.xml` は 404） | 日中随時 | 200 / 09-28 | ○/–/–/共通画像 | △ | **✗ 規約：商用目的のデータ収集・二次利用・再配信不可** | 要許諾 | 0 | 契約前提 | C（JPX 総研と契約時） |
| TDnet 閲覧サイト | JPX | 適時開示 | HTML | release.tdnet.info | 即時 | 200 だが **robots `Disallow: /`** | – | ○ | 無料の許可ルートなし | – | – | **既存 monitor の TDnet レーンが使用中**（先行調査で指摘済み） | D（無料経路）／有料 TDnet API：基本料 ¥70,000/月＋情報料（月300件まで0円等）、再配信可 |
| 国民保護ポータル（J アラート） | 内閣官房 | ミサイル等 | – | kokuminhogo.go.jp | – | 公開 feed なし | – | × | – | – | 0 | ギャップ | D |


## 3. 日本（報道・経済メディア・プレスリリース）

**国内の大手報道・金融情報サイトは、公式規約で個人利用限定または営利利用を禁止している**（RSS が動いていても商用アプリでは使えない）。許諾なしで使える国内の総合速報 source は見つからなかった。

| source | URL | tech（2026-09-28） | pub/upd/can/img | 24h件数 | com（公式規約） | hl/full/img | ai（robots） | terms | Tier |
|---|---|---|---|---:|---|---|---|---|---|
| NHK | https://news.web.nhk/n-data/conf/na/rss/cat0〜7.xml（www.nhk.or.jp/rss/news/ も同内容） | 200 / 09-28。**再取得で空応答・301 の回あり** | ○/○/○/○ | cat0: 7（2.7h分） | **✗** 個人利用のためのみ、商業目的の再配信・再提供は不可 | ✗/✗/✗ | GPTBot・ClaudeBot 等を Disallow | https://www.nhk.or.jp/toppage/rss/index.html | **D** |
| 時事通信 | https://www.jiji.com/rss/ranking.rdf ほか | 200 / 09-28 | ○/○/○/○ | – | **✗** 個人の私的利用のみ、営利目的不可 | ✗ | AI ボット拒否 | https://www.jiji.com/policy/rss.html | **D**（配信契約なら別） |
| 朝日新聞 | https://www.asahi.com/rss/asahi/newsheadlines.rdf | 200 / 09-28 | ○/○/○/○ | 36 | **✗** 営利目的サイトでの利用禁止 | ✗ | AI ボット拒否 | https://www.asahi.com/information/service/rss.html | **D** |
| 毎日新聞 | https://mainichi.jp/rss/etc/mainichi-flash.rss | 200 / 09-28（20件で約3.3時間分） | ○/○/○/○ | 20 | **✗** 商業目的の利用はお断り（「実験」扱い） | ✗ | AI ボット拒否 | https://mainichi.jp/rss/ | **D** |
| 読売新聞 | 公開 RSS なし | – | – | – | ライセンス前提 | – | AI ボット拒否 | – | **D** |
| 産経新聞 | sankei.com/arc/outboundfeeds/rss/?outputType=xml（`/rss/news/economy.xml` は 404） | 200 | ○/–/–/– | – | 公式案内なし（要確認） | 要確認 | AI ボット拒否 | – | **D** |
| 共同通信 / 47NEWS | 47news.jp/rss/… | **403** | – | – | ライセンス前提 | – | AI ボット拒否 | – | **D**（配信契約なら別） |
| 日本経済新聞 | 公開 RSS なし（404） | – | – | – | ライセンス前提 | – | AI ボット拒否 | – | **D** |
| ロイター日本語 / ブルームバーグ日本語 | 401 / 403、公開 RSS なし | – | – | – | ライセンス前提 | – | – | – | **D** |
| Yahoo!ニュース | https://news.yahoo.co.jp/rss/topics/business.xml ほか | 200 / 09-28 | ○/○/○/○ | 8件保持 | **✗** 個人利用のみ、サイト・アプリを作成して公開することは不許可 | ✗ | AI ボット拒否 | https://news.yahoo.co.jp/rss | **D** |
| Google News RSS（日本語） | news.google.com/rss/search?…&hl=ja | 200 | ○/–/×/× | – | **✗** 営利目的以外の個人的使用が条件 | ✗ | – | https://www.google.com/intl/ja_jp/terms_google_news.html | **D** |
| 株探 / みんかぶ / Yahoo!ファイナンス / フィスコ / モーニングスター / Trader's Web | 公開 RSS なし（株探 /rss/ は 404） | – | – | – | **✗** 業務目的利用・自動取得・再配布を禁止（株探は検索結果要約ベース、規約ページ 403） | ✗ | – | info.kabutan.jp/terms-site/ ・ info.minkabu.jp/terms/ | **D** |
| 東洋経済オンライン | https://toyokeizai.net/list/feed/rss | 200 / 09-28 | ○/○/–/○ | – | **✗** 営利目的の利用・クローラ収集を禁止 | ✗ | – | https://toyokeizai.net/list/base-terms | **D** |
| ダイヤモンド・オンライン | https://diamond.jp/list/feed/rss/dol | 200 / 09-28 | ○/○/○/○ | – | **✗** スクレイピング収集・生成 AI への利用を禁止 | ✗ | – | https://www.diamond.co.jp/tos/dol.html | **D** |
| ITmedia（NEWS / ビジネス / EE Times Japan / MONOist） | https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml ・ eetimes.xml ・ monoist.xml（`business_articles.xml` は HTML） | 200 / 09-28 | ○/○/○/○ | 11 | 出典表示・改変禁止。**ニュースアプリ等への組み込みは許諾制（相談窓口あり）** | 許諾制 | 拒否なし | https://corp.itmedia.co.jp/media/rss_condition/ | **C**（相談で B） |
| 日経クロステック | https://xtech.nikkei.com/rss/index.rdf | 200 / 09-28 / 101件 | ○/–/–/– | – | RSS 条件の明記なし（日経 BP 規約・要確認） | 要確認 | AI ボット拒否 | – | C |
| 日刊工業新聞 | https://www.nikkan.co.jp/rss/nksrdf.rdf | 200 / 09-28 | ○/–/–/○ | – | 自サイト掲載は事前連絡＋出典明記が条件、プログラムでの再配信は禁止 | 条件付き/✗/✗ | AI ボット拒否 | https://www.nikkan.co.jp/pages/rss | C（連絡） |
| **PR TIMES** | https://prtimes.jp/index.rdf （企業別 RSS あり） | 200 / 09-28 / 200件保持、24h 192件（週末） | ○/○/○/○（リリース画像） | 192 | **許可なしの営利目的利用は禁止**。報道関係者は報道目的で利用可。権利は投稿企業 | 要相談 | 記載なし | https://prtimes.jp/main/html/kiyaku | **C**（提携・パートナーメディア化できれば A。企業ニュースで最も価値が高い） |
| @Press | https://www.atpress.ne.jp/rss/index.rdf | 200 / **feed に日付なし**（記事ページにはあり） | ×/○/○/○ | – | 会員規約：権利者許諾なき複製・転載・再配布不可（RSS 個別規約は要確認） | 要確認 | 記載なし | https://www.atpress.ne.jp/term_use/ | C |
| レスポンス（自動車） | https://response.jp/rss/index.rdf | 200 / 09-28 / 50件 | ○/○/○/○ | – | 要確認 | 要確認 | – | – | C |
| 4Gamer（ゲーム） | https://www.4gamer.net/rss/index.xml | 200 / 09-28 | ○/○/○/○ | 14 | 無断転載禁止、「商用利用を除き」リンク可→**商用はリンクでも要問い合わせ** | ✗（要問い合わせ） | – | 4gamer.net/rss/rss.shtml | C |
| Game*Spark | https://www.gamespark.jp/rss/index.rdf | 200 / 09-28 | ○/–/–/– | – | 要確認 | 要確認 | – | – | C |
| ファミ通 | RSS 404 | – | – | – | – | – | – | – | 未評価 |
| 流通ニュース（小売） | https://www.ryutsuu.biz/feed | 200 / 09-28 / 50件 | ○/○/○/○ | – | 要確認 | 要確認 | – | – | C |
| WWD JAPAN / 繊研新聞（消費財・アパレル） | wwdjapan.com/feed ・ senken.co.jp/posts/feed.xml | 200 / 09-28 | ○/–/–/– | – | 要確認（繊研は有料媒体） | 要確認 | – | – | C |


## 4. 米国・世界経済（公式）

| source | operator | 国 | category | type | URL | 速度 | tech（2026-09-28） | pub/upd/can/img | lang | ticker | com | hl/full/img | cost | calls/日 | risk | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|
| FRB press | Federal Reserve | US | 金融政策 | RSS | https://www.federalreserve.gov/feeds/press_all.xml | 発表即時 | 200 / 最新 09-25 20:30Z / 20件全て日付 | ○/×/–/○ | en | × | allowed（米連邦 PD） | ○/○/写真注意 | 無料 | 48＋発表時 | 低 | **A** |
| FRB speeches | Federal Reserve | US | 金融政策 | RSS | https://www.federalreserve.gov/feeds/speeches.xml | 即時 | 200 / 09-23 | ○/×/–/– | en | × | allowed（PD） | ○/○/– | 無料 | 24 | 低 | **A** |
| BEA | Bureau of Economic Analysis | US | GDP/PCE | RSS | https://apps.bea.gov/rss/rss.xml | 発表即時（時刻固定） | 200 / 09-24 12:30Z / 48件 | ○/×/–/– | en | × | allowed（PD） | ○/○/– | 無料 | 48＋発表時 | 低 | **A** |
| BLS CPI / 雇用統計 | Bureau of Labor Statistics | US | 指標 | Atom | https://www.bls.gov/feed/cpi.rss ・ /feed/empsit.rss | 発表即時 | 200（UA 明示必須、403 のリスク） | ○/○/–/– | en | × | allowed（PD） | ○/○/– | 無料 | 48＋発表時 | 自動アクセスに厳しめ | **A** |
| SEC 8-K current | SEC | US | 開示（海外企業・ADR・取引先） | Atom | https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom | 常時 | 200（連絡先付き UA 時）/ 最新 09-28 05:28Z。UA なしは 403 | ○/○/○/n/a | en | ○（CIK→ticker） | allowed（PD） | ○/○/– | 無料 | 96 | **10 req/s・UA 宣言必須** | **A** |
| SEC press | SEC | US | 規制 | RSS | https://www.sec.gov/news/pressreleases.rss | 即時 | 200 / 09-23 | ○/×/○/○ | en | × | allowed（PD） | ○/○/– | 無料 | 48 | 同上 | **A** |
| White House news | White House | US | 政策・関税・大統領令 | RSS | https://www.whitehouse.gov/news/feed/ （`/feed/` は 403） | 即時 | 200 / 09-28 01:59Z（エージェント確認） | ○/×/○/○ | en | × | allowed（PD。写真の一部は第三者） | ○/○/写真注意 | 無料 | 96 | URL 変更の前歴 | **A** |
| USTR | USTR | US | 通商・関税 | RSS | https://ustr.gov/rss.xml | 即時 | 200 / 09-28 00:59Z（先頭に 2009 年の固定項目→日付ソート必須） | ○/×/○/× | en | × | allowed（PD） | ○/○/– | 無料 | 96 | 低（既存利用中） | **A** |
| **Federal Register API** | OFR/GPO | US | 関税・輸出規制・制裁・大統領令 | JSON API / RSS | https://www.federalregister.gov/api/v1/documents.json?order=newest （agency 絞り込み RSS も可） | 数時間〜1日（Public Inspection はより早い） | 200 / 09-28 公表分 | ○/–/○/n/a | en | × | allowed（PD、API キー不要と公式明記） | ○/○/– | 無料 | 96 | 低 | **A** |
| State Dept press | US State Dept | US | 外交・制裁 | RSS | https://www.state.gov/rss-feed/press-releases/feed/ | 即時 | 200 / 09-27 16:01Z（全文 content:encoded あり） | ○/×/–/○ | en | × | allowed（PD） | ○/○/– | 無料 | 96 | 低 | **A** |
| DoD news（war.gov） | DoD | US | 軍事 | RSS | https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=10 | 即時 | feed 200 / 09-25。記事ページ（war.gov）は 403 | ○/×/–/– | en | × | allowed（PD） | ○/○/– | 無料 | 48 | ドメイン移行・WAF | B |
| Treasury press | US Treasury | US | 財政・制裁 | HTML | https://home.treasury.gov/news/press-releases （旧 RSS は HTML を返す） | 即時 | HTML 200、RSS なし | –/–/–/– | en | × | allowed（PD） | ○/○/– | 無料 | 48 | HTML 構造変更 | B |
| OFAC recent actions | Treasury/OFAC | US | **制裁** | HTML | https://ofac.treasury.gov/recent-actions （**RSS は 2025-01-31 廃止**、公式告知あり） | 即時 | HTML | –/–/–/– | en | × | allowed（PD） | ○/○/– | 無料 | 48 | HTML 構造変更 | B |
| Commerce BIS | BIS | US | 輸出規制 | HTML | bis.gov（RSS 404）→ **Federal Register の agency=industry-and-security-bureau で代替** | FR 経由は遅い | FR RSS 200 / 09-24 | ○/–/○/– | en | × | allowed（PD） | ○/○/– | 無料 | FR に含む | 低 | B（FR 経由） |
| CFTC | CFTC | US | 規制・COT | RSS | https://www.cftc.gov/RSS/RSSGP/rssgp.xml | 即時 | 200 / 09-24 | ○/–/–/○ | en | × | allowed（PD） | ○/○/– | 無料 | 24 | 低 | B |
| Census indicators | Census | US | 指標 | HTML/API | https://www.census.gov/economic-indicators/ | 発表時 | 構造化エンドポイント未特定 | –/–/–/– | en | × | allowed（PD） | – | 無料 | – | 入口未特定 | C（要調査） |
| EIA press / Today in Energy | EIA | US | エネルギー | RSS | https://www.eia.gov/rss/press_rss.xml ・ /rss/todayinenergy.xml | TIE 平日毎日 | 200 / press 09-09・TIE 09-25 | ○/×/×/○ | en | × | allowed（公式: 政府刊行物は PD） | ○/○/第三者画像注意 | 無料 | 24 | 低 | **A** |
| EIA API v2 | EIA | US | 在庫・価格 | JSON API | https://api.eia.gov/v2/ | 日次〜週次 | 無料キー必須（未登録） | – | en | × | allowed（PD） | – | 無料（キー） | 24 | 登録要 | **A**（データ用途） |
| ECB press | ECB | EU | 金融政策 | RSS | https://www.ecb.europa.eu/rss/press.html | 即時 | 200 / 09-24 | ○/×/○/○ | en | × | 出典明示で転載可の趣旨（条件あり） | ○/条件付き/要確認 | 無料 | 48 | 低 | **A** |
| EC Press Corner | European Commission | EU | 通商・制裁・規制 | RSS | https://ec.europa.eu/commission/presscorner/api/rss?language=en | 即時 | 200 / 09-26 | ○/–/–/○ | en | × | 一般に CC BY 4.0（Decision 2011/833/EU、個別は要確認） | ○/可能性高/写真別 | 無料 | 48 | 低 | **A** |
| Bank of England | BoE | UK | 金融政策 | RSS | https://www.bankofengland.co.uk/rss/news | 即時 | 200 / 09-25 / 50件 | ○/–/–/○ | en | × | 独自ライセンス（OGL 類似） | ○/条件付き/要確認 | 無料 | 24 | 低 | **A** |
| BIS.org 中銀講演 | BIS | 国際 | 金融 | RSS1.0 | https://www.bis.org/doclist/cbspeeches.rss | 日数件 | 200 / 09-24 | ○/–/–/– | en | × | 要確認 | ○/–/– | 無料 | 12 | 低 | B |
| IMF | IMF | 国際 | マクロ | RSS | imf.org の RSS | – | **403**（Akamai） | – | en | × | 要確認 | – | – | 0 | 遮断 | C |

## 5. 地政学・安全保障・災害

| source | operator | 国 | category | type | URL | 速度 | tech | pub/upd/can/img | lang | com | hl/full/img | calls/日 | risk | Tier |
|---|---|---|---|---|---|---|---|---|---|---|---|---:|---|---|
| **GDELT DOC 2.0** | GDELT Project | 国際 | 世界の報道メタデータ（地政学・紛争・事故） | JSON API | https://api.gdeltproject.org/api/v2/doc/doc | 15分更新 | 初回で **429**（5秒に1回制限、共有 IP の影響の可能性）。過去 shadow でタイムアウト | ○/–/○/– | 多言語 | **allowed**（公式: 学術・商用・政府用途で無制限、引用とリンク必須） | メタデータのみ。**見出しと画像は元媒体の権利** | 96〜288（5秒間隔厳守） | 429・タイムアウト | B（早期検知の補助。表示は元媒体の規約に従う） |
| USGS 地震 | USGS | US/世界 | 災害 | GeoJSON/Atom | https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson | 1分更新 | 200 / 24h で 17件 | ○/○/○/n/a | en | allowed（PD） | ○/○/– | 288 | 低 | **A** |
| GDACS | EC JRC / UN OCHA | 国際 | 災害アラート | GeoRSS | https://www.gdacs.org/xml/rss.xml | 随時 | 200 / 09-28 03:19Z / 248件（約760KB） | ○/–/–/× | en | 規約ページ 404・要確認 | ○（見込み）/–/– | 96 | 規約不明・大きい | B |
| NOAA NHC | NOAA | US | ハリケーン | RSS | https://www.nhc.noaa.gov/index-at.xml ・ index-ep.xml | 数時間ごと | 200 / 09-28 05:12Z | ○/–/–/n/a | en | allowed（PD） | ○/○/– | 48 | 低 | **A** |
| IAEA top news | IAEA | 国際 | 原子力（イラン等） | RSS | https://www.iaea.org/feeds/topnews | 週数件 | 200 / 09-25（**日付が年2桁の独自形式**）、記事 403 | △/–/–/– | en | 要確認 | – | 12 | 日付パース | B |
| UN News（全体・トピック） | UN | 国際 | 紛争・人道・経済 | RSS | https://news.un.org/feed/subscribe/en/news/all/rss.xml | 日数十件 | 200 / 09-25〜27（gzip 常時） | ○/–/–/○ | en | **UN サイト規約は personal, non-commercial use** | グレー/×/× | 48 | **規約**（既存 market_macro/shadow で使用中） | C |
| NATO | NATO | 国際 | 安全保障 | HTML | nato.int（旧 RSS 404） | – | RSS なし | – | en | 要確認 | – | 0 | feed なし | C |
| 台湾国防部 PLA 動態 | ROC MND | TW | 台湾周辺 | HTML（主発信は X） | https://www.mnd.gov.tw/en/news/plaact | 毎朝 | 本環境からタイムアウト | – | en/zh | 要確認 | – | 0 | 地域制限の可能性 | C |
| PBOC / 国務院 / MOFCOM 英語版 | 中国政府 | CN | 金融・通商 | HTML | pbc.gov.cn/en ・ english.www.gov.cn ・ english.mofcom.gov.cn | 不定 | HTML のみ、MOFCOM タイムアウト | – | en | 要確認 | – | 0 | 構造化なし | C |
| UKMTO | 英国海軍 | UK | 船舶攻撃アラート | HTML / メール | https://www.ukmto.org/indian-ocean/recent-incidents | 即時 | **403**（先行調査と同じ） | – | en | 要確認 | – | 0 | 機械取得不可 | C（最重要だが取れない） |
| 韓国 JCS | 合同参謀本部 | KR | 北朝鮮ミサイル | – | 未調査 | – | – | – | ko | – | – | – | – | 未評価 |
| MARAD MSCI / NGA 航行警報 / EU NAVFOR Aspides | 米運輸省・NGA・EU | 国際 | 海上安全 | 要調査 | maritime.dot.gov ・ msi.nga.mil | – | **未検証（N2 で要プローブ）** | – | en | 米政府分は PD 見込み | – | – | – | 未評価 |

## 6. 海外報道（総合・経済・地域）

| source | operator | 国 | URL | tech | pub/upd/can/img | 24h件数 | com | hl/full/img | ai | risk | Tier |
|---|---|---|---|---|---|---:|---|---|---|---|---|
| BBC World / Business | BBC | UK | https://feeds.bbci.co.uk/news/world/rss.xml ・ /business/rss.xml | 200 / 09-28 | ○/○/○/○（media:thumbnail あり） | 17 / 11 | **unclear**（RSS ページは Web サイトでの利用を歓迎・表記「BBC News」・ロゴ不可・停止権留保。商用可否は明記なし） | 条件付き/×/× | robots で ClaudeBot/GPTBot 等を拒否 | **既存 headline trigger・shadow で使用中** | C |
| Al Jazeera | Al Jazeera Media Network | QA | https://www.aljazeera.com/xml/rss/all.xml | 200 / 09-28 | ○/○/○/○ | – | **prohibited**（robots.txt・規約: personal, non-commercial。AI・TDM・商用を明示的に禁止、書面許可要） | ×/×/× | **明示禁止** | **既存 headline trigger・shadow で使用中** | D |
| Guardian RSS / Open Platform | Guardian News & Media | UK | https://www.theguardian.com/business/rss ・ content.guardianapis.com | 200 / 09-28 | ○/○/○/○ | 15 | Developer key は非商用（1 call/s、500/日）。**商用は Commercial key（個別見積り）** | 商用キーで可 | 要確認 | 要契約 | C（契約で B） |
| NPR | NPR | US | https://feeds.npr.org/1004/rss.xml | 200 / 09-27 | ○/–/–/– | – | 規約に Content Feeds 節、非商用の可能性高（要確認） | 不明/×/× | – | 規約 | C |
| Deutsche Welle | DW | DE | https://rss.dw.com/rdf/rss-en-all | 200 / 09-28（business feed は 09-23 で停滞） | ○/○/○/○ | – | 規約未発見・要確認 | 不明/×/× | – | 規約 | C |
| France 24 | FMM | FR | https://www.france24.com/en/rss | 200 / 09-28 | ○/–/–/○ | – | 規約ページ 403・要確認 | 不明/×/× | – | 規約 | C |
| SCMP | SCMP | HK | https://www.scmp.com/rss/4/feed ほか | 200 / 09-28 | ○/○/○/○ | 13 | 要確認 | 不明/×/× | – | 規約 | C |
| Nikkei Asia | 日経 | JP | https://asia.nikkei.com/rss/feed/nar | 200。**feed 内に日付なし**（記事に datePublished、有料記事） | ×（feed）/○/○/○ | – | 要確認（日経は通常許諾制） | 不明/×/× | – | 時刻なし・有料 | C |
| Times of Israel | ToI | IL | https://www.timesofisrael.com/feed/ | 200 / 09-28、記事 403 | ○/–/–/– | – | 要確認 | 不明/×/× | – | ボット遮断 | C |
| Kyiv Independent | KI | UA | https://kyivindependent.com/news-archive/rss/ | 200 / 09-28 | ○/○/○/○ | – | 要確認 | 不明/×/× | – | 規約 | C |
| Reuters | Thomson Reuters | 国際 | 公開 RSS なし | – | – | – | 有料ライセンスのみ | – | – | – | D（契約時のみ） |
| AP | AP | US | apnews.com/index.rss → 403 | – | – | – | 有料（AP Media API） | – | – | – | D |
| Bloomberg | Bloomberg | US | feeds.bloomberg.com（非公式 URL） | 200 | ○/–/–/○ | – | 公開許諾なし | ×/×/× | – | 予告なく停止 | D |
| CNBC | Versant（旧 NBCU） | US | search.cnbc.com/rs/…?partnerId=wrss01&id=100727362 | 200 / 09-28 | ○/○/○/○ | 18 | **prohibited**（ToS は personal/non-commercial。本体条項は要再確認） | ×/×/× | robots で AI クローラー拒否 | 規約 | D |
| MarketWatch / WSJ | Dow Jones | US | feeds.content.dowjones.io/public/rss/mw_topstories | 200 / 09-27 | ○/–/–/○ | – | 規約ページ 401・一般に個人非商用 | ×/×/× | – | 規約 | D |
| Financial Times | FT | UK | https://www.ft.com/world?format=rss | 200、記事 403 | ○/–/–/– | – | **prohibited**（robots.txt で ML/AI 目的の利用を明示禁止） | ×/×/× | **明示禁止** | 規約 | D |
| New York Times | NYT | US | rss.nytimes.com | 200 | ○/–/–/○ | – | **prohibited**（公式: 事前の書面許可なき商用利用禁止） | ×/×/× | – | 規約 | D |
| Google News RSS | Google | 国際 | news.google.com/rss/search?… | 200（日本語検索で 102件） | ○/–/×（中継 URL）/× | – | 自動取得・商用再配信の許諾なし（robots も `/` Disallow） | ×/×/× | – | 規約・中継 URL | D |

## 7. 業界専門・企業 newsroom・プレスリリース（海外）

| source | 分野 | URL | tech | pub/upd/can/img | com | 備考 | Tier |
|---|---|---|---|---|---|---|---|
| NVIDIA newsroom | 半導体・AI | https://nvidianews.nvidia.com/releases.xml | 200 / 09-24〜27 | ○/–/○/○ | 企業発表・要確認（一次情報として見出しリンクは低リスク） | 一次情報 | **A候補**（規約確認後 A） |
| Samsung Newsroom | メモリ・端末 | https://news.samsung.com/global/feed | 200 / 50件、**未来時刻（+5h）を観測** | ○/–/–/– | 要確認 | 時刻補正必須 | B |
| OpenAI news | AI | https://openai.com/news/rss.xml | 200 / 09-25 / 1,230件（全履歴） | ○/–/–/403 | 要確認 | 記事ページは 403 | B |
| Google blog | AI・クラウド | https://blog.google/rss/ | 200 / 09-24 | ○/–/–/– | 要確認 | | B |
| Microsoft Source | AI・クラウド | https://news.microsoft.com/source/feed/ （`/feed/` は 2025-05 で停止） | 200 / 09-25 | ○/–/–/– | 要確認 | 静かな停止の実例 | B |
| AMD IR | 半導体 | https://ir.amd.com/news-events/press-releases/rss | 200 / 08-31 | ○/–/–/– | 要確認 | 低頻度 | B |
| Intel / Micron / Broadcom / TSMC IR | 半導体 | 各社 `/rss` | **403**（bot 対策） | – | – | **SEC 8-K（TSMC は 6-K）で代替** | C |
| ASML / Anthropic | 半導体・AI | 推定 URL 404 | 公式 RSS 未発見 | – | – | 要調査 | 未評価 |
| TrendForce（DRAM/NAND 価格） | 半導体 | `/feed/Press_Center.html` は 0件、`/news/feed/` は 07-01 で停止 | RSS 使用不可 | – | 要確認 | `/presscenter/news` HTML か sitemap 監視 | C |
| DigiTimes | 半導体サプライチェーン | https://www.digitimes.com/rss/daily.xml | 200 / 09-28 / 35件 | ○/–/–/○ | 要確認（有料媒体） | 見出しのみ | C |
| EE Times | 半導体 | https://www.eetimes.com/feed/ | 200 / 09-27 | ○/–/–/– | 要確認 | | B |
| Tom's Hardware / The Register / The Verge / Ars Technica | テック | 各 feed | 200 / 09-27〜28 | ○/–/○/○ | 要確認 | 速報性は中 | B |
| TechCrunch | テック・AI | https://techcrunch.com/feed/ | 200 / 09-28 | ○/–/○/○ | RSS 規約: 帰属・リンク必須、改変・広告挿入禁止、停止要求可（リーダー用途想定） | | B |
| SemiAnalysis | 半導体 | newsletter.semianalysis.com/feed | 200 / 09-26 | ○/–/–/– | 本文の多くが有料 | | C |
| OilPrice.com | 原油 | https://oilprice.com/rss/main | 200 / 09-27 | ○/○/○/○ | 要確認 | | B |
| Rigzone | 原油・ガス | https://www.rigzone.com/news/rss/rigzone_latest.aspx | 200 / 09-27 | ○/–/–/– | 要確認 | | B |
| gCaptain | 海運・ホルムズ | https://gcaptain.com/feed/ | 200 / 09-27 | ○/○/○/○（画像は Reuters 素材） | 要確認 | **画像不可** | B |
| Maritime Executive | 海運 | https://maritime-executive.com/articles.rss | 200 / 09-28 / 57件 | ○/○/○/○ | 要確認 | | B |
| Splash247 | 海運 | https://splash247.com/feed/ | 200 / 09-28、記事 403 | ○/–/–/– | 要確認 | | B |
| Hellenic Shipping News | 海運 | https://www.hellenicshippingnews.com/feed/ | 200 / 09-27 | ○/–/–/– | 要確認（転載記事が多い） | | C |
| Defense News / Breaking Defense | 防衛 | defensenews.com/arc/outboundfeeds/rss/ ・ breakingdefense.com/feed/ | 200 / 09-25〜27 | ○/–/○/○ | 要確認 | | B |
| Electrek | EV | https://electrek.co/feed/ | 200 / 09-28 | ○/○/○/○ | 要確認 | | B |
| GamesIndustry.biz | ゲーム | gamesindustry.biz/feed | 200 / 09-25 | ○/–/–/– | 要確認 | | B |
| NHTSA recalls API | 自動車リコール（米） | https://api.nhtsa.gov/recalls/… | 200 JSON | n/a | allowed（米政府データ。公式明記は要確認） | 車種指定型。新着一覧には別データセット要 | **A** |
| PR Newswire | プレスリリース | https://www.prnewswire.com/rss/news-releases-list.rss | 1回目 404・2回目 200 / 20件で約7時間分 | ○/○/○/○ | 要確認 | 応答不安定 | C |
| Business Wire | プレスリリース | feed.businesswire.com/rss/home/?rss=… | 200（項目 0件の回あり） | – | 要確認（ヘルプ 403） | | C |
| GlobeNewswire | プレスリリース | globenewswire.com/RssFeed/… | タイムアウト | – | 要確認 | | C |
| Offshore Technology / Automotive News / Janes / Lloyd's List | 各業界 | 各 feed | 403 / 404 / 500 | – | 有料等 | | D |
| AnandTech | 半導体 | – | 2024 年閉鎖（既知情報・未検証） | – | – | | D |

## 8. ニュース集約 API（有料含む）

| source | 無料枠 | 商用 | 公式価格 | Tier |
|---|---|---|---|---|
| GDELT | 無料（5秒に1回） | allowed（引用・リンク必須） | 無料 | B（§5） |
| GNews | 100 req/日、非商用、12時間遅延 | 有料プランで可 | Essential €49.99/月（1,000/日）、Business €99.99、Enterprise €249.99 | B（低コスト商用候補） |
| NewsAPI.org | Developer は開発のみ・24時間遅延 | Business 以上 | Business $449/月、Advanced $1,749/月 | C |
| newsapi.ai（Event Registry） | 2,000 searches/月 | 無料版は要確認 | 5K plan $90/月 | C |
| NewsData.io | 200 credits/日、12時間遅延 | ブログでは無料も商用可（公式価格ページ未取得・要確認） | Basic $199.99/月（ブログ記載・要確認） | C |
| Marketaux | 100 req/日 | 要確認 | Basic $29/月〜 | C |
| Finnhub company news | 60 calls/分（第三者情報） | 無料は非商用（要確認） | 要確認 | C |
| Alpha Vantage NEWS_SENTIMENT | 25 req/日 | 要確認 | $49.99/月〜 | C |
| Tiingo News | 1,000 req/日 | Business でも internal use のみ | Power $30 / Business $50（要確認） | D（表示不可） |
| Bing News Search API | – | – | **2025-08-11 廃止**（Microsoft 公式） | D |

## 9. 集計

| Tier | 件数 | 主な source |
|---|---:|---|
| A | 26 | 財務省・金融庁・官邸・ESRI・気象庁 XML・EDINET・消費者庁、FRB（2）・BEA・BLS・SEC（2）・White House・USTR・Federal Register・State・EIA（2）・ECB・EC・BoE、USGS・NHC、NHTSA、NVIDIA（A候補：規約確認後） |
| B | 35 | 日銀（商用転載は相談）・防衛省・内閣府・国交省・厚労省・デジタル庁・政府広報・e-Stat、DoD・Treasury/OFAC HTML・CFTC・BIS.org、GDELT・GDACS・IAEA、業界媒体・企業 newsroom、GNews（有料） |
| C | 42 | ITmedia・PR TIMES・@Press・日経クロステック・日刊工業・業界媒体（国内）、JPX RSS、BBC・Guardian・UN News・海外地域紙、有料ニュース API 等 |
| D | 30 | NHK・時事・朝日・毎日・読売・産経・共同・日経・Yahoo!・Google News・株探等・東洋経済・ダイヤモンド、TDnet 閲覧サイト（無料経路）、Al Jazeera・CNBC・NYT・FT・Dow Jones・Reuters・AP・Bloomberg、閉鎖・廃止 API |
| 未評価 | 4 | 韓国 JCS、海上安全系（MARAD/NGA/EU NAVFOR）、ASML/Anthropic、ファミ通 |
| **合計（評価行）** | **137** | 1行に複数媒体をまとめた行があるため、個別媒体数はこれより多い（約160） |

**Tier A の偏り**: A はすべて公式・公的機関か構造化 API。**報道で Tier A は 0 件**。


## 10. 使用中 source の規約リスク（報告のみ。変更していない）

| 使用箇所 | source | 所見 | 推奨（所管側で判断） |
|---|---|---|---|
| headline trigger（本番）・important-news-shadow | Al Jazeera | robots.txt と規約で personal, non-commercial、AI・TDM・商用の禁止を明記。書面許可が必要 | 許諾取得か、別 source への置き換えを cost-optimization 側で検討 |
| headline trigger（本番）・shadow | BBC World | 商用可否が明記なし、AI クローラーを robots で拒否 | BBC への確認 |
| market_macro（本番）・shadow | 日本銀行 whatsnew RSS | 独自規約で「商用目的の転載・複製は事前相談」 | 日銀へ相談（トリガー用途と見出し表示を分けて確認） |
| TDnet レーン（本番） | TDnet 閲覧サイト | robots.txt `Disallow: /`、無料の許可ルートなし（先行調査で既出） | 有料 TDnet API（基本料 ¥70,000/月〜、再配信可）の検討 |
| market_macro（本番）・shadow | UN News Peace & Security | UN サイト規約は personal, non-commercial use | 利用範囲の確認（公的機関の発表として見出しリンクのみに留める等） |
| shadow | GDELT | 商用可。ただし 429（5 秒に 1 回）とタイムアウト | 間隔制御 |
| 未接続の提案ファイル | 財務省・官邸・JPX RSS（404）、防衛省 press RSS（403） | URL が現存しない | 接続前に再調査 |
| personalized-reports（MIC 設計書の追記による） | Yahoo Finance 非公式 chart API | Yahoo 規約は書面許可のない商用利用を禁止 | 別途判断 |

## 11. 出典（主な公式ページ）

- 米連邦著作物: 17 U.S.C. §105。EIA: https://www.eia.gov/about/copyrights_reuse.php
- Federal Register API: https://www.federalregister.gov/developers/documentation/api/v1
- OFAC RSS 廃止告知: https://ofac.treasury.gov/recent-actions/20250206
- SEC アクセス条件: https://www.sec.gov/os/accessing-edgar-data（本調査時はページ 403、既知ルールとして記載）
- 公共データ利用規約（PDL1.0）解説（デジタル庁）: https://www.digital.go.jp/assets/contents/node/basic_page/field_ref_resources/f7fde41d-ffca-4b2a-9b25-94b8a701a037/b44a7e0c/20240705_resources_data_outline_07.pdf
- 日銀: https://www.boj.or.jp/about/copyright.htm ／ JPX: https://www.jpx.co.jp/term-of-use/index.html ／ TDnet API: https://www.jpx.co.jp/markets/paid-info-listing/tdnet/02.html ／ EDINET: https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0030.html ／ 気象庁: https://www.jma.go.jp/jma/kishou/info/coment.html
- NHK: https://www.nhk.or.jp/toppage/rss/index.html ／ 時事: https://www.jiji.com/policy/rss.html ／ 朝日: https://www.asahi.com/information/service/rss.html ／ 毎日: https://mainichi.jp/rss/ ／ Yahoo!ニュース: https://news.yahoo.co.jp/rss ／ Google ニュース: https://www.google.com/intl/ja_jp/terms_google_news.html ／ 東洋経済: https://toyokeizai.net/list/base-terms ／ ダイヤモンド: https://www.diamond.co.jp/tos/dol.html ／ ITmedia: https://corp.itmedia.co.jp/media/rss_condition/ ／ 日刊工業: https://www.nikkan.co.jp/pages/rss ／ PR TIMES: https://prtimes.jp/main/html/kiyaku ／ @Press: https://www.atpress.ne.jp/term_use/
- ECB: https://www.ecb.europa.eu/services/disclaimer/html/index.en.html ／ BoE: https://www.bankofengland.co.uk/legal ／ EC: commission.europa.eu/legal-notice
- IEA: https://www.iea.org/terms ／ UN: https://www.un.org/en/about-us/terms-of-use
- BBC RSS: https://www.bbc.co.uk/news/10628494 ／ Al Jazeera: https://www.aljazeera.com/terms-and-conditions ＋ robots.txt
- Guardian: https://open-platform.theguardian.com/access/ ／ NYT: https://www.nytimes.com/rss ／ TechCrunch: techcrunch.com/rss-terms-of-use
- GDELT: https://www.gdeltproject.org/about.html
- NewsAPI: https://newsapi.org/pricing ／ GNews: https://gnews.io/pricing ／ newsapi.ai: https://newsapi.ai/plans ／ Marketaux: https://www.marketaux.com/pricing ／ Alpha Vantage: https://www.alphavantage.co/premium/ ／ Tiingo: https://www.tiingo.com/about/pricing
- Bing 廃止: https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- 第三者・ブログ情報に依拠: Finnhub 無料枠、NewsData 価格、Tiingo 価格の一部。
