# Claude Task 1

- task_id: broad-market-news-collection-and-user-notification-control-20260912
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus 5
- purpose: かぶモリのニュース監視を「収集段階ではChatGPTの1時間監視に近い広さで拾い、通知するかどうかはユーザー設定で決める」設計へ見直す。北朝鮮ミサイル発射やホルムズ海峡周辺の攻撃のような、日本市場へ影響し得る重大事象を収集段階で落とさない。

## Product direction

現在の問題は「通知が多くならないように、収集段階でニュースを絞りすぎている」こと。

今後は以下を分離する。

1. **Collection**: 国内外の市場関連ニュースを広く収集する。
2. **Classification**: 重要度・カテゴリ・市場影響・銘柄関連度を付与する。
3. **Notification policy**: ユーザー設定に応じてPushする/しないを決める。

重要原則:
- 「保有/監視銘柄と直接関係が薄い」ことを理由に、地政学・災害・金融政策などの重大ニュースを収集時点で捨てない。
- 通知がうるさいかどうかはユーザーが決める。
- ユーザーが望むなら、かなり多めに通知できる設計にする。

## Concrete missed-event audit

最低限、以下2件がどこで落ちたかを追跡する。

1. 2026-09-12 北朝鮮のミサイル/飛翔体発射
2. ホルムズ海峡周辺の攻撃・タンカー/航路リスク拡大

確認する段階:
- source discovery / query
- fetch
- candidate insert
- dedupe
- severity classification
- category classification
- market-wide判定
- tracked-stock / sector relevance filter
- Fact gate
- app/news storage
- notification enqueue

「仕様通り落ちた」で終わらず、プロダクト要件に照らして取りこぼし原因として整理する。

## Required audit

以下をread-onlyで監査する。

- `important-news-monitor`
- `market-intelligence-ingest`
- `important_news_candidates`
- `market_events` / `market_metrics` / `mic_*` 系
- 現在のニュースsource/query/category/severityロジック
- market criticalのsector relevance条件
- notifications producer条件
- alert_settingsの現行構造
- Cron頻度と収集タイミング

`market-intelligence-ingest` は最近本番に存在することが確認されているが、今回の監査開始時点では出所を推測しない。git history / TASK / migration / Edge Function sourceをread-onlyで確認して位置づけを特定する。

## Target collection scope

少なくとも以下を収集対象として扱える設計を作る。

- 日本株/国内企業
- 米国株/主要指数
- 為替
- 金利/国債
- 原油・天然ガス・主要コモディティ
- 半導体/AI/大型テック
- 中央銀行/金融政策
- 政府・規制・関税
- 地政学/戦争/軍事衝突
- 北朝鮮/台湾海峡/中東など日本市場に波及しやすい安全保障
- 災害/地震/津波/大規模停電・インフラ障害
- 海運/ホルムズ海峡/スエズ等の物流チョークポイント
- 金融システム/銀行・取引所障害
- 主要企業の決算/下方修正/上方修正/大型M&A

収集は広く、保存後に重要度・カテゴリ・関連度を付ける。

## Classification design

重要度は最低限:
- emergency
- critical
- high
- medium
- low

カテゴリは最低限:
- geopolitics
- disaster
- monetary_policy
- fx
- rates
- oil_energy
- commodities
- shipping_logistics
- semiconductors
- ai_tech
- us_market
- japan_market
- regulation_policy
- corporate
- earnings
- financial_system

必要なら複数カテゴリを持てる設計を提案する。

### Emergency concept

`emergency` は保有/監視セクター一致を必須にしない。

例:
- 日本周辺のミサイル/Jアラート級
- 戦争の急拡大
- ホルムズ海峡の封鎖/大規模攻撃
- 台湾有事級
- 大規模地震/津波
- 主要中央銀行の緊急政策
- 金融市場インフラの重大障害
- 原油供給の大規模途絶

ただし誤報防止のFact/source gateは維持する。

## User notification model

収集範囲と通知範囲を分離する。

通知プリセット案を設計する。

### 静かめ
- 保有/監視銘柄 critical 以上
- market emergency

### 標準
- 保有/監視銘柄 high 以上
- market critical 以上

### 多め
- 保有/監視銘柄 medium 以上
- market high 以上

