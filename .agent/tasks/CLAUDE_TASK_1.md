# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: morning-greeting-x-oauth-refresh-deploy-20260906
- owner: claude
- slot: claude-1
- status: ready
- purpose: K1承認済みcommit `b459024` の朝の挨拶X OAuth 401 refresh修正を、本番 `x-test-post` に安全にdeployし、既存の重複投稿防止・Cron・DB・他workstreamを一切変更せず、次回scheduled `morning_greeting`を観測できる状態にする。
- scope:
  - 作業開始時に `origin/main` をfresh-checkし、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASKを確認する
  - commit `b459024` が `origin/main` に含まれていることを確認する
  - deploy前の本番 `x-test-post` version/status/verify_jwt をread-only確認する
  - `x-test-post` のみ本番deployする
  - deploy後に ACTIVE / version / verify_jwt をread-only確認する
  - `scheduled_posts` / `publish_claims` / Cron / OAuth token metadata / morning greeting設定をread-only確認し、意図しない変更がないことを確認する
  - 2026-09-06のfailed `publish_claims` とfailed `scheduled_posts` はそのまま残っていることをread-only確認する
  - 実X APIへの手動テスト投稿は行わない
  - 可能であれば次回scheduled `morning_greeting`が走るまでの準備状態（翌日画像生成、scheduled row等）をread-only確認する。次回実行がまだ先なら未観測として報告し、それ自体を失敗扱いしない
- forbidden:
  - コード変更
  - 新規実装commit
  - `b459024` 以外の未承認差分をdeployへ混ぜる
  - 2026-09-06のfailed claimを削除・更新・再claimしない
  - 2026-09-06の朝の挨拶を手動投稿・再投稿しない
  - 実X APIへのテスト投稿・画像アップロード
  - production secrets / OAuth token値の表示・変更
  - OAuth refresh token運用ルール変更
  - failed/stale claim reclaim追加
  - 401以外へのretry拡張
  - `important-news-monitor/**`、重要ニュース、P0.7変更
  - Expo/Auth/MVP/Push通知workstream変更
  - Cron変更
  - GitHub Actions workflow変更
  - morning greeting画像生成workflow変更
  - DB schema/migration/GRANT/production data変更
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - `b459024` がmainに存在することを確認
  - `x-test-post` のみ本番deploy完了
  - deploy後 ACTIVE
  - 既存 `verify_jwt=false` を維持
  - Cron / DB / morning greeting設定 / 他Edge Functionに意図しない変更なし
  - 2026-09-06 failed claim / scheduled rowは未変更のまま
  - 手動X投稿・手動画像アップロードなし
  - 次回scheduled morning greetingがまだ未実行なら「未観測」と明記し、翌日以降のread-only観測を次工程として残す
  - 完了時はこのファイル末尾に `## Report` を追加し、statusを `review_required`、next_ownerを `chatgpt` にする
- commit: 原則不要。TASK status/report更新のcommitのみ可
- push: TASK report更新のみ可
- deploy: 必須。`x-test-post` のみ
- report_mode: inline
- next_owner: chatgpt

## Approved previous task

- previous_task_id: `morning-greeting-x-oauth-refresh-20260906`
- K1_result: approved
- approved_commit: `b459024`
- approved_behavior:
  - media upload / tweet送信の401時のみ、1回だけOAuth refreshして1回だけretry
  - 1 executionあたりrefresh最大1回
  - 429 / 5xx / network系など401以外の曖昧失敗は自動retryしない
  - 2026-09-06 failed claim / scheduled rowは未変更
- approved_tests:
  - `_shared`: 5/5 pass
  - `x-test-post`: 298/298 pass
  - `important-news-monitor`: 235/235 pass
- previous_deploy: 未実施

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / pre_deploy / deploy / deployed_version / verify_jwt / safety_checks / production_observation / remaining_issues / next_recommendation を記録する。
