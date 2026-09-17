# Claude Task 1

- task_id: market-report-shared-platform-design-audit-20260916
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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
## Report

- task_id: `market-report-shared-platform-design-audit-20260916`
- result: **設計・監査完了（実装なし）**。設計書 `docs/market-report-shared-platform/DESIGN.md` を作成
- model_used: Opus 5（`claude-opus-5`）
- source_base: `origin/main` `84648cd`（着手時）→ 提出時 `2861901` に rebase（差分は H2 のニュース URL 除去のみで本設計と重複なし）。本番は read-only 確認のみ（`x-test-post` v109、`personalized-reports` v13、`important-news-monitor` v54、MIC ingest v11 / evaluator v7、`send-push-notifications` v15）。`x-test-post` v109 と `origin/main` の byte 比較は未実施

### current architecture findings

- 4経路はデータ・ニュース・AI処理をほぼ共有していない。X朝刊は web_search 2〜3回で材料収集し、**指数の数値は一切取得しない**（米3指数・SOX・先物は空欄固定）。X大引けは web_search 1回（検索2〜4）＋ Yahoo 1分足。アプリは Yahoo 日足＋重要ニュース（app copy 済み）のみで、**アプリ朝刊には米国市場・為替・金利が無い**。
- **X大引けは 9/14・9/15・9/16 の3営業日連続で `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`。** 原因は `close_report_data_logic.ts` の「最後の1分足の時刻が 15:30 以降」判定。Yahoo の1分足は足の開始時刻で刻まれ、日経平均の最終足は 15:29、1306.T は 15:24（クロージング・オークション）になるため、条件を満たせない。Yahoo の read-only 取得で 9/10〜9/15 の全日を確認済み。
- タスク記載の「90分判定で 17:00:01 に stale」は、現行 `validateCloseFreshness` が 16:45〜17:05 窓で当日終値を fresh 扱いするため主因ではない。
- **9/15 X大引け失敗 / アプリ大引け成功の構造差**: X は `interval=1m` の足時刻、アプリは `interval=1d` と `meta.regularMarketTime`（当日かつ 15:30 以降）で判定。同じ Yahoo・同じ銘柄で取得方法だけが違う。
- X朝刊の直近: 9/14 形式不正、9/15 成功、9/16 OpenAI 429×3、9/17 Voice JSON 解析失敗（Fact は passed）。
- **費用の記録漏れ**: X大引けは失敗時に tokens・検索回数・費用を保存しない（9/14〜9/16 は `api_cost_usd=null` だが収集呼び出しは実行済み、約 $0.03/回）。収集 web_search は終値チェックの**前**に走るため、終値が無い日も費用が発生する。成功時も Voice rewrite 呼び出しの費用は合算されていない。
- `market_contexts` は X が読むが本番 0 行（実質未使用）。MIC は FRED 米金利・MOF JGB・EIA 原油を取得済みだが、どのレポートも使っていない。MIC `mic_source_registry` は全行 `is_active=false` なのに ingest は稼働しており、不一致は未確認。

### overlap findings

- 日本市場を X大引け（17:00、1分足）とアプリ大引け（17:15、日足）で2回、別方法で取得。
- 「なぜ動いたか」は X だけが web_search で作り、アプリは作れない（理由を推測しない指示）。
- ニュースは X が web_search で取り直し、アプリは重要ニュース監視を再利用。同じ TDnet 開示を X は検索し直している。
- 米金利・原油は MIC が公式ソースで取得済みなのに、X は記事から方向感を拾っている。
- 営業日・休場判定が3か所（X、personalized-reports、MIC Cron 条件）に分散。

### proposed architecture

- 1サイクル（朝刊/大引け）につき `market_data_packet`（コード取得のみ、AI なし、不変）→ `market_report_packet`（分析1 call ＋ コード検証 ＋ Fact 1 call、再生成1回まで）を1回だけ作る。
- 消費: X は要約1 call ＋ Voice（収集 web_search 削除）、アプリ「市場全体」は追加AIなしでそのまま表示、「マイポート」はユーザー差分のみ draft＋Fact。
- packet は X/アプリより先に作成（朝 07:50、大引け 16:15）し、25〜35分の再試行余裕を持つ。packet 無し・Fact 不合格なら X は投稿しない / 市場全体タブは出さない（fail-closed）。
- web_search は既定0回。今日の市場ニュースが0件、または必須の米国材料が無い日のみ補完1回。
- 因果は `claims[].claim_type`（observation / reported_cause / consistent_with / watch_point）と `evidence_refs` で構造化。ポートフォリオ側は `portfolio_effect` をコードで作り、`causal` は使わない（`reported` / `consistent_with` / `insufficient_evidence`）。9/14 朝刊の「指数→保有銘柄」未根拠表現を設計で防ぐ。

### packet/schema recommendation

- `market_data_packet.v1`: metric 単位で `value / previous_close / change / session_date / observed_at / fetched_at / provider / source_url / freshness / quality / is_proxy / gap_reason`。`data_quality.status`（ok / partial / blocked）。大引けは日経・1306 当日終値が必須、朝刊は米指数2つ以上とドル円が必須（米指数・ドル円の Yahoo 銘柄は **未検証**）。
- `market_report_packet.v1`: headline / summary / major_moves（数値は metric key 参照のみ）/ claims / strong・weak sectors・themes / key_news / overseas_to_japan_effects / next_session_watch / risks / data_gaps / fact（local・ai・attempts）/ usage。
- DB は **案B**: `market_report_cycles`（`(report_type, trading_date)` 一意）＋ insert-only の `market_data_packets` / `market_report_packets`、既存の `personalized_reports` / `morning_report_runs` / `close_report_runs` に nullable FK。A（上書きで履歴と由来を失う）と C（消費者ごと・ユーザーごとのコピーでユーザー数に比例）は不採用。指数・為替の日足は MIC `market_metrics` に Yahoo ソースとして保存し、packet は MIC から組み立てる案。

