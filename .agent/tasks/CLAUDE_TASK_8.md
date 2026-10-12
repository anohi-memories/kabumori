# Claude Task G8 — 国内ニュース Phase J1-a：jp_official 診断の永続化

- task_id: news-improvement-a-jp-official-diagnostics-j1a-g8-20261012
- owner: claude
- slot: claude-8
- status: ready
- next_owner: claude
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sonnet5（高）
- scope: 国内 jp_official の診断集計を既存 important_news_monitor_runs.diagnostics JSONB に格納する最小実装。ニュース判断・候補選定・公開・Pushは変更しない。
- safety: 独立 worktree/checkout必須。main/本番の直接変更、merge/deploy、DB migration/RPC/RLS、secrets、実API/Web Search有料呼出、外部AI送信禁止。PR116固定10/13 production worktree、PR129、G9および他slotを保護。

## 開始前の必須確認

1. PROJECT_RULES.md / .agent/ORCHESTRATION.md / ACTIVE_TASK / CURRENT_STATE / G8旧J0 Report、fresh origin/mainとPR116/129、作業tree/checkout、他slot競合と未commitを確認。task_idとready一致のときのみ開始。
2. 既存の `supabase/functions/important-news-monitor/index.ts` および `news_collection_diagnostics.ts` と該当テストを調べ、実際の保存経路と診断JSONのキーを確認する。
3. J0設計 `docs/news-coverage/JP_GENERAL_FINANCIAL_COVERAGE_J0_20261012.md` §6 を参照（J0 branch `claude/news-jp-coverage-j0-20261012` commit `d0be8977`）。今回のJ1-aブランチに未マージJ0成果物を無断混入させない。

## 実装

1. jp_official診断を既存run diagnosticsに安全に追加する。原則 `jpOfficial` 内の enabled, signalsRead, selected, alreadyKnown, inserted, deferred, enrichedPages, skipped, drops の数値/真偽集計のみ。現行集計構造に合わせ、既存診断キーを破壊しない。
2. OFF/未設定でも enabled=false、件数ゼロ相当を安全に表現し、呼び出し増加や候補・配信への影響を生じさせない。部分失敗でも監視本体を停止させない。個人情報、source URL、記事タイトル、Secrets、全文を診断に格納しない。JSONサイズとログ量を抑える。
3. 変更可能ファイルは `supabase/functions/important-news-monitor/index.ts`、`supabase/functions/important-news-monitor/news_collection_diagnostics.ts` と同じモジュールの該当test、必要ならJ1-a専用文書に限定。G9/API provider、PR129本文抽出、PR116本番ソースなどに変更が必要なら止めて相談。
4. 現行API/Web Search呼出数、DB schema、判断結果、候補数、X/アプリ/Pushへの副作用は増やさない。元の診断構造と後方互換にする。

## テスト・完了条件

- OFF / ON / skipped / drops / 部分失敗 / JSONシリアライズ / 不要情報混入無しのテストを作る。
- important-news-monitor の関連テストと既存回帰、lint/type、git diff --check、secret scanを実施。テスト件数と未実施項目を明記。
- mainとの対象path交差、他slot、PR116・PR129への非干渉を検証する。競合があればpushせず報告。
- 独立G8 branchにcommit/push可。Draft PRは必要なら作成してよいがmerge/deployは禁止。
- Reportには task_id/result/changed_files/tests/commit_hash/push/PR/merge/deploy/safety_checks/remaining_issues/next_recommendation を記載。完了時は review_required / next_owner chatgpt。返却先: ニュース改善API最適化のちゃ、完了コードK8。
- production Edge deployと診断read-backは別承認。K8がコード受入れ後に検討。

## Report

（G8が実装後に記入）

---

## Preserved prior G8 TASK / Reports / evaluations — DO NOT EDIT history below

# Claude Task G8 — 日本の一般重大ニュース＋金融ニュース網羅強化 Phase J0（取得→アプリ到達監査と次段実装設計）

- task_id: news-improvement-a-jp-general-major-financial-coverage-j0-g8-20261012
- owner: claude
- slot: claude-8
- status: done
- next_owner: none
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（中）
- allocation: USER PRIORITY：G8は「ニュース改善A」専任。日本の一般重大ニュースと国内金融・経済・企業ニュースの充実を優先。G9=API最適化B、ほかG/H・別案件のTASK・Report/worktreeには触れない。
- scope: **Phase J0に限る**：本番read-only事象単位gap監査→取得sourceと合法利用可否の比較→アプリまでのfunnel可視化→offline評価ハーネス/合成fixturesと明示的なPhase J1実装計画。
- required_quality: 重要ニュースの取りこぼし（recall）優先。ただし事実未確認の誤報・無許諾コンテンツ利用・既存配信遅延を許容しない。
- safety: production read-only aggregate SELECT only、実API有料呼出/追加Web Search実課金/本番書込み/PR merge/deploy禁止。
- freeze: PR #129（head 81251b316ae44a634a1b4108b420a18765d17261 / OPEN Draft）・PR #116の10/13固定production worktree・G9ほか全slotを変更しない。

## ユーザーの新しい優先要望（2026-10-12）

かぶモリで国内情報を大幅強化する：
1. **一般重大ニュース**：重大事件、企業不祥事、事故、災害、サイバー攻撃、訴訟、社会的問題、政策急変等（投資・市場への影響のあるものを中心とし、未確認の犯罪疑惑を事実扱いしない）。
2. **金融・経済**：日銀・金利・為替・景気・物価・財務省/金融庁・銀行/証券/保険/市場インフラ・規制/税制・国家政策。
3. **日本企業**：TDnet/IRに加え、IRに出る前の不祥事・障害・製品事故・訴訟・行政処分・M&A・サプライチェーン等。
4. **アプリ掲載を拡大**：X投稿基準とは独立させ、見逃せないニュースは広く一覧へ。Pushは緊急・重大のみを基本にし、ユーザー設定とFact/権利/出典確認を守る。記事取得数・X公開数・アプリ表示数・Pushを混同しない。
5. これまでの「公式・無料ソースで兆候、重要な穴のみ限定Web補完、取りこぼし最小、API費用抑制」は維持。規約に抵触する無料RSSスクレイピングで穴埋めしない。

## 現状の根拠（ChatGPTによる2026-10-12 JST本番read-only集計）

- 過去7日間 `news_discovery_signals` の `source_id like 'jp_%'` は173件、`important_news_candidates` の `source_name='jp_official'` は11件（公開2件）、TDnet公開86件。**173→11は単純な同一記事の追跡ではない**。必ずURL/normalized title/event単位で照合し、母集団・期間・権利・dedupe差を説明して正確なfunnelにする。
- 全レーン過去7日 candidates943件 / X公開146件 / app_title_ja非null20件 / important_news Push sent79件。ただし**app_copyの有無≠アプリ表示**。公開146件の追加app_copy=0でも、Fact通過のpost本文・日本語開示・原語fallback・既存RPCによる表示はあり得る。既存 `get_my_important_stock_news` と `get_my_important_stock_news_phase5_base` の可視性フィルタ・`alert_settings`・追跡銘柄条件・アプリホーム市場3件/保有3件上限を読むこと。過去の203?といった未検証数字は使わない。
- 本番 `important-news-monitor` Edge v102と現在mainに `IMPORTANT_NEWS_JP_OFFICIAL_LANE=enabled` でのみ走る独立経路あり。現行コードでも`jp_mof_news`、`jp_fsa_news`、`jp_kantei_news`、`jp_caa_news`、`jp_jma_extra`がenabled、`jp_esri`と`jp_jma_eqvol`は意図的にOFF/重複排除。フラグ実値を推測しない。7日で`jp_official`の11件は記録されたが、現時点のON/OFFは未確証。run diagnostics JSONの仕様と観測可能性も調査。
- `docs/news-coverage/REDESIGN.md`、`docs/news-sources/news_acquisition_architecture.md`、`news_recall_benchmark.md`、`news_source_catalog.md` に先行設計あり。**これを読まずに別の巨大ニュースシステムを設計し直さない**。現状main/本番の進化との差を表形式で明記。
- PR #129はFed statement＋TDnet決算factsを独立既定OFFにする**別リリース工程**。このTASKではPR129のsource/migration/merge/deployを操作しない。

## Phase J0作業指示

### A. 現状把握（新規実装の前）

1. まず `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md` と本TASK・旧Report、fresh origin/main / worktree/checkout/未commit/競合を確認。G8に割当`ready`、task ID一致・専用独立checkout確保の場合のみ進む。PR129の旧G8作業treeとPR116の本番専用checkoutは一切触らず、**fresh mainから別のG8専用J0 branch/worktree**を作る。
2. 既存 `_shared/news_discovery`、`news-discovery-observer`、`important-news-monitor` (`jp_official_*`, `breaking_market_*`, `headline_trigger_*`, `news_coverage_*`)、TDnet、`get_my_important_stock_news(_phase5_base)`、`src/lib/news-presentation.ts`, `src/lib/home-news-sections.ts` をread-only調査。責務・漏れ・権利ゲート・ON/OFFを一覧化。
3. 本番DBへのアクセスは可能なら**匿名/集約read-only SELECTのみ**、個人の保有銘柄、氏名、デバイストークン、ユーザーID、private本文、Secretsは取り出さない。接続できない場合は上記のちゃ監査値に`reported_unverified`注記し、想像で数値を埋めない。
4. 直近7/14日、平日と10/12祝日を分ける。分野別の`source→signal→candidate→judgement→generation→X公開→app list eligibility→app home→push`を**event_idまたはsource_url等で一対一にトレース**し、数を比較できない段階はNULL/不可と示す。**日本語app_copyを作らない＝表示ゼロ**と誤解しない。JP公式173/11/2の欠落reason（合法sourceなし、規則filter、候補のdedupe、判定no_post、生成failed、アプリseverity、ユーザー表示/最大件数、Push gate）を原因別に分類。アプリの実機表示についてread-onlyデータで証明できない場合は`NOT_VERIFIED_ON_DEVICE`と明記。
5. Xに出す閾値と、アプリ内の一般ニュース/金融/銘柄別の表示閾値を分けて改善案を設計する。タイトルだけ・Fact未確認の事件を断定しない。Pushは現仕様を勝手に緩めず将来案を提示する。

### B. 国内ソースと一般速報の具体的な埋め方

