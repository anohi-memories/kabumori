# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-deploy-voice-guided-retry-20260905
- owner: claude
- slot: claude-1
- status: done
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

## Report

- task_id: important-news-deploy-voice-guided-retry-20260905
- result: `important-news-monitor`のみdeploy完了。deploy前後で`verify_jwt`・`auto_publish`・`interval_minutes`・`is_active`・Cronはすべて無変更を確認。deploy後、自然fetch cycleが1回正常完了（error無し）。Voice retryの自然発火事例はこの観測期間内ではまだ発生していない（該当するVoice failureが発生していないだけで、異常ではない）。
- deploy:
  - コード変更・新規commitなし（本タスクの禁止事項どおり）
  - deploy直前、ローカルの`post_generation_logic.ts`にK1承認済みの修正（`国名`厳格化、`英単語`等の新規retryableパターン、voice_retryプロンプト文言更新）が含まれていることをgrepで確認
- deployed_version:
  - deploy前: v27 ACTIVE, verify_jwt=false
  - deploy後: **v28 ACTIVE, verify_jwt=false**（維持確認済み）
- natural_cycle_check:
  - deploy直後（2026-09-05 14:28 UTC以降）に`important-news-fetch`が1回実行され、`status=completed`, `error=null`（新規候補0件、正常稼働を確認）
  - この観測期間内では新規candidateがgeneration対象にならなかったため、judgement/generation自体は未実行
- voice_retry_observation:
  - 観測期間内でVoice retryが発火した実例は**未観測**。該当するFact=passed かつ Voice=failed（修正可能な品質問題のみ）のcandidateがまだ発生していないため（それ自体は失敗扱いしない、と明記されている通り）
  - deploy直前に確認した最新のgeneration_failed実例（13:07 UTC, `generation_voice_retry.attempted=false`）はdeploy**前**の生成であり、旧ロジックによるもの。今回の修正の効果はまだ実例で確認できていない
- safety_checks:
  - `verify_jwt=false`: 維持確認済み
  - `auto_publish=false`: 維持確認済み
  - `interval_minutes=20` / `is_active=true`: 維持確認済み
  - Cron（7ジョブ、スケジュール）: 無変更確認済み
  - コード変更・新規commit/push: なし（禁止事項どおり）
  - P0.7 / breaking_market検索 / TDnet・market_macro取得 / X投稿実行 / morning greeting系 / model変更 / retry回数・Fact・Voiceルール変更: すべて未着手・未接触
  - 他workstreamの未コミット変更・並行スロットの作業（Codexの`.agent/CODEX_REPORT.md`・`.agent/tasks/CODEX_TASK.md`、Claude slot 2の`.agent/tasks/CLAUDE_TASK.md`を含む）: 変更・stage・commitなし。`git reset --mixed`でbranch pointerのみ移動し、working tree上の他エージェントの編集・進行中タスクファイルは一切触れていないことを確認済み
  - secrets: 非表示・非変更
- remaining_issues:
  - Voice retryが実際のVoice checker出力に対して意図通り機能するかは、該当するFact=passed/Voice=failed（修正可能な品質問題）のcandidateが自然発生するまで実証できない。継続的なread-only観測が必要
- next_recommendation: 現状で安全に稼働中のため追加対応は不要。今後の自然cycleで`generation_voice_retry.attempted=true`の実例が観測できたら、その内容（initial/retry issues、fact/voice status）を任意タイミングで報告する。

## K1 Review decision

承認。

- `important-news-monitor` は v28 ACTIVE へ更新済み
- `verify_jwt=false`、`auto_publish=false`、interval、Cronは維持
- deploy対象は `important-news-monitor` のみ
- コード変更・DB変更・X投稿実行・他workstream変更なし
- deploy後の自然fetch cycleは正常完了
- Voice retry自然実例が未観測なのは、対象candidateがまだ発生していないためであり失敗扱いしない

本タスクは完了とする。Voice retry実例の観測は任意のread-onlyフォローアップとし、追加実装は要求しない。
