# 国内一般重大ニュース＋金融ニュース網羅強化 Phase J0（監査・設計・オフライン評価）

- 作成: 2026-10-12 JST（G8 / ニュース改善A）
- 範囲: Phase J0 のみ。**コード変更なし（本番経路へのimport・DB・Edge・Cron・Secrets変更なし）**。追加物は本書、`tools/jp-news-coverage/`（オフライン評価ハーネス、本番に未接続）、本番read-only集計SQL（未実行）のみ。
- 先行設計: `docs/news-coverage/REDESIGN.md`、`docs/news-sources/news_acquisition_architecture.md`・`news_recall_benchmark.md`・`news_source_catalog.md`・`n3_*`。**本書はこれらを置き換えず、現在のmain（2026-10-12）との差分と次段の最小実装計画だけを定める。**

## 0. 検証状態（先に読む）

| 項目 | 状態 |
|---|---|
| 本番DBの集計（7/14日funnel、遅延p50/p90） | **NOT_VERIFIED（未実行）**。auto modeが本番readを `[Production Reads]` で拒否した。再試行・迂回はしていない。集計SQLを作成しローカルPostgresで構文・集計動作のみ検証済み。ユーザー実行用: `tools/jp-news-coverage/run_j0_funnel.sh`（結果は1つのjson、ID/URL/タイトル/ユーザー情報を含まない） |
| ChatGPT提示の数値（signals 173 / jp_official 11 / 公開2 / TDnet公開86 / candidates 943 / X公開146 / app_title_ja 20 / Push 79） | **reported_unverified**（本書では再計算していない。funnelの母集団が異なる点だけをコードから整理） |
| `IMPORTANT_NEWS_JP_OFFICIAL_LANE` の本番現在値 | **確証なし**。値はEdgeの環境で、リポジトリからは読めない。後述の通り「候補行の有無」以外にDBへ残らない |
| アプリ実機表示 | `NOT_VERIFIED_ON_DEVICE`。可視性はSQL/クライアントの静的読解のみ |
| 利用規約・権利 | 先行docsの記載（主に2026-09-28）を転記。**本日の再確認なし**。実装・常時巡回の根拠にする前に再確認が必要 |

## 1. 現状（mainのコード）と先行設計の差

### 1.1 取得レーン（コード確認）

| レーン | 取得元 | 国内一般/金融への関与 | 状態 |
|---|---|---|---|
| tdnet / company_ir | TDnet一覧HTML＋PDF、登録企業IR | 国内企業の適時開示（IR前の不祥事・事故は対象外） | 本番稼働 |
| market_macro | 公式RSS: 日銀・FRB・USTR・UN平和安全・EIA・JMA eqvol | 日銀、気象庁地震 | 本番稼働（日銀は商用転載「事前相談」規約: CAT§10） |
| **jp_official** | `news_discovery_signals` を**SELECTのみ**（再取得しない） | 財務省・金融庁・首相官邸・消費者庁・気象庁特別警報 | フラグ `IMPORTANT_NEWS_JP_OFFICIAL_LANE=enabled` の時だけ。値は未確認 |
| breaking_market | OpenAI web_search（1日4スロット: 災害・安全保障/日銀/日本市場急変/為替介入・財務省）、1fetch 1検索、候補15/fetch、鮮度3h | 空白の限定補完 | 本番稼働（要 OPENAI_API_KEY） |
| headline trigger | BBC World / Al Jazeera 見出し→Luna triage→検証 | 国内ではない | 本番稼働（権利リスク: §4.3） |
| news_discovery observer | 公式RSS/API→`news_discovery_signals`（観測専用） | jp_* 8系統（下表） | 稼働（コード内コメントは古い。cron/deployは本書では未確認） |
| shadow | 11feed評価専用 | — | 評価専用 |

### 1.2 jp_official レーンの実装事実

