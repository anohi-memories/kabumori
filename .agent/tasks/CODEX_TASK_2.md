# Codex Task 2

- task_id: broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: Phase 4自然観測で判明した「収集段階の取りこぼし」と「all_usefulでも市場ニュースに登録業種一致が必要で通知・アプリ表示・日本語化が狭い」問題を、安全に改善する。collection / app visibility / push policy の分離原則を維持しつつ、広く集め、ユーザーが選んだ通知量に応じて市場全体ニュースを正しく届ける。

## Approved prior state

Phase 4 `broad-news-phase4-natural-push-observation-20260913` はK1 PASS。

自然観測で確認済み:
- ホルムズ海峡付近の商船攻撃を自然取得→分類→判定→X公開まで確認。
- `coverage_categories=[geopolitics, shipping_logistics]`, `coverage_severity=high` の複数カテゴリ分類が実データで動作。
- TDnet企業IRにも複数カテゴリ付与が動作。
- duplicate enqueue 0、pending/processing backlog 0、failed notification 0。
- 統合producerの正のenqueue / Push到達は未観測。
- 現在ユーザー設定は本人操作により `notification_preset='all_useful'`, `emergency_alerts=true`, 16カテゴリすべてenabled=true。
- `supabase db push` は引き続き禁止。migration履歴乖離あり。

Phase 4で判明した直接問題:

1. **収集取りこぼし**
   - 2026-09-13の「サウジの原油パイプライン復旧に5〜6週間」という続報がcandidateに入らなかった。
   - fetch Cron自体は正常。
   - `commodities_energy_supply` topicも実行されたが `rawCandidateCount=0`。
   - ゲート除外ではなく、web_searchから候補自体が上がっていない。
   - 現状は許可ドメイン、1 topicあたり検索回数、鮮度3時間、続報専用クエリの不足が主因候補。

2. **all_usefulの意味が狭すぎる**
   - 現状market-wideはemergency以外、登録銘柄の業種一致が必要。
   - そのため `all_useful` でも原油・海運・地政学など、保有外だが市場全体に重要なニュースが通知されない。
   - 同じ業種一致条件が、Pushだけでなく **アプリ表示** と **日本語app copy生成対象** にも効いている。
   - 例: ホルムズ商船攻撃はseverity highだが登録業種一致0のため、通知0・アプリ表示対象外・app copy対象外。

ユーザー方針:
**まず広く収集する。通知量はユーザー設定で調整する。収集や市場全体ニュースを保有業種だけに狭めて静かにする設計にはしない。**

## Goal

### Phase 5A — collection expansion

重要な市場ニュース、とくに続報を拾う確率を上げる。

最低限、以下を監査し、過剰コストやノイズを避けながら改善する:

1. 許可ソース / domain coverage
   - Reuters / AP / Bloomberg / 日経 / 政府系だけで不足しているエネルギー・商品・海運の一次/準一次ソースを追加候補にする。
   - 例: S&P Global Commodity Insights / Platts系、Argus Media、EIA、IEA、OPEC、主要取引所・当局等。
   - 有料本文依存や信頼性不明サイトを安易に広げない。
   - URLを無条件許可するのではなくsource policyを維持。

2. web_search breadth
   - 現在1 topicあたり1 searchなら、重要固定topic / 続報topicのみ2 search等の段階的拡張を検討。
   - 全topic一律で無制限に増やさない。
   - 1時間あたりsearch数 / 想定コストをReportする。

3. freshness
   - breaking marketの3時間制限が続報を落とす場合、6時間程度へ緩和を第一候補にする。
   - 必要なら「初報」と「進行中事象の続報」で別freshnessを持つ。
   - 12時間等へ広げる場合は重複・古報再浮上リスクを定量評価。

4. follow-up topic
   - 進行中事象の「復旧見通し / 停止期間 / 供給量 / 航行再開 / 被害更新 / 制裁追加 / 政策変更」などを拾う専用query/topicを追加する。
   - oil_energy / shipping_logistics / geopolitics / financial_system等に効く設計。

5. zero-result diagnostics
   - topicごとの `rawCandidateCount=0` 連続回数を診断できるようにする。
   - 連続空振りが可視化できればよい。新しい永続DBテーブルが不要なら既存run diagnosticsへ載せる。
   - 収集改善のためだけにCron増設はしない。

### Phase 5B — `all_useful` market-wide semantics

**設計判断: `all_useful` は market-wide medium以上を、登録銘柄/業種一致なしでも対象にする。**

理由:
- Phase 3で定義した `all_useful` は「market-wide medium以上」。
- 現行の業種一致は、その意味を実質的に狭めている。
- ユーザーは原油・海運・地政学など保有外の重要ニュースも受け取りたい。

必須:
- `all_useful`
  - market-wide: medium / high / critical / emergency → 業種一致不要
  - low → 引き続きPushしない
  - category OFFは尊重
  - push_enabled / important_news / Fact passed / 日本語copy / freshness / dedupeは必須
- `quiet / standard / many`
  - 既存プリセットの意図を壊さない。
  - 原則として現行market thresholdを維持し、業種一致を残すか外すかは実データ件数を比較してReportする。
  - **勝手に全presetを広げない。** 今回の確定変更対象は `all_useful`。
- emergency
  - 従来どおり全presetで専用gateに従い、業種一致不要。
- company/holding/watch
  - 既存挙動を壊さない。

### Phase 5C — app visibility / Japanese app copy alignment

`all_useful` ユーザーについて、通知だけ広げてアプリに記事が無い状態を作らない。

