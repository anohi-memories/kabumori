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
  - Codex slot 1: `ready`（`x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910`：会社員AIラボの実X OAuth接続 + Supabase Vault token登録 + read-only identity verification。X投稿/live化/Cron追加は禁止）
  - Codex slot 2: `done`
  - Claude slot 1: 別タスク管理
  - Claude slot 2: `done`（複垢化Phase 2はH1へ移管済み。G2では継続しない）
- multibrand_work:
  - 初期対象: `kabumori` / `ai_salaryman_lab` / `mio`
  - 初期安全調査: `feature/multibrand-foundation` / commit `56244c7`
  - 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`、K2承認済み
  - Phase 1: commit `719249f`、K2承認済み。ローカル再現とCron安全対策
  - Phase 2: commit `5806e85`、C1承認済み。brand/account基礎、BrandContext、Kabumori互換
  - Phase 3A: commit `34cb78c`、C1承認済み。会社員AIラボ独立profile + dry-run基盤
  - Phase 3B: commit `d04d36d`、C1承認済み。Vault opaque refs、brand/account-aware OAuth state、read-only X identity verification準備。688/688 tests、SAFE、本番変更ゼロ
  - Phase 3Cは会社員AIラボの実OAuth接続とVault token登録、read-only本人確認までを行う
  - 接続後も `publish_mode=dry_run` / `publish_enabled=false` を維持し、X投稿と自動投稿Cronは解放しない
  - Xログイン・認可同意はユーザー本人操作が必要。パスワード/2FAコードを取得・保存しない
  - Kabumori legacy oauth_token_store/token/投稿挙動を変更しない
  - `mio` はdisabledのまま
- parallel_work:
  - 既存未コミット変更は他workstreamの所有物として扱い、変更・stage・commitしない
  - H1開始前と本番反映直前にorigin/mainと他スロットTASKをfresh-checkし、同じDB migration/RPC/Edge Function/workflow/production設定に触れる競合があれば開始しない
  - 実装は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation`
- known_issue:
  - 2026-09-09 morning_greetingはX投稿成功後、legacy Storage receipt保存HTTP 400によりscheduled_posts側がfailed扱いになった別問題が未修正

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
