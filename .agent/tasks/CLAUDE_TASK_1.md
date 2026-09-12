# Claude Task 1

- task_id: broad-market-news-coverage-phase2-production-wiring-20260912
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus 5
- purpose: Phase 1で特定したニュース収集の穴を埋め、北朝鮮ミサイル・ホルムズ海峡攻撃級を収集段階で落とさない広域ニュース収集と分類を、既存の重要ニュースパイプラインへ安全に接続する。Push量の拡張はまだ行わない。

## Prior phase / K1 approval

Phase 1 `broad-market-news-collection-and-user-notification-control-20260912` はK1承認済み。

確定事項:
- 北朝鮮ミサイルは severity/notification で落ちたのではなく、source discovery/query 段階で未検索だった。
- ホルムズ関連は一部候補化されており、事象によってはその後の分類・関連度・表示/通知条件で落ちる。
- 現行の制約は保存上限ではなく、取得元と検索トピックの不足。
- collection / classification / notification policy を分離する。
- `emergency / critical / high / medium / low` とカテゴリ分類の設計は `docs/news-coverage/REDESIGN.md` を正とする。
- Phase 1で追加した `news_coverage_logic.ts` / `news_collection_scope_proposal.ts` は未接続実装。既存本番挙動は変更していない。
- Phase 1 tests: 157 pass / 0 failed、deno check PASS、git diff --check PASS。

## Goal for Phase 2

まず「広く拾える」状態を作る。

このPhaseでは、通知量を増やすことより先に、以下を達成する。

1. 北朝鮮・ミサイル・Jアラート級を候補化できる。
2. ホルムズ・中東・海運・原油供給途絶を安定して候補化できる。
3. 災害・金融政策・主要市場インフラ障害なども広域収集対象へ入る。
4. 保存時に severity / category / market-wide / relevance を付けられる。
5. `emergency` は保有銘柄・監視銘柄・sector一致がなくても保存される。
6. 既存のTDnet/企業IR/個別重要ニュース経路を壊さない。
7. Push eligibilityは現行のまま維持し、今回の収集拡張だけで通知量を急増させない。

## Required implementation

### A. Breaking-market query coverage

既存 `important-news-monitor` の breaking_market 検索を拡張する。

最低限、以下を明示的な検索対象に含める。
- North Korea / 北朝鮮 / missile / ballistic missile / projectile / J-Alert / EEZ
- Hormuz / Strait of Hormuz / tanker attack / shipping attack / blockade / maritime security
- Iran / Israel / Middle East escalation / Gulf shipping
- oil supply disruption / crude spike / energy supply
- Taiwan Strait / military escalation
- major earthquake / tsunami / disaster / major infrastructure outage
- emergency central-bank action / emergency rate move
- exchange outage / clearing / financial-system disruption

既存4トピックを無制限に増やして検索コストを暴騰させないこと。
Phase 1設計に沿って固定/回転トピックを再設計し、各重要カテゴリの最大未監視頻度を明示する。

### B. Primary / authoritative sources

実装可能な範囲で一次情報源を追加する。

優先候補:
- 防衛省 / 統合幕僚監部
- 首相官邸 / 内閣官房の緊急情報
- 気象庁（地震・津波等）
- 日本銀行
- FRB
- EIA
- UN等、既存の信頼できる一次情報

HTML/RSS/APIの安定性・利用条件・取得コストを確認し、壊れやすいスクレイピングを無理に増やさない。
一次情報を追加できないカテゴリは breaking_market web search で補完し、Reportへ理由を書く。

### C. Classification wiring

Phase 1で追加した未接続ロジックを既存パイプラインへ安全に接続する。

最低限:
- severity: emergency / critical / high / medium / low
- category: geopolitics / disaster / monetary_policy / fx / rates / oil_energy / commodities / shipping_logistics / semiconductors / ai_tech / us_market / japan_market / regulation_policy / corporate / earnings / financial_system
- market-wide eventをcompany_codeなしで保持できる既存構造を優先
- Fact未通過はPush対象にしない既存原則を維持
- cross-source same-event dedupeを弱めない

`emergency` の例:
- 日本周辺の弾道ミサイル/Jアラート級
- ホルムズ封鎖・大規模攻撃
- 戦争の急拡大
- 台湾有事級
- 大規模地震・津波
- 緊急金融政策
- 主要取引所/決済インフラの重大障害
- 大規模な原油供給途絶

誤報防止のsource/Fact gateは維持する。

## Important product rule

**収集するかどうかと通知するかどうかを分離する。**

このPhaseで新しいニュースを多く保存しても、ユーザーのPush通知条件を勝手に広げない。

