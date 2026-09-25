# Claude Task 2

- task_id: kabumori-voice-gate-product-policy-audit-20260925
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（中）
- purpose: かぶモリの定期配信でVOICEチェックが過剰にfail-closedになっていないかを監査し、Fact/Safetyと文体品質を分離した PASS / WARN / BLOCK 方針を設計する。今回は監査・設計のみ。source変更・deploy禁止。

## Product decision

有料ユーザー向けの定期配信では、
- 少し不自然
- AIっぽい
- 語尾や絵文字が微妙
- 軽い言い回しの違和感
程度で朝刊/大引け等が欠配になるより、Fact/Safetyを満たすレポートが毎日届くことを優先する。

VOICEは原則として「文章品質」の判定に寄せ、
Fact/Safetyと役割を分離する。

目標分類:
- PASS: 問題なし
- WARN: 文体上の軽微な問題。配信は止めない
- BLOCK: 意味破綻・安全上の問題など、本当に配信停止すべきもの

## Critical constraint

現在H2が `kabumori-pr29-plus-v27-validator-final-review-20260925` をレビュー中。
そのレビュー対象ファイルやPRを変更しないこと。

今回はread-only監査・設計だけ。
コード変更、PR作成、merge、deploy、設定変更は禁止。

## Mandatory startup

1. 独立worktree / checkoutを使う。
2. fresh origin/main。
3. 読む:
   - PROJECT_RULES
   - .agent/ORCHESTRATION.md
   - .agent/CURRENT_STATE.md
   - 本TASK
   - 最新G2 report
   - H2の現在TASK
4. H2とファイル競合が起きないことを確認。
5. productionは必要ならread-onlyだけ。

## Audit scope

### A. かぶモリアプリ側

必ず確認:
- personalized-reports の Fact/local/VOICE 相当の全gate
- morning / close
- Pushまでの経路
- どの条件で「保存されない」「通知されない」になるか
- retry/rewriteの有無
- 文体上の問題が配信停止に直結している箇所

### B. 共通/shared側

確認:
- `_shared/kabumori_voice.ts`
- 共通market report packet
- Voice/Fact/Safetyの責務分離
- アプリとXで共通化できるpolicy境界

### C. X側はread-only inventoryのみ

この部屋からX実装TASKは作らない。

ただし統一方針のため、read-onlyで以下を棚卸し:
- morning_report
- close_report
- useful_tip
- morning_greeting
- interaction
- us_premarket_report
- その他 Voice evaluator 利用箇所

各経路について:
- VOICE failで投稿が止まるか
- rewriteがあるか
- rewrite失敗時に元のFact-passed本文を使えるか
- Fact/SafetyとVOICEが混ざっていないか

X側の変更提案は「X担当ちゃへ渡すhandoff案」としてまとめるだけ。

## Required design

### 1. PASS / WARN / BLOCK matrix

最低限以下を分類する。

WARN候補:
- 少しAIっぽい
- 語尾の単調さ
- 軽い冗長
- 絵文字数/位置の違和感
- 見出しが少し不自然
- ニュース記事っぽい文体
- 軽微な日本語のぎこちなさ
- 同義反復
- ブランドトーンからの軽微なズレ

BLOCK候補:
- 意味不明/文意破綻
- 内容が逆転する誤訳
- 明示的な危険な売買推奨
- Fact-passed本文をrewriteで事実変更
- 禁止された断定/捏造
- 個人情報/秘密情報漏洩
- 構造破損で画面/配信が成立しない
- 法令/安全上明確に止めるべき内容

Fact側に残すもの:
- 数値
- 銘柄/主体
- 日付
- 因果
- 根拠
- 市場データとの整合
- unsupported impact
- hallucination

VOICE側に残すもの:
- 自然さ
- 読みやすさ
- ブランドトーン
- 絵文字
- 冗長さ
- 語尾
- AI記事感

### 2. Delivery policy proposal

最低でも次の案を比較する:

A. 現行 fail-closed
B. WARNは1回rewrite、rewrite失敗なら元のFact-passed本文を配信
C. WARNはそのまま配信、非同期改善だけ記録
D. severity閾値方式

推奨案では、
「週に何回も欠配する」ことを避けることを明示的なKPIにする。

### 3. Observability

設計に以下を含める:
- voice_status: pass / warn / block
- warning_codes[]
- rewrite_attempted
- rewrite_succeeded
- fallback_original_used
- delivery_blocked_by
- daily delivery success rate
- block reason breakdown
- Fact pass rate vs Voice warn rate vs true block rate

