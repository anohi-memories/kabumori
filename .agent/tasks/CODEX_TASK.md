# Codex Task

- task_id: important-news-cost-phase1-recall-safe-shadow-handoff-20260919
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: Claudeのread-only調査とPhase 0本番計測を引き継ぎ、重要ニュース監視のPhase 1をrecall最優先で再設計・追加検証する。現行productionの検索頻度を正しいbaselineとして再計算し、重大公式ソースの本文不足補完と、未確認/遅延事例を潰す。Phase 1のshadow本番導入はまだ未承認。

## User decisions / non-negotiable goals

- コスト削減より重要ニュースrecallを優先。
- ニュース監視は最終的に10分程度の高頻度を目指すが、10分ごとに高コストWeb Searchを固定4本叩く設計にはしない。
- 無料/公式ソースは高頻度、Web Searchは条件発火・fallback・補完用途へ寄せる。
- MICは速報監視の前提にしない。MICは追加トリガーとしてのみ利用し、MIC停止/遅延でも速報監視が成立すること。
- 重要ニュースのcoverageは狭めない。むしろ弱い分野を広げる。
- Phase 1 production cutoverは、recall/遅延の安全条件を満たすまで承認しない。

## Proven production state — Phase 0

ClaudeがG1/G2とは別枠で実施したPhase 0はproduction反映済み。

- important-news-monitor v58のみdeploy。
- Phase 0 commit/main: 9257c35（Claude報告）。
- ai_usage_events と important_news_monitor_runs.diagnostics.cost にニュースAI/Web Searchのusageを記録する。
- migrationなし。既存 ai_usage_events を利用。
- 他11 Functions、34 Cron、schema/migration、OAuth/Vault、Push/X設定は変更なしとClaudeが確認。
- 16:00自然実行で news_breaking_search 4行を確認:
  - web_search 4回
  - input 49,768 tokens
  - output 1,297 tokens
  - estimated cost = $0.0515 / 1 fetch cycle
- 手動OpenAI callなしで自然実行確認。
- judgement Luna/Sol、generation、app-copyのusage rowは自然候補待ち。

### Cost implication

1 fetch cycleの固定4検索が約$0.0515。

現行production baselineを必ず使うこと:
- 2026-09-19〜09-23: 2時間ごと = 12 fetch/day = 48 searches/day
- 2026-09-24以降: 1時間ごと = 24 fetch/day = 96 searches/day

ClaudeのPhase 1メモには旧20分運用由来の288 searches/day、約$111/月等が含まれているため、そのまま採用禁止。
現行48/96 searches/dayを基準にすべて再計算する。

## Claude Phase 1 read-only findings to inherit

本番変更なしで過去データ/無料ソース/GDELT等を調査。

### Historical replay summary

- production重要ニュースデータは概ね9/4以降。
- 変更しない公式RSS由来10件は10/10再現可能。
- TDnet重大IRは現行取得を維持。
- 旧Web Search由来の重要ニュース19件について:
  - 新方式でも同等か早い: 12件
  - 無料ソースの方が遅い: 2件
  - 未確認: 5件
- よって現時点で19件中12件しか安全に置換できる証拠がない。
- 70% Web Search削減と取り逃し0を同時に満たす証拠はまだない。

### Known delayed cases

- イスラエル/ヒズボラ戦闘: 新方式候補が旧方式より約+45分
- フーシ派の島占拠: 新方式候補が約+7時間

### Not-yet-proven cases

5件:
- 戦争 2
- 関税 1
- 海運 1
- 地政学 1

必ず再検証し、検索語不一致/GDELT rate limitを理由に未確認のままcutoverしない。

### Cases where new architecture could improve recall/latency

- 9/12 北朝鮮ミサイル:
  - 旧方式では拾えていない
  - GDELTに07:45記事あり
- 9/12 サウジ東西パイプライン攻撃:
  - 旧方式は13時間後の続報のみ
  - GDELTは04:00に初報
- ホルムズのイラン船被弾:
  - GDELTが旧方式より約5.5時間早い
- イランのタンカー攻撃:
  - 無料ソース候補が旧方式より約7時間45分早い
- 9/18 日銀利上げ:
  - 公式RSSは12:00取得済み
  - タイトルのみ/本文要約空
  - Luna→Sol判定でno_post
  - Web Searchで14:20に拾い直し
  - 既に無料公式ソースで取得できていたのに本文不足で約2時間20分遅延

### Source observations

