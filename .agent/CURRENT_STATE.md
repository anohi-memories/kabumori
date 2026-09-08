# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-08 JST（Codex 2枠・Claude 2枠の4スロット運用更新後）
- repo: kabumori
- branch: main
- verified_base_commit: `25b2eea`（今回の4スロット運用更新を開始した`origin/main`）
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
  - Codex slot 1: `done`（重要ニュース自動投稿のproduction有効化）
  - Codex slot 2: `idle`（新規割当可能）
  - Claude slot 1: `in_progress`（大引け自動投稿のproduction有効化）
  - Claude slot 2: `ready`（朝刊の米国休場・前営業日ラベル修正）
- parallel_work:
  - Web admin / Expo / stocks sync関連の未コミット作業が存在し得る。既存変更を変更・stage・commitしないこと
- deploy_version:
  - `important-news-monitor`: v31 / ACTIVE
  - `x-test-post`: v86 / ACTIVE（morning_greeting自動dispatch分岐を追加）
- important_settings:
  - important news auto_publish=true / safe cutover適用済み / publish-ready Cronは5分間隔で1本active
  - useful tip schedule active
  - morning greeting: 06:30-07:00 JST / daily_probability=1 / active
- pending:
  - Claude slot 1の大引け自動投稿有効化は作業中。完了前のproduction状態を推測しない
  - Claude slot 2の朝刊修正は未着手。production変更は禁止
  - 重要ニュースのcutover後初回自然投稿は未観測。人工生成・手動投稿しない
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
