# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: morning-greeting-x-oauth-refresh-20260906
- owner: claude
- slot: claude-1
- status: ready
- purpose: 2026-09-06朝の `morning_greeting` が、期限切れX OAuth access tokenを使った画像アップロードで401になり失敗した問題を、既存の重複投稿防止設計を維持したまま最小修正する。
- scope:
  - 作業開始時に `origin/main` をfresh-checkし、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASKを確認する
  - `supabase/functions/x-test-post/**` の朝の挨拶 publish 経路と既存X OAuth refresh経路だけを必要最小限で調査する
  - 既存の通常X投稿では401時に `refreshXTokens()` → 1回再試行する設計を確認し、その考え方を朝の挨拶のX media upload / X tweet送信にも安全に共有または適用する
  - 朝の挨拶で最初の media upload が401の場合、X OAuth tokenを1回だけrefreshし、新access tokenでmedia uploadを1回だけ再試行できるようにする
  - media upload成功後のtweet送信が401の場合も、401は認証拒否でXに受理されていない前提の範囲で、refreshがまだ未実施なら1回だけrefreshしてtweet送信を1回だけ再試行できるようにする
  - refresh済みなのに再度401なら即失敗する。429/5xx/network timeoutなど、投稿受理の成否が曖昧になり得る失敗を自動再送対象へ広げない
  - scheduled `morning_greeting` と admin manual publish の両経路で、同じ安全なrefresh-capable auth経路が使われることを確認する
  - mock/fake fetchで、期限切れaccess token→media 401→refresh成功→media成功→tweet成功の回帰テストを追加する
  - refresh失敗、media再401、tweet送信後の曖昧失敗で危険な再送をしないことをテストする
  - `publish_claims` の atomic same-day claim、安全なfailed状態、Storage receipt等の既存重複防止設計は維持する
- forbidden:
  - 2026-09-06のfailed `publish_claims` を削除・更新・再claimしない
  - 2026-09-06の朝の挨拶を手動投稿・再投稿しない
  - 実X APIへテスト投稿・画像アップロードを行わない
  - production secrets / OAuth token値を表示・変更しない
  - OAuth refresh token自体の運用ルールを変更しない
  - failed claimの自動reclaim・stale reclaimを追加しない
  - 401以外の曖昧なX送信失敗へ自動retryを広げない
  - `important-news-monitor/**`、重要ニュース、P0.7を変更しない
  - Expo/Auth/MVP/Push通知workstreamを変更しない
  - Cron、GitHub Actions、morning greeting画像生成workflowを変更しない
  - DB schema/migration/GRANT/production dataを変更しない
  - 本番deployを行わない
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - 期限切れaccess tokenでmedia uploadが401になった場合に、refresh→media upload 1回再試行で復旧できる
  - refresh実行は1 executionあたり最大1回で、refresh後の再401は失敗する
  - tweet側も401のみ安全な1回refresh/retryが可能で、401以外の曖昧失敗は再送しない
  - scheduled / manual publishの両経路で同じ安全性が成立する
  - 既存の `publish_claims` same-day one-claim、failed claim block、X post後の重複防止方針が維持される
  - 今日2026-09-06のfailed claim・scheduled row・Xには一切変更なし
  - 関連テストと `x-test-post` 回帰テストがPASSする
  - 必要な変更だけを最小commitし、fresh-check後に `origin/main` へpushする
  - 本番deployはしない。deployはK1承認後の別タスクにする
  - TASK末尾に `## Report` を追加し、statusを `review_required`、next_ownerを `chatgpt` にする
- commit: 必須。朝の挨拶OAuth refresh修正の最小差分のみ
- push: fresh-checkで競合がなければ `origin/main` へpush
- deploy: 禁止
- report_mode: inline
- next_owner: chatgpt

## Incident evidence

2026-09-06 JSTの本番read-only確認結果:
- 画像 `morning-greeting-assets/generated/2026-09-06.png` は生成済み
  - created_at: `2026-09-05 20:41:40.469918+00` = 2026-09-06 05:41:40 JST
- `scheduled_posts`
  - id: `e0c6da3b-ed6f-45d8-81cb-05b1796d1a2b`
  - post_type: `morning_greeting`
  - scheduled_for: `2026-09-05 21:51:58+00` = 2026-09-06 06:51:58 JST
  - status: `failed`
  - attempt_count: 1
- `publish_claims`
  - id: `6202d89e-1369-4837-b64a-9de65d53f5e1`
  - date_jst: `2026-09-06`
  - status: `failed`
  - execution_id: `0fe1c7af-f4a8-4905-904c-ca40a644bad7`
  - x_post_id: null
  - error_code: `MORNING_GREETING_MEDIA_UPLOAD_FAILED:401`
- `oauth_token_store` metadata
  - provider: `x`
  - expires_at: `2026-09-05 13:27:12.53+00` = 2026-09-05 22:27:12 JST
  - updated_at: `2026-09-05 11:27:12.53+00`
- 本番 `x-test-post` は incident確認時点で v86 ACTIVE / verify_jwt=false

コード確認で判明した原因:
- 通常tweet経路 `postToX()` は401時に `refreshXTokens(auth)` を実行し、new access tokenで1回再試行する
- 朝の挨拶 `runMorningGreetingManualPublish()` は `xAccessToken` 文字列だけを受け取り、`https://api.x.com/2/media/upload` と `https://api.x.com/2/tweets` を直接呼ぶため401時のOAuth refresh経路がない
- 今回は期限切れaccess tokenでmedia uploadが401となり、tweet API到達前に安全に失敗した

## Safety intent

今回の目的は「失敗した朝の挨拶を無理に再投稿すること」ではなく、**次回以降の正規scheduled executionがaccess token期限切れでも、401という明確な認証拒否だけを1回refreshして安全に継続できるようにすること**。

今日のfailed claimは、既存設計どおり人間レビュー対象としてそのまま残す。自動reclaimや手動削除は行わない。

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / root_cause_confirmed / changed_files / auth_refresh_behavior / retry_safety / tests / commit_hash / push / deploy / production_changes / remaining_issues / next_recommendation を記録する。
