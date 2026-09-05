# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-deploy-middle-east-oil-shipping-coverage-20260905
- owner: claude
- slot: claude-1
- status: ready
- purpose: K1承認済みcommit `e67b825` の中東・原油輸送リスク取得強化を、本番 `important-news-monitor` に安全にdeployし、自然fetchで実運用上の取得可否を確認できる状態にする。
- scope:
  - origin/main fresh-check
  - commit `e67b825` がmainに含まれることを確認
  - deploy前の `important-news-monitor` version/status/verify_jwt を確認
  - `important-news-monitor` のみ本番deploy
  - deploy後に ACTIVE/version/verify_jwt を確認
  - `auto_publish=false`、interval、Cron等が変わっていないことをread-only確認
  - 次の自然 `important-news-fetch` cycleをread-only観測し、`war_geopolitics_taiwan` 系の取得処理がerrorなく動くことを確認
  - 可能なら `centcom.mil` / `defense.gov` がOpenAI web_search経由で実際に利用されたか、またはIran/Hormuz/oil tanker系候補が取得されたかをread-only確認
- forbidden:
  - コード変更
  - 新規commit/push
  - P0.7 corporate X market-impact gate開始
  - importance judgement / generation / Voice retry変更
  - TDnet / company IR / market_macro変更
  - auto_publish変更
  - X投稿実行・投稿ロジック変更
  - Cron変更
  - DB schema/migration/GRANT変更
  - morning greeting系変更
  - model変更
  - breaking_marketのquery数、最大2検索/cycle、20分rotation、24h freshness、max_tool_calls=1、actual visited URL検証を変更しない
  - secrets表示・変更
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - K1承認済みcommit `e67b825` がmainに存在することを確認
  - `important-news-monitor` のみdeploy完了
  - deploy後ACTIVE
  - 既存 `verify_jwt=false` 維持
  - `auto_publish=false` 維持
  - Cron/interval/DB/X投稿等に意図しない変更なし
  - 自然fetch cycleを少なくとも1回read-only観測し、errorなく正常稼働していることを報告
  - Iran/Hormuz/oil tanker/CENTCOM系の実ヒットが無ければ「未観測」と明記し、それ自体を失敗扱いしない
  - `centcom.mil` / `defense.gov` の実クロール可否も観測できなければ未確認として明記
  - コード変更・新規commitなし
  - TASK末尾に `## Report` を追加し status を `review_required` にする
- commit: 禁止
- push: 不要
- deploy: 必須。`important-news-monitor` のみ
- report_mode: inline
- next_owner: chatgpt

## Background

直前の実装タスク `important-news-middle-east-oil-shipping-coverage-20260905` はK1承認済み。

承認済み内容:
- commit `e67b825`
- important-news-monitor全体回帰 235/235 pass
- `war_geopolitics_taiwan` に Iran / Israel / Strait of Hormuz / oil tanker / maritime attack / energy infrastructure / CENTCOM を追加
- `centcom.mil` / `defense.gov` をallowed domainsへ追加
- query数6、最大2検索/cycle、20分rotation、24h freshness、max_tool_calls=1、actual visited URL検証はすべて維持
- auto_publish=false維持

現在の本番は直前K1で `important-news-monitor` v28 ACTIVE、verify_jwt=false、auto_publish=false。今回のdeploy後も安全設定を維持すること。

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / deploy / deployed_version / natural_fetch_check / middle_east_oil_observation / source_domain_observation / safety_checks / remaining_issues / next_recommendation を記録する。