6. 「金融庁/財務省/首相官邸/消費者庁/気象庁/内閣府/日銀/TDnet/EDINET/JPX」に加えて、**公取委、経産省、警察庁、消防庁、国交省、厚労省、防衛省/外務省、地方・都道府県発表、企業newsroom**等をsource catalog候補として**実際の公式feed/API・公開条件・更新遅延を確認したものだけ**掲載。RSS/APIがない場合は存在すると仮定せず`unknown`にする。
7. 無料の公的情報だけでは事件・企業不祥事の初報が遅い。**商用利用・機械取得・AI入力・表示/引用それぞれを独立に許される根拠で確認**し、ニュース媒体・転載サイト・Google/Yahoo/NHK等を「公開RSSだからOK」と扱わない。GDELT等のメタデータや合法なシグナルを検討する場合も、メタデータの利用権と元記事の転載権は別。利用条件が不明なら現時点で実装/常時巡回/外部AI送信しない。`internal_trigger_only`さえ規約違反なら使用禁止。
8. 一般速報の候補は`event (主体・行為・対象・時刻)`で重複統合し、出典URLと検証状態を保管。重大事故/不祥事/訴訟の真偽・確定/捜査段階を混同しない。記事本文・写真の無断複製やAI外部送信はしない。一次情報による確認、複数独立情報、最新性、誤情報の訂正/取消経路を要件として作る。
9. 限定Web Searchは事故・訴訟・不祥事・戦争初報・金融インフラ障害・急な市場変動の**空白eventだけ**に発火する次段案を作り、抑制・重複防止・日次費用上限/skip条件と誤Fact guardを記載。本TASKでは**実有料呼出なし・予算未承認**。
10. sourcesは重点順に Tier A（契約不要と確認した公式・安全な信号）/Tier B（利用条件の整理が必要）/Tier C（有料配信契約/許諾検討）に分け、機能と権利の両面で本当に使えるsourceのみ次実装候補へ進める。商用規約をユーザーに事実として断定するときは根拠URLと確認日を添付。

### C. オフラインで再現可能な品質ベンチマーク

11. 過去の`docs/news-sources/news_recall_benchmark.md`を活用し、**著作権本文なしの自作架空合成**fixtureで以下を最低各2例：企業不祥事・事件/事故・金融規制/銀行破綻・日銀政策・地震/ミサイル・行政処分/訴訟・重要でない反例、計14件以上。`discovered / relevant / eligible_for_app / urgent_push`を**別の判定軸**としてオフライン分類する検証スクリプト/テストを `tools/jp-news-coverage/`等のJ0専用・他slot非競合パスに追加可能。既存本番pipeへのimport/DB migration/Edge変更は**不可**。
12. 失敗要因`no_source, terms_excluded, filtered_rule, no_candidate, judgement_rejected, generation_failed, app_display_gate, push_policy, duplicate_event, unknown`と、`fetched_at`・`first_public_at`・`judgement_at`・`display_eligible_at`（分かる範囲）の列定義を作り、重大事件/金融ニュースの**event単位Recall、アプリ到達率、遅延p50/p90**を測れるようにする。正解集合は本人の毎時監視ログ＋公式発表＋既存候補など多源だが、実ログが入手できないときは`NOT_AVAILABLE`と明記。
13. 小さな実装PoCは**オフライン・mock・自作fixtureだけ**。外部AI・実WebSearch・第三者本文・本番API・DB書込み不可。正例だけでなく、行政処分との噂混同/誤報/旧ニュース再掲/告発の未検証/外国事件と日本関連なしなどの負例も含める。費用・誤判定・遅延の推定は`estimate`と実測を区別。

### E. 追加必須要件 — 国内限定Web検索コスト・費用対効果の厳密評価（ユーザー追認 2026-10-12）

- **判断前提**: 国内の重大事件・企業不祥事・訴訟・事故・日銀/銀行/保険/証券・政策急変等、一次情報の取得元が不足する領域なら**規約に適合した限定Web検索の追加費用は許容検討する**。ただしユーザーは価格調査を要求しており、**検索実行・課金の許可はまだない**。候補案・過去台帳集計・純粋なoffline仮計算だけで評価する。
- **公式料金（2026-10-12確認）**: OpenAI Responses API 通常`web_search`は **$10/1,000ツール呼出 = $0.01/ツール実行＋検索コンテンツの入力トークン、モデル入力/出力料金**。preview non-reasoningは別料金（$25/1000, search-contentトークン無料）なので混同不可。GPT-4o-mini/4.1-mini非previewは8,000入力トークン固定ブロック特例あり。料金根拠: `https://developers.openai.com/ja-JP/api/docs/pricing`（2026-10-12）。
- **本番の旧実績（2026-10-12 read-only確認）**: Supabase project `wsmznyzcvmuitkglfeuj` の `public.ai_usage_events`で`created_at >= '2026-10-06 00:00+09'` / `feature LIKE 'news_breaking_search|%'` / `web_search_calls>0` を集計：**31 Responsesイベント、Web Search tool 33 calls、推計cost_usd合計$0.42074、1 tool call平均$0.01275**、平均入力13,375・平均出力210 token/イベント。使ったmodelは`gpt-5.6-luna`。`cost_usd`は内部見積もりでOpenAI確定請求とは限らない。直近変更前に多数検索した古い期間を混ぜて月額予算としない。日次実測及び請求書との差異を明記。
- **国内向けの追加呼出だけの予算感**（30日×各日定額、**$0.013/検索仮定**）：5/day = 150 calls/`$1.95/month`; 10/day = 300/`$3.90`; 20/day = 600/`$7.80`; 40/day = 1,200/`$15.60`; 80/day = 2,400/`$31.20`。2026-10-12の参考為替`$1=約¥158.43`なら、それぞれ約¥309/¥618/¥1,236/¥2,472/¥4,943。**通常検索の増分のみ**で既存Web検索、判定Luna/Sol、app-copy/翻訳、fact check、生成、Supabase処理費と超過呼出/リトライは含まない。最大ケース/イベント当たり2回検索・複数検索ツール起動等を入れた悲観ケースも別途作る。
- **J0必須成果物**: (1) 日本一般速報・金融・企業の各カテゴリ別 source gap数、(2) 0/5/10/20/40/80検索/day × 検索context(low/medium) × 1/2回tool呼出を分けた月額 **search only / search+judgement / search+article creation** 3段階総費用表、(3) **1件の真に追加発見された重要eventあたりの増分ドル費用**（cost_per_new_verified_major_event）を過去監査またはoffline eventサンプルから推定。イベント原票が無ければ`NOT_MEASURABLE`と明記し、仮定のみの数値と区別する。
- **節約しつつRecall優先**: 無料・合法的に取得した公式/公的signalとGDELT等の合法メタデータを先行。eventレベルのトリガーを`already_covered / insufficient_official / urgent_domestic_incident / corporate_scandal / financial_system_breakdown / policy_surprise`等へ分け、各source/eventにTTLとクールダウン・URL/event重複除去、2段階の検証で不要な再検索を避ける。危機時は優先度枠を残す設計とし、安さだけで重要事象を除外しない。
- **予算ガード案は提案のみ**: 月額検索予算・soft/hard JST日次上限・同時実行時の原子reserve・一事象検索回数とmodel`max_tool_calls`・失敗時再試行・利用台帳と通知閾値・費用超過時停止・重大事象の例外承認が必要。初期案を**平常10/day、異常時20〜40/day（ユーザー承認待ち）**として設計し、例外超過は黙って実行しない。現行 generic検索4/dayとは別の**増分予算**として集計し、旧shadowのsoft30/hard48がそのままproduction稼働予算だと誤認しない。
- **規約・出典**: Web検索でページが見つかっても元記事の著作権・機械取得・AI外部入力・転載利用を自動的には取得できない。公式一次資料を別確認、アプリには事実を独自に要約しURL出典を付す。規約で不可の新聞RSSや記事本文を「searchだから合法」と見なさず、技術/規約未確認はHOLD。
- **具体的な報告**: `docs/news-coverage/JP_GENERAL_FINANCIAL_COVERAGE_J0_20261012.md`に上記公式価格URL・確認日・DB監査SQL（個人情報無し）・増分月額表・実測/推定区別・導入KPIとSTOP条件を追記。J0中に本番APIを呼ばない。次`K8`に**「いくら払えば何件改善できる見込みか」**を提示。正式な本番予算、どの検索/モデルを使うかはG8の独断で承認しない。

### D. 報告と次フェーズ設計

14. 成果を `docs/news-coverage/JP_GENERAL_FINANCIAL_COVERAGE_J0_20261012.md`（実測可観測なfunnel＋missing reasons＋既存設計との矛盾＋source rights matrix＋次J1案）へ保存。J0 offline harness/fixturesはあれば各変更ファイル一覧。推奨J1実装は「権利OKの国内速報信号をshadowのみ追加」「必要時だけWeb補完」「アプリ一覧/市場全体の表示判定改善」の**3本を競合しない順番**に分割し、優先順位・対象ファイル・必要承認・tests・費用ガードを具体化。将来の広域ニュース計画をG8 TASK内に保留メモとして置き続けず、正式な設計文書へ切り分ける。
15. git diff --check・必要なDeno tests/check/lint・source rights scan・secret scanと、PR129/PR116/G9/他slotへの変更0を確認。G8専用J0のbranchへcommit/pushは可能（安全な独立worktreeがある場合のみ）。新Draft PRは必要なら作成提案だけでよい；既存PR129へのcommit/rebase/mergeは禁止。
16. 完了時は本TASK末尾の`## Report`に task_id, result, baseline_window, source_candidates, rights_clearance, delivery_funnel, gap_reasons, benchmark/tests, changed_files, commit_hash, branch, push, merge, deploy, remaining_issues, safety_checks, recommended_J1_TASK, next_recommendation を記録。status`review_required`/next_owner`chatgpt`として**K8を「ニュース改善API最適化のちゃ」へ返す**。意図的に未確認の権利・本番有効化条件はBLOCKED/要承認とする。

## K8 evaluation — 2026-10-12 JST
- PASS_SOURCE_DESIGN / PRODUCTION_HOLD: J0 design and offline harness accepted; production funnel NOT_VERIFIED, tests 6 PASS reported by G8 only.
- Commit d0be8977, six J0-only paths; no deployment/merge or paid API.
- Next J1-a requires separately assigned G8 task.

## Report

