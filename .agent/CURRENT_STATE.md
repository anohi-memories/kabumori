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
  - Codex slot 1: `ready`（`x-multibrand-phase2-brand-context-20260910`：X自動投稿システム複垢化Phase 2。G2から移管。brand/account基礎schema・BrandContext・kabumori互換導入。本番変更・認証接続・X投稿は禁止）
  - Codex slot 2: `done`
  - Claude slot 1: 別タスク管理
  - Claude slot 2: `done`（上記Phase 2をH1へ移管済み。G2では継続しない）
- multibrand_work:
  - 初期対象: `kabumori` / `ai_salaryman_lab` / `mio`
  - 安全な分離作業コピーと初期調査: `feature/multibrand-foundation` / commit `56244c7`
  - 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`、K2承認済み
  - Phase 1: `docs/multibrand/PHASE1.md` / commit `719249f`、K2承認済み
  - Phase 2は2026-09-10にユーザー指示でClaude G2からCodex H1へ移管
  - 承認済み判断: 共通パイプライン+brand_id、brands/social_accounts分離、X App当面共通1 App、トークンSupabase Vault、シングルトンin-place多行化、新ブランド既定OFF、expand->switch->contract
  - Phase 2の目標は `kabumori` 1ブランドだけをbrand-aware構造で従来互換にすること。会社員AIラボ・みおは未接続・未有効化
  - 本番Supabase link、DB/migration/RPC/Edge Function/Cron/Secret変更、OAuth、X実投稿、main mergeは禁止
  - Phase 1で発見したローカルmigration再生時の本番URL入りCronリスクに対するlocal-only unschedule対策とcheck-safe-envを維持
- parallel_work:
  - 既存未コミット変更は他workstreamの所有物として扱い、変更・stage・commitしない
  - H1開始前にorigin/mainと他スロットTASKをfresh-checkし、同じDB migration/RPC/Edge Function/workflow/production設定に触れる競合があれば開始しない
- known_issue:
  - 2026-09-09 morning_greetingはX投稿成功後、legacy Storage receipt保存HTTP 400によりscheduled_posts側がfailed扱いになった別問題が未修正

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
