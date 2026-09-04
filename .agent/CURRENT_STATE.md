# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-05 JST
- repo: kabumori
- branch: main
- latest_commit: `.agent/` 初期構築を含む `origin/main` 最新commit（hashは `git rev-parse origin/main` で確認）
- verified_base_commit: `edb91a8fe60b522b2232a30fc09dbecdabae21f3`（初期構築開始時のHEAD / origin/main）
- active_workstream: なし（次指示待ち）
- parallel_work:
  - Web admin / Expo / stocks sync関連の未コミット作業あり。今回の共有運用とは別workstream
  - 既存変更を変更・stage・commitしないこと
- deploy_version:
  - `important-news-monitor`: v26 / ACTIVE（Supabaseで確認済み。初期指示のv25から更新あり）
- important_settings:
  - `important_news_monitor_settings.is_active=true`
  - `important_news_monitor_settings.auto_publish=false`
  - `useful_tip_schedule_settings.is_active=true`（復旧済み・DB確認済み）
- pending:
  - morning greetingのfresh-date live test
  - P0.7以降を含む重要ニュース追加作業は別途指示待ち
- handoff_note: `HANDOFF.md` はWeb-admin系を含む既存引き継ぎ用途。今回のGitHub共有運用では更新しない

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