- task_id: news-improvement-a-jp-general-major-financial-coverage-j0-g8-20261012
- result: J0 完了（監査・設計・オフライン評価）。**本番read-only集計は auto mode に拒否され未実行 → 実測funnelは NOT_VERIFIED**。ChatGPTの数値(173/11/2 等)は reported_unverified のまま。ソース/本番/PR129/PR116/他slot 変更なし。
- baseline_window: 7日（SQLは窓変更で14日・JST日別・10/12祝日分離に対応）。実行はユーザー側 `tools/jp-news-coverage/run_j0_funnel.sh`（1つのjson、ID/URL/タイトル/ユーザー無し）。ローカルPGで構文・集計動作のみ検証済み。
- source_candidates: 稼働=財務省/金融庁/首相官邸/消費者庁/気象庁特別警報(jp_official)、OFF=ESRI(リンクがメニュー頁)/JMA eqvol(market_macro重複)、EDINET(キー未登録)。公取委・警察庁・消防庁・外務省・自治体・企業newsroomは先行カタログに評価なし→`unknown`（feed実在を仮定しない）。国交省・厚労省・経産省・防衛省・e-StatはTier B。
- rights_clearance: 国内主要報道(NHK/時事/朝日/毎日/Yahoo!/東洋経済 等)は機械取得・AI入力・表示とも許諾なし(D)→使用禁止。JPX RSS不可、TDnet閲覧サイトはrobots全拒否、日銀は商用転載事前相談。**初報を埋める合法・無料源は構造的に無い**（有料配信の契約・一次情報網羅拡大・限定Web検索のいずれか）。規約は先行docs(2026-09-28)の転記で本日再確認なし。権利リスク未解消: headline triggerのAl Jazeera(D)/BBC(C)、UN News(C)、日銀、TDnetレーン。
- delivery_funnel（コード確定分）: レーンは enabled 5系統のみ読み、48h/READ_LIMIT200/挿入6件/25s予算/テーマfilterはデフォルトDROP。`jp_official`候補は`rejected`でも、base `market_feed` は rejected 除外条件を持たない（wrapperの`broad_feed`はtdnet/company_irのみ可視）ため、severity≥medium＋追跡銘柄sector一致なら表示され得る（意図か不整合か未確認）。日本語app_copyは可視性の条件ではない（表示は 検証済み投稿文→app_copy→開示→日本語本文→原文抜粋）。ホームは市場3/保有3、一覧RPC最大50。実機表示は NOT_VERIFIED_ON_DEVICE。
- gap_reasons: 173→11は別母集団（jp_%全系統 vs enabled5系統、routine drop、容量、重複、judgement no_post）。公開2はX基準でアプリ到達とは別。原因別の件数は集計SQL実行後に確定。観測穴=**レーンON/OFFと drops 診断がDBに残らない**（HTTPレスポンスのみ。`collectionDiagnostics` に jpOfficial 無し）、signal側にcandidate_id無し。
- benchmark/tests: `tools/jp-news-coverage/`（合成fixtures16件・7グループ各2以上+負例4、4軸 discovered/relevant/eligible_for_app/urgent_push と miss_reason 10種、recall/アプリ到達率/遅延p50p90、時刻なしは NOT_AVAILABLE）。deno test 6件PASS、lint clean。モデル検証であり本番実測ではない。
- changed_files: docs/news-coverage/JP_GENERAL_FINANCIAL_COVERAGE_J0_20261012.md, tools/jp-news-coverage/{fixtures,classify,classify_test}.ts, run_j0_funnel.sh, prod_readonly/j0_funnel_aggregate.sql（すべて新規・本番未接続）
- commit_hash: d0be8977afc2ee53626e10c52a106e36e6c35168
- branch: claude/news-jp-coverage-j0-20261012（origin/main 0d7a35fb 起点）
- push: done（ls-remote で同SHA確認）。Draft PRは未作成（提案のみ）
- merge: not_performed
- deploy: not_performed
- remaining_issues: 本番集計の実行、JP公式レーン本番値の確認、権利リスク源の方針、base market_feed の rejected 非対称、新規feedの実在・規約一次確認、有料配信/Web検索の予算。
- safety_checks: 本番read/write・Edge・Cron・Secrets・有料API・外部検索なし（本番readは拒否され迂回せず）。PR129(81251b31)/PR116固定/G9/他slot未変更。secret/diff-check clean。使い捨てPGは停止。
- recommended_J1_TASK: J1-a 観測性（jp_official診断をrun diagnosticsへ、DB変更なし）→ J1-b アプリ一覧表示判定（migration=別承認）→ J1-c 権利OKの国内公的feedをshadow追加（要プローブ）→ J1-d 限定Web検索（要予算承認）。詳細は設計文書§6。
- next_recommendation: ユーザーが集計スクリプトを実行→結果で原因別funnelを確定。ちゃがJ1-aを先行TASK化。K8をニュース改善API最適化のちゃへ返却。

---

## Preserved prior G8 TASKs / Reports / evaluations — DO NOT EDIT history below

# Claude Task G8 — PR #129 最小リリース安全装置：新本文取得の独立OFFスイッチ（R5）

- task_id: news-improvement-a-pr129-release-safety-env-switches-g8-20261012
- owner: claude
- slot: claude-8
- status: done
- next_owner: none
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sonnet5（高）
- scope: ニュース改善A/G8専任。PR129の新規Fed本文取得と決算短信facts自動生成を**別々に安全停止**できる最小実装+回帰テストのみ。他案件・G9・ほかG/H枠へ引継ぎ禁止。
- PR: https://github.com/anohi-memories/kabumori/pull/129
- reviewed_head: 0a2df248f6e49bcb1bfea690f38064c93e5f895c
- preceding_qa: news-improvement-a-pr129-premerge-offline-integration-qa-g8-20261012 (source MERGE_CANDIDATE)
- forbidden: merge, deploy, production env change, production DB/Edge, secrets, Cron, API/model/provider, schema/RPC/migration, paid AI, external live Fed/TDnet, non-G8 worktrees/tasks, unrelated code

## 背景（今回のK8判断）

前G8 R4 source-only QAは latest当時の main `cdb066fa...` + PR129 head `0a2df248...` で `git merge-tree --write-tree`と一時checkoutの`git merge --no-commit --no-ff`が**衝突0**、QA checkoutで重要ニュース761/抽出34/discovery+observer162/shadow20（加えてshared ai_provider94）すべてPASSを報告。GitHubでPR129 OPEN/Draft/unmerged、HEADは同SHA、Netlify Preview success、Vercel build-rate-limitによるfailureを確認。mainはその後 `26d6921667701027033c1ea9d2cc67a31617b45b`に前進したがQA-mainとの変更ファイル交差は0、GitHub mergeable表示は現在UNKNOWN（過去MERGEABLEを確定値扱いしない）。

既存H4指摘3件R1/R2/R3はG8 R3で修正、R4の回帰PASS。**新たな誤Factの再発指摘ではない**。ただしPR129は本番にdeployされると新規Fed声明本文とTDnet決算factsが即時有効で、安全にOFFにする環境変数がない。PR116（固定merge commit `a26e4365ebcb701491629892e8bae207d28833c2`）の2026-10-13 JST朝8時前production Edge反映は別工程。PR129はそこへ混入禁止、PR116本番作業のworktree `/Users/yuya/Developer/kabumori-pf`保護。

## 今回の限定実装

1. `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, G8 TASK/Report、PR129最新head、fresh main、既存worktree・未commit変更・競合対象を最初に確認。G8専用独立worktree/checkoutで作業し、他slotのbranch/server/worktreeには触れない。
2. **Fed公式声明本文取得のみ独立ゲート**: 推奨env `IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT=enabled` の時だけ、`important-news-monitor/index.ts` fed元候補への`storedStatementStates`/`enrichFedStatementCandidates`/`fillMissingCandidateBody` の新規処理を動かす。未設定/空/typo/disabledなら新規Fed本文取り出し・更新を一切行わず、**従来のFed RSS候補処理は保つ**。Fed以外の公式source、既存市場macro/JP official/breaking/trigger分岐は変えない。disabled pathで追加read/write/fetchが増えないようにする。
3. **TDnet決算短信factsの別ゲート**: 推奨env `IMPORTANT_NEWS_TDNET_KESSAN_FACTS=enabled` の時だけ `official_source_fetchers.ts` の新しい `composeTdnetPdfBody` / `assessKessanBody` を評価。OFFなら既存の `buildTdnetBodySummary(text)` が従来通り返され、PDF取得数・fetch制限・source policy・非決算の汎用要約・失敗時スキップを改変しない。PDF取得自体まで無効化しない（PR129以前のTDnet PDF処理は維持）。新しいFact検証機能だけOFFにする。
4. **デフォルトOFF / 明示ON / fail closed**: `=== "enabled"` 以外はOFFとする。既存の`IMPORTANT_NEWS_JP_OFFICIAL_LANE`等を参考に命名と環境変数読み取りを最小化。Provider/model/APIキー/DB/Cron/本番envの変更禁止。将来個別ONの選択はこのチャットのちゃとユーザーが別途判断する。コード上に本番OFF手順とON判定をreadmeか短いrunbookに明示（Secrets値は記載しない）。
5. **OFF既定の回帰**: Deno.env.getをmock/stubまたはプロセスenv安全設定した offline test を追加。Fed独立ON/OFF・Fed statement vs minutes/projections・Fed失敗＆既存候補の更新なし/あり、TDnet 決算facts ON/OFF・非決算 generic・ダッシュ/符号/数字折返し・正常IFRS等。**OFFの旧経路**と**ONのPR129 R3安全機能**を両方確かめる。既存の重要ニュース761、抽出34、discovery/observer162、shadow20等を後退させない。テスト数を正直に報告。R4のsource-only/PR116固定ソースへの影響を説明。
6. **稼働時の切替注意**: env flagはdeploy済みEdgeの環境として反映されるまで単独では効かない場合がある。切替方法は既存の運用に沿って具体的な手順/可否をread-only調査し、**本番設定変更/Edge deploy/secret writeを実行しない**。OFF時は既存のFed headline-only判断やTDnet旧要約に戻るので、ニュース漏れ/従来数字のあいまいさが消えるわけではないことを記録。
7. 不要な設計変更・新しいFact抽出・DB待機キュー・再判定backlog・外部API課金・BOJ本文接続は禁止。H4/C4は既にレビュー完了、H4を再レビューに無断再利用しない。ONの場合に突然別DB writeが起きないよう新旧全ての新規更新をゲートできることをテストで確証する。
8. 安全な状態でのみ既存PR129ブランチ`claude/news-body-integration-phase7-20261011`へcommit/pushしDraft維持、merge/deployしない。競合があればpush停止・報告。
9. 完了後は`## Report`にtask_id/result/flag_names/default_off/on_behavior/off_behavior/tests/changed_files/commit_hash/push/PR_head/PR_state/remaining_issues/safety_checks/next_recommendationを記し、**K8を「ニュース改善API最適化のちゃ」へ返す**。次K8でflag修正とQAを確認してmerge判断。G8はニュース改善A専任のまま、別案件は一切引き継がない。

## K8 evaluation — ChatGPT, 2026-10-12 JST