- 読み出し: `policy=DIRECT_SOURCE`・`discovery_only=false`・`restricted_publisher=false`・`title_display_allowed=true`・`fetched_at >= now-50h`・enabledなsourceのみ・READ_LIMIT 200。候補化は **news_discoveryのうちこのレーンのみ**。他のsignal（米欧等）はcandidate化の経路がない。
- 鮮度 48h、1fetchの挿入上限 6（`MAX_JP_OFFICIAL_CANDIDATES_PER_FETCH`）、ソース間ラウンドロビン、時間予算25秒。enrich失敗はスロットを使わない。本文は公式ページ40〜700字（8s/redirect 3/400KB/ドメイン固定）。
- テーマfilterは **デフォルトDROP**（`no_matching_theme`）。HARD_ROUTINE（人事・採用・公募・入札・講演・啓発・表彰 等）→ソース別routine→ソース別allow→SOFT_ROUTINE の順。
- 候補は `source_name=jp_official`、`entity_key=jp_official:{source}:{30分bucket}`、`company_code=null`（市場全体扱い）。

| source_id | feed（registry） | 候補化 | 備考 |
|---|---|---|---|
| jp_mof_news | mof.go.jp/news.rss | ON | 為替介入・予備費・税制・制裁・国債計画・G7/G20 |
| jp_fsa_news | fsa.go.jp/fsaNewsListAll_rss2.xml | ON | 行政処分・災害金融措置・組織再編・府令・システム障害 |
| jp_kantei_news | kantei.go.jp/index-jnews.rdf | ON | 経済財政諮問会議・月例経済報告・ミサイル・首脳会談・閣議 |
| jp_caa_news | caa.go.jp/news.rss | ON | 重大製品事故・措置命令 |
| jp_jma_extra | data.jma.go.jp extra.xml | ON | 特別警報のみ。XML電文のため本文はfeedの短文 |
| jp_esri | esri.cao.go.jp/rss-jp.xml | **OFF** | リンクが統計メニューでタイトルに数値なし |
| jp_jma_eqvol | data.jma.go.jp eqvol.xml | **OFF** | market_macroが同feedを取得済み（重複回避） |
| jp_edinet_documents | EDINET API | 取得OFF | APIキー未登録 |

### 1.3 観測可能性の穴（J1の前提）

1. **レーンON/OFFがDBに残らない**。診断JSON `jpOfficial{enabled, signalsRead, selected, alreadyKnown, inserted, deferred, enrichedPages, skipped{}, drops{}, results[]}` はHTTPレスポンスのみで、`important_news_monitor_runs.diagnostics`（`collectionDiagnostics`）には含まれない（`news_collection_diagnostics.ts` に該当なし）。run行には `fetched_count += selected` 等の加算だけが入る。→ J1 で `jpOfficial` の `enabled / signalsRead / selected / drops` をrun diagnosticsへ書く最小変更が必要（設計は§6）。
2. `drops` の理由別カウントは同じくレスポンスのみ。7日分の「なぜ落ちたか」は事後に再構成できない。
3. `source→signal→candidate` はURL/正規化タイトルでしか結べず、signal側に `candidate_id` がない。

### 1.4 先行設計との差（表）

| 先行設計の主張 | 現在のmain | 差 |
|---|---|---|
| REDESIGN: 公式RSS+8（気象庁2・防衛省・財務省・JPX・首相官邸・米財務省・BIS）を追加 | 財務省・金融庁・首相官邸・消費者庁・気象庁がobserver→jp_officialで稼働。JPX/防衛省は未接続 | 一部実装。防衛省press RSSは403、JPX RSSは規約で不可 |
| REDESIGN: 5段階severity・16カテゴリ・通知プリセット（quiet〜all_useful） | `coverage_severity`・`coverage_categories`・`alert_settings.notification_preset` が実装済み。市場全体フィードの `all_useful` ブランチあり | 実装済み。TS側の通知適格関数は未配線の記述あり（SQLが正本） |
| ARCH: 発見の主役を定点巡回に、Web Searchは補完 | breaking_marketは1日4検索の最小運用。jp_officialは**signal→candidateの唯一の橋** | 方針どおりだが、橋は国内公式5系統のみ |
| BENCH: 実測値は文書にない | 本書もサーバ実測は未実施（§0）。ハーネスはオフライン | 同じ |
| CAT: Al Jazeera=D（AI/TDM明示禁止）、BBC=C | headline triggerは両方を見出し入力に使用（コード上primary登録） | **未解消の権利リスク**（先行docsも「報告のみ」） |

## 2. アプリまでのfunnel（コードに基づく到達条件）

