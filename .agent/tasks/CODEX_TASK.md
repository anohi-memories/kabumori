# Codex Task

Codex（こでさん）専用の現在タスクです。

- task_id: important-news-freshness-coverage-diagnosis-20260906
- owner: codex
- status: done
- next_owner: chatgpt
- purpose: 2026-09-06 JST 03:20前後に雇用統計関連ニュースが遅れて取得された件と、同日全体で重要ニュース取得量が少ない件について、本番データと取得ロジックをread-onlyで調査し、遅延・取りこぼしの根本原因を切り分ける。
- priority: high
- detailed_report: `.agent/CODEX_REPORT.md`

## Review

- reviewed_by: chatgpt
- review_result: accepted
- review_date: 2026-09-06 JST
- completion_check:
  - 03:20 JSTの雇用統計AP記事について、公開23:11:18 JST → 候補化03:20:22 JST、249.1分（4時間9分）の遅延を特定済み。
  - 2026-09-06 JST 00:00〜22:03の自然Fetch 67回が全件completed、error/source error 0で、Cron/runtime/quota/timeoutを非原因と切り分け済み。
  - 当日新規candidate 3件、全件`breaking_market`。`market_macro` / `tdnet` / `company_ir` / その他0件を定量化済み。
  - 速報遅延の主因をquery rotation（各query実質60分間隔）とbreaking検索の低yield/検索品質変動、件数不足の主因をbreaking取得入口と`market_macro`のdedupe前global capによるsource starvationと特定済み。
  - 24h article freshness、event時刻未検証、cross-source event dedupe不足を副因として特定済み。
  - 「なぜ遅かったか」と「なぜ今日少ないか」を分離して結論化済み。
  - 最小修正案と構造改善案の双方を提示済み。
  - 実装コード変更、本番write、migration、deploy、Cron変更、X投稿、secrets露出なし。

## Accepted findings

- 03:20 JSTの雇用統計AP記事は、Fetch停止ではなく検索設計上の遅延。
- 雇用統計queryは毎時`:20`の実質60分間隔。記事公開後23:20 / 00:20 / 01:20 / 02:20は候補0、03:20で初取得。
- 同じ雇用統計イベント自体はBLS一次資料で9/4 22:38 JSTに既に捕捉済みで、AP後追い記事を速報候補として再許可した点も問題。
- `breaking_market`は6 queryを2本ずつrotationし、67 cycle中49 cycle（73.1%）でbreaking候補0。取得入口のyieldが低い。
- `market_macro`は56件取得しても固定source順の先頭30件をdedupe前にcapし、その30件が毎回既存duplicateとなるため、後段26件が恒常的にdeferされる構造問題がある。

## Next

この調査タスクは完了。新しい実装タスクはChatGPT側で別途切り出す。Codexは次のTASKが`ready`になるまで新規作業を開始しない。
