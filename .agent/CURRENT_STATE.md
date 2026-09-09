# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-09 JST
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
  - `K` はClaude完了対象が1枠だけ明白な場合のみ
  - `F` は4スロット全体の統括。別チャット担当タスクを文脈なしに完了処理しない
  - task_idと変更対象が分離され、競合しない場合のみ並行作業可
  - Codex/Claudeの別を問わず、同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数スロットで同時変更しない
- active_workstream:
  - Codex slot 1: `done`（close_report自動投稿のproduction有効化完了）
  - Codex slot 2: `done`（morning_greeting柔らかい文体 + 固定5タグをx-test-post v90へdeploy完了）
  - Claude slot 1: `idle`
  - Claude slot 2: `idle`
- free_slots:
  - Codex slot 1: 新規割当可能
  - Codex slot 2: 新規割当可能
  - Claude slot 1: 新規割当可能
  - Claude slot 2: 新規割当可能
- parallel_work:
  - Web admin / Expo / stocks sync関連の未コミット作業が存在し得る。既存変更を変更・stage・commitしないこと
  - 新規並行作業は変更対象を分離して割り当てること
- deploy_version:
  - `important-news-monitor`: v31 / ACTIVE（直近確認済み）
  - `x-test-post`: v90 / ACTIVE / verify_jwt=false（2026-09-09 morning_greeting soft-copy deploy後に確認）
- important_settings:
  - important news auto_publish=true / safe cutover適用済み / publish-ready Cronは5分間隔で1本active
  - useful tip schedule active
  - morning greeting: 06:30-07:00 JST / daily_probability=1 / active
  - close_report_settings.is_active=true
  - posting_windows.close_report.is_active=false（二重planner防止）
- pending_observation:
  - morning_greeting: 次回自然投稿で柔らかい文体・固定5タグ・画像をread-only確認
  - close_report: 2026-09-09 16:00 JSTの自然X投稿結果を予定時刻後にread-only確認
  - important news: cutover後の自然most_important投稿は、確認する場合はread-onlyで再確認
- known_issue:
  - 2026-09-09 morning_greetingはX投稿自体は成功したがlegacy Storage receipt保存HTTP 400によりscheduled_posts側がfailed扱いになった別問題が未修正
- model_usage:
  - 普段はGPT-5.6 Sol
  - 必要時のみSol高を提案
  - Astraは大規模設計変更・全体レビュー・複数領域をまたぐ難題など明確に価値がある時だけ提案し、容量節約を優先
- handoff_note:
  - 新しいChatGPT部屋は `.agent/CHATGPT_HANDOFF.md` → `.agent/CURRENT_STATE.md` → 必要時 `.agent/ORCHESTRATION.md` の順で確認する
  - `HANDOFF.md` はWeb-admin系を含む既存用途のため今回の部屋移動では変更しない

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