「取得数・X公開数・アプリ表示数・Push」は別母集団。以下が各段のゲート。

| 段 | ゲート（コード上の定義） | 通過しない時の `miss_reason` |
|---|---|---|
| source | registryにenabled源があるか | `no_source` |
| rights | `commercial_usage_status`/`policy`/`title_display_allowed` | `terms_excluded` |
| signal→candidate | jp_official: 5源・48h・テーマallow・6件/fetch・時間予算・同一事象/重複 | `filtered_rule` / `no_candidate` / `duplicate_event` |
| judgement | 判定→`rejected`(no_post) か `ready_for_generation`。Fact未通過はno_post強制 | `judgement_rejected` |
| generation | Fact+Voiceがpassedで `ready_for_publish`、さもなくば `generation_failed` | `generation_failed` |
| X公開 | `published`（X投稿基準） | — |
| **アプリ一覧** | 下記 | `app_display_gate` |
| Push | Fact通過の日本語文＋通知プリセット/emergency設定 | `push_policy` |

### 2.1 アプリ一覧の条件（`get_my_important_stock_news` = wrapper + `_phase5_base`、最新定義）

共通: `duplicate_of is null`、statusが `rejected / ready_for_generation / generating / ready_for_publish / generation_failed / publishing / publish_failed / published` のいずれか（`pending_judgement` は不可視）。severityは `coalesce(coverage_severity, important_news_app_severity(...))` が `emergency/critical/high/medium`（lowは不可視）。

| 経路 | 対象 | rejected（no_post）の扱い |
|---|---|---|
| company_feed | 追跡銘柄の `company_code` | tdnet/company_ir のみ可視 |
| base `market_feed` | `company_code is null`、severity medium以上、**追跡銘柄のsectorが事象のテーマsectorに一致**（emergencyはsector不要）。`tracking_type` は `holding`/`watch` | **除外条件なし**＝rejectedでもseverity≥mediumなら可視 |
| wrapper `broad_feed` | `alert_settings.notification_preset='all_useful'` のユーザー全員、severity critical/high/medium | tdnet/company_irのみ可視（market_macro/jp_officialのrejectedは不可視） |

- 日本語app_copy（`app_copy_fact_status='passed'`）の有無は**可視性の条件ではない**。表示の優先順は 検証済み投稿文 → app_copy → 開示本文 → 日本語本文 → 原題+原文抜粋（`news-presentation.ts`）。jp_officialは日本語タイトル/本文なので通常「日本語本文」で表示される。→ **「日本語app_copyが無い＝表示ゼロ」ではない**。
- ホームは `SECTION_LIMIT=3`：`tracking_type='market'` 3件と `'holding'` 3件（`'watch'` はホームに入らない。`market` は all_useful のみ→非all_usefulユーザーの市場セクションは通常空、sector一致の市場ニュースは `holding` 欄に入る）。一覧RPCは最大50件。
- 一方で `base market_feed` は rejected を含むため、jp_officialのno_postでも、severityがmedium以上に評価され追跡銘柄とテーマsectorが合えば表示され得る。**severity評価はjudgement（`deriveNewsSeverity`: 市場全体は japanMarketRelevance≥medium 等）とcollection分類に依存**する。これは意図か不整合か未確認（wrapperは同条件を明示除外しており、base側だけが非対称）。

### 2.2 「JP公式173→11→2」の読み方（原因別、数値は未検証）

173（signals, `jp_%`, 7日）と11（`jp_official` candidates）と2（公開）は**同じ記事の追跡ではない**。コードから確定できる差の要因:

1. **母集団**: signalsは `jp_%` 全系統（esri・jma_eqvol・edinet・routine大量を含む）。レーンは enabled な5系統のみ読む。JMA extra等は観測側で大半が落ちる（コード注記: 1日約1,700電文を観測側で除去）。
2. **決定的フィルタ**: HARD_ROUTINE / `no_matching_theme`（デフォルトDROP）/ SOFT_ROUTINE / 未来・古い・URL不正・非HTMLリンク（pdf/xml等）。
3. **容量**: 48h窓、READ_LIMIT 200、6挿入/fetch、25秒予算、enrich失敗/本文なし（`no_body`）。
4. **重複**: 同一ソース・同一正規化タイトル30分、既存候補とのURL/タイトル/ハッシュ一致。
5. **判定**: no_postは `rejected`（X公開は importance>no_post のみ）。公開2は**X投稿基準**の結果で、アプリ一覧の到達とは別。
6. **アプリ**: 上記2.1。