### 4. Rollout

big-bang禁止。

提案する段階:
1. shadow classification
2. WARN配信許可を一部経路でON
3. 朝刊/大引け
4. その他
5. X側は別部屋で独立レビュー後に切替

## Deliverable

TASK末尾Reportに:
- 現行全経路のgate一覧
- 欠配原因の分類
- Fact / Safety / Voiceの責務分離表
- PASS/WARN/BLOCK定義
- 推奨delivery policy
- 実装影響ファイル候補
- migration要否
- backward compatibility
- rollback
- telemetry
- app側実装TASK案
- X担当ちゃへ渡す完成handoff案
- 推薦実装モデル
- 推薦レビューmodel

今回はsource変更0、production mutation 0。

完了時:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-voice-gate-product-policy-audit-20260925`
- result：read-onlyの監査と設計を完了した。source変更 **0**、production mutation **0**（本番は直近30日分の集計SELECTを1回実行しただけ）。
- changed_files：本TASKの `## Report` のみ
- tests：なし（監査のみ）
- commit_hash / push：本Reportのcommitのみ
- deploy：なし
- remaining_issues / next_recommendation：下記の「実装TASK案」と「X handoff案」を参照。
- safety_checks：
  - H2のレビュー対象（PR #29、`510acf5`、`report_logic.ts`、`close_validator_fix_test.ts`）には一切触れていない。
  - 秘密情報・user_id・銘柄の詳細・投稿本文は本Reportに記載していない。

### 1. 現行の全経路のgate一覧

凡例：B＝配信を止める、R＝書き直しや再試行がある。

#### アプリ（`personalized-reports`：朝刊・大引け）

1. `snapshotBlockers`：価格がすべて取れない、または対象銘柄がない（B）
2. LLMのdraft（1回だけ）：`sufficient_information=false`、空、JSONの不正（B）
3. `localReportIssues`（B）：数字・銘柄・basis・助言・URL・ISO日付・英単語・複数日を前提にした語・markup・絵文字・見出しラベル・日本語でない・文字数超過・推定欄のhedge不足・共有分析との方向矛盾
4. LLMのFact（1回だけ。売買推奨や根拠のない影響も判定する）：B
5. 合格なら保存し、Pushをenqueueする。

- **VOICE専用のLLM評価はない**。ただし、3の文体系チェックと4の言い回しの判定が、実質的にVOICEの役割をしている。
- **rewriteも再試行もない**。1日1回だけclaimするため、不合格ならその日は欠配になる。

#### 共有layer

- `_shared/kabumori_voice.ts`：生成promptの文体指示（X用。アプリは使っていない）。
- `market-report-analysis`：Fact＋ローカル検査で、X向けの `x_post` 形式チェックはない。
- `shared_market_report_consumer`（X。現在はgate OFF）：VOICE工程はなく、形式が不正なら止まる。

#### X（read-onlyでの棚卸し）

| 経路 | VOICEで止まるか | rewrite | rewrite失敗時に元のFact済み本文を使うか | Fact / VOICEの混在 |
|---|---|---|---|---|
| morning_report | **止まる**（`MORNING_REPORT_VOICE_CHECK_FAILED`、再試行対象外） | 1回＋再評価 | **使わない**（欠配） | **混在**（VOICE評価の出力に `fact_check_status` があり、passedの条件に含まれる） |
| close_report | **止まる**（`CLOSE_REPORT_VOICE_CHECK_FAILED`） | 1回＋再評価（評価エラーは1回再試行） | **使わない** | 混在（同上） |
| us_premarket_report | 止まらない（VOICEは記録だけで、FactだけがB） | なし | — | 記録だけ |
| useful_tip | **止まる**（`USEFUL_TIP_VOICE_CHECK_FAILED`） | **なし** | **使わない** | 混在 |
| tip（株の小ネタ） | 止まらない（投稿経路にVOICE評価がない。previewだけ） | — | — | — |
| interaction | **止まる**（2回生成し、機械チェック＋VOICE） | 再生成2回 | — | 混在 |
| morning_greeting | LLMのVOICEはない。機械ガードで止まる（絵文字5個以上、文字数など文体系も含む） | なし | — | 文体系の機械ガードがB |
| 重要ニュース | **止まる**（`NEWS_GENERATION_VOICE_FAILED`、公開gateは `voicePassed` 必須） | 文体系の指摘だけ1回rewrite | **使わない** | 部分的に分離済み（再試行してよい指摘と、してはいけない指摘の分類がある） |

