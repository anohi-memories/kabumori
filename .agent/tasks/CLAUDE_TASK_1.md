# Claude Task 1

- task_id: close-report-immediate-live-test-20260908
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent
- purpose: 2026-09-08の大引けレポートについて、自動タスク経由ではSupabase実行まで到達しなかったため、現在のproduction状態を使って今すぐ安全にdry-runを実行し、全必須ゲートを通過した場合に限りXへlive投稿を1回だけ試す。

## User intent

ユーザーは「今すぐ大引けテスト投稿を実行してほしい」と明示している。

これは通常の開発タスクではなく、productionのclose_reportについて **dry-run -> 条件OKならlive 1回** を行う実行確認タスク。

## Current known facts

- production `x-test-post` は直近確認で v89 / ACTIVE。
- `posting_windows.close_report.is_active = false` と確認済み。
- 2026-09-07のlive試行は `CLOSE_REPORT_FACT_CHECK_FAILED` で安全停止し、X投稿0件だった。
- mainにはclose_report関連の未deploy変更が存在するが、このTASKではdeployしない。
- ChatGPT automationで16:00/16:03に実行を試みたが、Supabaseのclose_report実行ログには新規記録が無かった。

## Required steps

1. `.agent/ORCHESTRATION.md` とこのTASKを確認し、他slotと競合しないことを確認する。
2. production `x-test-post` の現在version/sourceと、close_reportのmanual/dry-run/live invocation経路を確認する。
3. **deployやコード変更はせず**、まず2026-09-08分のclose_reportをproductionでdry-run 1回だけ実行する。
4. dry-runで最低限以下を確認する:
   - HTTP success
   - close_report payload生成
   - Fact Check pass
   - Voice/format/safety validator pass（production v89で存在する範囲）
   - fixed hashtagsが期待どおり付与されること
   - `wouldPublish=true` または同等のpublish可能判定
   - X投稿API呼び出し0件
   - X実投稿0件
5. dry-runが全必須条件を通った場合に限り、2026-09-08分のclose_reportを **liveで1回だけ** 実行する。
6. live実行前に同日close_reportが既にpostedでないことを確認し、二重投稿防止claimを尊重する。
7. live成功時は `x_post_id` とposted状態を確認する。
8. live失敗時は再試行しない。エラーコード・どの安全ゲートで止まったかを記録する。

## Explicit authorization

このTASKでは、dry-runが全必須ゲートを通った場合に限り、2026-09-08のclose_reportについて **Xへのlive投稿を1回だけ許可する**。

許可されないもの:
- 2回以上のlive再試行
- 別post_typeの投稿
- production deploy
- code変更
- DB migration/schema/GRANT
- Cron変更
- secrets/OAuth変更
- `posting_windows`変更
- 安全ゲートの迂回
- claim/duplicate protectionの迂回

## Important handling of posting window

`posting_windows.close_report.is_active=false` は変更禁止。

manual/test invocationがこの設定のため安全にliveできない場合は、設定をtrueへ変えたり迂回したりせず、**BLOCKEDとして停止**して理由を報告する。

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report`追記
- production version
- dry-run result
- Fact/Voice/validator/wouldPublish結果
- live attempted yes/no
- live result / x_post_id / error
- duplicate protection確認
- production config変更0件確認

コード変更が無い場合はcommit不要。TASK report更新のみcommitしてよい。
