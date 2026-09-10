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
  - Codex slot 1: `ready`（`x-multibrand-phase3b-auth-connection-prep-20260910`：会社員AIラボのSupabase Vault認証・OAuth接続・read-only identity verification準備。X実投稿/live化/本番deployは禁止）
  - Codex slot 2: `done`
  - Claude slot 1: 別タスク管理
  - Claude slot 2: `done`（複垢化Phase 2はH1へ移管済み。G2では継続しない）
- multibrand_work:
  - 初期対象: `kabumori` / `ai_salaryman_lab` / `mio`
  - 初期安全調査: `feature/multibrand-foundation` / commit `56244c7`
  - 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`、K2承認済み
  - Phase 1: `docs/multibrand/PHASE1.md` / commit `719249f`、K2承認済み
  - Phase 2: commit `5806e85`、C1承認済み。brands/social_accounts/brand_settings、brand_id、BrandContext、publish guard、Kabumori legacy token境界まで実装。Deno tests 683/683、local reset PASS、SAFE確認。本番変更ゼロ
  - Phase 3A: commit `34cb78c`、C1承認済み。会社員AIラボ独立BrandCodeProfile、brand_context_dry_run、Vault mock境界を実装。Deno tests 686/686、SAFE確認。本番変更ゼロ
  - Phase 1で判明したローカルmigration再生時の本番URL入りCronリスクは、local-only unschedule migrationと `check-safe-env.sh` で対策済み。今後も維持する
  - 承認済み判断: 共通パイプライン+brand_id、brands/social_accounts分離、X App当面共通1 App、トークンSupabase Vault、シングルトンin-place多行化、新ブランド段階解放、expand->switch->contract
  - Phase 3Bは会社員AIラボの実OAuth/Vault接続に入る前の認証配管・安全手順を完成させる。per-account Vault refs、brand/account-aware OAuth state/callback、read-only X identity verificationを準備する
  - Phase 3Bでも会社員AIラボはdry_run / publish disabledを維持。X実投稿、自動投稿Cron追加、live化は禁止
  - `mio` は未実装・disabled
  - Kabumori legacy oauth_token_storeを壊さない
  - Phase 3BはTerra推奨。Vault/OAuth構造の根本変更が必要なら停止し、ChatGPTへ報告してSol等を検討
- parallel_work:
  - 既存未コミット変更は他workstreamの所有物として扱い、変更・stage・commitしない
  - H1開始前にorigin/mainと他スロットTASKをfresh-checkし、同じDB migration/RPC/Edge Function/workflow/production設定に触れる競合があれば開始しない
  - H1は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation` の分離環境を使用
- known_issue:
  - 2026-09-09 morning_greetingはX投稿成功後、legacy Storage receipt保存HTTP 400によりscheduled_posts側がfailed扱いになった別問題が未修正

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
