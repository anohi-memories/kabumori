# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-freshness-coverage-diagnosis-20260906
- owner: codex
- status: review_required
- next_owner: chatgpt
- purpose: 2026-09-06 JST 03:20前後に雇用統計関連ニュースが遅れて取得された件と、同日全体で重要ニュース取得量が少ない件について、本番データと取得ロジックをread-onlyで調査し、遅延・取りこぼしの根本原因を切り分ける。
- priority: high

## Investigation scope

1. 本番DBで 2026-09-06 JST 00:00〜現在 の重要ニュース候補を確認する。
   - レーン別件数: `breaking_market` / `market_macro` / `tdnet` / `company_ir` / その他実在する取得レーン
   - title / source / source_url / published_at / fetched_at / created_at / category / query metadata / status / importance 等、取得可能な範囲を確認
   - 取得時刻はすべてJSTへ変換して報告

2. 03:20 JST前後に拾われた雇用統計・米雇用関連ニュースを特定する。
   - 元記事の公開時刻
   - かぶモリが候補化した時刻
   - 公開→取得までの遅延時間
   - どのレーン・query・rotation slotで拾ったか
   - その前の自然fetch cycleで拾えなかった理由が追えるなら確認

3. 今日全体の「ニュースが少ない」原因を定量化する。
   - fetch execution自体が正常に20分間隔で回っているか
   - cycleごとの候補件数 / error / selected queryが分かれば確認
   - 候補0件が多いのか、候補はあるが後段判定で落ちているのかを分離
   - 日曜でTDnet/company_irが少ないことと、海外マクロ・地政学・米国市場ニュースの不足を混同しない

4. `breaking_market` の現行仕様をコードで確認する。
   - query総数
   - 1 cycleあたり検索数
   - rotation一巡時間
   - freshness window（現状24hならその実装箇所）
   - OpenAI web_searchへの鮮度指定・query文面・actual visited URL検証
   - published_atを取得後に独自検証/拒否しているか

5. 原因候補を最低でも以下に分けて判定する。
   - A: 24h freshnessが速報用途には広すぎて古い記事を後追い取得
   - B: query rotation待ちで初動が遅い
   - C: query文面が弱く速報記事を上位に引けていない
   - D: published_at検証不足で古い記事を速報候補として許可
   - E: web_search側の結果品質/更新遅延
   - F: 候補取得後のフィルタ・重複判定・重要度判定で落としすぎ
   - G: fetch execution / quota / error / timeout等の運用問題
   - 複数要因なら主因・副因を分ける

6. 改善案を「最小修正」と「構造改善」に分ける。
   - 最小修正例: breaking速報系だけfreshnessを短縮、published_at上限を厳しくする、重要イベント系queryを毎cycle固定枠にする等
   - 構造改善例: `breaking_market`を「速報専用レーン」と「24h補完レーン」に分離する
   - ただしこのタスクでは実装しない

## Specific user requirement

- ユーザーが時間を「3時20分」と言った場合は **03:20 JST** を意味する。15:20と解釈しない。
- 重要ニュースは「24時間以内なら拾えばよい」ではなく、速報性が重要。雇用統計のような市場インパクト大の材料が数時間遅れで取得されるのは失敗として扱う。
- 単に「今日は日曜だから少ない」で結論にしない。海外ニュース系の取得量・鮮度を別に評価する。

## Forbidden

- コード変更
- commit/push
- 本番DBへのwrite / migration / DDL / GRANT
- Edge Function deploy
- Cron変更
- secrets変更・表示
- X投稿
- auto_publish変更
- 既存candidate/statusの更新・削除
- 他workstreamの未コミット変更への接触

## Completion criteria

- 03:20 JST前後の雇用統計ニュースについて、公開時刻→取得時刻の遅延を具体的に特定
- 2026-09-06当日の取得件数をレーン別に定量化
- fetch自体の稼働問題か、検索/鮮度/rotation/後段filter問題かを切り分け
- 主因と副因を明示
- 「なぜ遅かったか」「なぜ今日少ないか」を別々に結論化
- 最小修正案と構造改善案を提示
- 実装は行わず、TASK末尾に `## Report` を追加
- status を `review_required`
- next_owner: chatgpt

