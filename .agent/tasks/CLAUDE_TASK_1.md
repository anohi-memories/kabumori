# Claude Task 1

- task_id: broad-news-phase4-natural-push-observation-20260913
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: Phase 3本番反映後の自然ニュース経路をread-only中心で観測し、統合producerの実enqueue、Push到達、重複0、滞留0、coverage分類とアプリカテゴリ表示までを実データで確認する。新規実装や本番変更は原則行わない。

## Approved prior state

Phase 3 `broad-news-phase3-production-rollout-20260913` はK1 PASS。

確認済み:
- `20260913140000_broad_news_visibility_notification_presets.sql` は対象1本だけ本番適用済み。
- `important-news-monitor` v50 が本番稼働中。
- runtime source byte compare PASS。
- 他Function / Cron / dispatcher / claim RPCは不変。
- appのmedium表示、severity/category日本語表示、4段階preset、emergency/category設定は実画面確認済み。
- Phase 3自然観測でmarket mediumのapp copy生成5件を確認。
- Phase 2 coverage分類も自然実データ1件で書き込み確認済み。
- 自然Pushはまだ未観測。
- 現在ユーザー設定は本人操作により `notification_preset='all_useful'`, `emergency_alerts=true`, 16カテゴリすべてenabled=true。
- pending通知滞留0、重複enqueue 0。
- migration履歴乖離は継続中。`supabase db push` 禁止。

## Goal

自然ニュースだけで、以下を確認する。

1. 新規candidateが通常Cronで取得される。
2. `coverage_severity` / `coverage_categories` / `emergency_class` が妥当に付く。
3. medium以上のmarket/companyニュースがapp copy対象になり、Fact-passed日本語copyが生成される。
4. 現在の `all_useful` 設定に合致するニュースで統合producerがnotificationsへ実enqueueする。
5. 同一event/userへ重複enqueueしない。
6. dispatcherが自然にclaim/sendし、pending/processingが滞留しない。
7. iOS Pushが自然発生した場合、ユーザー端末到達を確認できる。
8. アプリ一覧/detailで新規記事のseverity/categoryラベルが表示される。
9. 通知量が体感として多すぎないかを件数ベースで評価する。

## Observation window

まず現在時点から次の平日ニュースが十分流れるまで観測する。

- 2026-09-14 JST以降の自然Cronを優先。
- 少なくとも東京市場の朝〜大引け、可能なら米国市場前後まで観測。
- ただし自然Pushが早期に1件以上発生し、enqueue→send→到達→重複0まで証明できれば、その時点でreview_requiredへ進めてよい。
- 自然ニュースが乏しくPush未発生なら、人工candidateや手動Pushで埋めず「未観測」と報告する。