### 全部通知
- 保存された有用ニュースをかなり広く通知
- lowまで含めるかはノイズ量を見て提案

さらにカテゴリ別ON/OFFを将来追加できるschemaを検討する。

例:
- 地政学
- 災害
- 為替
- 金利
- 原油/エネルギー
- 半導体
- 米国市場
- 国内企業
- 決算

## UX principle

ユーザーが「通知多め」を選べることを重視する。

アプリが勝手に「うるさいだろう」と判断して収集自体を止めない。

通知しないニュースでも、必要ならアプリのニュース一覧には残せる構造を優先する。

## Phase 1 scope

今回は **監査 + 正式設計 + 必要最小限のローカル実装案** まで。

優先順:
1. 現行パイプラインの完全監査
2. 北朝鮮/ホルムズのdrop point特定
3. collectionとnotificationの分離設計
4. severity/category schema設計
5. user notification preset設計
6. 既存重要ニュースPushとの互換性確認
7. 最小変更案と段階的 rollout plan

コード変更が安全に分離でき、production変更なしでローカル実装・テストまで可能なら進めてよい。
ただし大きなschema変更や本番deployはK1前に行わない。

## Parallel safety

現在:
- Claude slot 2はX複垢/OAuth作業中。
- Codex slot 2のPush dispatcher hardeningは本番反映済みで自然観測待ち。

このG1では以下を触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- X token
- multibrand OAuth callback
- `send-push-notifications` のclaim/retry実装
- notifications claim RPC

もしニュース拡張のために上記と同じファイル/RPCを変更する必要が出たら、開始せず競合として報告する。

## Production safety

K1前は禁止:
- production DB migration/RPC変更
- Edge Function production deploy
- Cron変更
- synthetic production candidate/notification
- manual Push
- OpenAI/X APIの人工実行
- user alert_settings変更
- `supabase db push`

read-only production investigationは可。

## Migration safety

migration historyは既知の乖離がある。

- `supabase db push` 禁止
- migration history repair/reconcileは別タスク
- schema変更案はexpand-onlyを基本とする
- migration versionを勝手に修復しない

## Tests / proof expected

設計またはローカル実装を行う場合、最低限以下を確認する。

- market-wide emergencyがtracked-stock/sector一致なしでも保存対象になる
- 通常のcompany newsは既存dedupeを維持
- severity mapping deterministic cases
- category mapping deterministic cases
- user presetごとのnotification eligibility
- push_enabled=falseは最終的に通知0
- preset/category OFFで通知0
- collection自体はnotification OFFでも保存可能
- same event cross-source dedupe方針
- Fact未通過はPushしない
- existing important-news regression
- `deno check`
- `git diff --check`

## Deliverable

`CLAUDE_TASK_1.md` 末尾へ `## Report` を追記する。

Report必須:
- task_id
- result
- model_used
- current_collection_architecture
- north_korea_drop_point
- hormuz_drop_point
- market_intelligence_ingest_origin
- root_causes
- proposed_collection_scope
- proposed_severity_model
- proposed_category_model
- proposed_notification_presets
- schema_changes_proposed
- producer_changes_proposed
- app_settings_changes_proposed
- compatibility_with_existing_push
- parallel_conflicts
- tests
- production_changes
- changed_files
- commit_hash
- push
- remaining_issues
- next_recommendation

完了時:
- status: review_required
- next_owner: chatgpt
- origin/mainへ安全に同期


## Report

- task_id: broad-market-news-collection-and-user-notification-control-20260912
- result: **完了（Phase 1: 監査＋設計＋未接続のローカル実装）**。取りこぼしの原因は「絞り込みすぎ」ではなく**収集段階で探していない**ことだと特定した。設計と未接続実装＋テストを追加し、本番は一切変更していない（read-only調査のみ）。
- model_used: Claude Opus 5
- 設計文書: `docs/news-coverage/REDESIGN.md`

### current_collection_architecture

| レーン | 取得元 | 実際の広さ |
| --- | --- | --- |
| `tdnet` / `company_ir` | TDnet一覧HTML＋開示PDF（`npm:unpdf`） | 国内の適時開示はほぼ網羅 |
| `market_macro` | 公式RSS **5本**（日銀 / FRB / USTR / UN平和安全 / EIA） | 中央銀行と通商・国連の一部のみ |
| `breaking_market` | OpenAI web_search、検索トピック **4本** | **1サイクル（20分）に2検索**（固定1＋回転1）、回転3本なので各トピックは約1時間に1回 |