- commit: 禁止
- push: 禁止
- deploy: 禁止
- report_mode: inline
- next_owner: chatgpt

## Report

- result: review_required
- detailed_report: `.agent/CODEX_REPORT.md`
- observation_cutoff: 2026-09-06 22:03:25 JST
- production_function: `important-news-monitor` v29 ACTIVE / verify_jwt=false
- summary:
  - 2026-09-06 JST 00:00〜22:03の自然Fetchは67回、全67回completed、error/source error 0。20分間隔の実行障害はない。
  - 当日新規candidateは3件で、全件`breaking_market`。`market_macro` / `tdnet` / `company_ir` / その他は0件。
  - 03:20 JSTの雇用統計AP記事は23:11:18 JST公開、03:20:22 JST候補化で249.1分（4時間9分）遅延。`us_economic_data_surprise` queryの:20 rotation slotで取得したと特定した。
  - 同queryは記事公開後の23:20、00:20、01:20、02:20の4回で候補0、03:20に初めて取得。各runは正常終了しており、実行障害ではない。raw Responses/search-result diagnosticsが保存されないため、検索結果未出現とpost-validation除外の最終分離はできない。
  - 03:20の候補と同じ雇用統計は、BLS一次資料で9/4 22:38 JSTに既に候補化済み。記事公開時刻だけの24h freshnessとcross-source event dedupe不足により、古い同一イベントのAP後追い記事を新規速報候補として再許可している。
  - 6 queryを2本ずつ回すため各queryは実質60分に1回。67 cycle / 134 Responses requestに対し、validation後breaking candidateは延べ24件、49 cycle（73.1%）が0件、当日unique新規は3件。
  - `market_macro`は各cycleで56件を取得する一方、固定source順の先頭30件をdedupe前にcapし、30件すべて既存duplicate、残り26件を毎回deferしている。後段source（EIA等に候補がある場合）が恒常的に飢餓する構造がある。
- root_causes:
  - 主因（速報遅延）: query rotationで重要テーマも1時間間隔 + `search_context_size=low` / 1 search / 検索結果品質・indexingの変動。
  - 主因（件数不足）: breaking取得段階の低yieldと強い候補化prompt + market_macroのdedupe前global capによる後段source starvation。
  - 副因: 24h article freshnessが速報用途に広く、event occurrence freshnessとcross-source event identityを検証しない。
  - 非原因: Fetch/Cron/runtime/quota/timeout、DB後段のimportance判定。当日3件は全件importantまたはmost_importantで、no_post 0件。
- minimum_fix_recommendation:
  - 雇用/CPI/緊急政策/市場急変など速報性が高いqueryを毎20分の固定枠にし、残り1枠だけrotationする。
  - `breaking_market`を短い速報freshness（例2〜3時間）へ寄せ、event時刻も要求・検証する。24h記事は速報ではなく補完扱いに分離する。
  - `market_macro`は保存済みduplicateを除外してからcapするか、source別quota/round-robinで30件を配分する。
  - per-queryのresponse status、web_search call数、raw candidate数、URL/domain/time別除外数をrun diagnosticsへ保存する。
- structural_fix_recommendation:
  - `breaking_now`（毎20分、直接一次資料/速報検索、event age短）と`daily_context`（24h補完）を分離し、共通normalization/judgementへ合流する。
  - `entity_key + event type + event/release timestamp`でcross-source event identityを作り、同一統計の一次資料・後追い記事を統合する。
- changed_files: `.agent/tasks/CODEX_TASK.md`, `.agent/CODEX_REPORT.md`のみ（共有Report同期）。実装コード変更0。
- tests: read-only本番DB、Cron、Edge Function metadata、origin/mainコード照合。テスト実行なし（調査タスク）。
- deploy: なし
- production_writes: 0
- cron_changes: 0
- x_posts: 0
- secrets_exposed: 0