実測の原因別内訳は §7 の集計SQLで得られる（`jp_signals_by_source` / `jp_signals_url_matched_to_candidate` / `jp_official_candidates` / `app_market_feed_eligibility_proxy`）。URL一致は近似で、タイトル・event単位の完全対応は取れない（signalにcandidate_idが無い）→ NULL/不可として扱う。

## 3. ソースと権利（J1候補の選別）

**ルール**: 商用利用・機械取得・AI入力・表示/引用を独立に確認する。「公開RSSだからOK」としない。不明は `unknown`。以下は先行docs（CAT、2026-09-28）の転記で、**本日の規約再確認は未実施**。実装前に再確認する。

### 3.1 Tier A（無料・PDL1.0/米連邦PD。出典明記で商用可）— 国内

| 機関 | 状態 | 備考 |
|---|---|---|
| 財務省 / 金融庁 / 首相官邸 / 消費者庁 | **稼働中**（jp_official） | PDL。ロゴ・第三者著作物除く |
| 気象庁（防災XML） | 稼働中（特別警報）/ eqvol=market_macro | 気象業務法: 警報の独自発表禁止（出典付きの中継のみ）。2026-11-04 UTF-8統一予定 |
| 内閣府ESRI | 取得は可能だがレーンOFF（リンクがメニュー頁） | 本文取得の別設計が必要 |
| EDINET API v2 | 未稼働（キー未登録） | 提出書類自体の権利は要確認、短時間大量アクセス停止対象 |

### 3.2 Tier B（条件整理が必要）/ 未評価 / 不可

| 機関・源 | 状態（CAT記載） | J0判断 |
|---|---|---|
| 日銀 | 商用目的の転載・複製は**事前相談**。既存market_macroで使用中。本文は未取得 | 本文接続禁止を維持。見出しトリガー用途の整理は別途 |
| 防衛省 news.xml | 要確認、`press.xml`は403、ミサイル速報の代替不可、更新日次2回 | 速報用途に不適。Tier B |
| 国交省・厚労省・デジタル庁・e-Stat | Tier B（厚労省は未来日付など品質問題、e-Statはクレジット表示） | 候補。feed実在・遅延を個別プローブしてから |
| 経産省 | Atom（約3か月更新停止の記載）。PDL確認済み | 候補（更新が回復していれば） |
| 公正取引委員会 / 警察庁 / 消防庁 / 外務省 / 地方自治体 / 企業newsroom | **CATに評価なし（外務省はWAFで403の記載）**。実在するfeed/APIは**仮定しない**＝`unknown` | J1のプローブ対象（実在・利用条件・更新遅延を一次確認） |
| JPX RSS | 規約で商用データ収集・二次利用・再配信不可 | 不可 |
| TDnet閲覧サイト | robots `Disallow: /`、無料の許可ルートなし。有料TDnet API（基本料¥70,000/月＋情報料、再配信可と記載） | 既存TDnetレーンは別論点（先行docsは「報告のみ」）。有料契約は未承認 |
| 国内報道（NHK・時事・朝日・毎日・Yahoo!・東洋経済・ダイヤモンド・株探 等） | **公式規約で個人利用限定/営利・自動取得・生成AI利用禁止**、または公開RSSなし/403 | **使用禁止**。`internal_trigger_only` でも規約違反なら不可 |
| PR TIMES / @Press / ITmedia 等の配信 | 営利利用は許諾が必要（Tier C） | 契約・提携の打診が必要（ユーザー判断） |
| GDELT DOC 2.0 | メタデータは商用可（引用・リンク必須）。見出し・画像は元媒体の権利。5秒/回、429多発 | 発見シグナルのみ。元記事の転載権は別（現registryは `discovery_only` で表示不可） |

### 3.3 使えない/使わない根拠の整理

