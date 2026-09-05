# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-deploy-middle-east-oil-shipping-coverage-20260905
- owner: claude
- slot: claude-1
- status: review_required
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

## Report

- task_id: important-news-deploy-middle-east-oil-shipping-coverage-20260905
- result: `important-news-monitor`のみdeploy完了。deploy前後で`verify_jwt`・`auto_publish`・`interval_minutes`・`is_active`・Cronはすべて無変更を確認。deploy後、自然fetch cycleが1回正常完了（error無し）。Iran/Hormuz/oil tanker/CENTCOM系の実ヒット、および`centcom.mil`/`defense.gov`の実クロールは、この観測期間内ではまだ発生していない（該当ニュースの発生とrotation選択タイミング次第であり、異常ではない）。
- deploy:
  - コード変更・新規commitなし（本タスクの禁止事項どおり）
  - deploy直前、ローカルの`breaking_market_source_fetchers.ts`にK1承認済みの修正（`Strait of Hormuz`等の語彙追加、`centcom.mil`ドメイン追加）が含まれていることをgrepで確認
- deployed_version:
  - deploy前: v28 ACTIVE, verify_jwt=false
  - deploy後: **v29 ACTIVE, verify_jwt=false**（維持確認済み）
- natural_fetch_check:
  - deploy直後（2026-09-05 15:04 UTC以降）に`important-news-fetch`が1回実行され、`status=completed`, `error=null`（新規候補0件、正常稼働を確認）
- middle_east_oil_observation:
  - **未観測**。`important_news_candidates`をtitle/source_urlで`hormuz`/`tanker`検索したが該当行なし。6クエリ中2つ/cycleのローテーション性質上、`war_geopolitics_taiwan`が選択されたか・該当ニュースが実際に発生しているかの両方に依存するため、未観測＝異常ではない
- source_domain_observation:
  - **未確認**。`centcom.mil`・`defense.gov`からのcandidateはこれまで一度も無し（過去分含めて検索したが該当なし）。OpenAI web_search側が実際にこれらのドメインをクロールできるかは、実ヒットが発生するまで検証できない
- safety_checks:
  - `verify_jwt=false`: 維持確認済み
  - `auto_publish=false`: 維持確認済み
  - `interval_minutes=20` / `is_active=true`: 維持確認済み
  - Cron（7ジョブ、スケジュール、2026-09-07の一時job含む）: 無変更確認済み
  - コード変更・新規commit/push: なし（禁止事項どおり）
  - P0.7 / importance judgement・generation・Voice retry / TDnet・company IR・market_macro / X投稿実行 / morning greeting系 / model変更: すべて未着手・未接触
  - breaking_marketのquery数・最大2検索/cycle・20分rotation・24h freshness・max_tool_calls=1・actual visited URL検証: 無変更確認済み
  - 他workstreamの未コミット変更・並行スロットの作業: 変更・stage・commitなし。`git reset --mixed`でbranch pointerのみ移動し、他エージェントの編集は無傷を確認
  - secrets: 非表示・非変更
- remaining_issues:
  - Iran/Hormuz/oil tanker系の実ヒット、および`centcom.mil`/`defense.gov`の実クロール可否は、該当ニュースの発生とrotation選択タイミング次第であり、継続的なread-only観測が必要
- next_recommendation: 現状で安全に稼働中のため追加対応は不要。今後の自然cycleでcentcom.mil/defense.gov経由の候補、またはHormuz/tanker系候補が観測できたら、その内容を任意タイミングで報告する。