- 保存上限はむしろ余裕がある（macro 30 / breaking 15 / 全体100件）。**制約は取得元と検索トピックの数**。
- Cron: fetch `0,20,40`、judgement `7,27,47`、generation `14,34,54`、publish-ready `*/5`。
- 分類: `importance`（no_post / important / most_important）＋`category`（30種）＋`japan_market_relevance`。**災害（地震・津波）カテゴリが無い**。
- アプリ表示: `deriveNewsSeverity` → SQL `important_news_app_severity` のミラー。市場ニュースは **critical / high のみ**表示。
- 通知: 個別銘柄はX publish時のproducer、市場全体は `enqueue_market_critical_notifications`（`market_critical_news` 既定OFF × critical × 業種一致 × 6時間以内 × Fact passed 日本語）。
- 本番実データ（read-only）
  - 直近7日: candidate 599件。市場全体は **80件**。severity内訳は critical 4 / high 9 / medium 8 / **low 59**。
  - 直近24時間: tdnet 54 / market_macro 3 / breaking_market 2。市場全体は5件のみ。
- 本番の important-news-monitor v44 のソースを download して、テスト以外の全ファイルがリポジトリと**バイト単位で一致**することを確認済み（監査結果は本番にそのまま当てはまる）。

### north_korea_drop_point

**source discovery / query 段階で落ちた（fetch以前）。**

- 直近3日の candidate を `north korea|missile|ballistic|pyongyang|北朝鮮|ミサイル|飛翔体` で検索して**該当0件**。候補行が作られた形跡がない。
- 原因: 検索トピック4本のいずれも北朝鮮・ミサイル・Jアラート・EEZを含まない。`war_geopolitics_taiwan` は「war ceasefire Taiwan Middle East Iran Israel Hormuz oil tanker CENTCOM」で、北朝鮮の語が無い。
- 取得元にも防衛省・気象庁・首相官邸・NHK等の日本語一次情報が無い。
- つまり「仕様どおり落ちた」ではなく**探していない**。dedupe以降の段階はすべて未到達。

### hormuz_drop_point

保存はされていた。事象ごとに落ちた段階が違う。

| 保存(UTC) | タイトル | importance | 関連度 | app severity | 状態 | 落ちた段階 |
| --- | --- | --- | --- | --- | --- | --- |
| 09-09 12:20 | ペルシャ湾北部でタンカーが飛翔体に被弾 | no_post | medium | **low** | rejected | judgement（X基準で no_post）→ severity low で非表示 |
| 09-10 08:40 | 米イラン衝突で原油100ドル超・アジア株下落 | no_post | **high** | **medium** | rejected | judgement →**市場フィードが critical/high のみ**のため非表示 |
| 09-11 14:20 | フーシ派が紅海入口マユン島を掌握 | important | high | high | published | 通過（X投稿＋アプリ表示） |

- judgement の記録理由は「保存済み情報だけでは安全に確定できないため投稿対象外」。これは**X投稿の可否基準**で、アプリ表示・通知の基準としては厳しすぎる。
- `deriveNewsSeverity` は Fact未確認の市場ニュースを構造上 medium より上に上げない。市場フィードは critical/high のみ。結果、**収集済みなのに誰にも届かない medium / low 帯**が生じている（7日で67件）。

### market_intelligence_ingest_origin

git history / docs / migration をread-onlyで確認した結果。

- 由来: **ユーザーからの直接依頼**（`docs/market-intelligence/ARCHITECTURE.md` の冒頭に「通常のH1/H2/CODEX_TASK運用とは別の直接依頼」と明記）。`.agent/tasks/*` のどのスロットのタスクでもない。
- コミット: `79b57cc`（Phase 0設計文書）→ `b850f6f`（Phase 1A実装）→ `daa7916`、`ce968e0`（修正）。すべて 2026-09-12。
- 中身: **ニュース収集ではなく構造化された市場ファクトの蓄積基盤（MIC）**。アダプタは FRED / EIA / MOF JGB / SEC EDGAR。
- 本番状態: Function v5 稼働、migration `20260912090000` 適用済み、テーブルは `mic_source_registry`（4ソース登録）/ `mic_ingestion_runs` / `market_events`（0行）/ `market_metrics`（4行）。**専用Cronは無い**（cron 10件に含まれていない）。
- 今回のタスクとの関係: MIC は数値・イベントの一次情報基盤で、ニュース収集レーンとは別物。**今回は触っていない**。将来、MIC の `market_events` をニュース分類の裏付けに使える可能性はあるが、本設計は依存しない。