必須:
- `all_useful` の market medium+ は登録業種一致なしでもアプリ一覧対象。
- 英語ニュースならapp copy生成対象にも入る。
- Fact-passed日本語copyのみ表示する既存安全条件を維持。
- lowは一覧対象外のまま。
- category/severity日本語ラベルを維持。
- detail routeを維持。
- `quiet / standard / many` のアプリ表示方針は現行仕様との整合を確認し、不要に狭めたり広げたりしない。

## Important design boundary

collection / app visibility / push notification policy は分離する。

- collectionはユーザーpresetに関係なく広く取る。
- app feed / app copy / push eligibilityはユーザー設定に基づいて決める。
- 収集を狭めて通知量を抑える設計に戻さない。

## Required startup / parallel safety

開始前に必ず読む:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/tasks/CLAUDE_TASK_1.md`
6. `.agent/tasks/CLAUDE_TASK.md`
7. Phase 4 Report in `.agent/tasks/CLAUDE_TASK_1.md`
8. `docs/news-coverage/REDESIGN.md`
9. fresh `origin/main`
10. production read-only current state

必ずisolated clean worktree/cloneを使用。
既存未コミット変更は他workstream所有物として触らない。

現在H1は `x-test-post` / AI Lab multibrand系を扱っている。今回H2は原則以下に限定:
- `important-news-monitor`
- broad news coverage pure logic/tests
- app important-news feed/settings関連
- 必要なら新しいapproved migration候補

H1の `x-test-post`, OAuth, Vault, social_accounts, AI Lab routing, close report等には触らない。

Push hardening境界:
- `send-push-notifications` sourceは変更しない。
- `claim_pending_push_notifications` RPCは変更しない。
- notifications claim/retry/CAS schemaは変更しない。
- Push eligibilityはproducer側で決定し、既存queueへenqueueする。

競合が見つかった場合は開始せず、具体的なファイル/RPC/FunctionをReportする。

## DB / migration safety

market visibility / producer RPCの変更でSQLが必要なら、新しいexpand/replace migrationを作ってよい。

ただしC2前は:
- production migration適用禁止
- production RPC変更禁止
- production Edge Function deploy禁止
- `supabase db push` 禁止
- migration history repair/reconcile禁止

migration履歴は既知の乖離あり。
C2承認後の本番反映も1ファイル単位 + rollback-contained proof + read-back前提。

## Tests — collection

最低限:
- サウジ原油パイプラインのような「同一事象の重要続報」をquery/topicが対象にできるfixture
- oil_energy / shipping_logistics / geopolitics / financial_system follow-up query coverage
- source allowlist追加先のaccept/reject
- freshness境界（現行3hと新しい閾値）
- stale再浮上防止
- duplicate / same_event回帰
- zero-result diagnostic count
- search budget cap
- North Korea/J-Alert/disaster fixed coverage回帰
- existing broad-news source validation回帰

## Tests — `all_useful`

以下を明示的に証明:
- all_useful + market medium + sector mismatch → eligible
- all_useful + market high + sector mismatch → eligible
- all_useful + market critical + sector mismatch → eligible
- all_useful + market low → ineligible
- all_useful + category OFF → ineligible
- all_useful + Fact fail → ineligible
- all_useful + stale → ineligible
- all_useful + duplicate → 0 additional enqueue
- emergency + sector mismatch → existing eligible behavior preserved
- push_enabled=false → 0
- important_news=false → 0
- company holding/watch regression
- quiet / standard / many regression
- market_critical legacy compatibility regression

## Tests — app visibility / copy

- all_useful + market medium + sector mismatch → feed visible
- all_useful + English market medium + sector mismatch → app copy target
- generated app copy Fact fail → hidden/fail-closed
- low → hidden
- old company behavior regression
- registered-sector matching behavior regression
- category/severity label regression
- no tracked stocksでもall_useful market medium+ feedを取得できること

## Volume / cost review

Report必須:

### Collection
- 現行 vs 変更後の1時間あたりweb_search最大回数
- 1日あたり概算増分
- 直近7日データに対する追加候補見込み
- 古い/重複ニュース再流入リスク

### Notification / app
直近7日実データで:
- all_useful旧条件（業種一致あり）対象件数
- all_useful新条件（業種一致なし）対象件数
- severity/category別増分
- 1日平均Push見込み
- app feed件数増分
- 原油/海運/地政学の具体例

通知が極端に増える場合、実装を勝手に縮めずC2へ件数と選択肢をReportする。

## Static / regression

- important-news-monitor relevant runtime suite
- personalized report / dispatcher regression（source変更なしでも既存suite確認）
- app tests
- app `tsc`
- changed Deno checks
- `git diff --check`

既知の無関係エラーは新規エラーと分離してReportする。

## Production prohibitions before C2

- Edge Function deploy
- DB migration/RPC/schema apply
- Cron変更
- user settings変更
- manual/synthetic Push
- synthetic production candidate
- X投稿 / manual X API
- OpenAI production manual invoke
- `supabase db push`
- migration history repair/reconcile
- OAuth/Vault/token操作

read-only production auditは可。

## Completion

実装・テスト・read-only試算まで完了したら:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` を今回結果で更新
- origin/mainへ安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- current_collection_bottlenecks
- collection_changes
- source_policy_changes
- search_budget_before_after
- freshness_before_after
- followup_topic_behavior
- zero_result_diagnostics
- current_all_useful_behavior
- new_all_useful_behavior
- app_visibility_changes
- app_copy_changes
- producer_changes
- dispatcher_changes (expected: none)
- schema_or_migration_changes
- 7day_collection_estimate
- 7day_notification_estimate
- app_feed_estimate
- tests
- production_changes (expected: 0 before C2)
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

C2承認までは本番反映しない。
