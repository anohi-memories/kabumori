# Claude Task 1

- task_id: broader-stock-news-coverage-phase1-20260910
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: かぶモリアプリの価値を高めるため、現行の「Xへ出す重大ニュース」だけでなく、保有・監視銘柄ユーザーに有用なニュースをより広く収集できる基盤へ拡張する。個別銘柄IRに加えて、相場全体を動かす政治・地政学・政策・マクロニュースも対象に含める。今回は収集範囲の監査・カテゴリ設計・安全な最小実装・テストまでを行い、X自動投稿基準や本番配信量を勝手に広げない。

## Context

直前TASK `important-news-push-copy-quality-20260910` はChatGPTのK1レビューで完了承認済み。

現在までに完成している重要ニュースPush基盤:
- `important-news-monitor` v38 が本番稼働
- 自然publish後、登録銘柄ユーザー向けnotification producerが動く
- `send-push-notifications` v4 が毎分Cronで配信
- `alert_settings.push_enabled` / `important_news` opt-outを本番実証済み
- `/news` RPCは `published` を含む
- Push本文はFact/Voice通過済みX投稿文を優先して読みやすく改善済み
- Push → `/news` の導線は構造上つながっている

既知の次の課題は、現在の収集・判定が「Xへ出すほど重大なニュース」に寄っており、保有者には有用だがX全体投稿には強すぎない材料を十分拾えていないこと。また、個別銘柄IRだけでなく、トランプ大統領・米政権の発言や政策、戦争・停戦・制裁など、指数・為替・原油・半導体等を通じて日本株全体や特定業種を大きく動かすマクロ/地政学ニュースも重要な監視対象とする。

## Product Principle

**収集は広く、配信は狭く。**

今回もっとも重要な原則:
- ニュースを拾う範囲は広げる
- ただし、現在のX自動投稿基準を勝手に緩めない
- 「収集された」ことと「Xへpublishする」ことを同一条件にしない
- 個別銘柄ニュースと市場全体ニュースを区別して扱える設計にする
- 将来、保有銘柄 / ウォッチ銘柄 / severity / セクター影響に応じてPushやアプリ表示を分けられる構造を優先する

## Model

ニュース取得・分類・X publish安全性・Push・将来のseverity設計・マクロ/地政学影響判定を横断するため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktreeの状態確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `important-news-monitor/**`、同じnews source、同じRPC/migration、同じproduction設定を変更中なら開始せず競合報告
9. 本番 `important-news-monitor` v38のsource/versionをread-only確認し、origin/mainとの一致を確認
10. 既存未コミット変更は他workstream所有として扱い、変更・削除・stage・commitしない

## Phase 1A: Current coverage audit

実装前に、現在のニュース取得からX publishまでの経路をコードと本番read-onlyデータで確定する。

最低限確認:
- `official_source_fetchers.ts`
- `market_macro_source_fetchers.ts`
- `breaking_market_source_fetchers.ts`
- importance judgement / grouping / candidate logic
- generation / Fact / Voice / publish gate
- auto_publish cutover / rate control
- notification producerとの接続条件
- `/news` で現在見えるstatus / importance

以下を整理する:
1. 現在拾えているsource種別
2. 現在候補化されるニュース種別
3. importance=`important` / `most_important` の現行判定
4. どの段階でニュースが落ちるか
5. 「保有者には有用だが現在拾えていない/落ちている」代表例
6. X公開基準とアプリ/Push向け基準を分離できるポイント
7. 市場全体ニュース（政治・政策・地政学・マクロ）が現在どのsource/判定で拾われ、どこで落ちているか

可能なら直近の本番候補データをread-onlyで分類し、件数と具体例をReportする。人工candidateは作らない。

## Phase 1B: Coverage taxonomy

少なくとも以下の個別銘柄カテゴリを、現行で拾える / 一部拾える / 拾えていない に分類する。

- 決算発表
- 業績予想の上方/下方修正
- 配当増減・無配・復配
- 自社株買い / 消却
- 株主優待の新設・変更・廃止
- M&A / TOB / 買収 / 売却
- 資本業務提携 / 大型提携
- 大口受注 / 大型契約
- 増資 / CB / 社債など資金調達
- 株式分割 / 併合
- 主要株主・大量保有に関する重要変化
- 行政処分 / 規制 / 訴訟
- 不祥事 / 事故 / 工場停止 / サイバー事故
- 経営トップ交代
- 大型製品・サービスの発表 / 延期 / 中止
- 市場で重要な格付け・レーティング変更（信頼できるsourceがある場合）
- その他、保有者の投資判断に直接影響しうるIR