### root_causes

1. 収集が検索トピック4本・RSS5本に固定され、安全保障・災害・物流チョークポイント・金融インフラ・コモディティを誰も探していない（北朝鮮の直接原因）。
2. 1サイクル2検索の予算で回転が1時間1周。速報性が要る事象に間に合わない。
3. 1つの `importance` が「X投稿の可否」と「アプリに出すか」の両方を決めている。Xに出さないものは rejected として実質消える。
4. 市場フィードが critical / high のみ。medium 以下は保存されていても表示されない（ホルムズの直接原因）。
5. 通知の広さをユーザーが選べない（market_critical_news の ON/OFF だけ）。「多め」を選ぶ手段が無い。
6. カテゴリ enum に災害が無く、地震・津波の分類先が無い。

### proposed_collection_scope

- 検索トピックを4本 → **11本**（追加7本）。固定枠に `japan_security_emergency`（北朝鮮ミサイル・Jアラート・EEZ・台湾）と `disaster_infrastructure`（地震・津波・噴火・台風・停電・製油所停止）を置き、回転枠に `shipping_chokepoints` / `financial_system_infrastructure` / `commodities_energy_supply` / `us_market_session` / `japan_market_session` を追加。
- 公式RSSを5本 → **13本**（追加8本）: 気象庁（地震・火山／気象警報）、防衛省、財務省、JPX、首相官邸、米財務省、米商務省BIS。すべて一次情報。**配信URLの実在確認はwiring前の別ステップ**（本タスクでは1件もfetchしていない）。
- 検索コストを明示: 固定3＋回転1 = **1サイクル4検索（時間12回）**。現行は2検索（時間6回）。回転8本で一周160分。
- 収集の可否は「https の一次情報URLと時刻が検証できるか」だけで決める（`shouldStoreForCoverage`）。**銘柄・業種の一致や「通知がうるさいか」を収集段階の理由にしない。**

### proposed_severity_model

- `emergency / critical / high / medium / low` の5段階。
- 既存 `deriveNewsSeverity`（SQLミラーあり）は**変更しない**。その上に emergency を重ねる `classifyCoverage` を新設。
- `emergency` は**業種一致を不要**にする。誤報防止ゲートは維持。
  - 一次情報ホスト（Reuters / AP / Bloomberg / 日経 / 各政府機関 / 気象庁 / 防衛省 / JPX 等）かつ https。サブドメインは許可、`reuters.com.evil.example` のような偽装は不可。
  - 公開から6時間以内、時刻がパース可能。
  - 事象パターン**と**深刻度パターンの両方一致（「北朝鮮と協議」「防災訓練」「日銀総裁の見通し講演」は emergency にならない）。
  - 企業コード付き開示は対象外。
- emergencyクラス8種: missile_near_japan / war_escalation / chokepoint_disruption / taiwan_contingency / major_disaster / emergency_monetary_action / market_infrastructure_failure / oil_supply_disruption。

### proposed_category_model

- 16カテゴリ: geopolitics / disaster / monetary_policy / fx / rates / oil_energy / commodities / shipping_logistics / semiconductors / ai_tech / us_market / japan_market / regulation_policy / corporate / earnings / financial_system。
- **複数付与**。既存30カテゴリからの対応表＋見出し・要約のキーワードで加算する（タンカー攻撃 → geopolitics ＋ shipping_logistics ＋ oil_energy）。
- カテゴリ0件の状態を作らない（カテゴリ別フィルタから漏れるため）。

### proposed_notification_presets

| プリセット | 個別銘柄 | 市場全体 | emergency |
| --- | --- | --- | --- |
| 静かめ | critical 以上 | なし | 受け取る |
| 標準 | high 以上 | critical 以上 | 受け取る |
| 多め | medium 以上 | high 以上 | 受け取る |
| 全部通知 | medium 以上 | medium 以上 | 受け取る |