## Required startup / parallel safety

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CLAUDE_TASK.md`
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- 前Phase 3 Report
- origin/main fresh-check

G2はX複垢Phase 3Fで進行中。以下は触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- AI Lab routing / dry-run
- X token / callback

H2 Push hardening境界も変更しない:
- `send-push-notifications` source
- `claim_pending_push_notifications`
- notifications claim schema/RPC

このG1は原則read-only観測。競合するコード変更は行わない。

## Required read-only checks

### A. Candidate / classification

新規candidateについて最低限:
- created_at / published_at
- source_type / source_name
- company_codeの有無
- status / importance
- `coverage_severity`
- `coverage_categories`
- `emergency_class`
- `fact_check_status`
- app copy fact status

明らかな誤分類があれば、修正せず具体例と影響をReportする。

### B. App copy

- medium以上で必要なapp copy生成が走ること。
- `app_copy_fact_status='passed'` を確認。
- 低重要度lowが一覧へ混ざらないこと。
- 古い記事のcategory空欄は既知事項として分離。

### C. Unified producer

自然ニュースで `enqueue_important_news_notifications` が実際に正のenqueueを起こした場合:
- candidate/news id
- user単位のenqueue件数
- source_type/source_id
- tracked_stock_idがcompanyでは適切、market emergencyではNULL
- preset/category/emergency条件との整合
- duplicate rowなし

producerエラーがあればエラー内容をsecretなしで記録。

### D. Dispatcher / delivery

新規notificationができた場合:
- queued/pending → processing → sent の自然遷移
- attempt_count / retry_after / claim token周辺に異常なし
- 同じsource/userの二重送信なし
- pending/processing滞留なし
- Expo/APNs delivery errorなし

`send-push-notifications` やclaim RPCを変更しない。

### E. User-visible Push

自然Pushが発生したらユーザーへ確認を求めてよい。

確認すること:
- iPhoneへ届いたか
- タップで該当ニュースdetailへ遷移できたか
- 文面が過剰/不自然でないか

ユーザー確認が必要な時点で、何を見てほしいか短く明確に伝える。

### F. Volume review

観測期間の自然データで:
- candidate総数
- severity別件数
- app表示対象件数
- Push eligibility件数
- 実enqueue件数
- 実sent件数
を集計。

現在は `all_useful` なので、通知が多すぎる場合は勝手に設定変更せず、`many` / `standard` への変更案をReportする。

## Prohibited

- synthetic candidate
- manual/synthetic Push
- manual invokeで通知を作ること
- user alert settingsの勝手な変更
- Cron変更
- X投稿
- Edge Function deploy
- DB migration/RPC/schema変更
- `supabase db push`
- migration history repair/reconcile
- OAuth/Vault/token変更
- secret/tokenの表示

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- origin/mainへ制御情報のみ安全に同期

Report必須:
- task_id
- result
- model_used
- observation_window
- candidate_counts
- classification_examples
- app_copy_observation
- unified_producer_positive_observation
- notification_rows
- duplicate_check
- dispatcher_delivery_observation
- user_push_confirmation
- app_detail_confirmation
- volume_assessment
- production_changes (expected: 0)
- changed_files (expected: task report only)
- push
- remaining_issues
- safety_checks
- next_recommendation

本タスクは観測タスク。問題が見つかっても勝手に修正せず、次タスク候補として切り出す。
## Report

- task_id: broad-news-phase4-natural-push-observation-20260913
- result: **観測完了（本番変更0件）**。収集→分類→判定→X公開までは自然データで動作確認。**統合producerの正のenqueueとPush到達は未観測**（条件を満たす自然ニュースが発生しなかった）。加えて観測中に**3件の未解決事象を新たに特定**: (1) 収集段階の取りこぼし（サウジ原油パイプライン復旧見通し）、(2) **朝刊レポートがFactチェック不合格で生成されず**（2026-09-14 08:35 JST）、(3) X投稿本文の生成失敗4件（fact/voice）。いずれも修正せず次タスク候補として整理。ユーザー指示により観測を打ち切り、Codex（こでさん）への引き継ぎを兼ねてReportを提出する。
- model_used: Claude Opus 5
- observation_window: 2026-09-13 16:23 JST（基準取得）〜 **2026-09-14 09:39 JST**。5分ごとの read-only ポーリング（変化時のみ通知）。手動invoke・合成candidate・手動Pushなし。ユーザー指示（利用量上限が近く、以降の作業をCodexへ引き継ぐ方針）により、当初予定の「月曜夕方まで」を短縮して打ち切り。月曜17:00の予約観測タスクは**削除済み**（Reportの二重提出は起きない）。5分ポーリングのバックグラウンド監視も**停止済み**。

### candidate_counts

| 項目 | 値 |
| --- | --- |
| 候補総数 | 1070 → **1077**（期間中の新規7件） |
| coverage分類済み | 1 → **8件** |
| emergency判定 | 0件 |
| 日本語コピー（Fact passed）累計 | 9件（期間中の新規生成0件。理由は app_copy_observation 参照） |
| X公開済み | 19 → **20件** |
| `generation_failed` | **4件**（うち本日新規2件） |
| 通知 | 1件（9/11の大引けレポート、sent）から変化なし |
| 滞留（pending/processing） | 0件 / failed 0件 |
| 投稿待ち（ready_for_publish / publishing） | 30件 |
| 朝刊レポート | 1件生成 → **failed（Fact不合格）**、通知なし |

内訳: 9/13 は日曜でTDnet休止のため新規1件のみ。9/14 08:00〜08:40 JST にTDnetが再開し6件流入した。

### classification_examples

**正の実例1（海外・市場ニュース / Phase 2の残課題が解消）**

- `Iranian commercial vessel struck near Strait of Hormuz, one killed`
  - 取得 09-13 17:20 JST / 公開 14:53 JST、source_type `breaking_market`（Phase 2で追加したホルムズ系トピック由来）
  - `coverage_categories = [geopolitics, shipping_logistics]`（複数付与が実データで動作）
  - `coverage_severity = high`、`emergency_class = null`
  - 判定 importance `important` / `japan_market_relevance = medium` / `fact_check_status = passed`
  - 17:30 JST に X 公開成功
  - **Phase 1で「拾えていない／集めても消えていた」と指摘した種類の事象を、収集から公開まで通せた初の実データ**

**正の実例2（国内IR / 企業ニュースでも複数カテゴリが動作）**

- 中部電力（9502）「浜岡原子力発電所の新規制基準適合性審査における基準地震動策定に係る不適切事案に関する調査報告書の公表（1/3〜3/3）」 09-14 08:00・08:20 JST 取得
  - `coverage_categories = [disaster, regulation_policy, corporate]`（**TDnet由来の企業IRに複数カテゴリが付いた初の実データ**）
  - 1/3: `coverage_severity = medium` / `japan_market_relevance = high`、2/3: medium / medium、3/3: high / importance `important`
  - **アプリ表示は対象外**: 企業ニュースの表示条件は「medium以上 ＋ 当該銘柄をユーザーが登録」。9502 は未登録。
- 大塚HD（4578）治験結果: `[corporate, earnings]` / severity high / importance important
- 153A 自己株式処分: `[corporate]` / low、WisdomTree ETF 日々開示: `[corporate]`
- 09-12 18:00 取得のガザ情勢記事（market_macro）: `low` / `[geopolitics]` / rejected のまま（想定どおり）

**誤分類（修正せず報告）**

- 浜岡 3/3 の1件だけ `coverage_categories` に **`monetary_policy` が混入**（原発の審査報告書に金融政策カテゴリ）。1/3・2/3 には付いていないため、本文テキストのキーワード判定による誤検出と推測。影響は軽微（カテゴリ通知設定で余計な一致を生む可能性）。
- emergency の誤検出は0件（船1隻への攻撃を emergency にしていないのは妥当）。

### app_copy_observation

- 期間中の新規生成は**0件**。累計9件はすべて `app_copy_fact_status = 'passed'`。
- 理由を `important_news_app_copy_targets` の定義から read-only で特定した（**新しい発見**）:
  - 対象は「**タイトルに日本語を含まない**」記事のみ。TDnet／company_ir は元から日本語なので生成不要 — 設計どおり。
  - ホルムズの件（英語 / app_severity high / `company_code` null）は、市場ニュースの**業種一致がないため `visible_market` に入らず**、アプリ表示対象外、したがって**日本語コピーも生成されない**。
  - → **「`all_useful` で業種一致を外す」見直しは、通知だけでなくアプリ表示・日本語化にも同時に効く**。次タスクのスコープを決める際の重要な前提。
  - 企業ニュースは `status <> 'rejected' or source_type in ('tdnet','company_ir')` の条件付きで、TDnet は rejected でも表示対象になる。
- `low` がアプリ一覧に混ざっていないことを確認（feedのseverity内訳に low は0件）。
- 既知の分離事項: Phase 2 deploy 以前の古い記事は `coverage_categories` が空のため、カテゴリラベルが空欄になる。

### unified_producer_positive_observation

**未観測。** `enqueue_important_news_notifications` による正のenqueueは1件も発生していない。

理由（read-onlyで特定、設計どおりの挙動）:

- ホルムズの件の影響業種（`important_news_theme_sectors`）: 海運業 / 石油・石炭製品 / 倉庫・運輸関連業 / 卸売業 / 空運業 / 鉱業 / 電気・ガス業
- ユーザーの登録銘柄の業種: サービス業 / その他製品 / 小売業 / 情報・通信業 / 機械 / 輸送用機器 / 銀行業 / 電気機器
- **重なり0**。市場全体ニュースは emergency 以外は業種一致が必須。emergency でもないため業種バイパスも発生しない。
- 9/14 の浜岡・大塚HDは企業ニュースだが、9502・4578 ともユーザー未登録のため対象外。
- したがって `notification_preset='all_useful'` でも通知は出ない。**プリセットを最大にしても、市場ニュースは「登録業種に関係するもの」に限られる**ことが実データで確定した。

### notification_rows / duplicate_check

- 新規 notifications 行: **0件**。既存1件（`personalized_report` / sent / tracked_stock_id NULL）のみ。
- 重複チェック: 同一 user_id × source_type × source_id の重複0件。`notifications_market_news_without_stock_once` と `notifications_personalized_report_once` の両部分ユニーク索引は存在。

### dispatcher_delivery_observation

- pending / processing の滞留は常時0件、failed 0件。dispatcher は毎分稼働。
- `send-push-notifications` / `claim_pending_push_notifications` / notifications claim schema は**未変更**（H2境界を尊重）。
- 観測されたエラー（`net._http_response` は**約6時間で行が消える**ため長期集計は不可。以下は観測できた範囲）:
  - 09-13 17:35 JST `NEWS_PUBLISH_CANDIDATE_LOOKUP_FAILED` 1件
  - 09-13 22:20 JST `NEWS_CANDIDATE_LOOKUP_FAILED` 1件
  - 09-13 23:47 JST `NEWS_JUDGEMENT_CANDIDATE_LOOKUP_FAILED` 1件
  - 09-13 23:42 JST `CLAIM_PENDING_NOTIFICATIONS_FAILED:504` 1件（**H2領域**。9/12 15:53 UTC に続き2回目）
  - 09-14 02:30 JST 前後に同一分内で集中: `CLAIM_PENDING_NOTIFICATIONS_FAILED:504`（**3回目**）＋ `NEWS_MONITOR_SETTINGS_FAILED`（初発）＋ `pg_net` 5秒タイムアウト3件。その後さらに30分あたり3件の集中を1回観測。
  - `pg_net` 5秒タイムアウトは9/13中に17件（DNS待ち。次サイクルで復帰）
  - いずれも `publish_failed` 0件 / 通知失敗0件 / 滞留0件で実害は確認されず。評価: 個別処理のバグではなく **DBへの読み取りが一時的に詰まる事象**。1日で取得・判定・投稿・監視設定・Push claim の**5経路**で観測した。

### 【重要 1】収集段階の取りこぼし（ユーザー報告を起点に特定）

ユーザー報告: 2026-09-13 21:04 JST に「サウジの原油パイプライン復旧に5〜6週間かかる」というニュースが出た（別経路で把握）。かぶモリでは通知も表示もされなかった。

read-only 調査:

- `important_news_candidates` に該当行は**存在しない**（3日分を saudi / pipeline / 原油 等で検索。該当は 09-10〜09-12 の既知3件のみ）。
- 最新候補は 09-13 17:20 JST。**以降7時間、新規候補0件**。
- fetch cron は20分ごとに正常稼働。21:20 と 24:00 のサイクルでは原油・供給を狙う `commodities_energy_supply` トピックも実行済み。
- 診断ログ（全トピック共通）: `providerStatus succeeded` / `httpStatus 200` / `responseStatus completed` / `webSearchCallCount 1` / **`rawCandidateCount 0`** / `validatedCandidateCount 0`、`rejectionCounts` は全項目0（`disallowed_domain` / `stale_published_at` / `source_not_visited` すべて0）。
  - → **ゲートで落としたのではなく、web_search から候補が1件も上がってこなかった**。
- 仮に拾えていた場合（SQL関数を read-only で評価）:
  - `important_news_app_severity = high`（アプリ表示対象）、`important_news_market_themes = [oil_energy]`
  - 09-12 のパイプライン攻撃記事とは `important_news_same_event = false` → **重複で消えることはない**
  - ただし業種一致しないため**通知は出ない**
- 結論: 主因は **収集の狭さ**（許可ドメインが Reuters / AP / Bloomberg / 日経＋政府系に限定、1トピック1検索、鮮度3時間）。副次的に **通知・表示の業種一致条件** が原油・海運を追えない構造になっている。

### 【重要 2】朝刊レポートが生成されなかった（2026-09-14）

ユーザー報告を受けて read-only 調査。**Cronは正常に走っており、Factチェックで不合格になって保存されなかった**。

- `personalized_reports` の該当行: `report_type = morning` / `trading_date = 2026-09-14` / `created_at = 08:35 JST` / `status = failed` / `fact_status = failed` / `error = REPORT_FACT_FAILED` / `notified_at = null`
- `fact_issues`: 「**『指数の値動きが保有銘柄に影響する可能性があります』は、packetにない指数と保有銘柄の因果関係を示しています**」
  - つまりLLMが、packetに無い「指数→保有銘柄」の因果を書いたため不合格。
  - 設計どおりの fail-closed 挙動（`completed` かつ `fact_status = passed` のみ保存・通知）であり、**誤った内容がユーザーに届くことは防げている**。
- 生成試行は1回のみ。**リトライなし**のため、その日の朝刊は欠落する。
- 補足: `personalized-reports` は現在 **v13**（G1が反映したのは v11。その後 別slot により更新されている）。本Phaseでは一切deployしていない。
- 次タスク候補: (a) 生成プロンプトで「指数と保有銘柄の因果を書かない」を明示、(b) Fact不合格時に1回だけ再生成する（大引けレポートで既に有効だったパターン）、(c) 因果表現をローカルチェックで事前に弾く。

### 【重要 3】X投稿本文の生成失敗が4件

- 09-14 08:20 4578: `NEWS_GENERATION_VOICE_FAILED`（fact は passed、文体チェックで失敗）
- 09-14 08:20 9502（浜岡 3/3）: `NEWS_GENERATION_FACT_RETRY_FAILED`（factリトライ後も不合格）
- 09-11 23:20 / 23:40 456A（HUMAN MADE 業績上方修正・子会社化）: `NEWS_GENERATION_FACT_FAILED` 2件
- 通知・Push への影響なし。**X投稿の取りこぼし**としては影響あり（severity high の記事が2件含まれる）。
- 次タスク候補: `generation_failed` の内訳（fact / voice）の可視化と、リトライ方針の見直し。

### user_push_confirmation / app_detail_confirmation

- user_push_confirmation: **未観測**（自然Pushが発生していないため、ユーザーへの到達確認は行っていない）。
- app_detail_confirmation: Phase 3 で実施済み（ユーザー本人が実画面で「すべて正常」を確認: 一覧・medium表示・severity/category日本語ラベル・detail・4段階preset・emergency toggle・category ON/OFF・保存後の再読込一致）。本Phaseでの追加確認は、アプリ表示対象の新規記事が無いため未実施。

### volume_assessment

| 指標 | 期間中の値 |
| --- | --- |
| 候補総数 | 新規7件（9/13は1件、9/14朝に6件） |
| severity内訳（新規分） | high 2件 / medium 2件 / low 1件 / 判定前2件 |
| アプリ表示対象 | 累計13件（日本語コピー9 ＋ 国内medium以上4。うちユーザー登録銘柄に紐づくものは0件） |
| Push eligibility | 0件（業種一致・銘柄登録のいずれも不成立） |
| 実enqueue | 0件 |
| 実sent | 0件 |

- 現在 `all_useful`（最も多い設定）でも、観測期間の通知は**0件**。通知が多すぎる兆候はまったく無い。
- したがって `many` / `standard` への引き下げ提案は**不要**。むしろ「最大設定でも原油・海運・他社の重大ニュースが届かない」ほうが問題。
- ユーザー設定は変更していない（本人がアプリで保存した値のまま）。

### production_changes

**0件。** read-only 観測のみ。DB書き込み・migration・deploy・Cron変更・X投稿・手動Push・手動invoke・ユーザー設定変更のいずれも行っていない。

### changed_files

- `.agent/tasks/CLAUDE_TASK_1.md`（status と本Report）
- `.agent/CURRENT_STATE.md`（引き継ぎのための現在地更新）
- コード変更なし。

### push

- origin/main（fast-forward / 必要に応じ rebase）

### 引き継ぎ（Codex / こでさん向け）

**本番の現在地（2026-09-14 09:39 JST 時点で実測）**

- Edge Function: `important-news-monitor` **v52** / `personalized-reports` **v13** / `send-push-notifications` **v15** / `x-test-post` **v107** / `x-oauth-connect` **v17** / `market-intelligence-ingest` **v11** / `market-intelligence-state-evaluator` **v7** / `brand-post-dry-run` **v5** / `stocks-master-sync` v16 / `stocks-new-listing-sync` v15。
  - G1がPhase 2/3で反映したのは monitor v50 と personalized-reports v11。**それ以降は別slotが更新している**ため、着手前に `supabase functions list` で再確認すること。
- Cron: **22件すべて active**。ニュース系4（fetch `0,20,40` / judgement `7,27,47` / generation `14,34,54` / publish-ready `*/5`）、`send-push-notifications-dispatch` 毎分、`dispatch-scheduled-posts` 毎分、銘柄同期2、personalized-reports 2（morning `35 23 * * 0-4` / close `15 8 * * 1-5`）、MIC系 ingest/evaluator 12。G1は変更していない。
- 適用済みで**未記録**のmigration（履歴乖離が継続）: `20260910163500` / `20260910200000` / `20260911090000` / `20260911120000` / `20260911150000` / `20260911170000` / `20260911200000` / `20260911230000` / `20260912180000` / `20260913140000`。**`supabase db push` は禁止**。1ファイル単位で `supabase db query --linked -f <絶対パス>` を使い、適用前にロールバック前提テスト（`begin;` … `RAISE EXCEPTION 'PX_TEST_RESULT %'` … `rollback;`）、適用後に read-back。
- ユーザー設定: `notification_preset='all_useful'` / `emergency_alerts=true` / 16カテゴリ有効 / `market_critical_news=true` / push・重要ニュース・朝刊・大引けすべてON。**本人が選んだ値なので勝手に変えない。**
- worktree: `/Users/yuya/Developer/kabumori/.claude/worktrees/ios-push-e2e`。`supabase/config.toml` と `supabase/.temp` はGit管理外のローカルファイル（CLIのproject root固定に必要）。deployはこのworktreeから行い、必ず download → byte compare する。

**G1セッション固有の稼働物（引き継ぎ時点の状態）**

- 5分ごとの read-only 監視バックグラウンドタスクは**停止済み**。
- 月曜17:00の予約観測タスクは**削除済み**（プロンプトは `~/.claude/scheduled-tasks/kabumori-close-news-observation/SKILL.md` に残置）。
- 観測メモ（Report統合済み、参照用）: 同ディレクトリの `FINDINGS.md` / `FINDINGS_ADDENDUM.md`。
- Metro（`192.168.188.127:8081`）を起動したまま。不要なら停止してよい。

**未解決・次にやること（優先順）**

1. **収集条件の拡大**（取りこぼしの直接原因 / migration不要・monitor deployのみで済む想定）
   - 許可ドメイン追加（エネルギー・商品の一次/準一次媒体: S&P Global Platts、Argus Media など）
   - 1トピックあたりの web_search 回数を増やす（現在1回）
   - 鮮度 `MAX_BREAKING_MARKET_ITEM_AGE_MS` 3時間 → 6〜12時間へ緩和
   - 「進行中事象の続報」トピック追加（復旧見通し・供給量・停止期間の更新を拾う）
   - 空振り（`rawCandidateCount 0`）の連続回数を診断に出す
2. **通知＋表示の業種一致条件の見直し**: `all_useful` では市場ニュースの業種一致を不要にする、またはカテゴリ単位（oil_energy / shipping_logistics 等）で業種条件を外せる設定。**アプリ表示と日本語コピー生成にも同じ条件が効いている**点に注意（`important_news_app_copy_targets` / `visible_market`）。
3. **朝刊レポートのFact不合格対策**（本日欠落した直接原因）: プロンプトに「指数と保有銘柄の因果を書かない」を明示、Fact不合格時の1回リトライ、因果表現のローカルチェック追加。
4. **X投稿本文の生成失敗4件**の内訳可視化とリトライ方針見直し。
5. 判定の見直し: 供給停止の期間・数量が判明した続報を初報より重く扱う。
6. monitor / dispatcher のDB読み取りに短いリトライを入れる（現在は1回失敗でそのサイクルを落とす）。5経路で発生、9/14未明には集中も観測。
7. H2領域: `CLAIM_PENDING_NOTIFICATIONS_FAILED:504` の**3回目**発生を C2 レビューで共有。
8. 投稿待ち30件の滞留の妥当性確認。
9. 継続課題: migration履歴の乖離、テスト用の監視銘柄17件（E2E用に追加したもの。削除対象）、`supabase/config.toml` がGit管理外、古い記事の `coverage_categories` 空欄、`net._http_response` の保持が約6時間しかなくエラーの長期傾向が追えない（別テーブルへの記録を検討）。

### remaining_issues

- 統合producerの正のenqueueとPush到達が**未観測**。平日の自然ニュースで要確認（`all_useful` でも業種一致・銘柄登録が壁になる点に注意）。
- 収集の取りこぼし（サウジの件）が未解決。
- 朝刊レポートが本日欠落（Fact不合格・リトライなし）。
- X投稿本文の生成失敗4件。
- `monetary_policy` の誤付与1件。
- 観測が土日＋月曜午前のみで、平日フルの件数・費用の実測が無い。

### safety_checks

- 本番への書き込みゼロ（select と read-only の関数評価のみ）。deploy・migration・Cron変更・X投稿・合成candidate・手動Push・手動invoke・ユーザー設定変更なし。
- `send-push-notifications` / claim RPC / notifications claim schema / `x-oauth-connect` / OAuth / Vault / social_accounts には触れていない。
- secret / token は表示していない。問題は修正せず記録のみ。
- 観測タスク・バックグラウンド監視を停止し、予約タスクを削除したため、G1が今後自動で本番に触ることはない。

### next_recommendation

1. K1（ChatGPT）で「収集条件の拡大」をCodex向け次タスクとして起こす。スコープ案: 許可ドメイン追加＋検索回数増＋鮮度緩和＋続報トピック＋空振り可視化。migration不要、`important-news-monitor` の deploy のみ。
2. 同時に「`all_useful` での業種一致条件の撤廃（またはカテゴリ単位の例外）」を設計判断として決める。ユーザーは原油・海運など保有外の重大ニュースも受け取りたい意向。**通知・アプリ表示・日本語化の3つに同じ条件が効く**ため一体で設計する。
3. 朝刊レポートのFact不合格対策を小タスクとして先に流す（1日1回の価値提供が止まっているため優先度は高い）。
4. その後、平日1日分の自然観測を改めて実施し、producerの正のenqueue・Push到達・通知量を確定させる。
