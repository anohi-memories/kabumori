# ニュース取得強化 N1 — 低コスト・高 Recall ニュース取得網の棚卸し

- 作成: 2026-09-28（G1〜G4 外の直接作業。調査・設計のみ）
- production・DB・Cron・Edge Function・既存 `important-news-monitor` / `important-news-shadow` / `docs/news-cost-optimization/` は**変更していない**。

## 文書

| ファイル | 内容 |
|---|---|
| [news_source_catalog.md](news_source_catalog.md) | source 一覧（評価行 137、Tier A 26 / B 35 / C 42 / D 30 / 未評価 4）と規約評価 |
| [news_acquisition_architecture.md](news_acquisition_architecture.md) | 無料 feed 主体の取得アーキテクチャ、Web Search の限定利用、95% 目標の評価 |
| [company_news_non_ir_design.md](company_news_non_ir_design.md) | IR 以外の企業ニュース取得と alias 辞書による銘柄紐付け |
| [market_anomaly_news_trigger.md](market_anomaly_news_trigger.md) | 市場異常 → ニュース逆引き |
| [news_recall_benchmark.md](news_recall_benchmark.md) | ChatGPT 広域監視との比較検証方法（実データは含まない） |
| [news_cost_estimate.md](news_cost_estimate.md) | HTTP / AI / Web Search の概算コスト |

## 主要所見

1. **無料で規約上安全に使えるのは公式・公的機関と GDELT だけ**。報道で Tier A は 0 件。国内大手報道（NHK・時事・朝日・毎日・Yahoo!・Google News・東洋経済・ダイヤモンド・株探等）は公式規約で個人利用限定／営利利用禁止。
2. 無料・規約適合の経路は「公的機関が発表する事象」に強く、「報道が最初に伝える事象」（戦争・事故・海上攻撃・国内一般・企業不祥事）に弱い。**無料経路だけで 95% は現実的でない**見立て（ベンチマークで測定する）。
3. 本番で使用中の source にも規約リスク（Al Jazeera=D、BBC=C、UN News=C、日銀=商用転載は事前相談、TDnet 閲覧サイト=robots 全拒否）。**報告のみ。変更していない**。
4. 市場異常トリガーに使える 1〜15 分足の無料・商用可データは見つからない。無料は日次のみ。日中は「ニュース量急増」シグナルか、有料の ETF 代替データ。
5. 未接続の提案ファイル `news_collection_scope_proposal.ts` の財務省・官邸・JPX RSS は 404（正しい URL は catalog に記載）。

## N2 推薦（優先順）

1. **N2-a: 無料 Tier A source の shadow 取得器＋記事プール**（新規 Function・新規テーブル、既存 monitor 非接続、投稿・通知なし）。対象: 財務省・金融庁・官邸・ESRI・消費者庁・気象庁 XML（電文種別 filter）・EDINET、FRB・BEA・BLS・SEC 8-K・White House・State・USTR・Federal Register・EIA・ECB・EC・BoE・USGS・NHC、GDELT（5 秒間隔厳守）。`fetched_at` 必須。
2. **N2-b: event 台帳でのベンチマーク開始**（ChatGPT ログはユーザーが保存、2 週間）。分野別に「無料 Tier A＋GDELT でどれだけ取れるか」を実測。
3. **N2-c: alias 辞書 v0**（stocks_master＋EDINET コードリスト＋Wikidata、保有・ウォッチ上位 100 銘柄のブランド/子会社を手作業）。source と独立して作れる。
4. **N2-d（ユーザー判断）: 許諾・契約の打診**。優先度順に PR TIMES（企業ニュース）、時事または共同（国内速報）、日銀（見出し表示）、ITmedia、BBC。TDnet API の要否も併せて。
5. **N2-e: 既存 source の規約リスク対応の検討**（Al Jazeera / BBC / UN News / 日銀 / TDnet）。**既存 monitor・shadow 所管のため、cost-optimization 側と合意のうえ別タスク**。
6. 市場異常トリガーの有料データ契約は、N2-b の結果で「日中の穴」が大きいと分かってから判断。
