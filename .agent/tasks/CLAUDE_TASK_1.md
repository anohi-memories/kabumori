# Claude Task 1

- task_id: market-report-shared-platform-design-audit-20260916
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: X朝刊/X大引けとアプリ朝刊/アプリ大引けを、共通の市場データ・Fact済み市場分析packetから派生させる次世代共通基盤を、実装前に監査・設計する。

## User decision / target experience

ユーザー方針:

- X = 市場分析の要約・集客版
- アプリ = 市場分析の完全版 + 自分専用分析

朝刊・大引けのアプリ画面は最終的に:

- `市場全体`
- `マイポート`

の2タブまたはセグメント切替とする。

ユーザーが朝刊/大引けを開いたとき、

1. 今日の市場全体で何が起きたか
2. その結果、自分のポートフォリオへどう影響したか

を一続きで理解できることを目標とする。

## Core architecture hypothesis

設計候補:

```text
market_data_packet
    ↓
market_report_packet
    ├─ X summary
    ├─ app market report
    └─ portfolio report(userごと)
```

朝刊:
- `morning_market_data_packet`
- `morning_market_report_packet`

大引け:
- `close_market_data_packet`
- `close_market_report_packet`

ただし名称・分割方法は現行実装を監査した上で確定すること。最初からこの形に無理に合わせない。

## Goal

実装はまだしない。

現行4経路を正確に監査し、重複と差異を洗い出した上で、以下を設計書として確定する。

1. 現在のX朝刊生成経路
2. 現在のX大引け生成経路
3. 現在のアプリ朝刊生成経路
4. 現在のアプリ大引け生成経路
5. 重複している市場データ取得
6. 重複しているOpenAI処理 / Fact / Voice / summary処理
7. 共通化できる処理と、用途別に残すべき処理
8. `market_data_packet` schema
9. `market_report_packet` schema
10. `portfolio_report` input/output contract
11. app「市場全体」「マイポート」の表示仕様
12. DB保存形式
13. APIコスト before / after
14. migration / rollout順序
15. rollback / compatibility戦略

## Mandatory startup / parallel safety

開始前に必ず確認:

1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/tasks/CODEX_TASK.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK.md`
7. fresh `origin/main`
8. relevant current production Function versions / Cron / settings read-only

必ずisolated clean worktree/cloneを使用。
既存未コミット変更は他workstream所有物として触らない。

### Parallel boundaries

- H1 may own `x-test-post` / OAuth / AI Lab live test.
- G2 owns morning-greeting image cost gate.
- H2 may be idle/done or may later receive another task.

このG1は**設計・監査のみ**。競合を避けるため production source / DB / Cron / settings を変更しない。

## Current systems to inspect

最低限、実ファイル・RPC・Cron・DB schema・production read-only evidenceから以下を追う。

### X morning

- schedule/planner/claim
- market data acquisition
- material/news acquisition
- prompt assembly
- AI generation
- Fact
- Voice
- rewrite/retry
- persistence/diagnostics
- X publish

### X close

同上。特に:
- Nikkei
- TOPIX / 1306 proxy
- futures
- same-day close validation
- freshness
- 17:00 execution

既知の候補問題:
- 15:30 closeを90分以内と判定するため、17:00:01等でstaleになり得る。

この設計タスクでは修正しない。共通packet設計でどう扱うべきかを明示する。

### App personalized reports

morning / closeそれぞれ:
- portfolio snapshot
- market data acquisition
- Yahoo calls
- current market summary fields
- AI draft generation
- Fact check
- retryの有無
- persistence
- notification enqueue
- app display/deep-link

既知:
- 9/14 morning `REPORT_FACT_FAILED`
- 9/15 morning/closeはcompleted / Fact passed / Push sent
- 現行はFact fail時のbounded regeneration retryなし

### Broad news / TDnet inputs

共通市場レポートへ再利用可能な既存情報を洗い出す:
- `important_news_candidates`
- market-wide coverage categories/severity
- app-copy済みニュース
- TDnet/company IR
- market-intelligence系

同じニュース本文を何度もAIへ再送しない設計を優先する。

## market_data_packet design requirements

完全に構造化された「事実の正本」を目指す。

最低限候補:

- report_type: morning / close
- trading_date / as_of
- generated_at
- market session metadata
- Nikkei
- TOPIX or explicitly labeled 1306 proxy
- growth market index if reliable source exists
- Nikkei futures
- US major indices
- SOX
- USDJPY / relevant FX
- rates
- oil / key commodities
- sector performance
- themes
- important market news references
- TDnet / corporate material references
- geopolitics / policy / macro references
- scheduled important events
- source URL / provider
- source timestamp / observed_at
- freshness classification
- data quality / gaps / confidence
- exact proxy labels

重要:
- source/timestamp/freshnessをmetric単位で保持できる構造を検討
- 値と説明文を混ぜない
- unavailable / stale / proxy / partialを明示
- Xとappが同じ確定データを参照できること

## market_report_packet design requirements

`market_data_packet` を根拠に、1回の市場分析生成で以下を構造化する案を検討:

- market_summary
- major_moves
- why_market_moved
- strong_sectors
- weak_sectors
- strong_themes
- weak_themes
- key_news
- macro_policy_geopolitics
- overseas_to_japan_effects
- afternoon_or_next_session_watch
- risks
- event_calendar
- evidence_refs per claim where practical

大引けでは特に:
**「なぜ今日この値動きになったのか」**
を指数結果の羅列ではなく説明できること。

アプリ市場全体は原則この詳細版を再利用し、追加AI生成を必須にしない設計を優先する。

## X summary design requirements

Xは共通packetから軽量変換する。

- 300字前後
- 現行のX朝刊/大引けの読みやすさ・形式をなるべく維持
- 市場data/newsを丸ごと再取得しない
- heavyweight web search / market researchを再実行しない
- possibleならdeterministic formatter + lightweight modelの比較も行う
- Fact済みpacketから外の新情報を足さない

## Portfolio analysis design requirements

input:

- common `market_data_packet`
- common `market_report_packet`
- user portfolio snapshot
- holdings / credit positions / watchlist
- stock-specific news/materials
- sector/theme mapping

output候補:

- total P/L
- holding contribution
- market-relative performance
- Nikkei / TOPIX comparison
- sector effect
- company-specific effect
- FX effect
- US/SOX/theme effect
- why each holding moved
- portfolio concentration / risk
- leverage / credit cautions
- next-session watch points

### Causality safety

最重要。

AIがpacketにない因果を自由に作らないこと。

可能なら各銘柄について構造化:

```text
portfolio_effect:
  ticker
  relative_move
  market_effect
  sector_effect
  company_news_effect
  fx_effect
  theme_effect
  evidence_refs
  confidence
