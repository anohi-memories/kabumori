# Claude Task 1

- task_id: close-report-one-time-live-20260908
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: urgent

## Goal

2026-09-08分のclose_reportを、正規のproduction経路でXへ1回だけ投稿する。

## Authorization

ユーザーは、直前dry-runが全ゲートPASS済みであることを前提に、`posting_windows.close_report.is_active`を一時的に有効化して1回だけlive投稿し、終了後に必ず無効へ戻すことを明示承認した。

## Preconditions

直前確認:
- production x-test-post v89 / ACTIVE
- dry-run HTTP 200
- Fact Check pass
- Voice Check pass
- wouldPublish true
- fixed hashtags正常
- 今日分postedなし

## Steps

1. 実行直前に今日分が未postedであることとduplicate protectionを再確認。
2. `posting_windows.close_report.is_active`を一時的にtrueへ変更。
3. 既存の正規planner/dispatcher経路のみで2026-09-08 close_reportを1回だけ実行。
4. 成功ならx_post_id / run id / posted状態を確認。
5. 失敗なら再試行せず、error codeと停止ゲートを記録。
6. 成功・失敗・BLOCKEDを問わず、最後に必ず`is_active=false`へ戻し、DB再読でfalseを確認。

## Safety

禁止:
- 2回目のlive再試行
- window start/end時刻変更
- daily_probability変更
- scheduled_posts手動直書き
- claim/duplicate/safety gate迂回
- code変更/deploy
- Cron/secrets/OAuth/migration/schema変更
- 他post_type投稿

現在時刻が既存window外で、is_active=trueでも正規経路が今日分を生成できない場合は、時刻変更や直書きをせずBLOCKEDで停止し、is_active=falseへ戻す。

## Completion

完了時はstatus: review_required / next_owner: chatgpt とし、Reportにlive attempted、結果、x_post_id/run id/error、duplicate protection、最終is_active=false確認を記載する。