**VOICE評価器自体のエラー**（`VOICE_EVALUATION_JSON_PARSE_FAILED`、`_EMPTY_OUTPUT`、`_SCHEMA_INVALID`）も、朝刊・大引け・お役立ちでは「内容の不合格」として扱われ、欠配になる。インフラ障害なのに、再試行されずに止まる。

### 2. 欠配の原因の分類（本番、直近30日、kabumori）

- **X朝刊**：予定13件のうち成功5件、失敗8件。
  - failed runの内訳：Fact失敗13、US市場lane失敗3、検索予算超過2、**VOICE不合格2〜3**、**VOICE評価器エラー2**、その他4（retryによる重複を含む）。
- **X大引け**：予定11件のうち成功1件、失敗9件。
  - 主因は `CLOSE_DATA_UNAVAILABLE` 7件とFact 9件（run単位）。
  - VOICE評価器エラーが1件。
- **お役立ち**：30件のうち成功22件、失敗5件。うち **VOICE評価器のparse・空出力が3件**。
- **交流**：50件のうち成功37件、失敗12件。主因は機械ガード9件。
- **朝の挨拶**：12件のうち成功5件、失敗7件。主因はX認証・メディア。文字数が1件。
- **重要ニュース**：Factは合格したのに **VOICEで止まったものが21件**（公開56件、公開待ち30件に対して）。
- **アプリ**：大引けは7件のうち完了5件（ローカル検査1件、Fact 1件）、朝刊は7件のうち完了5件（OpenAI 1件、Fact 1件）。
  - v22〜v26のdry_runでは、文体・hedge系のローカル検査による誤拒否と、朝刊Factの言い回しの誤判定を確認した。
- **結論**：
  - 欠配の最大要因は、データ取得とFactだった。
  - ただし、**「Factは合格したのに、VOICEまたはVOICE評価器のエラーで止まる」経路が、X朝刊・お役立ち・重要ニュースに実在する**。
  - アプリでは、文体系のローカル検査とFactの言い回し判定が同じ役割をしている。

### 3. Fact / Safety / Voice の責務分離表

| 層 | 責務 | 判定の結果 | 現在の置き場所 |
|---|---|---|---|
| Fact | 数値、銘柄・主体、日付、因果、根拠、市場データとの整合、根拠のない影響、捏造 | BLOCK | アプリ：ローカル検査の数字・銘柄・basis・方向矛盾・複数日語＋Fact LLM。X：各laneのFact＋**VOICE評価器の中の `fact_check_status`（ここは混在しているので分離が必要）** |
| Safety | 明示的な売買推奨、利益保証、架空の本人の取引・保有、個人情報・秘密情報、法令、構造の破損 | BLOCK | アプリ：ADVICE・URL・markup・Factの推奨判定。X：VOICE評価器の「架空の経験」判定（Safetyへ移す） |
| Voice | 自然さ、読みやすさ、ブランドトーン、絵文字、冗長さ、語尾、AI記事感 | PASS / WARN（配信は止めない） | X：VOICE評価器のhuman・AI記事感・絵文字のスコア。アプリ：英単語・ラベル・絵文字・文字数・ISO日付などのローカル検査、Factの言い回し判定 |

### 4. PASS / WARN / BLOCK の定義

- **PASS**：Fact、Safety、Voiceの全観点で問題がない。
- **WARN**（配信する＋`warning_codes` を記録する）：
  - 少しAIっぽい、語尾が単調、軽い冗長、絵文字の数や位置の違和感、見出しが少し不自然、ニュース記事っぽい文体、軽微なぎこちなさ、同義反復、ブランドトーンからの軽いズレ。
  - アプリの文字数の軽微な超過（例：上限の120%以内）、ISO日付（コードで正規化できるもの）、英単語（packet由来のもの）、見出しラベル、絵文字。
  - 観察を促す言い回し（「見守る」「注意が必要」など。推奨ではないもの）。
  - **VOICE評価器のエラー**（評価不能）。1回再試行しても失敗した場合はWARNの `voice_unavailable` とする。