- 重大事件・企業不祥事・事故の**初報は公的情報では遅い**（警察・消防・企業広報が先に出さない/出ない/feedがない）。これを埋められるのは報道だが、国内主要報道は**機械取得・AI入力・表示のいずれも許諾なし**（CAT§Tier D）。→ 現時点で「合法かつ無料」の初報源は構造的に存在しない。
- 埋める道は3つ: (a) 有料配信の契約・許諾（Tier C、費用・承認が必要）、(b) 公的一次情報の網羅拡大（警察・消防・公取委・自治体の実在feedを個別確認）、(c) 限定Web Search（§5、空白eventのみ）。
- 無断転載・スクレイピングで埋めない。

### 3.4 現在使用中のソースの権利リスク（報告のみ・変更なし）

headline trigger（Al Jazeera=D/AI・TDM明示禁止、BBC=C/商用可否不明・robotsでAIクローラ拒否）、market_macroのUN News（C）と日銀（商用転載は事前相談）、TDnetレーン（robots全拒否）。J0では変更しない。ユーザー判断が必要（§8）。

## 4. 一般速報の設計方針（J1以降の要件）

1. **event単位統合**: `(主体・行為・対象・時刻)` → event_id。出典URL・検証状態（`primary_confirmed / multi_source / single_source / rumor / retracted / old_republish`）を保持。
2. **誤情報の扱い**: 未確認の犯罪疑惑・噂・告発を事実として断定しない。`single_source/rumor` はアプリ一覧に「報道段階」ラベルを付けても、Fact確認なしの断定文は生成しない。訂正・取消（retracted）は既掲載を下げる経路を要件とする。
3. **X基準とアプリ基準を分離**: Xは importance、アプリは「見逃せないか」（severity≥medium＋確認済み）。Pushは現仕様（emergency/critical＋Fact通過＋ユーザー設定）を**緩めない**。
4. **本文・画像を無断複製しない**。外部AIへ送るのは権利確認済みの短い一次情報のみ。

## 5. 限定Web Search補完の次段案（実装・課金なし）

- 発火: 空白eventのみ（事故・訴訟・不祥事・戦争初報・金融インフラ障害・急な市場変動）で、**公的一次情報に当該eventが無い**ときだけ。
- 抑制: 同一event/テーマのクールダウン、日次上限（既存N3設計: soft 30 / hard 48回、実装前に現行4スロット/日運用に合わせて再設定）、予算超過・重複でskip。
- 誤Fact guard: 検索結果は発見シグナルのみ。公表情報は一次情報URLで確認できるまで「未確認」。
- 費用: 1回約$0.013（先行docsの推定）。J0では**実呼出なし・予算未承認**。

## 6. Phase J1 実装計画（3本・競合しない順）

| 順 | 内容 | 対象ファイル | 必要承認 | テスト | 費用ガード |
|---|---|---|---|---|---|
| **J1-a** | **観測性**: jp_officialの診断（enabled / signalsRead / selected / drops / skipped）を `important_news_monitor_runs.diagnostics` に追加。DB変更なし（jsonbの既存列） | `important-news-monitor/index.ts`、`news_collection_diagnostics.ts` と各test | ちゃ判断（本番deployは別承認） | 診断形のtest、既存important-news-monitor suite | なし（AI呼出不変） |
| **J1-b** | **アプリ一覧の表示判定改善**: (1) base `market_feed` の rejected 非対称の方針決定（意図なら明文化、不整合ならwrapperと揃える）、(2) 国内一般ニュースのseverity評価（確認済み＋日本関連）を別軸化、(3) 一覧件数・ホーム上限の見直し案 | `supabase/migrations/*`（新規migration）、`src/lib/*`、SQLテスト | **DB migration＝別承認・Preview適用必須** | ローカルPG proof（`supabase/tests`）、既存RPCの回帰、実機/Simulator確認 | なし |
| **J1-c** | **権利OKの国内公的信号をshadowで追加**: 公取委・警察庁・消防庁・国交省・厚労省・経産省・防衛省・自治体の実在feedを個別プローブ（URL・更新遅延・利用条件）→ registry追加（`enabled_for_n2`）、jp_officialには**接続しない**（観測のみ）。利用条件が不明なら追加しない | `_shared/news_discovery/source_registry.ts`、observer test、docs | feed/API実在と規約の再確認、ちゃ承認 | registry検証、fetcher mock、解析fixture | 追加は観測のみ・AI呼出なし |
| J1-d（任意・要予算承認） | 空白eventだけの限定Web Search（§5） | breaking_market周辺 | **ユーザーの予算承認** | 発火条件・抑制のtest | 日次上限・クールダウン |