- `low` はどのプリセットでも通知しない（アプリ一覧には残す）。ノイズ量を見てから将来判断。
- カテゴリ別OFFを併用。**全カテゴリOFFのときだけ**通知を止める。
- emergency は専用スイッチ（既定ON案）でプリセットのしきい値に従わない。
- 判定順: push_enabled → 通知マスタ（important_news）→ 重複 → **Fact passedの日本語テキスト** → カテゴリ → emergency → 銘柄/業種一致 → しきい値。プリセットを広げてもFactゲートと重複防止は超えられない。

### schema_changes_proposed

すべて expand-only、**未適用**（SQL全文は設計文書の§4）。

1. `alert_settings` に `notification_preset`（既定 'standard'、check付き）と `emergency_alerts`（既定 true）を追加。列単位で authenticated に select/insert/update を付与。
2. `alert_category_settings(user_id, category, enabled)` を新設（本人のみのRLS）。カテゴリ追加でschema変更が不要な行形式。
3. `important_news_candidates` に `coverage_categories text[]` / `coverage_severity` / `emergency_class` / `coverage_classified_at` を追加（＋ severity用btreeとcategories用ginの索引）。既存列は変更しない。
4. `category` の check に `'disaster'` を追加。
5. フィードRPCは**既存関数を残したまま**別バージョンを作り、市場ニュースのしきい値をプリセットに応じて広げる。

### producer_changes_proposed

- 既存2つのproducerを消さずに、判定を `notificationEligibility` に寄せる。
- 市場producerの条件を「critical × 業種一致」から「プリセットのしきい値 ×（emergency は業種一致不要）」へ拡張。
- Fact passedの日本語テキストが無いものはどの経路でも通知しない（現行と同じ）。
- 重複防止は現行の unique 制約と `important_news_same_event` をそのまま使う。

### app_settings_changes_proposed

- 通知設定画面に「通知の量」（静かめ／標準／多め／全部通知）のプリセット選択を追加。
- 「緊急のニュース（Jアラート級・大地震・海峡封鎖など）」の専用スイッチ。
- カテゴリ別ON/OFF（地政学・災害・為替・金利・原油/エネルギー・半導体・米国市場・国内企業・決算 など）。
- ニュース一覧に、通知されなかったニュースも残す（カテゴリ表示とフィルタを追加）。

### compatibility_with_existing_push

- `market_critical_news=true` → 「標準」、OFF → 「静かめ」に対応（`presetFromLegacySettings`）。
- テストで現行2経路の再現を固定: 個別 high は通知される／市場 critical は通知される／市場 high は通知されない／市場未オプトインのユーザーには通常の市場通知が来ない。
- 唯一の意図的な差分: **「静かめ」でも emergency は届く**。emergency の既定をONにするかはK1判断（OFF既定にもできる）。
- 既存の `important_news` / `push_enabled` は上位スイッチとして維持。dispatcher（send-push-notifications）の変更は不要。

### parallel_conflicts

- なし。触っていない: `x-oauth-connect` / OAuth / Vault / social_accounts / X token / multibrand callback / `send-push-notifications` のclaim・retry実装 / notifications claim RPC。
- 他スロットの状況: Claude slot 2 は X複垢OAuth（in_progress）、Codex slot 2 は push dispatcher hardening（review_required、本番反映済み v9）。今回の追加ファイルはいずれとも重複しない。
- `important-news-monitor` に**ファイルを追加しただけ**で、既存ファイルは1行も変更していない（`index.ts` からのimportも無い）。将来 wiring する段階では、同Functionを触る他スロットとの競合確認が必要。

### tests

