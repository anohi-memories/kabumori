# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-deploy-trump-fed-coverage-20260905
- owner: claude
- slot: claude-1
- status: ready
- purpose: K1承認済みcommit `af73cf2` の `breaking_market` 検索カバレッジ修正を本番 `important-news-monitor` へ安全にdeployし、自然fetchで反映確認できる状態にする。
- scope:
  - origin/main fresh-check
  - commit `af73cf2` がmainに含まれることを確認
  - `important-news-monitor` だけを本番deploy
  - 既存の verify_jwt 設定を維持する（現在の本番値を確認して同じ値でdeploy）
  - deploy後、functionがACTIVEになったこととversionを確認
  - 可能なら次の自然 `important-news-fetch` cycle後にread-onlyでfetch正常性を確認
- forbidden:
  - コード変更
  - 新規commit
  - P0.7開始
  - auto_publish変更
  - Cron変更
  - DB schema/migration/GRANT変更
  - X投稿実行
  - morning greeting系変更
  - 他workstreamの変更
  - secrets表示・変更
- completion_criteria:
  - `important-news-monitor` のみdeploy完了
  - deploy前後で安全設定に意図しない変更がない
  - ACTIVE/versionを報告
  - 自然fetch観測が時間的に可能なら結果を報告。不可能なら未確認として明記
  - TASK末尾に `## Report` を追加し status を review_required にする
- commit: 禁止（コード変更なし）
- push: 不要
- deploy: 必須。`important-news-monitor` のみ
- report_mode: inline
- next_owner: chatgpt

## Background

- 直前タスク `important-news-trump-fed-trade-coverage-20260905` はK1承認済み。
- commit `af73cf2` はorigin/mainへpush済み。
- important-news-monitor全体回帰 224/224 pass。
- 修正内容は `trump_tariff_semiconductor` queryに `Federal Reserve rate cut pressure threat to halt trade` を追加した最小差分。
- クエリ数6、最大2検索/20分、1検索 max_tool_calls=1、allowed domains、24h freshness、actual visited URL検証は維持済み。
- 本番 important-news auto_publish=false を維持する。

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / deploy / deployed_version / natural_fetch_check / remaining_issues / safety_checks / next_recommendation を記録する。