### Market-wide / macro / geopolitical taxonomy

以下も必ず監査・設計対象に含める。人物名単独の話題ではなく、**日本株・米株・為替・金利・原油・セクターへ実際に影響しうる政策/出来事**として扱う。

- トランプ大統領・米政権の市場影響が大きい発言、政策発表、大統領令
- 米国の関税・追加関税・報復関税、通商政策
- 米中摩擦、輸出規制、半導体/AI関連規制
- 日本・米国・中国・EU等の大型経済政策、規制変更、補助金政策
- 戦争開始・拡大、軍事衝突、攻撃、重大な安全保障事件
- 停戦・和平交渉・合意・決裂
- 経済制裁・制裁解除
- 中東情勢など原油/LNG価格へ大きく影響する地政学イベント
- 台湾海峡・朝鮮半島など日本株/半導体/サプライチェーンへ影響する緊張
- 海峡・港湾・海運ルートの封鎖/障害（ホルムズ、紅海等）
- OPEC+等の大幅な原油生産方針変更
- FRB / 日銀などのサプライズ性が高い政策変更・緊急措置
- 為替介入または介入観測に直結する政府・中銀の重大発表
- 大規模災害・パンデミック・サイバー攻撃など市場全体や複数業種に重大な影響があるイベント
- その他、日経平均・TOPIX・ドル円・SOX/半導体・原油などを急変させうるニュース

特に「トランプが何か言った」だけで無差別に拾うのではなく、関税、対中政策、半導体、金融政策への圧力、戦争/停戦、エネルギー等、**市場への伝播経路が説明できるもの**を対象とする。

カテゴリを増やすこと自体が目的ではない。投資判断への関連性、source信頼性、速報性、市場影響の大きさを基準にする。

## Phase 1C: Severity / delivery design

現行importanceを壊さず、将来以下のように分離できる最小設計を提案する。

推奨概念:
- Critical: 市場全体または銘柄に非常に大きな影響。X対象候補。
- High: 保有者にはかなり重要。Push候補だが、必ずしもXへ出さない。
- Medium: アプリ一覧で見る価値が高い。通常はPushしない。
- Low: 原則保存しないか、参考情報扱い。

市場全体ニュースについては、company_codeが無いことを理由に単純破棄せず、将来 `market_scope` / `affected_sectors` / `affected_assets` 等でユーザー影響を判定できる設計も検討する。ただし今回、本番Pushを全ユーザー配信する変更は行わない。

例:
- 米国が日本車への大幅追加関税を即時発表 → Critical候補
- 半導体輸出規制の対象拡大 → 半導体保有者にはCritical/High候補
- 中東で戦闘拡大し原油急騰リスク → 市場/エネルギー/航空・海運等へ影響
- 日常的な政治発言で具体的政策・市場反応が無い → Low/除外

ただし、今回いきなりDB schemaを増やす必要はない。既存の `importance` 等で安全に表現できるなら最小変更を優先し、schema変更が必要なら実装前に理由を明示する。

### Holdings vs Watchlist future policy

将来の推奨方針もReportする:
- holdings: Critical + HighをPush候補
- watchlist: 原則Critical、またはユーザー設定でHighも許可
- app feed: Critical + High + Medium
- market-wide Critical: 将来は保有銘柄/セクターとの関連付け、または市場全体アラート設定に基づいてPush候補

**今回はこの配信ポリシーを本番有効化しない。** 設計だけ整理する。

## Phase 1D: Minimal implementation

監査の結果、既存構造を壊さず安全に追加できるニュースカテゴリ/sourceが明確なら、最小の実装を行う。

実装ルール:
- `important-news-monitor` 内で完結する範囲を優先
- 個別銘柄sourceは公式IR/TDnet/信頼できる既存許可sourceを優先
- マクロ/地政学は政府・中央銀行・国際機関等の一次情報、または信頼できる既存許可ニュースsourceを優先
- SNS投稿や発言の孫引きを単一根拠に重大判定しない。可能な限り一次情報または複数の信頼できる根拠で確認する
- 無差別な一般Web検索を増やさない
- source URL / published time / relevant entity / market impact basis等のFact basisを必須とする
- duplicate/grouping既存仕様を維持
- 既存のCritical相当/X publish判定を緩めない
- 新たに収集したHigh/Medium相当ニュースが、誤って既存X auto_publishへ流れないfail-closed設計にする
- 自然X投稿件数が増える変更は今回禁止
- Push producerの対象範囲を勝手に広げない
- company_codeなしの市場全体ニュースを「全ユーザーPush」へ接続しない
- `/news` RPC変更は今回原則行わない