- verdict: PASS_SOURCE_REVIEW / MERGE_CANDIDATE / DEPLOY_HOLD
- verified_PR: #129 OPEN/Draft/unmerged, exact head `81251b316ae44a634a1b4108b420a18765d17261`, parent R3 `0a2df248`、R5は1 commit / 6 changed files、PR total16 files。GitHubに2つの独立フラグのsourceと7つの新mockテストがある。
- Fed flag: `IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT===enabled` の条件でのみ `storedStatementStates` / enrichment / body fillを実行。OFFは既存RSS受理・headline-only判定を維持。TDnet flag: `IMPORTANT_NEWS_TDNET_KESSAN_FACTS===enabled` の時だけ数値表facts先頭、それ以外は従来keyword summaryのまま。どちらも初期OFFで独立、BOJ本文未接続を維持。
- verification_scope: GitHub source + tests + commit diff; Deno runはG8報告 important-news-monitor768PASS、news_body_extraction34PASS、shadow20PASS、news_discovery/observer162PASS。ChatGPT自身はDeno/実Edge/PostgREST実行せず。R4のQAは当時mainとのmerge-tree+一時統合競合0、QA時点main後進19 commitsの主な変更は.agent/等で対象sourceの重複は無し（GitHub比較）。現在GitHub mergeabilityはunknown（API null）、merge済みとは主張しない。
- CI: Netlify Preview success、Vercel failureのURLはbuild-rate-limitのため、CI全greenとは主張しない。
- unresolved: 既存no_post/generation_failed行の再判定なし、F7上限/RSS消失、TDnet fallback旧要約数値の曖昧さ、BOJ rights、実本番On運用検証なし。OFFにしても旧機能の品質制約は残る。R5 README冒頭にはPhase6当時の「まだEdgeに未接続」という古い説明があるため、次の最小文書整備時に訂正する（今回source release blockerとは判定しない）。
- decision: G8 R5 TASKはdone/next_owner none、次のTASKは自動割当しない。**PR129のmergeとdeployはまだ実施しない**。2026-10-13の固定PR116 production反映は別工程でread-backが必要。PR116にPR129を混入させない。ユーザー承認とPR116実反映後のfresh SHA/mergeability確認を経てPR129のmergeを検討。導入時は両フラグOFFで開始し、各ONは別途承認。
- routing: ニュース改善Aは引き続きG8専任、API最適化B/G9や他G/Hは不干渉。


## Report

- task_id: news-improvement-a-pr129-release-safety-env-switches-g8-20261012
- result: implemented — 2つの独立・既定OFFスイッチを追加（機能/Fact抽出ロジックは不変）
- flag_names: `IMPORTANT_NEWS_FED_STATEMENT_BODY_ENRICHMENT`（Fed公式声明本文）, `IMPORTANT_NEWS_TDNET_KESSAN_FACTS`（TDnet決算短信facts）
- default_off: 両方とも `=== "enabled"` の完全一致のみON。未設定/空/`true`/`Enabled`/`disabled`/typoはOFF（fail closed）。
- on_behavior: Fed=statement項目のみ公式ページを読み、factsを本文化し、保存済み・未判定・本文なしの行へguard付きで本文追記（R3までの安全機能は全て有効）。TDnet=`composeTdnetPdfBody`でfacts先頭の本文（読めない表は注意文＋従来要約）。
- off_behavior: Fed=RSS候補は従来どおり（見出しのみ）、stored-state read・声明ページfetch・body fill が一切走らない（`selectCandidates` の追加列も要求しない）。TDnet=従来の `buildTdnetBodySummary` の結果をそのまま返す（PDF取得数・サイズ上限・失敗時の例外・非決算要約は不変）。Fed以外のmacro/JP official/breaking/trigger分岐は未変更。
- tests: important-news-monitor 768 PASS（761+新規7）; news_body_extraction 34 PASS; shadow 20 PASS; discovery+observer 162 PASS（合算の重複なし）; 新規7件=TDnetフラグ値判定/OFF==従来要約/失敗系不変/非決算不変、実 index.ts ハンドラ＋RSS/DB mockでFed OFF(未設定・空・true・Enabled・disabled)は声明ページ非取得・本文null・PATCHなし、ON は声明のみ取得し据置4.25〜4.5%を本文化・議事録は不変、フラグ名の分離。旧実装(フラグなし)では新規テストは import 不能/OFF期待でFAIL。typecheck=既存TS2322のみ、lint=97(baseline同数)、diff --check clean。
- changed_files: important-news-monitor/{index,official_source_fetchers,fed_statement_enrichment_test,kessan_pdf_body_integration_test}.ts, release_flags_test.ts(新規), _shared/news_body_extraction/README.md（OFF手順/ON判定を明記、Secrets値は記載なし）
- commit_hash: 81251b316ae44a634a1b4108b420a18765d17261
- push: done（claude/news-body-integration-phase7-20261011, 0a2df248→81251b31）
- PR_head: 81251b316ae44a634a1b4108b420a18765d17261
- PR_state: OPEN / Draft / 未merge
- 切替の注意（read-only調査・実行はしていない）: フラグはEdge Functionの環境変数。deploy済み関数に反映するには関数のsecrets/環境へ設定が必要（`supabase secrets set` は全関数versionを更新する既知の挙動、readbackで確認）。repo側は何も設定しない。OFFに戻すとFedは見出しのみ判定、TDnetは従来keyword要約に戻り、ニュース漏れリスクと数字のあいまいさは消えない。
- remaining_issues: 既存 no_post/generation_failed/published 行の再判定は未実装（意図的）。実PostgREST/Edgeでの競合・実Fed文書の過去会合言及頻度は未確認。mergeabilityは再取得が必要（過去のMERGEABLEを確定値としない）。
- safety_checks: merge/deploy/本番env・DB・Edge・Cron・Secrets変更なし、有料API・実Fed/TDnet取得なし（テストはmock）、PR116(a26e4365)固定・kabumori-pf・他slot/G9未変更、BOJ未接続維持。
- next_recommendation: K8でフラグ実装とQAを確認。本番投入は PR116反映後に merge→deploy（両フラグOFFで出荷）→必要に応じて個別にON、の順を提案。ON判断はちゃとユーザー。

---

## Preserved prior G8 Tasks / Reports / Evaluations (immutable history below)

# Claude Task G8 — PR #129 統合・マージ前 Source QA（R4）

- task_id: news-improvement-a-pr129-premerge-offline-integration-qa-g8-20261012
- owner: claude
- slot: claude-8
- status: review_required
- next_owner: chatgpt
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sonnet5（高）
- scope: Aニュース改善専任G8によるsource-only・offline premerge QA。新機能実装・機能仕様拡張なし。B=G9、他G/H案件へ一切引き継がない。
- target_pr: https://github.com/anohi-memories/kabumori/pull/129
- target_head: 0a2df248f6e49bcb1bfea690f38064c93e5f895c
- commit_source_changes: 禁止（既存コードの欠陥を発見した場合は自動修正せず報告し、ちゃが別TASKを判断）
- prohibited: merge, deploy, production DB/Edge/Cron/Secrets, paid API, real external Fed/TDnet requests, schema/RPC/migration, other worktrees, PR116 release workspace; PR115/G9を触らない

## 目的・K8判定

前G8 TASK `news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012` は `0a2df248` に5ファイル/1commitのR3をpushし、H4独立レビューで見つかった以下3件を修正したと報告。GitHubソース/関連テストをChatGPTが確認：
- H4-R1 P1 決算短信interleaved amount/%の折返し誤Fact → header layout確認・安全な結合・不明時fail-closed。
- H4-R2 P2 Fed公式本文fillと見出しのみ判定保存の競合 → 空本文snapshotを原子的条件付きPATCHで確認、staleなら保存せず次回判定。
- H4-R3 P2 FOMC過去利上げと今回据置の混同 → 決定文ごとaction/range/changeを束ねる、曖昧なら保留。
G8自己報告：important-news-monitor761 PASS、extraction34 PASS、discovery/observer162 PASS、shadow20 PASS、実PDF60件のfacts51件で原文一致51件。ChatGPTはコマンド未実行。PR129 OPEN/Draft/未merged。本番未反映。

**K8評価：SOURCE_CORRECTIONS_ACCEPTED / PREMERGE_QA_REQUIRED / MERGE_DEPLOY_HOLD**。H4がすでに1回重要な独立レビューを実施しており、今回は**新たな全面レビューの繰返しではなく、最新mainとの統合安全性とreleaseゲートだけをQA**する。

## 作業

1. **fresh state**：`PROJECT_RULES.md`・`.agent/ORCHESTRATION.md`・`.agent/ACTIVE_TASK.md`・`.agent/CURRENT_STATE.md`・G8 TASK/Reportを読む。PR129 exact HEAD / main / other slots worktree list / 未committed変更/競合/PR116の固定本番ソースを確認。安全な独立G8 QA worktreeまたはcheckoutを用意。既存G8実装用worktreeもそのまま保護し、他slotのcheckout/reset/dev serverを操作しない。
2. **main差分と統合可否の実証**：K8時点でmain `7a5d7e3f42526c92552bd7d585602ed692a9b103`、PR base `77a627da`。mainはその間約330commit前進、GitHub変更ファイル集合の重複は0だが `mergeable_state=unknown`。開始時最新のmainを再取得し、変更ファイル交差・依存API/型/パッケージ差・`git merge-tree`等の**read-only merge simulation**を行い、conflict/compatibilityを検証。`main`にもPR129 branchにもmerge/rebase/force-pushをせず、実際のmerge commitは作らない。preview検証が必要なら一時QA専用branch/checkoutに限定し他ownerを触らない。
3. **高リスク3点だけの最終回帰**：H4-R1（m/2m/折返し＋負号＋IFRS＋EPS＋fail-closed）、R2（judge_pendingの実handler mockでselect→fill→save CAS、0行/他lane/先進status/即時生成不可）、R3（Fed現在と過去、複数現在判断は保留、正常raise/lower/maintain、反対票）。加えて旧F1-F9とF7毎時 starvation防止などの既存テストをsource-onlyでまとめて再実行。各ケースの期待値、全PASS/失敗、実PDF60件の対象・集計、G8前報告との差を明記する。ネットワーク/実本番DB/実モデル/実公表なし。
4. **配信前の運用安全ゲート**：Fed enrichmentがどのruntime条件でONになるか、RSS 14日鮮度や20秒budget/cold startでの取りこぼし、未処理no_post / generation_failed / publishedの履歴保全と新本文再判定未実装、TDnet読取不可fallback原文数字、BOJ本文未接続/権利保留、生成Factの照合元の正しさを短いrelease-checklistにまとめる。QAで既知制約と新しい確定欠陥を区別し、**未解決問題をPASSに隠さない**。特にPR116の2026-10-13固定production反映へのPR129混入を防ぐため、今どのコミットがdeploy予定か照合（PR116の本番deploy実行はしない）。
5. **CI確認**：K8時点 Vercel failureは`build-rate-limit`のURLを指し、Netlify Previewはsuccess。ビルド制限をコード失敗と扱わず、GitHubがmergeabilityを計算できていない場合はUNKNOWNと記載。偽のCI GREENやマージ可能断定は禁止。
6. **結論を出す**：source-only `MERGE_CANDIDATE`・`CHANGES_REQUIRED`・`BLOCKED`のいずれか。源コード変更が必要なら **このTASKでは作業しないで**原因、最小fix対象と再現条件を報告。統合問題がなければマージ候補にはできるが、**実際のPR129 merge/deployはChatGPTの次回判断とユーザー承認を待つ**。このQA工程はユーザーに代わって本番反映を承認するものではない。
7. **完了記録**：既存TASK末尾の`## Report` に task_id / integration_main_SHA / PR_head / merge-tree結果 / affected_paths / tests / 3fixes_checked / flags_and_risks / CI / result / changed_files(通常none) / commit/push(原則none) / merge/deploy(no) / safety_checks / next_recommendationを記録し、K8を`ニュース改善API最適化のちゃ`へ返す。