- **BLOCK**：
  - 意味不明・文意の破綻、内容が逆転する誤り。
  - 明示的な売買推奨、利益保証。
  - rewriteによる事実の変更（rewrite後の再Factで検出）。
  - 禁止された断定や捏造（Factが確認したもの）、根拠のない因果の断定（アプリの推定欄の断定を含む）。
  - 架空の本人の取引・保有、個人情報・秘密情報の漏洩。
  - 構造の破損（JSONの不正、必須欄が空、画面や投稿の形式が成立しない）。
  - 法令・安全上、明確に止めるべき内容。
- **判定のルール**：`delivery_blocked_by` はFactまたはSafetyに限る。Voiceだけを理由に止めることはしない。

### 5. 推奨するdelivery policy

| 案 | 内容 | 欠配リスク | 品質リスク |
|---|---|---|---|
| A 現行のfail-closed | VOICEで不合格なら止める | 高い（週に複数回の欠配が起こりうる） | 最小 |
| B WARNは1回rewrite、失敗なら元の本文 | Voiceが不合格ならrewriteを1回→再Fact・再Voice。改善しない、またはrewriteが失敗したら**元のFact済み本文**を配信する | 低い | 小（Fact済みの本文なので事実面は安全） |
| C WARNはそのまま配信 | rewriteせずに配信し、改善は非同期で行う | 最小 | 中（文体の劣化がそのまま出る） |
| D severityの閾値方式 | 評価器のスコアや重大度で、WARNとBLOCKを分ける | 低〜中 | 閾値の設計次第 |

**推奨：B＋D（BLOCKはFact・Safetyのコードだけ、Voiceはseverityで分ける）**

1. Fact・SafetyのBLOCKは現行どおりfail-closedにする。
2. Voiceの不合格はWARNとし、rewriteを最大1回行う。
   - rewrite後の本文は**必ず再Factにかける**。事実が変わっていればrewrite本文を捨てる。
   - 改善しなければ、**元のFact済み本文を配信**する（`fallback_original_used=true`）。
3. VOICE評価器のエラーは1回再試行する。それでも失敗したら `voice_unavailable`（WARN）として、元のFact済み本文を配信する。
4. アプリ（rewriteなし）では、ローカル検査をBLOCK群とWARN群に分け、WARN群は配信を止めない。
   - Fact LLMの出力に `issue_category`（fact / safety / style）を追加し、styleだけの場合はWARNにする（Factの判定基準は緩めない）。
5. **KPI**：朝刊・大引けの配信成功率（Fact・データが揃っていた日のうち、実際に届いた割合）が **週に欠配0〜1回以内**。Voiceだけが理由の欠配は **0件**。

### 6. 実装で影響を受けるファイルの候補

- アプリ：`supabase/functions/personalized-reports/report_logic.ts`（ローカル検査の分類・Factのschema・outcome）、`index.ts`（保存とtelemetry）、必要なら `src/lib/report-presentation.ts`（WARNは表示しない）。
- 共有：`_shared/` に `delivery_policy.ts`（PASS/WARN/BLOCKの型、コードの分類表、判定関数）を新設する。アプリとXで共通にする。
- X（handoff）：`x-test-post/index.ts`（朝刊・大引け・お役立ち・交流の判定部分）、`voice_evaluation_logic.ts`（`fact_check_status` をVoice評価から外すか、Fact signalとして分離）、`report_voice_rewrite_logic.ts`（rewrite後の再Fact）、`morning_report_retry_logic.ts`（評価器エラーをインフラ扱いに）、`important-news-monitor/post_generation_logic.ts`・`publish_logic.ts`（`voicePassed` 必須をWARN許容に）。

### 7. migrationの要否

- **Phase 1ではmigration不要**。アプリは `personalized_reports.body` / `source_basis`（jsonb）に、Xは `*_report_runs.market_data` / `post_execution_logs` の既存jsonb・messageに記録できる。
- 集計や監視の効率が必要になった段階で、`voice_status` などをcolumn化する。その場合はexpand-onlyのmigrationを別TASKで行う。

### 8. backward compatibility

- 新しいfieldはすべて任意（optional）。旧形式の行や旧アプリはそのまま動く。
- アプリの表示は、WARNがあっても変えない（ユーザーには見せない）。

### 9. rollback

- 経路ごとの `delivery_policy_mode`（`fail_closed` / `warn_deliver`）を、コード定数またはsettings行で切り替える。**既定は `fail_closed`**。
- 問題があれば、定数を戻すか、該当の関数をrollback（既知のsourceへのdeploy）する。DBの変更は不要。

