# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-10 JST
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot 1: `.agent/tasks/CODEX_TASK.md`
  - Codex slot 2: `.agent/tasks/CODEX_TASK_2.md`
  - Claude slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
  - Claude slot 2: `.agent/tasks/CLAUDE_TASK.md`
  - `.agent/ACTIVE_TASK.md` は後方互換・全体一覧
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`
- active_workstream:
  - Codex slot 1: `done`（Phase 3CをClaude slot 2へ移管済み）
  - Codex slot 2: `done`
  - Claude slot 1: `ready`（別ニュース基盤タスク。複垢化とは競合させない）
  - Claude slot 2: `ready`（`x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910`：Codex H1から移管。会社員AIラボOAuth接続→Vault保存→read-only本人確認まで。X投稿/live化/Cron変更は禁止）
- multibrand_work:
  - 初期対象: `kabumori` / `ai_salaryman_lab` / `mio`
  - 初期安全調査: `feature/multibrand-foundation` / commit `56244c7`
  - 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`、K2承認済み
  - Phase 1: commit `719249f`、K2承認済み
  - Phase 2: commit `5806e85`、C1承認済み
  - Phase 3A: commit `34cb78c`、C1承認済み
  - Phase 3B: commit `d04d36d`、C1承認済み
  - Phase 3C最新実装: `feature/multibrand-foundation` commit `a8414d9` (`Accept dashboard secret key for OAuth start`)
  - `x-oauth-connect` のみ本番deploy済み
  - OAuth開始POSTに限りDashboard secret key `apikey` を許可。callback/token読取/X投稿には使わない
  - Dashboardテスト画面で `{"handle":"kaishain_ai_lab"}` とsecret key header設定まで完了。`Send Request` は未実行
  - 現時点でOAuth state / Vault / social_accountsへの新規書込み、X API、Xログインは未実行
  - 次はG2でOAuth開始→authorization URL確認→ユーザー本人Xログイン/同意で停止→callback後Vault保存→`GET /2/users/me` read-only確認
  - 接続後も `publish_mode=dry_run` / `publish_enabled=false`
  - X投稿・Cron変更・live化・publish有効化・Kabumori token変更・mio操作は禁止
- parallel_work:
  - 既存未コミット変更は他workstreamの所有物として扱い、変更・stage・commitしない
  - G2開始前にorigin/mainと他slot TASKをfresh-checkし、同じmigration/RPC/Edge Function/workflow/production設定へ触れる競合があれば開始しない
  - 複垢化実装は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation`
- known_issue:
  - 2026-09-09 morning_greetingはX投稿成功後、legacy Storage receipt保存HTTP 400によりscheduled_posts側がfailed扱いになった別問題が未修正

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