## Report

- task_id: news-improvement-a-pr129-premerge-offline-integration-qa-g8-20261012
- integration_main_SHA: cdb066fad5b2a7bd20ce4e0685f50f575fe560ef（開始時点のorigin/main。K8時点 7a5d7e3f からさらに前進、PR base 77a627da）
- PR_head: 0a2df248f6e49bcb1bfea690f38064c93e5f895c（PR #129 OPEN/Draft、未merge、GitHub mergeable=MERGEABLE / mergeStateStatus=UNSTABLE＝Vercelのみ失敗）
- merge-tree結果: `git merge-tree --write-tree origin/main <PR head>` 競合なし（tree 616943c5…）。使い捨てworktreeで `git merge --no-commit --no-ff` も "Automatic merge went well"、15ファイル追加/変更・競合0。**commit/ref/push は一切作成せず `merge --abort` 後にworktree削除**。
- affected_paths: PR129=15ファイル（_shared/news_body_extraction/*7、important-news-monitor/{candidate_body_fill,fed_statement_enrichment,index,official_source_fetchers}.ts と関連テスト4）。mainの前進(124ファイル)との交差は0。main側で変わった _shared/ai_provider・market_report_* は important-news-monitor が import しておらず、静的依存の衝突なし。
- tests（統合結果の使い捨てcheckout上、offline・mockのみ）: important-news-monitor 761 PASS / news_body_extraction 34 PASS / important-news-shadow 20 PASS / news-discovery-observer 37 PASS / _shared/news_discovery 125 PASS（observer+discoveryの合算162と一致）/ _shared/ai_provider 94 PASS（main側の追加分、参考）。FAILなし。typecheck=既存TS2322(x_oauth2_post.ts)のみ、lint=97件(baseline同数)、diff --check clean。実PDF60件はソース不変のため前回結果(facts51/一致51/prose4/missing4/空1)を採用し今回は再取得せず。G8前報告761/34/162/20と一致（件数の差なし）。
- 3fixes_checked: R1（m個/2m個/grouped/折返し結合/注記挿入・過不足でfail-closed/amounts_only確証）、R2（実index.tsのjudge_pendingハンドラ＋fill競合、他lane/先進status/0行区別/即時生成なし）、R3（過去利上げ×今回据置、複数現在決定は保留、通常raise/lower/maintain、反対票）— いずれも既存テストで再実行しPASS。旧F1〜F9・F7毎時starvation防止も同スイートでPASS。
- flags_and_risks（未解決を隠さない）:
  1. **Fed本文取得と決算短信factsはフラグ/kill switchなし**。`fetchSources===true` のmarket_macro fedループと、TDnet PDF経路に無条件で有効。deploy時は即時ON（停止手段はdeploy rollbackのみ）。ON/OFFが必要なら別TASKでenv flag追加が妥当。
  2. 既存 no_post / generation_failed / published 行への新本文再判定は未実装（pending_judgement かつ本文空のみ更新）。履歴は保全されるが、旧見出しのみ判定は是正されない。
  3. Fed取得は1回2成功/4試行/20秒budget。RSS鮮度は14日(MAX_MARKET_MACRO_ITEM_AGE_MS)。cold start・連続失敗時は取りこぼし得るが、呼出間隔依存の恒久starvationはない（4件超の永続失敗は確率的）。取得間隔は10分想定でrepo内未確認。
  4. 本文が読めない決算短信は「読み取れませんでした」注記＋従来keyword要約にfallbackする。その要約内の数字（期の取り違えあり得る）は確定Factではなく参考扱いで、生成Factの照合元が従来要約になる点は既知制約（PR116のTDnet忠実性ガードに依存）。
  5. BOJ本文は未接続（boj_document_text.tsはPhase 6モジュールとして存在するがindex/fetchersから未参照を静的テストで確認）。権利確認待ち。
  6. 並行競合は mock による再現で、実PostgREST/Edgeでは未確認。実Fed文書での過去会合言及の頻度も未確認。
  7. PR #129はPR116固定コミット a26e4365 の祖先ではなく（`merge-base --is-ancestor` で確認）、a26e4365 の変更ファイルに PR129 のファイルは含まれない。PR116の10/13本番反映が a26e4365 固定ソースである限りPR129は混入しない。PR129を先にmainへmergeしても、deployをa26e4365固定のworktree(kabumori-pf)から行えば影響しないが、mainからのdeployに切り替える場合はPR129が入る点に注意。
- CI: Vercel=FAILURE（既知のbuild-rate-limit系。コード失敗とは扱わない・未再実行）、netlify deploy-preview=SUCCESS。GitHub mergeable=MERGEABLE だが mergeStateStatus=UNSTABLE。CI GREENとは主張しない。
- result: **MERGE_CANDIDATE（source-only）— ただし deploy は上記1(無フラグ)と2を承認した上で別判断。実merge/deployはChatGPT判断とユーザー承認待ち**
- changed_files: none
- commit_hash: none（ソース変更・commit・pushなし。本Reportのみmainへ）
- push: not_performed（PR129 branch / main のソースとも）
- merge: not_performed
- deploy: not_performed
- safety_checks: 本番DB/Edge/Cron/Secrets/有料API/実Fed・TDnet外部取得なし（テストはmock、実PDF再取得もなし）; PR129 branch・main・他slot/G9/PR115/PR116(kabumori-pf)・G8実装worktree(kabumori-p7)に未変更; 使い捨てworktreeは削除済み。
- next_recommendation: ChatGPT判断。mergeするなら(a)Fed/決算短信facts用のenvフラグ追加を別TASKで先行するか、フラグなしで即時ONを承認し、(b)PR116 10/13反映後にPR129をmerge→deploy、(c)非pending行の再判定は別設計。K8をニュース改善API最適化のちゃへ返却。

---

## Preserved previous G8 tasks, reports, evaluations (history; do not edit)

# Claude Task G8 — PR #129 H4独立レビュー3件の最小修正（R3）

- task_id: news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012
- owner: claude
- slot: claude-8
- status: review_required
- next_owner: chatgpt
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- type: targeted code correction after Codex H4 C4
- target_PR: https://github.com/anohi-memories/kabumori/pull/129
- reviewed_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54
- review_report: .agent/CODEX_REPORT_4.md
- review_verdict: CHANGES_REQUIRED / P1×1 P2×2
- user_routing: Aニュース改善専任G8だけ。API最適化B/G9、ほかG/H、別案件に触れず、引継ぎもしない。
- forbidden: production deploy/merge/paid API/real DB/real Edge/real Fed/TDnet requests, schema/RPC/migration/Cron/Secrets/provider/model changes, other worktrees/tasks

## 目的（レビューの繰返しではなく、実装とテスト）

H4によるPR129独立レビューは完了、C4確認済み。H4はソース未変更。GitHub PR129のレビュー済head `7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54` はOPEN/Draft/未merge（作業開始時にHEAD再確認）。既存968 PASS、H4独立12 probeの9 PASS/3 FAILは**実行済みレビュー結果**で、失敗した3件は安全性期待を破る合成再現。

以下のH4-R1(P1),R2(P2),R3(P2)だけを**実際に修正**する。F7の従来毎時modulo取りこぼしの改善、旧F1〜F6・F8等を維持。Styleや無関係なコードを広げない。失敗を誤Factにしないfail-closedを優先し、正常配信の不必要な停止を避ける。

## H4-R1 [P1] 決算短信：折返したinterleaved列の金額/増減率誤変換

- 対象 `supabase/functions/_shared/news_body_extraction/kessan_tanshin_facts.ts` の `parseRow()`、特に `tokens.length === metrics.length` を無条件でamounts_onlyにする処理と継続行の無視。
- **独立再現合成テキスト（架空数値）:**

```text
2026年3月期 決算短信〔日本基準〕(連結)
(百万円未満切捨て)
（１）連結経営成績
売上高 営業利益 経常利益 親会社株主に帰属する当期純利益
百万円 % 百万円 % 百万円 % 百万円 %
2026年3月期 1000 10 100 20
80 30 50 40
2025年3月期 900 5 90 6
70 7 40 8
```

- 真の当期金額: 売上1000 / 営業100 / 経常80 / 純利益50（百万円）。変化率 +10/+20/+30/+40%。旧実装は `ok=true, issues=[]` で営業10・経常100・純利益20を確定Factと出力する。
- 必須修正: `m` 個の数値をamounts_only行として認めるのは **headerからlayout==='amounts_only'と確証できる場合だけ**。interleaved/groupedの2m未満行は、明確で安全な継続行結合ができる条件だけ結合し、そうでなければ **表を読取不可・重要Fact非出力**。続行が別期間/forecast/注記に跨るのを誤結合しない。正常なinterleaved, grouped, amounts_only, 負号分離/IFRS/連結/forecast EPSを回帰で維持。
- 必須テスト: 上記折返し、次行切れ/欠落、曖昧な注記挿入、正常m/2m表、forecast EPS余剰token。同じ誤金額を確定の `kessan_facts` として通さない。読み取れない場合は明示issuesにfail-closed。

## H4-R2 [P2] 判定と本文追記のTOCTOU競合

- 対象 `important-news-monitor/index.ts` の `selectCandidatesForJudgement`→ `saveCandidateJudgement` と新 `candidate_body_fill.ts`。
- **独立再現:** `pending_judgement, body_summary=null` を `judge_pending` がSELECT→AIを一時停止（見出しのみでno_post推論）→同じrowに公式本文が `fillMissingCandidateBody` でPATCH成功→古いAI結果を返す→保存PATCHは `id+pending_judgement` のみなので旧no_postの理由が本文あり行に保存される。
- **修正要件:** 読み取った `body_summary` snapshot と保存時の値を**原子的な条件付き更新(CAS)**で照合し、変化していたら古い判定を保存せず、即時生成せず、`pending_judgement`を維持して次回公式本文で判定できる。再SELECTだけのTOCTOU、既存headline-only `content_hash` だけの比較を修正済みとしない。成功行は従来どおり処理。
- 変更の範囲は今回の**新規本文追記が関係する**レーンに限定できるなら限定する。初期bodyがnull/空の保存条件を `body_summary.is.null/eq.` 等で原子的にfilterする方法を検討し、PostgRESTクエリのNULL/空の意味と既存有本文/長文/URL長/特殊文字/他laneへの副作用を試験する。snapshotを一般に安全にCASできない場合は勝手なschema/RPC/migrationを追加せずBLOCKEDとして最小設計を報告。判定変更時に過去本文を消したり二重生成を許さない。
- 本番同時処理は mock mockだけで不十分の可能性を明記。少なくとも **実 `index.ts` handler のjudge_pending経路 + 本文fill経路**をDeno/DB mockで独立再現し、失敗前→修正後に同じ旧判定が保存されないことを確認。0-row conditional UPDATE の扱いは故障と競合を区別し、即時生成しない。bulk処理が古い判定で中断しないよう可能な限り既存作業制御を保護。
- `content_hash` はheadline-only保持の既存duplicate方針と矛盾しないことを確認。必要なら判断に明示リスク報告、危険なら勝手に広範囲変更しない。

## H4-R3 [P2] FOMC声明本文で過去の判断を今回の判断として採用

- 対象 `supabase/functions/_shared/news_body_extraction/fomc_statement_facts.ts` の `extractFomcStatementFacts()`。
- 旧実装: 記事全体に `decided to raise` が1つでもあれば、現在の `maintain` より優先し、金利レンジ・変更幅もそれぞれ本文の最初のmatchから取る。R1の正規URL/日付/文書種別検証では防げない。
- **独立再現合成HTML:** 正規URL `monetary20261009a.htm`、ヘッダー `Federal Reserve issues FOMC statement`、公開日 `October 9, 2026` を一致させた公式風本文：

```text
At its July meeting, the Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 4-1/4 to 4-1/2 percent.
At this meeting, the Committee decided to maintain the target range for the federal funds rate at 4-1/4 to 4-1/2 percent.
```

- 期待：**今回は4.25〜4.5%で据え置き**。旧出力 `4.25〜4.5%（引き上げ、25bp引き上げ）` は誤り。
- **修正要件:** action/range/changeを**同一の確定できる今回の政策決定文に結合**。過去の会合への参照やquoted historical actionを現在と区別し、複数の決定候補で確証なければ `facts.ok=false` / withheld（誤Factを作らない）。Fed通常の単一声明のraise/lower/maintain、分数レンジ、反対票/氏名、R1の同一性チェックを維持。英語文解析の過剰推測で特殊例を通さない。
- 実Fed文書で頻度は未確認。合成入力と実運用の発生を混同しない。

## 実行・安全条件

1. G8のTASK/Report、`PROJECT_RULES.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、`.agent/ACTIVE_TASK.md`、H4 `.agent/CODEX_REPORT_4.md` を確認。PR129最新headとfresh `origin/main`、worktree list、未commit変更、他slot所有、対象ファイルの他作業競合を確認。
2. PR129を編集する場合はG8**専用の独立**worktree/checkout。G9の評価ツールとPR115の所有ブランチ、PR116本番保護worktree、H4 worktree/他slot branch/dev serverを一切変更しない。並行他ownerがPR129を同時編集しているなら即停止。
3. 対象原則: `_shared/news_body_extraction/kessan_tanshin_facts.ts`, `fomc_statement_facts.ts`, `important-news-monitor/index.ts` の必要な狭い修正と関連テストのみ。候補本文fillそのものの安全条件は維持。DB schema/RPC/migration/Auth/Cron/Secrets/provider/modelの変更は別途明示承認が必要。
4. F7既存時刻依存starvationが戻ってないこと、旧F1〜F9で既に修正済みの検証、正常決算短信・通常Fed声明が過剰に止まらないことを再実行。offline no-net: G8前報告757 important-news-monitor、29 extractor、162 discovery/observer、20 shadowとH4既存968のscope差を説明し、件数を重複合算しない。
5. 3件それぞれ **修正前FAIL→修正後PASS** をG8-ownedテストとして恒久化。H4再現ログが別worktreeにある場合、参照だけで既存H4作業物を改変しない。Deno check/lint baseline `x_oauth2_post.ts:66` 既知エラーと今回新規を区別。実PDF/実Fed/本番/PostgREST実行していない場合は未確認と記す。有料API/公開/投稿はすべて不可。
6. 同一PR129既存branchへの変更は競合なし確認できた場合だけcommit/push可、Draft維持、**merge/deploy禁止**。PR116明日固定本番のソース混入を禁止。
7. 3件の欠陥が残るなら全面PASSを自称しない。固定head、変更ファイル、重要Factのbefore/after、実テスト、PR state、commit、既存F9のno_post backlog制約/20秒budget制約を含む `## Report` に結果を記録し、**`K8` をニュース改善API最適化のちゃへ返す**。新たなCodexレビューを独断で割り当てない。C4は既に完了、H4を勝手に再利用しない。

## Report

- task_id: news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012
- result: implemented — H4-R1/R2/R3 fixed with tests; no schema/RPC change
- reviewed_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54（開始時のPR129 head=同一、競合なし）
- H4-R1 [P1]: `parseRow` は「m個の数値」を、見出しの単位行が amounts_only と確証できる場合だけ金額行とする。interleaved/grouped でm個なら ROW_INCOMPLETE。折返しは「数値のみの次行」を2m個になるまで結合、注記・別期間・過剰・欠落は読取不可でfail-closed。before: 指摘の合成表で営業10/経常100/純利益20を `ok=true` で出力 → after: 売上1000/営業100/経常80/純利益50（+10/+20/+30/+40%）。正常m/2m/grouped/EPS余剰は不変。
- H4-R2 [P2]: `saveCandidateJudgement` は、本文なしでSELECTした候補の保存を `status=pending_judgement AND (body_summary is null OR '')` の1回の条件付きUPDATEで行う（snapshotは「空」のみで足りる＝fillは空の行にしか書かないため。長文URLなし）。0行の場合は読み戻しで「本文が後から付いた(NEWS_JUDGEMENT_STALE_BODY_CHANGED、pendingのまま次回再判定)」と「行が先へ進んだ(NEWS_JUDGEMENT_CANDIDATE_CHANGED)」を区別。即時生成しない、一括処理は候補単位のエラーとして継続（従来動作）。実 index.ts の judge_pending ハンドラ（Deno.serve捕捉＋PostgREST/OpenAI mock）で、モデル実行中に実 fillMissingCandidateBody が成功する競合を再現: before=旧no_post理由が本文あり行に保存 → after=保存されずpending維持。content_hashはheadline-only維持（既存duplicate方針と矛盾なし）。
- H4-R3 [P2]: action/range/changeを同一の「今回の決定文」から読む。過去会合・前回・月名・引用を含む文は履歴として除外。異なる現在決定が複数なら AMBIGUOUS_DECISION で ok=false。before: 4.25〜4.5%（引き上げ、25bp）→ after: 4.25〜4.5%（据え置き、変更なし）。通常の単一声明/反対票氏名/R1同一性は不変。
- changed_files: _shared/news_body_extraction/{kessan_tanshin_facts,fomc_statement_facts,review_fixes_test}.ts; important-news-monitor/{index,judgement_body_race_test(新規)}.ts
- tests: important-news-monitor 761 pass（前757+新規4）; news_body_extraction 34 pass（前29+新規5）; discovery+observer 162 pass; shadow 20 pass（重複合算なし。H4の968は別scope/別集計で、本報告の件数と単純加算しない）; before-fail確認: R1 2件/R2 1件/R3 2件が旧実装でFAIL; F7回帰（呼出間隔非依存）維持; lint 97(baseline同数); typecheck既存TS2322(x_oauth2_post.ts)のみ; 実PDF60件再照合: facts51/数値一致51/prose4/missing4/空1（変更なし）。
- commit_hash: 0a2df248f6e49bcb1bfea690f38064c93e5f895c
- push: done（claude/news-body-integration-phase7-20261011, 7bf9b8a0→0a2df248）
- PR_head: 0a2df248f6e49bcb1bfea690f38064c93e5f895c（PR #129 Draft/OPEN、未merge）
- merge: not_performed
- deploy: not_performed
- remaining_issues: (1) 既存 no_post/生成失敗/公開済み候補への本文反映は未実装（意図的、履歴保護・設計判断待ち）。(2) 本文fillの20秒budget・取得枠は従来どおり。(3) 並行本番での実競合は mock による再現であり実PostgREST/Edgeでは未確認。(4) 実Fed文書での過去会合参照の頻度は未確認（合成のみ）。
- safety_checks: 本番deploy/merge/DB schema・RPC・migration・Cron・Secrets・Provider・モデル変更なし; 実DB/実Edge/実Fed/TDnet(PDF fetchはローカル検証のみ既存手順)・有料API呼出なし（テストはmock）; PR116・他slot/G9/H4 worktree未変更。
- next_recommendation: 再レビューは R1(折返し・amounts_only確証)/R2(CAS・0行区別)/R3(決定文選択)に限定。K8をニュース改善API最適化のちゃへ返却。

---

## Preserved previous G8 tasks, reports, and K8 evaluations (do not edit)

# Claude Task G8 — PR #129 R2：K8追加指摘F7の公平性・F9境界確認

- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- owner: claude
- slot: claude-8
- status: done
- next_owner: codex-4
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- allocation: ユーザー専任指定の「ニュース改善A」のG8のみ。ほかのG/H枠・別案件・API最適化B（G9）に触れない。
- task_type: prior K8 CHANGES_REQUIRED narrowly scoped corrective implementation
- review_base_pr: https://github.com/anohi-memories/kabumori/pull/129
- review_base_head: 984eeb41f14257be56ecfc00e9a55fa01d1ee136
- safety: 本番deploy/PR merge/DB schema/RPC/migration/Cron/Secrets/Provider/モデル変更/有料API/他worktree操作は禁止

## K8評価の理由（完了判定：CHANGES_REQUIRED / RELEASE_HOLD）

- 2026-10-11のG8前TASK `news-improvement-a-pr129-f1-f9-remediation-g8-20261011` は `984eeb41` に6ファイル変更をpush。PR129はOPEN/Draft、未merge。G8が重要ニュース748、抽出29、discovery162等PASSを報告したが、ちゃ自身はローカルテスト未実施。
- F1〜F6・F8について具体的修正と回帰テストがGitHubに存在する。**F7の時間依存ローテーションに別条件で取りこぼしが残る**ため、K8は最終PASSを出さない。
- **必ず再現すべき反例**: `fed_statement_enrichment.ts` は `rotation=Math.floor(Date.now()/(10*60*1000))` を `eligible.length` で剰余する。一定の順番の新規FOMC声明が3件、取得上限2、起動が正確に毎時（60分=10分刻み6回）なら `(rotation+6)%3 === rotation%3` となり**毎回同じ2件しか取得せず、3件目を恒久的に保留**する。従来の「rotation:0/1/2」テストだけでは本番間隔を再現していない。実際のCron/呼出頻度はsource・runbook・read-only既存資料から確認し、未確認の本番実行間隔を断定しない。
- F9について `pending_judgement` かつ本文空の既存候補へのguard付きPATCHという新しい**本番DB更新経路**がPR129に含まれる（まだdeploy無し）。F9の `no_post`, `generation_failed`, `published` 等は未解消。公開済み重複投稿を防ぎ、ステータス・content_hashとbody_summaryの不一致やjudgementとの同時競合を安全に扱えるか独立レビュー要。
- 旧G8 Report内のF8個別結果記載が欠落し、`## Report` が厳密な見出しになっていない。旧履歴は全文保持し、今回のReportは明確な独立見出しで報告する。

## 今回の実装範囲と検証

1. **F7修正**: 実監視タイミングをsourceで確認し、1時間間隔/30分間隔の合成スケジュール（連続3〜6回）、再起動・cold start、候補3〜4件、上限2件、同一順序、先頭既存/失敗を含めて、有限周期で未処理の全件に処理機会が回ることを検証する。単に10分ずつ手動でrotation引数を増やすテストは禁止。実行間隔と候補数の公約数によるエイリアシングを防ぐ。既存DB上の有効な実行ID/履歴利用が必要な場合はSELECT-onlyのread pathに限り、DB schemaや本番設定変更を勝手にしない。任意周期を保証できない条件は明示。
2. **F9安全性確認**: Guard付きPATCHが `pending_judgement`・空本文以外を絶対更新しないよう、テストはfetch/DBを完全mockする。選択→同時処理→更新の競合を模擬し、body内容・candidate.content_hash・その後のjudgement/duplicate経路の整合、書込み失敗時の報告・再試行、行状態read-back、二重配信回避を点検する。**欠陥を認めたらPR129内で安全に修正**。スキーマ/RPC/実データ移行を要する場合は禁止事項を守り、別工程が必要な理由と最小安全設計を提示。非pending行は履歴保護のため現段階では変更しない。
3. **F1〜F6・F8正常系維持**: 前回の修正・合成ケースと実PDFで数値・連結/個別・FOMC文書同一性が壊れていないことを確認。F8ミドルイニシャルの個別Report結果を今回含める。新規レビュー対象はF7/F9と回帰に限定し、他P1を不要に書き換えない。
4. **PR/安全境界**: PR129だけ更新。G8専用独立worktree/checkoutをfresh origin/mainから確立。旧G8/他slot/G9/API-B/PR116のbranch・worktree・TASKを一切変更しない。PR116は2026-10-13予定の固定コミット専用、PR129混入禁止。BOJ取得未接続、著作権に注意。本番DB読み書き・実Edge呼出・有料AI使用なし。GitHubに先行したPR129更新や対象変更の競合があれば停止。
5. **テスト**: F7の本番想定固定時刻テストは修正前FAIL→修正後PASS。F9 mockの保存状態（pending/no_post/published/generation_failed）・競合・ハッシュ対応・監査保全のテスト。important-news-monitor全体、Phase6/7/R1、news_discovery/observer等既存suiteをオフライン再実行。実測未実施は未実施と記録。typecheck/lint既存baselineとの比較。
6. **完了**: 必要な変更だけPR129 branch `claude/news-body-integration-phase7-20261011` にcommit/push、Draft維持、merge/deployせず、F7/F9の残余リスクと再レビューの対象/判定を報告。F9の保留部分をPASS扱いしない。新しいコミットがあればその正確なSHAを記載し、`K8` をこのチャットに返却。追加レビュー担当を勝手に使わない。

## K8 evaluation — ChatGPT, 2026-10-12 JST

- verdict: ACCEPTED_IMPLEMENTATION / INDEPENDENT_REVIEW_REQUIRED / MERGE_HOLD
- verified_PR: PR129 OPEN/Draft/unmerged, head `7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54`, R1 `984eeb41` より1 commit/5 source+test files。Netlify/Vercel GitHub checks success、production検証・deployは未実施。
- source_review: `fed_statement_enrichment.ts` のF7を時刻剰余によらない順序へ変更、`candidate_body_fill.ts` のF9 conditional PATCH/結果read-backを確認。事実検証・実ネットワーク/DBを伴うend-to-end証明は未完了。G8報告757件などのDenoテストをChatGPT自身は再実行していない。
- remaining: F7 4件超/cold start/RSS消失のcoverage guarantee、上限20秒のhard timeoutではないこと。F9はpendingのみ、no_post/generation_failed/published等は歴史保護のため未更新、判定SELECTとの並行、content_hash据置が重複/出典監査に与える影響。
- next_action: 高リスクEdge/DB/FactsのためH4に**一度限りの重点Codex独立レビュー**（Sol（高）、`H4`開始→`C4`をこのチャットへ）を登録。G8のR2実装TASKはdoneとし枠を別案件の保留に使わない。A専任はG8維持、要修正ならC4後にG8へ戻す。マージ・デプロイは禁止。PR116とG9は別工程。

## Report

- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- result: implemented (F7 root-cause fixed; F9 boundary hardened and tested; non-pending rows deliberately unchanged)
- F7: 時刻剰余ローテーションを廃止。反例（3件・上限2・毎時起動で `(rotation+6)%3` が不変）は取得上限を「成功数」で数える方式に変更して解消。試行は最大4回/20秒、順序は「直近失敗が少ない順→乱数タイブレーク」で、呼出間隔(10/30/60分)に依存しない。未取得≤4件は毎回全件に機会があり、それ以上はwarm instanceで失敗を後回し、cold startは乱数。厳密な毎回保証は4件超では不可（永続化なしの限界）。
- F9: DB書込み部を `candidate_body_fill.ts` に分離（スキーマ/RPC変更なし）。PATCH条件 = id一致 + status=pending_judgement + source_name=market_macro + 本文null/空、1文を原子的に更新、返却行を読み戻して本文・status一致を検証（不一致は例外）。content_hashは意図的に不更新（見出しのみ候補のhashと一致し続け重複扱いを維持）。他レーンの行は取得対象外。書込み失敗は例外→sourceErrors→次回再試行、競合で既にstatusが動いた行は"skipped"。published/no_post/generation_failed等は一切変更しない。
- F1〜F6・F8: 変更なし（再回帰で維持）。F8個別結果: ミドルイニシャル付き反対者 `Christopher J. Waller`・`Michelle W. Bowman` を完全氏名で2票と読む／票数と氏名が食い違えば氏名省略(uncertain)／不明確なら票数を作らない — review_fixes_test の2件でPASS。
- changed_files: important-news-monitor/{fed_statement_enrichment,fed_statement_enrichment_test,index}.ts; 新規 candidate_body_fill.ts, candidate_body_fill_test.ts
- tests: important-news-monitor 757 pass（前回748→+新規F7 5件/F9 mock 6件、旧static 1件置換）; news_body_extraction 29 pass（Phase6 19+R1 10）; news-discovery-observer+_shared/news_discovery 162 pass; important-news-shadow 20 pass; F7新規5件は旧実装で5件FAILED→修正後PASS; lint 97（baseline同数）; typecheck既存TS2322のみ; diff --check clean。実PDF60件の再照合は今回kessan側を変更していないため未再実施（前回: facts 51/数値一致51）。
- commit_hash: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54
- push: done（claude/news-body-integration-phase7-20261011, 984eeb41→7bf9b8a0, fast-forward）
- PR_head: 7bf9b8a0a014ebe9a613e9ebeb0082d0b7834c54（Draft/OPEN, 未merge）
- merge: not_performed
- deploy: not_performed
- remaining_issues: (1) F9の非pending行（published/no_post/generation_failed）は未解消のまま意図的に未変更。履歴保護とstatus遷移の設計が必要。(2) 判定の実行中に本文を後付けすると、その1回の判定は見出しのみで確定し得る（Phase 7前と同等。ガードで公開済み二重投稿・生成済み行の改変は起きない）。(3) fed取得間隔は10分想定だがrepo内で確認できず、実装は間隔非依存にした。(4) 4件超の永続失敗では厳密保証なし。
- safety_checks: 本番deploy/DB schema/RPC/migration/Cron/Secrets/モデル/Provider変更なし、有料API・実DB/Edge呼出なし（DBは完全mock）; PR #116(a26e4365)・他slot/G9/kabumori-ex/kabumori-pfのbranch・worktree・TASKへ変更なし; BOJ未接続維持。
- next_recommendation: 独立レビュー(F7アルゴリズム/F9 guarded PATCH)へ。F9非pending行は別設計判断。K8をニュース改善API最適化のちゃへ返却。

---

## Preserved previous G8 TASK / Report (immutable history below)

# Claude Task G8 — ニュース改善A / PR #129 R1指摘9件の修正実装

- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- owner: claude
- slot: claude-8
- status: review_required
- next_owner: chatgpt
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- scope_owner: このチャットの「ニュース改善 A」のみ。今後もA作業はG8に割当（個別TASK完了後は同じ枠で再割当）。他の案件、他のG枠のTASKや作業を引き継がない。
- assignment_authorization: ユーザーが2026-10-11にG8の使用を明示承認
- type: corrective implementation, PR #129 review findings
- prohibited: production deploy, merge, paid API, DB/schema/RPC/migration/Cron/Secrets/model/Provider changes, unrelated work

## 背景・現在地

- PR [#129](https://github.com/anohi-memories/kabumori/pull/129) は **OPEN / Draft / 未merge**。レビュー対象head `61dd33d72711b11eefd39f77ac2d2431b9b6a9a5`（開始時に最新headを再確認）。
- branch: `claude/news-body-integration-phase7-20261011`。Phase 6 + Phase 7の決算短信・FOMC改善を統合済みだが、独立Codexレビューの判定は **CHANGES_REQUIRED（P1 5件 / P2 4件）**。
- 今回は **レビューの繰り返しではなく、指摘への実コード修正と回帰テスト**。独立レビューはH1/H2/C1/C2とは別件で、レビュー結果はこのTASK本文のF1〜F9を正本とする。別チャットにある本文を参照させずに完結させる。
- Phase 6 original: `b8d10833a992bc285a89d3ab37b2c3acd995bad0`; Phase7 reviewed head above。初期レビューの合成入力再現で9件の安全性アサーションが失敗。合成再現であり、実際の誤配信が発生したとは主張しない。
- PR #116の本番反映予定は **固定merge commit `a26e4365ebcb701491629892e8bae207d28833c2`のみ**。PR #129のコードを混入させない。PR #116本番作業のworktree `/Users/yuya/Developer/kabumori-pf` は絶対保護。

## 必須開始チェック / 非競合

1. `PROJECT_RULES.md` / `.agent/ORCHESTRATION.md` / `.agent/ACTIVE_TASK.md` / `.agent/CURRENT_STATE.md` / このTASKを読み、G8の `ready`、所有者、return_toを確認。
2. `/Users/yuya/Developer/kabumori-fresh` のfresh `origin/main`、PR129最新head、所有者、他TASK/Report、worktree list、未コミット変更、競合変更対象を確認。G8専用の独立worktree/checkoutを作る。既存A単独セッションが同じPR129を現在編集している可能性があれば、**同時変更はせず停止・報告**する。
3. `kabumori-ex`（Phase6）、`kabumori-pf`（PR116）、他slotのworktree/branch/dev server・未commitファイルは一切操作しない。H1〜H5/G1〜G7/G9/G10および他のTASK/Reportを編集しない。Bの`tools/provider-compare/`と評価用ドキュメントも触らない。
4. 権利確認待ちの日銀 `boj_document_text.ts` を本番経路へ接続しない。PR115や他PRへ変更を混ぜない。

## F1〜F9（レビューで再現された修正要件）

### F1 [P1] 分離した負号を除去し、損失を利益として出力
- 場所: `_shared/news_body_extraction/kessan_tanshin_facts.ts:103–104` の `parseRow`。
- 入力: 営業利益欄 `△ 100 △ 20`。現状 `+100百万円、+20%`、期待は `-100百万円、-20%`。結合した `△100 △20` は正常。
- 対応: 別トークンの負号を安全に数値へ結合、対応不明や想定外トークンは黙って落とさず **行を拒否**。誤った本文を後段Fact/VoiceがPASSするモックでも公開候補になり得るため、上流で防ぐ。正常・異常テスト。

### F2 [P1] 金額/増減率の列をトークン数だけで交互配置判定
- 場所: `kessan_tanshin_facts.ts:108–118`。
- 指標4列・単位 `百万円 百万円 百万円 百万円 % % % %`、数値行 `1,000 100 80 50 10 20 30 40` は **金額4個→増減率4個**。現状は交互配置と判断し営業利益80・経常利益10・純利益30に誤る。期待額は100/80/50。
- 対応: 見出し+単位+列配置から対応を確証する。交互配置と横並び配置の両方、曖昧な場合のfail-closedをテスト。数の個数だけから推定しない。

### F3 [P1] IFRS税引前利益を経常利益に誤置換
- 場所: `kessan_tanshin_facts.ts:56`, 出力名 `:205`。
- `売上収益 営業利益 税引前利益 親会社の所有者に帰属する当期利益` で税引前利益80を「経常利益80」と出力。
- 対応: 異なる会計指標を分離し元見出しの意味を保持。未対応なら数値を創作せず拒否。

### F4 [P1] 連結/個別の逆転
- 場所: `kessan_tanshin_facts.ts:93–95,170`。
- 直前に `参考: 個別財務諸表`、対象表の最近接見出しは `(1)連結経営成績`。現状個別と誤分類。
- 対応: **当該表に紐付いた最近接の明示見出し**を優先し、相反する場合は拒否。近傍の無関係な語で上書きしない。

### F5 [P2] 比較対象の四半期が不一致
- 場所: `kessan_tanshin_facts.ts:187–188`。
- 当期 `2026年3月期第1四半期`、前期 `2025年3月期第3四半期` を前年同期として出力。
- 対応: 年だけでなく決算期末月、四半期、累計/単独、通期/中間期、連結/個別の比較可能性を検査。確証なければ「前年同期比」にしない。

### F6 [P1] 過去の議事録を現在のFOMC声明と誤認
- 場所: `important-news-monitor/fed_statement_enrichment.ts:142–150`。
- RSSの2026年声明タイトルから同一公式host内の `/monetarypolicy/fomcminutes20250917.htm` に302される合成例。2025年議事要旨内の引用を2026年声明の新しい政策判断として出力した。
- 対応: HTTPS/hostに加え **最終URL種別・文書見出し・RSS公開日と文書日付・決定の主文・元候補との同一性**を検査。過去資料やminutes/projections/引用を声明として受理しない。実Fed redirectが起きた事実とは扱わない。

### F7 [P2] maxPerFetch=2で3件目以降が永久脱落
- 場所: `fed_statement_enrichment.ts:125–135`、`index.ts:2106` と後続重複判定。
- 同順3件を3回実行すると毎回先頭2件だけ取得、3件目は0回。保存済み先頭候補も枠を浪費。超過時errorsもなし。
- 対応: 既処理候補を取得枠から除き、未取得の公平性、上限維持、理由付き観測、次回再試行を検証。RSSから消える場合の継続性も検討。永続化/schema/RPCが必要なら勝手に実装せず BLOCKED/設計報告。

### F8 [P2] 反対者名のミドルイニシャルで切断
- 場所: `_shared/news_body_extraction/fomc_statement_facts.ts:103–109`。
- `Voting against this action were Christopher J. Waller and Michelle W. Bowman, who preferred a different action.` → 現状 `Christopher J` のみ・反対票1。期待は完全2氏名・2票。
- 対応: イニシャルと文末、名前と理由節を区別。票数を推測しない。不明時は明示的に未確定として安全に省略。全会一致も証拠がある時のみ。

### F9 [P2] 同URL既存候補に新本文を反映できない
- 場所: `important-news-monitor/index.ts:2106–2108,2142–2145`、`findNewsDuplicate():434–437`。
- 旧本文なし→新しい公式本文ありでcontentHashが変わっても、URL一致によりduplicateとして破棄される。
- 対応: published / no_post / generation_failed / 判定待ち / 本文不足 を区別。公開済み二重投稿は禁止、未公開の安全な本文更新・再判定、履歴/監査記録保護、競合・idempotency確認。DB schema/RPC/実データ変更が必要なら無断変更せず、残課題と安全な段階導入を提示。

## 横断安全要件

- 「読み取れなかった」注意文だけでは守れない。誤った/曖昧な従来要約の数字を確定重要Factとして扱わない。Factの照合元が誤るとFactモデルでは救えない。初回Fact誤PASSを考慮する。
- 誤情報を出さない **fail-closed** と、正常な重要ニュースを過剰停止しないことの双方を検証。
- 日銀公式本文の新取得・保存・接続は禁止（権利確認待ち）。TDnet 403迂回、第三者記事本文の無断保存は禁止。
- APIキー/トークン/本番DB/外部書き込み/モデル/Secrets/Cron/Edge deploy/本番変更をしない。PR129はDraft継続、mergeは禁止。
- 既存の独立レビュー用 `review_test.ts` 等は別セッションのファイルのため直接改変せず、必要なら再現条件をこのTASKから自己完結でテスト化する。

## 必須テストと完了条件

- F1〜F9各項目に「before失敗→after期待値」テスト、正常対照（適法な数値・既存の交互列・声明）を追加。
- `important-news-monitor` 全体（レビュー時742 PASS）、Phase6の19件、Phase7の15件、`news_discovery`+observer（162 PASS報告）をオフラインで再実行。累計を二重計上しない。
- 可能な限り実PDF39/60件の集計と、当期/前期数値の正確性を再照合。本文はrepo/DBに保存しない。観測できない実データは未実施と明記。
- P1の5件をすべて解消。P2の4件を修正、または安全な未解決/実装停止と依存条件を明示。P1/P2未解決の状態で全面PASSを自称しない。
- 競合なしを確認できた場合に限りPR129の既存branchにcommit/push。PRheadを再取得してから差分を適用、他作業を上書きしない。**merge/deploy禁止**。
- 完了後、このTASK末尾の `## Report

- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- result: implemented — F1〜F9 all addressed in source; F9 staged (see F9). PR #129 stays Draft / unmerged.
- F1: fixed — 分離した△/▲を後続の数値に結合、結合先のない印・想定外トークンは行ごと拒否（DANGLING_MINUS / UNEXPECTED_TOKEN）。
- F2: fixed — 見出しの単位行から「交互/金額→増減率」配置を確証。確証できない8数値は LAYOUT_UNCONFIRMED で拒否（個数だけの推定を廃止）。
- F3: fixed — 税引前利益(pretax_profit)・当期利益(profit_total)・親会社帰属(net_profit)を別指標化、同一指標の重複列は表ごと拒否。経常利益へ置換しない。
- F4: fixed — 表直上の最近接の「経営成績/業績」見出しで連結/個別を決定。見出し内の相反は BASIS_CONFLICT で拒否。「参考: 個別…」では上書きしない。
- F5: fixed — 前期行は決算期末月・四半期/中間/通期・累計・1年前を満たす場合のみ。満たさなければ facts 自体を採用しない（PRIOR_ROW_*_MISMATCH）。
- F6: fixed — 候補URLが声明のプレスリリースpath、最終URL＝同path（別文書へのredirect拒否）、ページ見出しが声明、文書日付＝URL日付＝RSS日付(±3日)を要求。議事録・見通しは受理しない。
- F7: fixed (no schema) — 保存済み(本文あり)は取得枠を消費しない、残りは10分周期のローテーションで公平化、上限(2)維持、超過は deferred_over_cap を観測、失敗は次回再試行。RSSから消えた項目の継続保証は永続化なしでは不可（残課題）。
- F9: partially staged — 未判定(pending_judgement)かつ本文なしの保存済み声明は、guard付きPATCH（status=pending_judgement かつ body空）で本文を後付け（スキーマ/RPC変更なし）。published / no_post / generation_failed 等は書き換えず stored_without_body:<status> を観測のみ。再判定・履歴保護が必要な後者は設計判断待ち（DB/RPC変更が要るなら未実施）。
- changed_files: _shared/news_body_extraction/{kessan_tanshin_facts,fomc_statement_facts}.ts, review_fixes_test.ts(新規); important-news-monitor/{fed_statement_enrichment,fed_statement_enrichment_test,index}.ts
- tests: important-news-monitor 748 pass（742+新規6）; news_body_extraction 29 pass（Phase6 19+新規10; F1〜F9の before-fail→after-pass確認済み、旧実装では16件FAILED）; news-discovery-observer+_shared/news_discovery 162 pass; observer+shadow 57 pass; lint 97件（baseline同数）; typecheck は既存 TS2322(x_oauth2_post.ts)のみ; git diff --check 問題なし。
- before_after_quality: 実PDF60件(TDnet決算短信)で facts 51 / 数値verbatim一致 51 / prose 4 / missing 4 / 抽出空 1 — Phase 6と同等でF1〜F5の厳格化による取りこぼし増なし（初回実装で重複列判定が過剰に拒否し30件に低下→表行がある場合のみ判定に修正して51へ回復）。正文の改変数値は51/51検出、正しい文の誤conflictは0。
- commit_hash: 984eeb41f14257be56ecfc00e9a55fa01d1ee136
- push: done (claude/news-body-integration-phase7-20261011, fast-forward from 61dd33d7)
- PR_head: 984eeb41f14257be56ecfc00e9a55fa01d1ee136 (PR #129 Draft, OPEN)
- merge: not_performed
- deploy: not_performed
- remaining_issues: (1) F9の非pending行（published/no_post/generation_failed）への本文反映・再判定は未実装（履歴保護とstatus遷移の設計・必要ならRPC/migrationが前提）。(2) F7: RSSから消えた未取得声明の永続的再試行は永続化なしでは保証できない。(3) 日銀は未接続のまま。(4) fed取得は本番未検証。(5) 標準の正常系で「-」単独記号の分離(△以外)は曖昧のため結合しない。
- safety_checks: 本番deploy/DB/schema/RPC/Cron/Secrets/モデル/Provider変更なし・有料API呼出なし; PR #116(a26e4365)・kabumori-ex・kabumori-pf・他slotのTASKへ変更なし; 日銀本文の取得/接続なし; 実PDFの本文はrepo/DBに保存せず。
- next_recommendation: PR #129 を独立レビュー(Codex)に再提出 → F9の非pending行の扱いを設計判断（schema/RPCが必要なら別TASK）。merge/deployはPR #116反映・観測後に別途判断。K8 を ニュース改善API最適化のちゃ へ返却。
