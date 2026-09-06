# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-freshness-coverage-diagnosis-20260906
- owner: codex
- status: ready
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