### 10. telemetry

- 1配信ごとに記録する：`voice_status`（pass / warn / block / unavailable）、`warning_codes[]`、`rewrite_attempted`、`rewrite_succeeded`、`rewrite_fact_status`、`fallback_original_used`、`delivery_blocked_by`（fact / safety / data / infra / null）。
- 日次で集計する：経路ごとのdelivery success rate、blockの理由の内訳、Fact pass率・Voice warn率・true block率。
  - SQLのviewで出すか、既存の管理画面に追加する（別TASK）。

### 11. rollout（big-bangはしない）

1. **shadow分類**：判定は現行のまま、PASS/WARN/BLOCKの分類とtelemetryだけを記録する（1〜2週間）。
2. アプリの**朝刊・大引け**でWARN配信をON（`app_enabled` とは独立したflag）。
3. X以外の他経路（重要ニュースなど）は、分類の結果を見て判断する。
4. **X**：別の部屋で独立レビューしたうえで、経路ごとに切り替える（朝刊・大引け→お役立ち→交流→重要ニュース）。

### 12. アプリ側の実装TASK案（G1/G2向け）

- title：「personalized-reports delivery policy Phase 1（shadow分類＋telemetry）」
- 推奨model：**Opus5.5（高）**（validatorとFactのschemaの設計）
- scope：
  - `report_logic.ts` でローカル検査をBLOCK群とWARN群に分類する（判定は変えず、shadowで記録）。
  - Fact LLMの出力に `issue_category` を追加する（判定は現行どおり）。
  - `index.ts` で `source_basis.delivery_policy` にtelemetryを保存する。
- 禁止：deploy（別承認）、`app_enabled` の変更、DB migration、X。
- tests：分類表の網羅（各codeがBLOCKかWARNか）、shadowで配信の判定が変わらないこと、telemetryの形。
- 後続：Phase 2で `warn_deliver` をflagでONにする（dry_runで検証してから）。

### 13. X担当ちゃへ渡すhandoff案（そのまま渡せる形）

> 【X handoff：Voice gate delivery policy】
> 推薦モデル：Opus5.5（高）、レビュー：Codex Sol（高）
> 背景：かぶモリの定期配信で、Fact合格後にVOICE不合格、またはVOICE評価器のエラーで欠配が発生している（直近30日：X朝刊のVOICE不合格2〜3件＋評価器エラー2件、お役立ちの評価器parse・空出力3件、重要ニュースのFact合格後のVOICE不合格21件）。製品方針として「Fact/Safetyを満たすレポートを毎日届ける」を優先する。
> 依頼：
> 1. `evaluateKabumoriVoice` の出力の `fact_check_status` と「架空の経験」判定を、Voiceの `passed` から分離する（Fact / Safety signalとして扱い、BLOCKは既存のFact laneまたは専用のSafetyチェックで確定させる）。
> 2. 朝刊・大引け：Voiceが不合格ならrewrite（既存）→ **rewrite本文の再Fact** → 不合格なら**元のFact済み本文を投稿**（`fallback_original_used`）。
> 3. お役立ち：同じ方針でrewriteを1回追加し、失敗したら元の本文を使う。
> 4. VOICE評価器のエラー（JSON parse・空・schema）は1回再試行し、それでも失敗したら `voice_unavailable`（WARN）として元のFact済み本文を投稿する。インフラ障害で欠配にしない。
> 5. 重要ニュース：`voicePassed` 必須を「Fact・Safetyが合格し、Voiceがwarn以上」に変える（再試行してよい指摘とそうでない指摘の既存分類は維持）。
> 6. 交流と朝の挨拶：文体系の機械ガード（絵文字数・文字数の軽微な超過）をWARNへ移すかを評価する。
> 7. telemetryを記録する：`voice_status` / `warning_codes` / `rewrite_*` / `fallback_original_used` / `delivery_blocked_by`。
> 8. rollout：shadow分類を1〜2週間→経路ごとにflagでON。既定は現行のfail-closed。
> 禁止：Fact・Safetyの判定の緩和、big-bangでの切り替え、アプリ（personalized-reports）の変更。

### 14. 推薦model

- 実装：アプリ・X とも **Opus5.5（高）**（gateの分類と安全境界の設計を含むため）。
- レビュー：**Codex Sol（高）**（fail-closedが保たれているか、BLOCKが抜けていないかの独立確認）。shadow分類だけの軽いものは Luna（高）でも可。