もし安全な最小実装にschema/RPC変更が必須なら、コードを書き始める前にReportのdesign sectionへ理由を記録し、今回は設計・テストまでで停止してよい。

## Required tests

最低限:
- 新たに対象とする個別銘柄カテゴリのpositive cases
- トランプ/関税/米中規制/戦争・停戦・制裁等のmarket-wide positive cases
- 単なる政治雑談・影響不明な発言は重大ニュース扱いしない
- マクロニュースについて市場への影響経路が無いものはfail closed
- 無関係な一般ニュースは候補化しない
- company/ticker誤紐付けをしない
- source_url / published_at等の必須Fact basis欠損はfail closed
- duplicate/grouping維持
- 既存 `important` / `most_important` 判定の回帰
- 既存X publish gateの回帰
- 新しく広げた収集が既存X publish量を増やさないこと
- producer / user targetingを変更していないこと
- company_codeなしのmarket-wide newsが勝手に全ユーザー通知されないこと
- important-news-monitor全回帰テストPASS
- changed pure modules `deno check`
- `git diff --check`

## Production rule for this task

**本番deployは禁止。**

今回は:
- audit
- design
- safe minimal implementation
- local/test validation
- commit/push
まで。

K1レビュー後にChatGPTが、本番投入してよい範囲を別途明示する。

本番について許可するのはread-only確認のみ:
- candidate件数/分類
- current Function version/source
- current settings/Cron状態

禁止:
- Edge Function deploy
- migration/RPC適用
- Cron変更
- auto_publish設定変更
- candidate status変更
- X投稿
- artificial candidate作成
- notification作成

## Forbidden

- `send-push-notifications`変更/deploy
- `x-test-post`変更/deploy
- `/news` RPC変更（監査で必須理由が出ない限り）
- Cron変更
- secrets/OAuth変更
- alert_settings変更
- X投稿基準の緩和
- auto_publish対象拡大
- Push配信対象の本番拡大
- company_codeなしmarket newsの全ユーザーPush化
- unrelated DB migration
- テスト用の人工important-news candidateを本番投入
- 既存backlogのstatus変更/削除
- 一般Webクロールの無制限追加

## Completion