- GDELT: 有望だがrate limit/取得失敗がある。単独依存禁止。
- BBC World / Al Jazeera / White House / ECB / SEC: 取得候補。
- NHK RSS: Claude調査時点では8/8以降更新停止で利用不可と判断。
- MIC:
  - production ingestは1日2回、日次データ中心。
  - market_events直近7日16件はFRED系、同じ10:00 batch、公表から数日遅れの例あり。
  - geopolitical / corporate_eventsは現状unavailable。
  - 速報起点には不十分。
  - ただし market_events / market_state_current のmaterial changeは追加Web Search triggerとして利用候補。
- 朝刊でのMIC利用はG1領域。H1ではmarket-report系を変更しない。

## Known current coverage gaps

少なくとも以下をPhase 1 coverage audit対象にする:

- 戦争 / 地政学
- 北朝鮮 / Jアラート
- 関税 / 通商 / 制裁
- 為替介入
- 中央銀行重要発言/政策変更
- 災害 / 特別警報 / インフラ障害
- エネルギー施設 / 原油
- 海運 / 海峡
- 金融システム / 銀行破綻
- 中国
- 半導体 / AI / 輸出規制
- 海外企業の重大決算/ガイダンス
- 日本企業重大IR
- 日本/米国市場急変

## Phase 1 target architecture

高頻度news polling
- free/official sources
- deterministic dedup/prefilter
- scheduled event windows
- source-health fallback
- low-frequency topic sweep
- conditional Web Search

MIC
- material change / market event
- additional trigger only
- conditional Web Search

原則:
- 何も起きていないcycleではWeb Search 0回を許容。
- ただしfree source停止/coverage gap時はfallbackでrecallを守る。
- 旧方式だけが拾う重要ニュースがある分野は固定検索を残す。
- MICを必須dependencyにしない。
- 同一eventはevent_key/source canonicalization/content hash等で重複排除候補。

## Immediate H1 goals — first, no production mutation

### A. Recalculate Phase 1 economics using correct production cadence

Claudeメモの288 searches/day前提を全て破棄し、以下で再計算:
- holiday/current: 48 searches/day
- from 9/24: 96 searches/day
- measured $0.0515 / 4 searches / fetch cycle

出すもの:
- current/day/month estimate
- shadow追加費用
- candidate designごとのsearch/day
- reduction % versus 96/day baseline
- eventual 10-min polling時のfree pollingとpaid searchの分離モデル

### B. Close the recall evidence gaps

未確認5件 + 遅延2件を最優先で再検証。

要件:
- GDELTだけに依存しない。
- query wording / synonyms / location/entity aliasesを再設計。
- official/BBC/Al Jazeera/White House/ECB/SEC/JMA等、利用可能なソースを組み合わせる。
- rate limit時のretry/backoffを評価。
- 無料ソースで拾えないことも結果として明示し、その分野はfallback維持。
- historical timestampの根拠/source URLを保存。
- production important/most_important判定実績をground truthの一つとして扱う。

### C. Investigate and design the official-title/body-missing fix

9/18 BOJ caseを一般化して設計。

目標:
- 公式/高信頼sourceで重大そうなタイトルを取得
- summary/bodyが空または不足
- そのままAI no_postにしない
- 公式本文取得を先に試す
- 公式本文が取得不能/不十分なら、必要時だけWeb Search補完
- 取得本文に対して既存judgement pipelineを通す

注意:
- BOJ専用hardcodeにしない。
- 信頼できるsource allowlist / title trigger / minimum content thresholdを明示。
- SSRF/open redirect/untrusted URL fetchを防ぐ。
- PDFの場合の既存enrichmentとの重複を確認。
- duplicate/claim/idempotencyを壊さない。
- no_post基準を無闇に緩めない。
- この段階では設計・source candidate・testsまで。production deployはC1承認前にしない。

### D. Refine shadow design without deploying

Claude案:
- separate important-news-shadow
- dedicated shadow tables
- separate Cron
- old pipeline continues publication
- shadow has no X/Push/App writes

これはまだproduction承認されていない。

H1では:
1. 必要な最小schema/Function/Cronを再評価。
2. 既存run/candidate tableをshadow flag/run_typeで安全に流用できるかも比較。
3. 二重paid searchを避ける設計を優先。
4. old pipelineのsearch resultをshadowが再利用できるか検討。
5. shadowの追加費用を正しい96/day baselineから再計算。
6. production mutationはしない。

## Required comparison / acceptance metrics

Phase 1の最優先KPIはrecall。

### Required acceptance before production cutover

- 過去 important / most_important 再現率: 100%目標
- shadow期間中の important / most_important 取り逃し: 0件
- 旧方式だけが拾った重要ニュースがある分野はfallback維持
- detection delay:
  - 個別差分を全件記録
  - 遅延が発生した重要事例は原因を説明
  - cutover候補は原則+20分以内
  - median/p95が旧方式以下を目標