```

- `causal` と `correlated/consistent_with` を区別する
- evidence無しの因果断定は禁止
- unknown / insufficient_evidenceを許容
- 9/14朝刊で起きた「指数→保有銘柄に影響」の未根拠表現を設計上防ぐ

## App display specification

朝刊・大引け共通:

```text
[ 市場全体 ] [ マイポート ]
```

### 市場全体

最低限検討:
- headline
- market summary
- indices/FX/rates/commodities cards
- strong/weak sectors
- themes
- major reasons
- important news/materials
- risks
- next watch
- data gaps / proxy labeling

### マイポート

最低限検討:
- portfolio P/L summary
- relative-to-market summary
- top positive/negative contributors
- each holding analysis
- market/sector/company/theme factors
- leveraged/credit cautions
- next watch points

既存report detail UIをどこまで再利用できるかも監査する。

## Cost audit

必ずbefore / afterを試算。

### Before

朝刊・大引けそれぞれで:
- Yahoo / external HTTP calls
- web searches
- OpenAI calls
- model種類
- typical input/output token magnitude
- Fact / Voice / retry call count
- Xとappで重複している部分

可能ならproduction logs / stored usageから実測値を使う。
不明は推測せずrangeで明示。

### After

目標:
- 市場全体分析 heavyweight call: 原則1回 / report cycle
- X: lightweight summary only
- app market: 原則shared report reuse
- portfolio: shared packet + user-specific delta only

1ユーザー時だけでなく、将来10/100/1000ユーザー時に市場分析コストがユーザー数比例しないことを設計で確認する。

## DB / persistence design

少なくとも比較する:

A. one table + jsonb packets
B. normalized market report tables + jsonb payload
C. current report tablesを拡張

検討軸:
- versioning
- immutable source packet
- retries
- idempotency
- morning/close uniqueness
- source lineage
- app query speed
- X consumer access
- schema evolution
- rollback
- storage size

推奨案を1つ示し、他案を退ける理由も書く。

## Migration / rollout design

big-bangは禁止。

安全な段階移行案を作る。

例:

Phase 0: observability / baseline
Phase 1: common market_data_packetをshadow生成
Phase 2: common market_report_packetをshadow生成し現行X/appと比較
Phase 3: app市場全体をshared packetへ切替
Phase 4: portfolio analysisをshared packetへ切替
Phase 5: X morning/closeをshared packet summaryへ切替
Phase 6: legacy duplicate acquisition/generation削除

ただし現行コードを監査し、より安全な順序があれば変更してよい。

各Phaseについて:
- touched files/functions/tables
- production risk
- test plan
- rollback
- compatibility
- expected cost effect
を示す。

## Deliverables

コード実装ではなく設計成果物を作る。

推奨:
- `docs/market-report-shared-platform/DESIGN.md`

最低限含める:

1. current architecture diagrams for all 4 paths
2. overlap matrix
3. exact duplicated data/API/AI work
4. target architecture diagram
5. `market_data_packet` schema proposal
6. `market_report_packet` schema proposal
7. portfolio analysis contract
8. app UI data contract
9. DB persistence recommendation
10. Fact / causality safety model
11. cost before / after
12. phased migration plan
13. risks / unresolved decisions
14. first implementation task recommendation

必要なら補助資料:
- `CURRENT_PATHS.md`
- `SCHEMAS.md`
- `MIGRATION_PLAN.md`

ただし文書を無駄に分割しすぎない。

## Validation

設計根拠はコード・DB定義・production read-only evidenceに基づける。

最低限:
- relevant files/functions/RPCs/Cronをpath付きで引用
- speculative assumptionsを明示
- current vs target call graph
- morning vs closeの差を明示
- X vs appのデータ取得差を明示
- 9/15 X close失敗 / app close成功の構造差を説明できること

## Prohibited

このG1では以下禁止:

- application source implementation
- Edge Function deploy
- DB migration/schema/RPC apply
- Cron/settings変更
- user setting変更
- X投稿
- OpenAI production manual invoke
- synthetic report / candidate / Push
- OAuth/Vault/token操作
- `supabase db push`
- migration history repair/reconcile

read-only production auditは可。

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- 設計文書をcommit/push
- `.agent/tasks/CLAUDE_TASK_1.md` にReport追記

Report必須:
- task_id
- result
- model_used
- source_base
- current architecture findings
- overlap findings
- proposed architecture
- packet/schema recommendation
- cost before/after
- phased migration recommendation
- production_changes = 0
- changed_files
- commit/push
- unresolved decisions
- first implementation task recommendation

このタスクでは実装しない。設計を固めてK1へ戻す。