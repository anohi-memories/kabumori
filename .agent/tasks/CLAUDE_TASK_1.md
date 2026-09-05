# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-deploy-voice-guided-retry-20260905
- owner: claude
- slot: claude-1
- status: ready
- purpose: K1承認済みcommit `f45ca12` のVoice guided retry改善を、本番 `important-news-monitor` に安全にdeployし、自然運用でretryが発火できる状態にする。
- scope:
  - origin/mainをfresh-check
  - commit `f45ca12` がmainに含まれることを確認
  - deploy前の `important-news-monitor` version/status/verify_jwt を確認
  - `important-news-monitor` のみ本番deploy
  - deploy後にACTIVE/version/verify_jwtを確認
  - `auto_publish=false`、interval、Cron等が変わっていないことをread-only確認
  - 時間的に可能なら次の自然 `important-news-fetch` / judgement / generation cycleをread-only観測し、エラーなく稼働することを確認
  - Voice retryの自然事例が発生した場合のみ、`generation_voice_retry.attempted=true`、`voice_retry_count=1`、retry fact/voice status等をread-onlyで確認
- forbidden:
  - コード変更
  - 新規commit/push
  - P0.7 corporate X market-impact gate開始
  - auto_publish変更
  - X投稿実行・投稿ロジック変更
  - Cron変更
  - DB schema/migration/GRANT変更
  - breaking_market検索、TDnet/IR取得、market_macro変更
  - morning greeting系変更
  - model変更
  - retry回数・Fact/Voiceルール変更
  - secrets表示・変更
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - K1承認済みcommit `f45ca12` がmainに存在することを確認
  - `important-news-monitor` のみdeploy完了
  - deploy後ACTIVEであること
  - 既存の `verify_jwt=false` を維持
  - `auto_publish=false` を維持
  - Cron/interval/DB/X投稿等に意図しない変更なし
  - 自然cycleを観測できた場合は正常性を報告。Voice retry実例がまだ無ければ未観測と明記し、それ自体を失敗扱いしない
  - コード変更・新規commitなし
  - TASK末尾に `## Report` を追加し `status: review_required` にする
- commit: 禁止
- push: 不要
- deploy: 必須。`important-news-monitor` のみ
- report_mode: inline
- next_owner: chatgpt

## Background

直前の実装タスク `important-news-voice-guided-retry-20260905` はK1承認済み。

承認済み内容:
- commit `f45ca12`
- important-news-monitor全体回帰 231/231 pass
- Fact=passedかつ全Voice issueが修正可能な表現品質問題のときだけ1回retry
- retry後は必ずFact→Voiceを再チェックし、両方passedだけ `ready_for_publish`
- 数字/日付/人物/企業/国名/制度/事実誤認/捏造等はnon-retryable
- 未知issueは安全側でretryしない
- production実例「欧州のリスク sentiment」「米国の特使が→特使ら」をテスト固定済み

現在の本番は `important-news-monitor` v27 ACTIVE、verify_jwt=false、auto_publish=false。今回のdeploy後もこれらの安全設定を維持すること。

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / deploy / deployed_version / natural_cycle_check / voice_retry_observation / safety_checks / remaining_issues / next_recommendation を記録する。
