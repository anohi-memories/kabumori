# Codex Report

- task_id: close-report-auto-post-enable-20260908
- result: review_required
- next_owner: chatgpt
- completed_at: 2026-09-09 JST

## Result

本番のclose_report自動投稿を、既存の正規scheduler経路だけで有効化しました。

### 採用したscheduler経路

- active Cron `dispatch-scheduled-posts`（`* * * * *`）
- `x-test-post` の毎分dispatch
- `claim_due_post()` → `plan_close_report()`
- `plan_close_report()` は `close_report_settings.is_active` とJPX営業日を確認して `scheduled_posts` を生成

`posting_windows.close_report` + `plan_daily_posts()` は別経路ですが、二重生成防止のため有効化していません。

### Production変更

- `public.close_report_settings.is_active`: `false` → `true`
- 変更時刻: `2026-09-08 23:51:59.763339+00`（2026-09-09 08:51:59 JST）
- `window_start=15:58`, `center_time=16:00`, `window_end=16:02`
- `timezone=Asia/Tokyo`, `holiday_edition_enabled=false` は変更なし
- `public.posting_windows` の `close_report` 行は `is_active=false` のまま

### 2026-09-09対象確認

- JST現在時刻: `2026-09-09 08:51`頃
- 2026-09-09は平日（ISO day 3）、JPX holidayではない
- Cronの自然実行により `scheduled_posts` に1件だけ生成済み
- `scheduled_for=2026-09-09 07:00:00+00`（16:00 JST）、status=`pending`, attempt_count=`0`
- 同日 `close_report` は1行、重複なし

### Duplicate / claim / security確認

- `scheduled_posts` の `UNIQUE (schedule_date, post_type, slot_no)` を確認
- `plan_close_report()` の `on conflict (schedule_date, post_type, slot_no) do nothing` を確認
- `claim_due_post()` は `plan_close_report()` を呼び、`for update skip locked` で1件だけclaim
- `plan_close_report(date)` / `claim_due_post()` のEXECUTEは `service_role` のみ（既存ACL）
- `posting_windows` 側を同時有効化していないため、close_reportの二重planner経路は発生しない

### Safety / unchanged

- `x-test-post` はACTIVE version `v89`を確認。今回deployしていない
- Cron、Edge Function、コード、migration/schema、GRANT、secret、OAuth、他post_type設定は変更していない
- `scheduled_posts`への手動直書き、planner手動実行、2026-09-08分のX手動投稿は行っていない
- X API呼び出し・X投稿は行っていない

## Tests / verification

- production read-only SQLでsettings、scheduler、2026-09-09営業日判定、scheduled row、function定義、ACL、UNIQUE制約を確認
- 変更対象コードなしのため、アプリ/Edge Functionテストは未実施
- 管理ファイルの`git diff --check`: PASS

## Remaining issues

- 16:00 JSTの実際のX投稿成功（`scheduled_posts.status` / `x_post_id`）は予定時刻前のため未観測
- 予定時刻後はread-onlyでclaim・投稿結果を確認する必要がある

## Next recommendation

`C1`でこのproduction設定変更、9/9のscheduled row、二重投稿防止、未deployをレビューしてください。