順序の理由: J1-aは副作用なしで以後の測定基盤、J1-bは表示（到達）、J1-cは網羅（取得）。J1-cとJ1-bは別ファイル群で競合しないが、効果測定はJ1-a後。

## 7. オフライン品質ベンチマーク（実装済み）

- 場所: `tools/jp-news-coverage/`（`fixtures.ts` 架空16件、`classify.ts`、`classify_test.ts`）。本番経路・DB・外部API・第三者本文なし。実行: `deno test --no-config --no-lock --allow-read tools/jp-news-coverage/classify_test.ts`（6件PASS）。
- 4軸を別判定: `discovered / relevant / eligible_for_app / urgent_push`。
- 失敗要因: `no_source, terms_excluded, filtered_rule, no_candidate, judgement_rejected, generation_failed, app_display_gate, push_policy, duplicate_event, unknown`。
- 列定義（event台帳）: `event_id, group, first_public_at, fetched_at, judgement_at, display_eligible_at, miss_reason, source_kind, rights_ok, verification, locality, severity`。取得できない時刻は `NOT_AVAILABLE`（推測で埋めない）。
- 指標: event単位Recall、アプリ到達率（発見済みのうちeligible）、遅延p50/p90（first_public→display_eligible、3時刻が揃うものだけ）。
- fixtures: 企業不祥事2・事件事故2・金融規制/破綻2・日銀2・地震/ミサイル2・行政処分/訴訟2・負例4（旧ニュース再掲/海外のみ/噂/取消）。

ハーネス上の例（合成値であり実測ではない）: 正解集合10件のうち発見6件（recall 0.6）、miss reasonは `no_source:3 / terms_excluded:1`。これは**モデル検証用**で、本番の成績ではない。

実測の取得: `tools/jp-news-coverage/run_j0_funnel.sh`（ユーザー実行・read-only集計）。得られるもの: 7日のsource×status×importance、JST日別、`jp_%` signalsのsource別件数とURL一致数、jp_official候補のstatus×severity×app_copy、アプリ市場フィード到達の代理（severity/可視status/市場全体）、source別の遅延p50/p90、Push送信数。期間は7日固定（14日・平日/祝日の別集計は、窓を `interval '14 days'` に変えて同一SQLを再実行し、JST日別で10/12祝日を分離）。

## 8. 未解決・要承認

1. 本番read-only集計の実行（ユーザー、上記スクリプト）と、結果を受けたgap原因の確定。
2. `IMPORTANT_NEWS_JP_OFFICIAL_LANE` の本番値の確認（Edge環境の読み出しが必要。J1-aでDBに残す）。
3. headline triggerのAl Jazeera/BBC利用、日銀見出し・UN Newsの扱い（権利リスクの方針決定）。
4. base `market_feed` が rejected を含む設計の意図確認（J1-b）。
5. 有料配信（PR TIMES・時事/共同・TDnet API・GNews等）の契約検討と費用承認。
6. 限定Web Searchの予算（J1-d）。
7. 公取委・警察庁・消防庁・外務省・自治体のfeed実在と規約の一次確認（J1-c）。

## 9. 先行設計との矛盾メモ

- REDESIGNの提案RSS（財務省・官邸・JPX・防衛省）の一部はCAT/ARCHで404/403（正しいURLは財務省 `news.rss`、官邸 `index-jnews.rdf`）。現行registryは正URL。
- ARCHはNHKを巡回例に挙げるが、CATではD（不可）。
- Web Search上限は COST(5〜40/日) と N3(soft30/hard48) で不一致。現行は1日4スロット運用で、いずれの上限にも達していない。
- observerのコメント「NOT connected to important-news-monitor」は、jp_officialレーンが読んでいるため古い。
- registry注記は「jp_jma_extraは特別警報のみ」だが、observer側filterは記録的短時間大雨・土砂災害警戒情報・竜巻注意情報も保持する（最終的にjp_official側が `特別警報` のみに絞る）。