終了時:
- status: `review_required`
- next_owner: `chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- current_pipeline_map
- source_inventory
- current_category_coverage
- missed_or_undercovered_categories
- market_macro_geopolitical_coverage（トランプ/関税/戦争/停戦/制裁/政策等を含む）
- real_data_audit
- proposed_taxonomy
- proposed_severity_model
- holdings_vs_watchlist_policy
- chosen_phase1_implementation
- why_x_publish_volume_does_not_increase
- changed_files
- tests
- production_changes（必ずnoneのはず）
- commit_hash
- push
- remaining_issues
- safety_checks
- phase2_recommendation

## Report

- task_id: broader-stock-news-coverage-phase1-20260910
- result: **完了（監査・設計・最小実装・テスト。本番変更なし）**。現行パイプラインでは `importance` 1本が「保存・表示する価値」と「Xへ出す価値」を兼ねており、Xに出すほどではないが保有者には有用なニュースが `no_post → rejected` として消えていることを、コードと本番データ（直近7日・665件）で確定した。これを分離する **アプリ向け severity（critical / high / medium / low）** を、既存の判定結果から決定論的に導く pure module `news_severity_logic.ts` として実装した。**index.ts からは参照していない（本番の挙動は1バイトも変わらない）**。本番データでのシミュレーションでは、X対象件数は104件のまま不変、新たにアプリ表示候補になるのは271件（個別銘柄263件・市場全体8件）。
- model_used: Opus 5

### current_pipeline_map

| 段階 | 処理 | 主な落ち方 |
|---|---|---|
| 1. 取得 | Cron `important-news-fetch`（0/20/40分）。TDnet一覧（当日） / 企業IR（`important_news_company_ir_sources`） / market_macro RSS 5本 / breaking_market Web検索（1周期最大2検索） | ソースに無いもの（格付け、SNS、TDnet以外の企業ニュース）は原理的に入らない。market_macro は14日、breaking は3時間より古いものを捨てる |
| 2. 候補化・重複 | `prepareNewsCandidate` / `findNewsDuplicate`（content_hash、source_url、entity+見出し24h、breaking:event は3h） | `duplicate` |
| 3. 判定 | Cron `important-news-judgement`。Luna → 必要時 Sol。`importance` = no_post / important / most_important、`category` 31種、`japan_market_relevance`、`fact_check_status` | `no_post` → `rejected`。**Fact が `needs_review`、または Sol に上げるべきなのに Sol 判定が無い場合は、モデルが重大と判断していても強制的に no_post**（`judgeCandidateWithEscalation`） |
| 4. 生成 | Cron `important-news-generation`。important / most_important → X投稿文を生成 → Fact / Voice チェック | どちらか不合格 → `generation_failed` |
| 5. 公開 | Cron `important-news-publish-ready`（5分）。`checkPublishCandidate`（ready_for_publish、important / most_important、Fact・Voice passed、ラベル、出典URL） + cutover + rate control（10分） + 夜間保留 | 条件不一致はスキップ。**important も most_important も、ここまで来れば自動でX投稿される** |
| 6. 通知 | publish成功時だけ producer → 登録銘柄ユーザー（company_code 一致）へ `notifications` | company_code なし → 誰にも通知しない |
| 7. アプリ | `/news` = `get_my_important_stock_news`：importance が important / most_important、かつ status が ready_for_publish / generation_failed / published | **no_post は表示されない** |

**結論**: 「収集」と「X公開」を分ける層が無い。判定で important 以上になれば X 投稿へ直行し、そうでなければアプリにも出ない。X の基準を守るほど、アプリで見られる材料も減る構造になっている。

### source_inventory

| レーン | 取得元 | 補足 |
|---|---|---|
| tdnet | `https://www.release.tdnet.info/inbs/I_list_{page}_{date}.html`（当日の全適時開示）+ PDF本文の抜粋（`buildTdnetBodySummary`、最大6,000字） | 取得時点では全件 `other_corporate_ir`。カテゴリは判定の段階で付く |
| company_ir | `important_news_company_ir_sources`（有効な企業IRフィード） | 本番の直近7日では0件 |
| market_macro | 日銀 whatsnew RSS / FRB press_all / USTR / 国連（平和・安全保障） / EIA | APIキー不要の公式RSS。許可ドメインは5つ |
| breaking_market | OpenAI Responses の web_search。固定の `critical_market_events`（雇用統計・CPI・日銀/FRBの緊急措置・為替介入・日経先物・原油の急変など）+ 3つの輪番（トランプ関税・半導体輸出規制・FRBへの圧力 / 戦争・台湾・中東・ホルムズ・タンカー / 銀行破綻・中国の景気対策） | 実際に訪問したURLのみ採用。許可ドメインは Reuters / AP / Bloomberg / 日経 / 財務省 / 日銀 / FRB / USTR / ホワイトハウス / 商務省 / BIS / 国務省 / BLS / BEA / 財務省（米） / CENTCOM / 国防総省 |

### current_category_coverage

直近7日（665件、tdnet 557 / market_macro 78 / breaking_market 30）の実績:

| 対象 | 現状 | 根拠 |
|---|---|---|
| 決算発表 | **一部拾える** | `earnings` 71件中 important 12件、no_post 59件。決算短信の大半は no_post でアプリにも出ない |
| 業績予想の上方・下方修正 | **拾える** | up 21件（important / most_important 12件）、down 10件（同8件） |
| 配当の増減・無配・復配 | **拾える** | increase 12件 / no_dividend 4件。復配は専用カテゴリ無し（increase に含まれる想定） |
| 自社株買い・消却 | **一部** | 73件中 important 以上は13件。ToSTNeT による取得の実施通知などは no_post |
| 株主優待の新設・変更・廃止 | **拾えていない** | カテゴリ無し。`other_corporate_ir` に埋もれる（見出しで判別すると8件） |
| M&A / TOB / 買収・売却 | **拾える** | ma 20件 / tob 10件 |
| 資本業務提携・大型提携 | **一部** | business_alliance 3件はすべて no_post、capital 2件 |
| 大口受注・大型契約 | **拾える（件数少）** | large_order 2件（どちらも important） |
| 増資 / CB / 社債 | **拾えていない** | カテゴリ無し。新株予約権の大量行使（希薄化約4.2%）も no_post（見出しで判別すると希薄化9件・社債/借入10件） |
| 株式分割・併合 | **拾えていない** | カテゴリ無し（1件） |
| 主要株主・大量保有 | **一部** | major_shareholder 7件中6件が no_post |
| 行政処分・規制・訴訟 | **一部** | 米FDAの審査完了報告通知（CRL）＝承認遅延が no_post（needs_review で強制的に落とされた） |
| 不祥事・事故・工場停止・サイバー | **一部** | misconduct 4件、major_security_incident のうち企業分2件。サービスの一時停止は no_post |
| 経営トップ交代 | **拾えていない** | カテゴリ無し（見出しで判別すると5件） |
| 大型製品・サービスの発表・延期・中止 | **拾えていない** | カテゴリ無し |
| 格付け・レーティング変更 | **拾えていない** | 信頼できる取得元が無い（TDnetの対象外） |
| 月次売上・受注速報 | **拾えていない** | 見出しで判別すると **71件**。すべて no_post |

### missed_or_undercovered_categories

保有者には有用だが現在は消えているもの（本番の実例）:
- **月次の売上・受注速報**（71件/週）: 「2026年９月期 ８月度 月次業績（売上高）速報」「月次営業レポート」など。小売・外食の保有者にとっては主要な材料
- **希薄化**: 「第三者割当により発行された第19回新株予約権…の大量行使」（発行済株式の約4.2%）
- **承認・規制**: 「…SI-6603の米国承認申請に関する審査完了報告通知の受領」（承認の遅延。判定モデルも影響を認めつつ、needs_review で強制的に no_post）
- **事業の停止**: 「SSL/TLSサーバー証明書発行サービスの一時停止」
- **決算短信・決算説明資料**の大半（earnings 59件が no_post）: X には強すぎないが、保有者は必ず見たいもの
- 株主優待・株式分割・社長交代: そもそも専用カテゴリが無く、判定の材料にもならない

### market_macro_geopolitical_coverage

- **拾えている（取得まで）**: 関税（USTR・breaking）、対中政策・米中の半導体、戦争・停戦（国連・breaking）、ホルムズ海峡・タンカー、制裁、日銀・FRB、米政権の政策。カテゴリも `tariffs` / `china_policy` / `us_government_policy` / `geopolitics` / `war_ceasefire` / `sanctions` / `semiconductor_ai` / `boj` / `frb` / `fx` / `interest_rates` / `other_market_moving` / `major_security_incident` とそろっている。
- **落ちている場所**: 判定の強制 no_post。モデル自身が市場への関連度を high と書いているのに、裏付けが保存テキストだけでは確定できない（needs_review）ため no_post になっている実例:
  - 「Asian shares fall as crude oil trades above $100 amid U.S.-Iran conflict」（war_ceasefire、関連度 high）
  - 「US strikes Iranian tankers after more attempted missile attacks on Navy ships」（関連度 high）
  - 「China imposes new measures on Japanese exports of a key chipmaking material」（semiconductor_ai、関連度 high）
  - 「Iran claims a strike on a US ship in the Strait of Hormuz」（関連度 high）
  X投稿の防御としてはこの強制 no_post は正しい。問題は、同じ判定がアプリ表示の可否まで決めていること。
- **正しく落ちているもの**: 日銀の見学会・不審電話の注意喚起・定例統計（39件すべて no_post）、国連の一般的な声明、「中国が関税引き下げを希望」のような意向表明。「トランプが何か言った」だけのものは、判定プロンプトの「規模・予想外度・日本株への影響が具体的に確認できる場合に限る」で弾かれている。
- **取得面の穴**（次段階の候補）: 米大統領令・ホワイトハウスの発表（breaking の許可ドメインにはあるが、専用のRSS取得は無い）、BIS の輸出規制、OFAC の制裁、財務省（日本）の為替介入実績、OPEC+ の決定、経産省。取得を増やすと判定・X投稿も増えうるため、今回は追加していない（下記 why_x_publish_volume_does_not_increase）。
- **company_code の無い市場全体ニュース**は、今は通知で誰にも届かず、`/news` の RPC も company_code 一致が前提なので、アプリにも出ない。

### real_data_audit

直近7日・重複を除く635件の、判定の付随項目の分布:

| importance | 市場関連度 | Fact | 件数 |
|---|---|---|---|
| no_post | low | passed | 419（定型IRの中心） |
| important | medium | passed | 62 |
| no_post | low | needs_review | 38 |
| no_post | medium | needs_review | 29 |
| most_important | high | passed | 18 |
| no_post | medium | passed | 17 |
| no_post | none | passed | 15 |
| important | high | passed | 12 |
| important | low | passed | 10 |
| no_post | high | needs_review | **9**（市場を動かす出来事の取りこぼしが集中） |
| no_post | （未判定） | （未判定） | 3 |
| most_important | medium | passed | 2 |
| no_post | high | passed | 1 |

### proposed_taxonomy

`news_severity_logic.ts` に定義した（既存の31カテゴリをそのまま使い、スキーマを増やさない）:
- **`NEWS_CATEGORY_TAXONOMY`**: 全カテゴリについて、範囲（company / market）、日本株への伝わり方（例: tariffs =「関税→輸出・自動車・部品」、war_ceasefire =「戦争・停戦→原油・防衛・リスク心理」、semiconductor_ai =「半導体・AI規制/需要→SOX・半導体株」）、保有者向けかどうか。
- company_code がある場合は、市場カテゴリ（例: 企業のサイバー事故）でも範囲を company にする。
- **`detectCorporateIrSubtype`**: 最大の取りこぼし元である `other_corporate_ir` の見出しから、決定論的に小分類を付ける。月次 / 株主優待 / 株式分割・併合 / 希薄化（第三者割当・新株予約権の行使・公募・CB）/ 社長交代 / 承認・CRL・治験 / 事業の停止・事故・障害・リコール・延期 / 上場廃止・市場区分の変更 / 社債・借入 / 新製品。どれにも当たらなければ routine。
- 本番の `other_corporate_ir` で試した結果: 月次71 / 社債・借入10 / 希薄化9 / 株主優待8 / 事業停止5 / 社長交代5 / 株式分割1 / routine 176（監査役の辞任、基準日の設定、子会社の設立、支店の閉鎖、内部統制、子会社からの配当、貸借銘柄など）。

### proposed_severity_model

`deriveNewsSeverity`（既存の判定結果から導く。`importance` は読むだけで書き換えない）:

| severity | 条件 | 意味 |
|---|---|---|
| **critical** | importance = most_important かつ Fact passed | 現在の X 対象（最重要）そのもの |
| **high** | importance = important かつ Fact passed | 現在の X 対象（重要）そのもの |
| **medium** | (a) 個別銘柄: company_code があり、保有者向けカテゴリ、または保有者向けIRの小分類、または Fact 未確定の X 級判定。(b) 市場全体: 市場関連度が medium 以上（Fact passed）、または high（Fact needs_review） | アプリ一覧に出す価値。Xには出さない。**no_post の項目は、どんな入力でも medium より上にならない**（全組み合わせをテストで確認） |
| **low** | 上記以外。source_url が https でない / 公開日時が無い場合は、判定に関係なく常に low | 表示しない |

市場全体の条件に「Fact needs_review なら high が必要」を入れたのは、実データで medium + 未確定を許すと、日銀審議委員の講演・記者会見・債券市場サーベイ・消費者物価の指標といった定例ものが入ってきたため。一方で、本当に市場を動かす未確定の出来事（タンカー攻撃・原油100ドル超・半導体材料の輸出規制・ホルムズ）は、すべて high と判定されていた。

実データでのシミュレーション（635件）: critical 20 / high 84 / **medium 271** / low 260。
- 新たにアプリ表示候補になる（no_post → medium）: 271件 = 個別銘柄のカテゴリ 164 + IRの小分類 99 + 市場全体 8
- 市場全体の8件: 原油100ドル超、米国によるタンカー攻撃、中国の半導体材料の対日輸出措置、イランのミサイル、ホルムズでの米艦攻撃の主張、半導体株の反発、日銀のドル円データ、中国の関税引き下げの意向表明
- X 対象（critical + high）は 104件で、現在の important 以上の件数と一致（変化なし）

### holdings_vs_watchlist_policy

`proposedDeliveryPolicy` として、コードで表現した（**どこからも呼ばれていない＝本番では無効**）:

| 対象 | Push候補 | アプリ一覧 |
|---|---|---|
| 保有銘柄（holding） | critical + high | critical・high・medium |
| ウォッチ銘柄（watch） | critical のみ（将来、ユーザー設定で high も） | critical・high・medium |
| 市場全体のみ（market_only） | **なし**（市場アラート設定、または銘柄・セクターとの関連付けができるまで） | critical・high・medium |

X への出し分けは、この関数では決めない（`xDecidedByExistingGate: true`）。X は引き続き、既存の importance ベースの公開ゲートだけが決める。

### chosen_phase1_implementation

- 新規 `supabase/functions/important-news-monitor/news_severity_logic.ts`（pure module）: 分類表 + IRの小分類 + severity の導出 + 配信ポリシー（設計）
- 新規 `news_severity_logic_test.ts`（20件）
- **取得元の追加・判定プロンプトの変更・スキーマ / RPC の変更・index.ts への組み込みは、どれも行っていない**。理由:
  1. どの取得元を足しても、判定で important 以上になった瞬間に X へ直行するので、X投稿が増えうる（今回は禁止）
  2. severity を保存・表示するには、列（またはテーブル）と `/news` RPC の変更が必要で、今回は禁止
  3. したがって Phase 1 の安全な最小実装は、「既存データから何を見せるべきかを決める純粋な規則」を確定し、実データで検証するところまでとした

### why_x_publish_volume_does_not_increase

1. **本番のコードパスが変わっていない**: 新しいモジュールは `index.ts` から import されていない（テストで固定: `index.ts` にモジュール名が含まれないことを確認）。deploy もしていない。
2. `deriveNewsSeverity` は `importance` を読むだけで、書き換えない（入力を変更しないことをテストで確認）。
3. no_post の項目は、31カテゴリ × 関連度5通り × Fact 3通り × 取得元4種 × company_code の有無、のすべての組み合わせで medium 以下になることをテストで確認。
4. 新たにアプリ候補になる項目を、実物の `checkPublishCandidate` に通すと、すべて不合格になることをテストで確認（importance が no_post、または Fact 未確定のため）。
5. 取得元・判定プロンプト・publish ゲート・cutover・rate control は変更なし。

### changed_files

- `supabase/functions/important-news-monitor/news_severity_logic.ts`（新規）
- `supabase/functions/important-news-monitor/news_severity_logic_test.ts`（新規）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

既存ファイルの変更は無い（producer・publish・判定・取得・index.ts すべて無変更）。

### tests

- `news_severity_logic_test.ts`: **20 passed / 0 failed**
  - 分類表が全31カテゴリを網羅している / company_code があれば範囲は company
  - X 級2段の意味の維持（Fact passed のときだけ critical / high。未確定は medium どまり）
  - 個別銘柄の保有者向けカテゴリ17種が medium
  - 本番の実際の見出しで、IRの小分類を判別できる（月次・優待の新設/廃止・分割・希薄化・社長交代・CRL・サービス停止・火災・上場廃止・社債）
  - 本番で却下された定型IR（監査役・子会社の設立・支店の閉鎖・内部統制・基準日・子会社からの配当・貸借銘柄）は low
  - company_code の無い企業ニュースは low（届け先が無い）
  - 市場全体の正の例: カナダの報復関税、中国の半導体材料の輸出措置、米イラン衝突と原油、対ロ制裁、自動車関税の大統領令、ホルムズの封鎖
  - 検証済みの X 級の市場イベント（日本車への即時追加関税）は critical
  - 政治的な雑談・影響の無い声明（晩餐会へのコメント、自律型兵器、平和への呼びかけ、日銀の見学会）は low
  - 日銀の講演・会見・統計（関連度 medium・未確定）は low。同じ関連度でも Fact passed なら medium
  - 未確定の Web 検索結果は、関連度 high でなければ表示しない
  - 必須の根拠（https の source_url・公開日時）が欠けたら、最重要でも low
  - 未知の関連度の値は「経路なし」扱い
  - **新たに表示候補になる項目は、既存の X 公開ゲートを通らない**（実物の `checkPublishCandidate` で確認）
  - **no_post が X 級になる組み合わせは存在しない**（全組み合わせで確認）
  - 配信ポリシーの設計（保有 / ウォッチ / 市場全体）
  - 本番パイプラインに組み込まれていない（index.ts に参照が無い）
- important-news-monitor 全体の回帰: **314 passed / 0 failed**（既存の importance 判定、X 公開ゲート、producer、対象判定、重複防止、グルーピングのテストを含む。すべて無変更で通過）
- `deno check`: `news_severity_logic.ts` と `news_severity_logic_test.ts`
- `git diff --check`: clean

