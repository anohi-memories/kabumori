# Claude Task 1

- task_id: close-report-auto-post-enable-20260908
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent

## Goal

2026-09-09以降、close_reportが平日の大引け後に自動投稿されるproduction状態へ安全に変更する。

## User authorization

ユーザーは「明日から自動で投稿するように変更しといて。それでないとテストにならん」と明示承認している。

## Required investigation before write

1. `.agent/ORCHESTRATION.md` とこのTASKを確認し、他slotと競合しないことを確認する。
2. production上のclose_reportスケジューリング経路を再確認する。
   - `posting_windows` + `plan_daily_posts()`
   - `close_report_settings` + `plan_close_report()`
   - Cron / dispatcher / scheduled_posts生成元
3. 2系統が並存しているため、両方を同時に有効化して二重生成しないこと。明日以降に実際に使われる正規経路を1つだけ選ぶ。
4. 既存duplicate protection / claimがどの単位で効くか確認する。

## Authorized production change

上記確認で正規経路が特定できた場合に限り、2026-09-09以降のclose_report自動投稿を有効化するために必要な最小限のproduction設定変更を許可する。

想定:
- 正規経路が `posting_windows` 系なら `posting_windows.close_report.is_active=true` を有効化する。
- `close_report_settings` 系が実際の正規経路なら、その側のみ必要最小限で有効化する。
- 両方を同時に有効化しない。

既存の投稿時刻は原則維持する。現在確認済みの基準は15:58-16:02 JST / center 16:00付近。時刻変更が不要なら変更しない。

## Verification

設定変更後に必ず確認:
- 明日2026-09-09分が自動計画の対象になること
- 同日close_reportが複数生成されないこと
- duplicate protection / claimが維持されること
- `x-test-post` production versionは変更しない
- Xへ今日2026-09-08分を手動投稿しない
- 他post_typeへ影響しない

可能なら、production writeを増やさない方法で2026-09-09のplanner判定を確認する。明日分のscheduled_postsを今この場で手動直書きしない。

## Safety / prohibited

禁止:
- `posting_windows` と `close_report_settings` の両方を同時に有効化
- scheduled_posts手動直書き
- 今日分close_reportのlive投稿
- code変更 / deploy
- Cron変更（既存Cronが正しく動作している場合）
- migration/schema/GRANT/secrets/OAuth変更
- claim/duplicate/safety gate迂回
- 他post_type設定変更

正規経路が安全に特定できない、または有効化で二重生成の可能性が残る場合は、production変更を行わずBLOCKEDで停止する。

## Completion

完了時:
- status: review_required
- next_owner: chatgpt
- Reportに以下を記載
  - 採用した正規scheduler経路
  - 変更したproduction設定と変更前後
  - 明日2026-09-09が自動投稿対象になる根拠
  - 二重投稿防止確認
  - production version / deploy変更なし確認
  - 明日何時ごろ自動実行される見込みか