- Web Search削減:
  - recall条件を満たした後に評価
  - 70%は目標であって必須ではない
  - recallを犠牲にして70%を達成するのは禁止

### Shadow comparison fields

最低限:
- event_key
- source
- category/topic
- first_seen_at
- old_pipeline_detected_at
- new_pipeline_detected_at
- old_detected
- new_detected
- importance
- detection_delay_sec
- trigger_reason
- web_search_used
- web_search_topic/query
- estimated_cost
- evidence/source URL
- free source health/status

## Source health / fail-safe requirements

- GDELT等がrate limit/downの場合、silent failure禁止。
- per-source healthを記録。
- 主要free sourceがunhealthyな分野は自動でfallback search cadenceを戻す候補を設計。
- fallback復帰はdeploy不要/設定で戻せる形を優先。
- source停止時に検索削減を維持するためニュースを捨てる設計は禁止。

## MIC integration rule

今回はMIC側を変更しない。

許可:
- production market_events / market_state_current のread-only調査
- material changeをnews-side triggerとして読む設計
- duplication/latency評価

禁止:
- MIC ingest/state evaluator source変更
- MIC Cron変更
- intraday price data追加
- market-report/G1 objects変更

将来:
- MICにintraday USDJPY / futures / oil / rates等が入れば追加triggerとして強化可能。
- それまでは速報の主監視はnews側。

## Claude artifacts / handoff caveat

Claudeが以下をローカルで作成したと報告:
- docs/news-cost-optimization/PHASE1_SHADOW_DESIGN.md
- docs/news-cost-optimization/replay/
- docs/news-cost-optimization/AUDIT_AND_PLAN.md のMIC追記

Claude報告時点では一部/全部未commitの可能性あり。

H1開始時:
1. fresh origin/mainで実在を確認。
2. 無ければ無いと記録し、このTASKに記載した検証結果を引き継ぎ正本として進める。
3. 他workstreamの未commit変更を探して持ち込まない。
4. Claudeローカル成果物を勝手に推測/再現したことにしない。

## Mandatory startup

開始前に必ず確認:
1. .agent/ORCHESTRATION.md
2. .agent/CURRENT_STATE.md
3. this TASK
4. .agent/CODEX_REPORT.md
5. 他3slot TASK
6. fresh origin/main
7. production important-news Cron read-only
8. production important-news-monitor deployed version/source metadata read-only
9. Phase 0 ai_usage_events recent rows read-only
10. Claude artifactsのmain存在有無

競合時STOP:
- 他slotが important-news-monitor/**
- important-news schema/migration
- important-news Cron
を変更中なら開始しない。

H2/G2 social-mobile、G1 market-reportへは触れない。

## Allowed work in this H1

- read-only production audit
- local/source candidate implementation
- tests
- docs
- historical replay
- shadow design
- BOJ/general official-body enrichment candidate
- cost model correction
- branch/main source commit if conflict-free and production behavior remains unchanged

## Production mutation policy

このH1ではPhase 1 production mutationは原則0。

禁止:
- new shadow migration apply
- shadow Function deploy
- shadow Cron create/enable
- existing breaking search cadence変更
- existing important-news judgement behavior production deploy
- MIC changes
- market-report changes
- X/Push/App publication behavior changes
- OAuth/Vault/secrets
- blind supabase db push
- migration repair/reconcile
- manual OpenAI replay/backfill without explicit approval

もしproduction mutationが必要と判断したら:
- exact object
- exact purpose
- expected cost
- rollback
- recall safety evidence
をReportしてSTOP。C1/ユーザー承認を待つ。

## Deliverables for C1

.agent/CODEX_REPORT.md に最低限:

1. correct baseline economics (48/96 searches/day)
2. Phase 0 natural usage evidence update
3. Claude artifacts presence/absence
4. 5 unverified + 2 delayed historical cases replay result
5. current coverage gaps
6. source-health findings
7. official-title/body-missing root cause and general fix candidate
8. tests for that candidate
9. refined shadow architecture
10. old-vs-new comparison schema
11. projected search reduction vs correct baseline
12. projected shadow cost
13. recall/latency risks
14. fields/domains where fallback must remain
15. exact production changes proposed next, if any
16. rollback plan
17. explicit production mutation = 0 for this H1 unless separately approved

## Completion / C1

完了時:
- .agent/CODEX_REPORT.md 更新
- this TASK -> review_required
- next_owner: chatgpt
- source/docsをpushする場合はfresh origin/main確認
- 他workstream変更を含めない
- .agent control metadataをmainへ同期
- C1待ちでSTOP