- `send-push-notifications` のclaim/retry実装を変更しない。
- notifications claim RPCを変更しない。
- `alert_settings` のpreset/category schemaはまだ本番適用しない。
- emergency用の新PushをこのPhaseで勝手に有効化しない。

まずDBに「拾えている」状態を作り、K1後に実データを観測してから通知Phaseへ進む。

## Read / parallel safety

開始前に必ず確認:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- このTASK
- `.agent/tasks/CLAUDE_TASK.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- `docs/news-coverage/REDESIGN.md`
- origin/main fresh-check

G2はX複垢/OAuth作業中。以下は触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- X token / callback

Codex Push hardeningと競合させない:
- `send-push-notifications` claim/retry
- `claim_pending_push_notifications`
- notifications claim schema/RPC

同じファイル/DB migration/RPC/Edge Functionを別slotが現在変更している場合は開始せず、競合箇所を具体的に報告する。

## Migration / production safety

migration historyは乖離中。

禁止:
- `supabase db push`
- migration history repair/reconcile
- destructive migration
- unrelated schema/RPC変更
- Cron変更
- synthetic production candidate/notification
- manual Push
- X投稿
- user alert settings変更

### Production rollout rule

まずローカル実装・テストを完了する。

既存 `important-news-monitor` の本番deployや本番schema変更が必要な場合:
1. exact diffとテスト結果をReportへ出す
2. statusを `review_required / next_owner: chatgpt`
3. **K1前には本番deployしない**

read-only本番調査は可。

## Tests

最低限:
- North Korea missile fixture → candidate対象
- J-Alert / EEZ系fixture → geopolitics + emergency候補
- Hormuz tanker/shipping attack fixture → shipping_logistics + geopolitics、重大条件でemergency
- oil supply disruption fixture → oil_energy
- earthquake/tsunami fixture → disaster
- emergency central-bank action → monetary_policy
- ordinary low-impact geopolitical articleを過剰にemergency化しない
- market emergencyはtracked stock / sector一致なしでもcollection/save eligibility true
- notification OFFでもcollectionはtrue
- Fact failはPush eligibility false
- company news existing dedupe regression
- existing severity SQL parity regression
- breaking_market resource/search budget
- important-news monitor regressions
- deno check
- git diff --check

可能なら、Phase 1で問題になった北朝鮮/ホルムズ相当の実ニュース本文・タイトルを匿名化fixtureとして追加する。

## Completion / Report

完了時:
- status: `review_required`
- next_owner: chatgpt
- origin/mainへ安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- query_topics_before_after
- primary_sources_before_after
- north_korea_coverage
- hormuz_coverage
- disaster_coverage
- classification_wiring
- collection_vs_notification_boundary
- resource_cost / search cadence
- changed_files
- tests
- production_changes
- deploy_status
- commit_hash
- push
- remaining_issues
- next_recommendation

本番変更が0なら明記する。K1で承認されるまでは本番deployしない。


## Report

- task_id: broad-market-news-coverage-phase2-production-wiring-20260912
- result: **ローカル実装・テスト完了。本番変更は0件。** 収集トピックを4本→11本（1サイクル2検索→4検索）、気象庁の一次フィードを追加、`disaster` カテゴリを追加、coverage分類（カテゴリ・emergency・severity）を既存パイプラインへ接続した。通知側（プリセット・カテゴリ設定・emergency Push）は未接続のままで、**誰のPush条件も変えていない**。K1承認までdeployしない。
- model_used: Claude Opus 5
- source_base: `origin/main` `7e1b9e9`（Phase 1 = `2329a76` の続き）。実装コミット `d4a85c6`。

### query_topics_before_after

| | before | after |
| --- | --- | --- |
| トピック数 | 4 | **11** |
| 1サイクルの検索数 | 2（固定1＋回転1） | **4（固定3＋回転1）** |
| 固定トピック | critical_market_events | critical_market_events / **japan_security_emergency** / **disaster_infrastructure** |
| 検索数/時 | 6 | **12** |
| 回転トピックの最大未監視時間 | 60分（回転3本） | **160分（回転8本）** |

追加した7本（既存4本は文言もkeyも変更なし）。

| key | slot | 対象 |
| --- | --- | --- |
| `japan_security_emergency` | 固定 | 北朝鮮 / ミサイル / 弾道 / Jアラート / EEZ / 日本海 / 台湾海峡 / 防衛省 |
| `disaster_infrastructure` | 固定 | 地震 / 津波警報 / 噴火 / 台風 / 避難 / 停電 / 製油所・工場停止 |
| `shipping_chokepoints` | 回転 | ホルムズ / スエズ / 紅海 / バブエルマンデブ / パナマ運河 / タンカー攻撃・拿捕 / 運賃 |
| `financial_system_infrastructure` | 回転 | 取引所障害 / 売買停止 / 清算・決済障害 / 銀行取り付け / サイバー攻撃 |
| `commodities_energy_supply` | 回転 | OPEC減産 / 原油供給途絶 / 輸出禁止 / LNG / 金・銅・鉄鉱石・レアアース |
| `us_market_session` | 回転 | 米指数 / SOX / 半導体 / AI設備投資 / 米国債利回り |
| `japan_market_session` | 回転 | 日経225 / TOPIX / 円相場 / 日銀 / 経済対策 |

- コスト上限の作り方も変えた。`selectBreakingMarketQueriesForCycle` は固定トピックを毎サイクル選び、残り枠を回転させる。`maxPerCycle` は引き続き絶対上限で、固定が枠より多い場合は宣言順に切り捨てて**上限を超えない**。
- `maxUnwatchedMinutes()` を追加し、最大未監視時間（160分）をテストで固定した。

### primary_sources_before_after

read-onlyで候補8本を実際に叩いて確認した（2026-09-12）。

| 候補 | 結果 | 対応 |
| --- | --- | --- |
| 気象庁 地震・火山 `eqvol.xml` | **200 / Atom** | **追加した** |
| 気象庁 気象警報 `extra.xml` | 200 / Atom | 追加しない（等級が本文にしか無く、大半が注意報。タイトルは定型の「気象特別警報・警報・注意報」） |
| 防衛省 `mod.go.jp/j/rss/press.xml` | **403**（Cloudflare） | breaking_market のWeb検索で補完（`mod.go.jp` をsource許可ホストへ追加） |
| 財務省 `mof.go.jp/rss/all.xml` ほか | 404 | 同上（既存の `mof.go.jp` 許可は維持） |
| JPX `jpx.co.jp/rss/news.xml` ほか | 404 | Web検索で補完（`jpx.co.jp` を許可ホストへ追加） |
| 首相官邸 `kantei.go.jp/jp/rss/index.rdf` ほか | 404 | Web検索で補完（`kantei.go.jp` を許可ホストへ追加） |
| 米財務省 press releases | 302 → HTML | Web検索で補完（既存の `treasury.gov` 許可を維持） |
| 米商務省BIS newsroom rss | 301 → HTML | Web検索で補完（既存の `bis.doc.gov` 許可を維持） |

- 壊れやすいHTMLスクレイピングは**1件も追加していない**（タスクの指示どおり）。
- 気象庁フィードは routine が支配的なので、専用フィルタ `isSignificantJmaItem` を通す。
  - タイトルが「震度速報 / 震源・震度に関する情報 / 津波警報・注意報・予報 / 津波情報 / 緊急地震速報 / 噴火警報 / 噴火速報 / 火口周辺警報」のいずれか
  - かつ本文（またはタイトル）に「大津波警報 / 津波警報 / 震度5〜7 / マグニチュード6〜9 / 緊急地震速報（警報）/ 噴火警報 / 噴火速報 / 噴火警戒レベル4〜5」
  - これで「降灰予報（定時）」「波浪注意報」「最大震度２」は候補化しない。
- `MarketMacroSource` に汎用の `include?` フックを追加した（使っているのは気象庁のみ）。既存5フィードの挙動は変わらない。
- breaking_market の許可ホストへ `jma.go.jp / mod.go.jp / kantei.go.jp / jpx.co.jp / fdma.go.jp / nhk.or.jp` を追加。**許可されるのはURLの適格性だけ**で、実際に訪問したURLか・https・鮮度・カテゴリの既存ゲートはすべてそのまま適用される。

### north_korea_coverage

- 原因（Phase 1で確定）: 検索トピックに北朝鮮・ミサイル・Jアラートの語が無く、日本の一次情報も未購読 → **fetch以前で落ちていた**。
- 対応: `japan_security_emergency` を**固定枠**に置いた（回転だと最大160分待ちになるため）。`mod.go.jp` / `kantei.go.jp` / `nhk.or.jp` を許可ホストへ追加。
- 分類: 「North Korea fires ballistic missile that fell inside Japan's EEZ」→ categories に `geopolitics`、emergency class `missile_near_japan`。日本語の「Jアラート発令 北朝鮮から弾道ミサイル発射」（官邸ドメイン）も同じ結果。テストで固定。

### hormuz_coverage

- 対応: `shipping_chokepoints` を回転枠に追加（既存の `war_geopolitics_taiwan` も維持）。
- 分類: 「Tanker reportedly struck by unknown projectile in northern Persian Gulf」＋本文にホルムズ → categories は `geopolitics` / `shipping_logistics` / `oil_energy`、emergency class `chokepoint_disruption`。**これはPhase 1で severity low になりアプリから消えていた実データそのもの**。
- 過剰検出はしない: 「Shipping rates ease on the Suez route」「Tanker charter rates rise on strong Asian demand」は emergency にならない（事象＋深刻度の両方一致が必要）。
- 原油供給: 「Saudi refinery shutdown after attack cuts crude supply」→ `oil_energy` ＋ `oil_supply_disruption`。

### disaster_coverage

- `disaster` を `IMPORTANT_NEWS_CATEGORIES`（TS）と DB の category check（migration）へ追加。これまで地震・津波は `major_security_incident` か `other_market_moving` にしか入れられなかった。
- severity taxonomy に `disaster`（market scope、伝達経路「地震・津波・噴火・大規模障害→インフラ・保険・建設・供給網」、holderRelevant false）を追加。**SQLミラーのパリティテストは合格**（ミラーは company 側の holder-relevant 一覧のみを持つため影響なし）。
- 収集: 固定枠 `disaster_infrastructure` ＋ 気象庁フィード。
- 分類: 「震度6強の地震 大津波警報を発表」→ `disaster` ＋ `major_disaster`。「Japan holds nationwide earthquake preparedness drill」は `disaster` だが emergency ではない。

### classification_wiring

2箇所だけに接続した（どちらも既存の判断列は変更しない）。

1. `insertCandidate`（保存時）: `classifyCollectionCoverage` で `coverage_categories` と、鮮度・一次情報ホストのゲートを通った場合の `emergency_class` / `coverage_severity='emergency'` を書く。severityの残りは判定後に決まるので null。
2. `saveCandidateJudgement`（判定保存時）: `classifyCoverage` で判定結果（importance / japan_market_relevance / fact_check_status）を使って `coverage_severity` を確定する。**保存時に記録済みの emergency は維持する**（判定は数分〜数時間後に走るため、鮮度窓を過ぎて黙って格下げされるのを防ぐ）。新しい `priorEmergencyClass` 引数でこれを明示した。

- emergency のゲート（維持）: 一次情報ホスト＋https、サブドメインのみ許可（`reuters.com.evil.example` は不可）、公開6時間以内、時刻パース可能、事象＋深刻度の両パターン一致、企業コード付き開示は対象外。
- market-wide は既存構造どおり `company_code is null` のまま。migration の check で「emergency は company_code が null のときだけ」を強制。
- cross-source same-event dedupe（`important_news_same_event` と既存の重複判定）は**一切変更していない**。
- Fact未通過はPush対象にしない原則は、通知側が未接続のためそのまま維持。
- `JudgementCandidate`（プロンプトと生成経路が使う共有型）は変更せず、index.ts ローカルの `JudgementWorkItem` に `emergencyClass` を持たせた。生成経路に渡すオブジェクトからは明示的に除外している。

### collection_vs_notification_boundary

- 収集・分類のコードは、ユーザー・保有銘柄・業種・通知設定を**1つも読まない**（`classifyCollectionCoverage` の入力はニュース1件のみ）。テストで `tracked_stocks` / `alert_settings` を参照していないことも静的に固定。
- `notificationEligibility` / `PRESET_THRESHOLDS` / `notification_preset` は index.ts から参照されていない（静的テストで固定）。
- `send-push-notifications` の claim/retry、`claim_pending_push_notifications`、notifications のschema/RPC、`alert_settings` は**触っていない**（Codex slot 2 の作業領域）。
- migration にも `alert_settings` / `notifications` / RPC定義は含まれていない（静的テストで固定）。
- 結果として、このPhaseで保存件数が増えても**通知量は増えない**。増えるのはDBに溜まる候補と、`coverage_*` 列の中身だけ。

### resource_cost / search cadence

- web_search: 2回/サイクル → **4回/サイクル**（20分周期なので 6回/時 → 12回/時、1日 288回）。使用モデルは既存と同じ `gpt-5.6-luna`。
- 固定3本（重大市況・日本安全保障・災害）は毎サイクル。回転8本は1本ずつ、一周160分。
- 気象庁フィードはRSS取得1回/サイクル（AI呼び出しなし）。フィルタで大半を捨てるため候補化はまれ。
- レーンの保存上限（macro 30 / breaking 15 / 全体100）は変更なし。
- 判定・生成のAI呼び出し回数は1候補あたり変わらない。候補が増えればその分だけ増える。

### changed_files

実装コミット `d4a85c6`（10ファイル、+738 / -30）。

| ファイル | 変更 |
| --- | --- |
| `breaking_market_source_fetchers.ts` | +115 / 追加7トピック、slot、固定複数対応の選択、`maxUnwatchedMinutes`、上限4、許可ホスト6件追加 |
| `market_macro_source_fetchers.ts` | +45 / `include` フック、気象庁フィード、`isSignificantJmaItem`、許可ドメイン追加 |
| `news_candidate_logic.ts` | +7 / `disaster` カテゴリ |
| `news_severity_logic.ts` | +1 / `disaster` の taxonomy |
| `news_coverage_logic.ts` | +56 / `classifyCollectionCoverage`、`priorEmergencyClass`、`isEmergencyClass`、`disaster` 対応、ヘッダ更新 |
| `index.ts` | +70 / -7 / 保存時と判定時の分類書き込み、`JudgementWorkItem`、select に `emergency_class` |
| `breaking_market_source_fetchers_test.ts` | トピック数の期待値を4→11に更新（理由をコメント） |
| `market_macro_source_fetchers_test.ts` | フィード数の期待値を5→6に更新（理由をコメント） |
| `news_coverage_wiring_test.ts` | 新規355行 |
| `20260912180000_news_coverage_classification.sql` | 新規95行（**未適用**） |

### tests

- 新規 `news_coverage_wiring_test.ts`: **20 pass**
  - 必須語彙（北朝鮮・ミサイル・Jアラート・EEZ・ホルムズ・タンカー・封鎖・紅海・スエズ・イラン・イスラエル・台湾・原油供給・OPEC・地震・津波・台風・停電・取引所障害・清算・決済障害・取り付け）がトピックに含まれる
  - 検索コスト（4/サイクル・固定3本）と最大未監視時間160分、上限を超えないこと、全トピックが一巡すること
  - 気象庁フィードの登録と許可ドメイン、フィルタ（重大のみ通す／注意報・定時予報・震度2は落とす）、実際のAtom形状での解析
  - 北朝鮮ミサイル → candidate対象・geopolitics・emergency（`missile_near_japan`）
  - Jアラート（官邸ドメイン）→ geopolitics ＋ emergency
  - ホルムズのタンカー攻撃 → shipping_logistics ＋ geopolitics ＋ oil_energy、emergency（`chokepoint_disruption`）。運賃ニュースは emergency にしない
  - 原油供給途絶 → oil_energy、地震・津波 → disaster（防災訓練は emergency にしない）、緊急金融政策 → monetary_policy
  - 低インパクトな地政学記事（実データ3件）を emergency にしない
  - market emergency が保有・監視・業種一致なしで分類される／収集コードが tracked_stocks・alert_settings を読まない
  - 判定時に severity が確定し、保存時の emergency が維持される（実データのホルムズ行で確認）
  - index.ts が新しい列だけを書き、通知ロジックを一切参照していない
  - migration が expand-only（drop table/column・truncate・RPC再定義・alert_settings・notifications を含まない、落とす制約は4つの再作成のみ）
- Phase 1 の `news_coverage_logic_test.ts` は**22 pass のまま**（プリセット・emergency・Factゲート・重複・`low` は通知しない、を含む）。
- `important-news-monitor` 全体の回帰: **391 pass / 0 failed**（`--allow-read --node-modules-dir=auto --no-check`）。
- 他領域の回帰: `personalized-reports` ＋ アプリ `tests/app` = **49 pass / 0 failed**。
- `deno check`（`--node-modules-dir=auto`）: 変更した全ファイルで型エラー0。残る唯一のエラーは `supabase/functions/_shared/x_oauth2_post.ts:66`（AES-GCM の `Uint8Array` / `BufferSource`）で、**今回触っていないファイルの既存事象**であり、npm型を読み込んだときだけ出る。
- `git diff --check`: PASS。
- 環境メモ: monitor 全体の一括実行には `npm:unpdf`（TDnet PDF依存）が必要。`--node-modules-dir=auto` で取得した（リポジトリには `deno.lock` を残していない）。`official_source_fetchers_test.ts` はnpm型モードで既存の型エラーが出るため、全体実行は `--no-check` を併用した。

### production_changes

（ローカル実装時点の記録。K1承認後の本番反映は末尾「Phase 2 production rollout」を参照）

**0件。** 実施したのは read-only 調査のみ。
- DB: migration未適用（新しい列も `disaster` カテゴリも本番には存在しない）。書き込み0。
- Edge Function: deployしていない（`important-news-monitor` は本番 v46 のまま。他スロットのdeployで版が進んでいる）。
- Cron・通知・`alert_settings`・X投稿・OAuth・Vault: 変更なし。
- 外部への read-only アクセス: 候補フィード8本のHTTP確認のみ（GETのみ）。

### deploy_status

**→ K1承認後に反映済み（末尾「Phase 2 production rollout」）。** 以下は承認前の記録と手順:
1. `supabase/migrations/20260912180000_news_coverage_classification.sql` をロールバック前提のテストで検証 → 単独適用（`supabase db query --linked -f`、`db push` は使わない）。
2. `important-news-monitor` を worktree から deploy し、download してコミットとbyte比較。他Functionの版が変わっていないことを確認。
3. 順序は必須: **migrationが先**。列が無い状態で新コードが走ると、保存時のPATCH/POSTが失敗する。
4. 反映後は read-only で観測（emergency の検出件数、誤検出、候補件数の増加、AIコスト）。

### remaining_issues

- 収集件数が増えるので、判定・生成のAIコストも増える。実データでの増分はK1後の観測が必要（現在の市場全体は約80件/7日）。
- 気象庁 `extra.xml`（気象警報）と防衛省・JPX・官邸・財務省の一次フィードは未購読。Web検索頼みのままで、**取りこぼしの可能性は残る**。専用の配信（JMAのPubSubHubbub や各サイトの別経路）調査は別タスク向き。
- `coverage_severity` は保存されるが、**アプリ表示にも通知にも使われていない**（設計のrollout段階2・4がまだ）。medium帯のニュースは引き続きアプリに出ない。
- emergency はパターン方式。実データで誤検出・見逃しを観測してから閾値を調整する必要がある。
- 回転トピックの最大未監視時間160分は、ホルムズ級の事象には長い可能性がある。観測後に固定枠の追加（＝検索コスト増）を検討。
- 既存の課題は継続: migration履歴のずれ（この新規migrationも適用時には未記録になる）、テスト用監視銘柄17件、`supabase/config.toml` がGit管理外。
- 参考: 昨夜Metroを起動しっぱなしにしていたバックグラウンドプロセスが終了した（アプリ確認は完了済みなので影響なし）。

### next_recommendation

1. K1で migration＋deploy を承認してほしい（順序はmigrationが先）。
2. 反映後2〜3日、read-onlyで観測する。
   - 候補件数の増加（市場全体 / カテゴリ別）
   - `emergency_class` が付いた件数と、その妥当性（誤検出・見逃し）
   - 判定・生成のAIコスト増分
   - 既存のX投稿量・通知量が変わっていないこと（このPhaseでは変わらないはず）
3. 観測結果を見て、設計のrollout段階2（アプリ表示を medium まで広げる）→段階4（通知プリセットとカテゴリ設定）へ進む。


## Report — Phase 2 production rollout（K1承認後）

- task_id: broad-market-news-coverage-phase2-production-wiring-20260912
- result: **本番反映完了**。許可された2操作（migration単独適用 → deploy）のみを実施し、確認項目はすべて成功した。反映後の自然収集では、**北朝鮮・災害・ホルムズ等を狙う収集経路が実際に稼働していることを確認**（該当する事象は観測時間内に発生していないため、候補化された実物はまだ0件）。
- model_used: Claude Opus 5
- source_base: `origin/main` `8c9ab22`（fresh-check 済み、ff済み）。適用したmigrationとdeployしたコードは `d4a85c6` の内容。

### 事前確認

- `origin/main` fresh-check → `8c9ab22` に fast-forward（自分のPhase 2コミットは既に含まれている）。
- 他slotとの競合: なし。
  - Claude slot 2 = X複垢OAuth（done / next_owner codex）
  - Codex slot 1 = OAuth start void RPC fix（review_required / user）
  - Codex slot 2 = push配信の重複防止強化（review_required / chatgpt）
  - `important-news-monitor` と `supabase/migrations` を触った直近のコミットは自分の `d4a85c6` のみ。他slotは `x-oauth-connect` と `send-push-notifications` で、ファイル・Function・RPCの重複なし。
- migration file: `20260912180000_news_coverage_classification.sql`（sha256 `88cc9cf1d3ce4ecdaa9d03ebac1fecce7ac9e650214a62f8a7daab67d19b6cbc`）。
- 適用前に**ロールバック前提の事前テスト**を1回実施（`begin; … rollback;`）。新列4つ・制約3つ・索引3つが作られ、`disaster` が許容され、既存関数のmd5・`alert_settings` 12列・通知1件が不変であることを確認。合成candidateは一切insertしていない。

### 1. migration 単独適用

- 実行: `supabase db query --linked -f <この1ファイルのみ>`。**`supabase db push` は使用せず**、他のmigrationは適用していない。migration履歴の修復もしていない。
- 結果: 成功（`rows: []`）。

### read-back 確認（適用直後）

| 項目 | 結果 |
| --- | --- |
| 新列 | `coverage_categories`（ARRAY / NOT NULL / 既定 `'{}'`）、`coverage_severity`（text / NULL可）、`emergency_class`（text / NULL可）、`coverage_classified_at`（timestamptz / NULL可） |
| 制約 | `..._coverage_severity_check` / `..._emergency_class_check` / `..._emergency_is_market_wide` の3つ |
| 索引 | `idx_important_news_coverage_severity` / `idx_important_news_coverage_categories` / `idx_important_news_emergency` |
| `disaster` カテゴリ | 許容（category checkに含まれる） |
| 既存候補行 | 1069行のまま。`coverage_severity` が入った行は0（既存行は書き換えていない） |
| フィードRPC | md5 `2b9c575bab3579476879dbe0e69bfb7d`（事前テスト時と同一 = 未変更） |
| 市場Push producer | md5 `3cb3e858b686cfe74a9663a0f932483a`（同一 = 未変更） |
| `alert_settings` | 12列のまま。ユーザー設定も変更なし（market/push/morning/close すべて true） |
| notifications | 1件のまま |
| Cron | 10件、内容変化なし |
| migration履歴 | `20260912075354` のまま（既知の乖離を維持。修復していない） |

### 2. Edge Function deploy

read-back成功を確認したうえで実施。

- 事前: pwd = worktree、HEAD = `8c9ab22`、project ref = `wsmznyzcvmuitkglfeuj`、`supabase/config.toml` に7 Functionの `verify_jwt=false` を確認。deploy前の全Function版を記録。
- 実行: `supabase functions deploy important-news-monitor --no-verify-jwt`（script size 693 kB）。
- 結果: `important-news-monitor` **v46 → v47**（updated_at 1789099151779 → 1789225463633）。

### deploy 後の byte 比較

- `supabase functions download important-news-monitor --use-api` を空ディレクトリで実行。
- runtime source 20ファイルすべてがリポジトリと差分なし（`diff -rq` で差分ファイル0）。worktreeに未コミット変更が無いことも確認済み。
- 主要変更ファイルはHEADと**バイト単位で一致**（`cmp`）: `index.ts` / `news_coverage_logic.ts` / `breaking_market_source_fetchers.ts` / `market_macro_source_fetchers.ts`。

### 無関係Functionの不変確認

| Function | before | after |
| --- | --- | --- |
| x-test-post | v103 / 1789169005998 | **unchanged** |
| send-push-notifications | v11 / 1789199846117 | **unchanged** |
| x-oauth-connect | v11 / 1789211313465 | **unchanged** |
| personalized-reports | v9 / 1789134583041 | **unchanged** |
| market-intelligence-ingest | v7 / 1789198463413 | **unchanged** |
| stocks-master-sync | v12 | **unchanged** |
| stocks-new-listing-sync | v11 | **unchanged** |
| important-news-monitor | v46 | **v47（今回の対象）** |

`verify_jwt` は全Function false のまま（変化なし）。

### 反映後の自然収集 read-only 観測

観測窓: deploy 2026-09-12 15:04 UTC（=09-13 00:04 JST）〜 16:11 UTC（=01:11 JST）。fetch cron 3回（15:20 / 15:40 / 16:00）。**手動invoke・合成candidate・手動Push・X投稿は一切していない。**

**新しい収集経路が実際に動いていることの確認（これが今回の主眼）**

- 各サイクルの `queriesRun`（1サイクル4検索＝固定3＋回転1）
  - 15:20 → `critical_market_events`, **`japan_security_emergency`**, **`disaster_infrastructure`**, `us_market_session`
  - 15:40 → 固定3本 ＋ `japan_market_session`
  - 16:00 → 固定3本 ＋ `trump_tariff_semiconductor`
  - **北朝鮮・ミサイル・Jアラート・EEZを狙う `japan_security_emergency` と、地震・津波・停電を狙う `disaster_infrastructure` が毎サイクル走っている**。設計どおり固定枠で、回転枠は1本ずつ入れ替わっている。
- 検索の実行状況: 全トピック `providerStatus: succeeded` / `httpStatus: 200` / `webSearchCallCount: 1`、`failureCode: null`。rejectionCountsは全ゼロ。
- 公式フィード（market_macro）: 6ソースすべて `succeeded`。内訳 boj 34 / fed 3 / ustr 4 / un_peace_security 24 / **jma_eqvol 0** / eia 1。
  - **新設の気象庁フィードが本番で正常に取得できている**。0件は「観測時間内に震度5以上・津波警報・噴火警報が無かった」ためで、フィルタが意図どおり routine を落としている（降灰予報などは候補化しない）。
- `sourceErrors` は毎回空配列。ホルムズ向けの `shipping_chokepoints` は回転枠のため、この3サイクルでは未到来（最大160分で一周する設計どおり）。

**候補化・分類の実データ**

| 項目 | 値 |
| --- | --- |
| deploy以降の新規candidate | **0件** |
| `coverage_classified_at` が入った行 | 0件 |
| `emergency_class` が入った行 | 0件 |
| deploy以降のX投稿 | 0件 |
| notifications | 1件（昨日の大引けレポート通知のみ、sent） |
| pending_judgement | 0件 |

- 0件の理由は、観測窓が**土曜深夜〜日曜未明（JST）**で、TDnetの開示が無く、breaking_marketの鮮度条件（3時間以内）を満たす新しい海外ニュースも出なかったため。既存66件のフィード項目はすべて既知＝duplicate 判定で、insertは発生していない。
- したがって「**収集経路は稼働している／分類列はDBに存在し受け入れ可能**」までは確認できたが、**実物のニュースに `coverage_severity` / `coverage_categories` / `emergency_class` が書かれた行はまだ0件**。書き込み経路の実データ確認は、平日の自然発生を待つ必要がある（合成candidateは投入しない方針のため）。

**既存挙動への影響**

- X投稿0件、通知0件増（1件のまま）、`auto_publish=true` のまま、monitor `is_active=true` のまま、設定の更新日時も 2026-09-10 のまま（誰も触っていない）。
- Cron 10件のまま。`alert_settings` と `send-push-notifications` は未変更。

**観測中に見つけた別件（自分の担当外・未対応）**

- 15:53 UTC に1件だけ HTTP 500: `{"error":"UNEXPECTED_ERROR","detail":"CLAIM_PENDING_NOTIFICATIONS_FAILED:504"}`。
  - これは Codex slot 2 が本番反映した push claim RPC（`claim_pending_push_notifications`）のタイムアウトで、**今回のdeployとは無関係**（`send-push-notifications` は未変更・v11のまま）。
  - 影響: 当該分の通知は無し（pending 0件、sent 1件のまま）。1分後の次サイクルで正常に戻っている。
  - 対応はしていない（他slotの領域）。C2レビューで共有されるべき事象として記録する。

### production_changes（この反映で行ったこと、これ以外は無し）

1. `20260912180000_news_coverage_classification.sql` の単独適用（DDLのみ。データ行の更新・削除は0）。
2. `important-news-monitor` の deploy（v46 → v47）。

やっていないこと: `db push` / 他migration適用 / migration履歴修復 / Cron変更 / `alert_settings` 変更 / Push条件変更 / `send-push-notifications` 変更 / 合成candidate / 手動Push / X投稿 / 他Functionのdeploy / 手動invoke。

### remaining_issues（更新）

- **実データでの分類確認が未了**。平日（月曜以降）の自然収集で、`coverage_severity` / `coverage_categories` / `emergency_class` が実際に書かれること、および emergency の誤検出・見逃しを観測する必要がある。
- `shipping_chokepoints`（ホルムズ）は回転枠のため最大160分の空きがある。観測後、固定枠へ昇格させるか（＝検索コスト増）を判断したい。
- 検索は6回/時 → 12回/時に増えた。AI費用の増分は、平日の候補件数が出てから評価する。
- 収集が広がっても、アプリ表示と通知は従来のまま（`coverage_severity` は保存のみ）。medium帯のニュースは引き続きアプリに出ない。設計のrollout段階2（表示拡大）・段階4（通知プリセット）は未実施。
- 気象庁の気象警報フィード（`extra.xml`）と防衛省・JPX・官邸・財務省の一次配信は未購読のまま（403/404のため）。Web検索頼みの部分が残る。
- 既存の課題は継続: migration履歴の乖離（今回の適用も未記録）、テスト用の監視銘柄17件、`supabase/config.toml` がGit管理外。
- 別件: 上記 push claim RPC の 504（Codex slot 2 の領域）。

### next_recommendation

1. 月曜（2026-09-14）の日本市場の開示と海外ニュースで、以下をread-only観測する。
   - 新規candidateに `coverage_categories` / `coverage_severity` が入っているか
   - `emergency_class` が付く件数と、その妥当性（誤検出・見逃し）
   - 候補件数の増加量とAI費用の増分
   - 既存のX投稿量・通知量が変わっていないこと
2. 観測が問題なければ、設計のrollout段階2（アプリ表示を medium まで広げる）へ進む。
3. `shipping_chokepoints` の固定枠昇格と、気象警報フィードの購読可否は、段階2と合わせて判断する。