### production_changes

**none**。Edge Function の deploy・migration・RPC・Cron・auto_publish・secrets・candidate の status・notification・X投稿、いずれも変更なし。本番へのアクセスは read-only の確認だけ（Function の version / ソースのバイト照合: v38 が HEAD と17/17一致、候補の件数・分類、判定の付随項目の分布）。

### commit_hash

- この直後の commit で、新規モジュール・テスト・本 Report を記録する

### push

- `origin/main` へ同期済み

### remaining_issues

1. **severity を保存する場所が無い**。アプリで medium を見せるには、列（例: `app_severity`、`ir_subtype`）または派生ビューと、`/news` RPC の拡張が必要（Phase 2）。
2. **市場全体ニュースの届け先の設計**。company_code が無いものは、今は通知もアプリ表示もされない。セクターや資産（原油・半導体・ドル円など）と保有銘柄を結び付けるか、「市場アラート」のユーザー設定が必要。全ユーザーへの一律配信はしない前提。
3. **取得面の穴**: 株主優待・株式分割・社長交代・格付けなどの専用カテゴリが無い（今回は見出しからの小分類で代用）。米大統領令・BIS・OFAC・財務省（日本）の為替介入実績・OPEC+ などは、専用の取得元が無い。
4. **判定の強制 no_post が、アプリ表示にとっては強すぎる**。X の防御としては維持すべきだが、アプリ用には「根拠の不足を明示して表示する」選択肢がありうる。今回の severity は、市場全体では関連度 high が必要、個別銘柄では Fact 未確定の X 級を medium どまり、というところまでにとどめた。
5. 月次速報（71件/週）は件数が多い。保有銘柄に限れば1ユーザーあたりは少ないが、アプリ一覧での見せ方（折りたたみ、既定では表示しないなど）は、プロダクトとして決める必要がある。
6. 小分類は見出しのキーワードによるもので、取りこぼしや誤判定がありうる（例: 「延期」「中止」を含む定型文）。
7. 前タスクまでの既知課題は継続。

### safety_checks

- 本番 deploy・migration・RPC・Cron・auto_publish・secrets・OAuth・alert_settings の変更なし
- X 投稿基準の緩和なし。auto_publish の対象拡大なし（公開ゲートは無変更。新しい規則は、どの入力でも X 級を増やせないことをテストで確認）
- Push の配信対象の拡大なし（producer は無変更）。company_code の無い市場ニュースを、全ユーザーへの通知につなげていない
- 人工の candidate の作成、candidate の status の変更、notification の作成、X 投稿、いずれもなし
- 取得元の追加なし（一般的な Web クロールの追加なし）
- 共有 checkout の未コミット変更には触れていない
- 本番へのアクセスは read-only のクエリと、Function ソースのダウンロードだけ

### phase2_recommendation

1. **severity の保存**: `important_news_candidates` に `app_severity`・`ir_subtype` を追加し、判定時に `deriveNewsSeverity` の結果を書く（または、既存の列から導く派生ビューにする。こちらは判定コードに触れずに済む）。既存の行も、保存済みの判定結果から後付けで計算できる。
2. **アプリ表示の拡張**: `/news` RPC を、importance ではなく severity（critical・high・medium）で絞る形に拡張する。status は `rejected` も含める（severity が medium 以上のときだけ）。この段階でも、X とPushは現状のまま。
3. **Push ポリシーの段階的な有効化**: まず保有銘柄の high（= 現在の X 対象と同じ）から。medium の Push は行わない。ウォッチ銘柄は critical のみ。
4. **市場全体ニュースの届け先**: `affected_entities` と分類表の伝わり方から、影響する業種・資産のタグを付け、保有銘柄の業種と突き合わせる。または「市場アラート」のユーザー設定を用意する。どちらも全ユーザー配信にはしない。
5. **取得元の追加は、severity の分離の後に**: 米大統領令・BIS・OFAC・日本の財務省などを足す場合は、新しいレーンを「アプリ専用（X 対象外）」として publish ゲートで除外する仕組みを先に作る（fail-closed）。
6. 小分類で見えてきた株主優待・株式分割・社長交代・増資などを、専用のカテゴリに昇格させるかを検討する（判定プロンプトとスキーマに影響するため、別タスクとする）。