### cost before/after

- 単価: luna $0.2/$1.2（100万 tokens）、web_search $0.01/回（コード記載値）。
- before（本番保存値）: X朝刊 成功平均 $0.039（Voice込み、web_search 2.5回）、X大引け 成功 $0.050（1件）、アプリ朝刊 $0.0021/ユーザー、アプリ大引け $0.0025/ユーザー。1営業日 N=1 で約 $0.09、N=1,000 で約 $4.7（現行実装は MAX_USERS_PER_RUN と時間予算で 1,000 人は処理不可）。
- after（見積もり・未計測）: 共通（分析＋X）1営業日 約 $0.02〜0.08、マイポート $0.0025〜0.003/ユーザー/回（市場文脈を渡すため +10〜20%）。N=1 で約 $0.03〜0.09、N=1,000 で約 $5.0〜6.1。
- 評価: 費用の幅は web_search を0回にできる日の割合で決まる。ユーザー1人では同程度〜やや安い。主な効果は、市場分析がユーザー数に比例しないこと、X とアプリの事実の一致、アプリ「市場全体」の追加、X の成功率改善。

### phased migration recommendation

- **Phase 0**（基盤と独立）: X大引けの終値取得を日足＋`regularMarketTime` に変更、終値判定を収集 web_search の前へ、失敗時と rewrite の費用記録、日足確定時刻の計測。`x-test-post` のみ、DB 変更なし。
- Phase 1: `market_data_packet` を shadow 生成（AI なし、3テーブル新設のみ、消費者なし）。2週間、実際に使われた値と照合。
- Phase 2: `market_report_packet` を shadow 生成し、X 実投稿・アプリ実レポートと並べて K1 レビュー（一時的に +$0.02〜0.06/日）。
- Phase 3: アプリ「市場全体」タブ公開（既存体験の置換ではなく追加のため、X より先）。
- Phase 4: マイポートを共通 packet 参照へ（Fact 再生成1回を追加、旧ロジックはフラグで残す）。
- Phase 5: X朝刊・大引けを packet 要約へ（リスク高、H1 領域。2週間 dry_run 並走後）。
- Phase 6: 旧取得・旧生成の削除。
- 各 Phase の touched files / リスク / テスト / ロールバック / 費用効果は設計書 §11。

### production_changes = 0

- 本番への書き込み、migration、RPC、Edge Function deploy、Cron・設定・ユーザー設定の変更、X投稿、OpenAI の手動 invoke、synthetic report / candidate / Push はいずれも **0**。
- 実施した本番操作は read-only の SQL（`cron.job`、report settings / runs、`personalized_reports`、MIC テーブル）と `supabase functions list` のみ。外部は Yahoo 公開チャートAPIの GET（`^N225` / `1306.T`、`range=5d&interval=1m`）のみ。

### changed_files

- `docs/market-report-shared-platform/DESIGN.md`（新規）
- `.agent/tasks/CLAUDE_TASK_1.md`（この Report と status）

### commit/push

- 着手: `Mark Claude slot 1 market report shared platform audit in_progress`（push 済み）
- 提出: 本 Report を含む commit を `origin/main` へ push（hash は push 後の `git log` を参照）

### unresolved decisions

1. Yahoo チャートAPI（非公式）を正本の取得元にしてよいか、JPX 公式データ等の調査を先にするか（ユーザー / K1）
2. グロース250・日経先物・業種別騰落の取得元。見つかるまで「取得できませんでした」表示で公開してよいか（K1）
3. アプリの既定タブ（マイポート / 市場全体）（ユーザー）
4. X の長さ: 現行の 500〜800字目安か、タスク記載の「300字前後」か（ユーザー）
5. packet 作成時刻（朝 07:50 / 大引け 16:15）（K1）
6. MIC `mic_source_registry` 全行 `is_active=false` と ingest 稼働の不一致（MIC 担当）
7. `x-test-post` v109 本番ソースと `origin/main` の差分有無（H1）
8. Phase 5 と H1 の AI Lab 作業の deploy 順序（K1）
9. ユーザー数増加時の `personalized-reports` 時間予算・`MAX_USERS_PER_RUN` 超過（範囲外、別タスク）
10. Fact 再生成の上限（本設計は計2回）（K1）

### first implementation task recommendation

- **`x-close-report-daily-close-source-fix`（Phase 0 の先行分）**: X大引けの終値取得を、アプリで実績のある日足＋`regularMarketTime` 判定へ変更し、終値が取れない日は収集 web_search を実行しない。失敗時も tokens・検索回数・費用を記録し、rewrite の費用も合算する。
  - 範囲: `supabase/functions/x-test-post/close_report_data_logic.ts` / `close_report_logic.ts` / `index.ts` の close 分岐のみ。DB・Cron・設定変更なし。live 窓 16:45〜17:05 は変更しない
  - 受け入れ条件: 9/10〜9/16 の実 Yahoo 応答を fixture にし、1分足 15:29 / 15:24 で失敗していた日が日足で成功すること。前場値・前日値・`^TPX` を拒否すること
  - 担当候補: H1（`x-test-post` 担当）。H1 の AI Lab hotfix と deploy が重ならない順序で
- 共通基盤の最初の実装は、その後の **Phase 1（data packet の shadow 生成、AI なし）** を推奨