- 新規 `news_coverage_logic_test.ts`: **22件 pass**。
  - market emergency が銘柄・業種一致なしで通知対象になる
  - 通常の company news は既存の重複・Fact条件を維持
  - severity の決定的ケース（既存 critical/high は不変、Fact未確認の市場ニュースが emergency に昇格）
  - カテゴリの決定的ケース（複数付与、未分類ゼロ、タンカー＝shipping＋oil、ミサイル＝geopolitics、地震＝disaster）
  - emergency のゲート（未信頼ホスト／http／偽装サブドメイン／期限切れ／時刻なし／企業開示）
  - 事象＋深刻度の両方一致が必要（協議・訓練・講演は emergency にしない）
  - プリセット別の通知可否（4プリセット × company/market × critical/high/medium）
  - `low` はどのプリセットでも通知0
  - push_enabled=false / important_news=false / emergency_alerts=false で通知0
  - 全カテゴリOFFで通知0、一部OFFなら通知される
  - Fact未通過は emergency でも通知0、重複は通知0
  - 収集は通知設定と独立（通知0でも保存される）
  - 収集範囲が目標16カテゴリを完全に覆う／北朝鮮・ホルムズに専用トピックと公式一次情報がある／検索コストの明示
- 既存回帰（`--allow-read`）: severity・SQLパリティ・通知producer・市場critical静的検査・関連度・表示・app copy＝**95件 pass**、breaking_market fetcher ＝ **29件 pass**、judgement＋resource limit ＝ **33件 pass**。合計 **157件 pass / 0 failed**（新規22件を含む）。
- `deno check`（新規3ファイル）PASS。`git diff --check` PASS。
- 環境の既知制約: `market_macro_source_fetchers_test.ts` と monitor 全体の一括実行は `npm:unpdf@1.8.1` が未インストールのため型検査で止まる（今回の変更とは無関係。TDnet PDF依存）。

### production_changes

**なし。** 実施したのは read-only 調査のみ。
- `important_news_candidates` / cron / alert_settings / notifications への書き込みなし（notifications は 1件のまま＝昨日のレポート通知）。
- migration未適用（schema_migrations 最大は 20260912075354 で変化なし）。deploy なし（Function のversionは全て変化なし）。
- `important-news-monitor` のソースを download したのは**比較のための読み取りのみ**。

### changed_files

- `supabase/functions/important-news-monitor/news_coverage_logic.ts`（新規、未接続）
- `supabase/functions/important-news-monitor/news_collection_scope_proposal.ts`（新規、未接続）
- `supabase/functions/important-news-monitor/news_coverage_logic_test.ts`（新規）
- `docs/news-coverage/REDESIGN.md`（新規）
- 既存ファイルの変更は 0（`.agent/tasks/CLAUDE_TASK_1.md` のstatus更新とこのReportを除く）

### commit_hash

- 実装・設計: `d71225f`
- Report: このコミット

### push

- origin/main（fast-forward）

### remaining_issues

- 提案したRSS 8本の**配信URLの実在と形式は未確認**（このタスクではfetchしていない）。wiring前に1本ずつ確認が必要。
- 検索コストが 6回/時 → 12回/時 に増える。費用の承認が必要。
- `disaster` カテゴリ追加は check 制約の拡張で、判定プロンプト側の分類語彙も合わせる必要がある。
- 「収集は広く、表示も広く」にすると、アプリ一覧の件数が増える（7日で低severity 59件相当）。一覧のフィルタとカテゴリ表示が前提。
- emergency 検出は現状**パターン方式**。AIによる分類を使うかは別判断（表示・通知時のAI呼び出しは禁止のため、分類は保存時に限る）。
- MIC（market-intelligence-ingest）との統合は本設計では未使用。将来 `market_events` を裏付けに使える可能性がある。
- 既存の課題は継続: migration履歴のずれ、テスト用監視銘柄17件、config.toml がGit管理外。

### next_recommendation

設計文書§5の段階導入をK1で承認してほしい。特に最初の2段階は収集コストもX投稿も変えない。

1. **分類の追記のみ**（schema 3・4 を適用し、分類を書くだけ。表示も通知も変えない）→ 実データで emergency 検出の精度と誤検出を確認。
2. **アプリ表示を medium まで広げる**（＋カテゴリ表示）。通知は現行のまま。
3. **収集を広げる**（トピック7本・RSS 8本の追加、検索予算を4/サイクルへ）。ここで費用が増える。
4. **通知プリセットとカテゴリ設定**（既定は現行互換、アプリUI追加）。
5. **emergency 通知の有効化**（既定ON/OFFをK1で決定）。

あわせて判断してほしい点:
- emergency 通知の既定値（ON案）
- 「全部通知」に `low` を含めるか（現案は含めない）
