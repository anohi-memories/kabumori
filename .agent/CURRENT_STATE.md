# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-05 JST（morning-greeting-enable-2026-09-06完了時点）
- repo: kabumori
- branch: main
- verified_base_commit: `c4427ea`（morning greeting auto-dispatch実装commit、origin/main一致確認済み）
- active_workstream: なし（review_required、ちゃっぴーの確認待ち）
- parallel_work:
  - Web admin / Expo / stocks sync関連の未コミット作業あり。今回の共有運用とは別workstream
  - 既存変更を変更・stage・commitしないこと
- deploy_version:
  - `important-news-monitor`: v26 / ACTIVE
  - `x-test-post`: v86 / ACTIVE（morning_greeting自動dispatch分岐を追加）
- important_settings:
  - `important_news_monitor_settings.is_active=true`
  - `important_news_monitor_settings.auto_publish=false`
  - `useful_tip_schedule_settings.is_active=true`
  - `posting_windows`に`morning_greeting`行を新規追加（06:30-07:00 JST, daily_probability=1, is_active=true）— 過去に用意されていた未適用migration案（07:00-07:30 JST）はsupersede済み
- pending:
  - 2026-09-06の朝の挨拶の実際の投稿予定時刻はJST深夜0時以降でないと`scheduled_posts`に確定しない（詳細は`.agent/CLAUDE_REPORT.md`）。当日朝の投稿結果（成功/失敗、x_post_id）の確認も未実施
  - 今日2026-09-05のfailed publish_claimは未変更のまま（既存仕様どおり同日再取得しない）
  - P0.7以降を含む重要ニュース追加作業は別途指示待ち
- handoff_note: `HANDOFF.md` はWeb-admin系を含む既存引き継ぎ用途。今回のGitHub共有運用では更新しない

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
