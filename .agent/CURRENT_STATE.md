# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-05 JST（G/C/K/F・3スロット運用更新後）
- repo: kabumori
- branch: main
- verified_base_commit: `c4427ea`（morning greeting auto-dispatch実装commit。以降`.agent/`運用ファイル更新あり）
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex: `.agent/tasks/CODEX_TASK.md`
  - Claude slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
  - Claude slot 2: `.agent/tasks/CLAUDE_TASK.md`
  - `.agent/ACTIVE_TASK.md` は後方互換・全体一覧
  - Codex開始=`G`、完了確認=`C`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`
  - `K` はClaude完了対象が1枠だけ明白な場合のみ
  - `F` は3スロット全体の統括。別チャット担当タスクを文脈なしに完了処理しない
  - task_idと変更対象が分離され、競合しない場合のみ並行作業可
- active_workstream: 新規割当待ち
- parallel_work:
  - Web admin / Expo / stocks sync関連の未コミット作業が存在し得る。既存変更を変更・stage・commitしないこと
- deploy_version:
  - `important-news-monitor`: v26 / ACTIVE
  - `x-test-post`: v86 / ACTIVE（morning_greeting自動dispatch分岐を追加）
- important_settings:
  - important news auto_publish=false
  - useful tip schedule active
  - morning greeting: 06:30-07:00 JST / daily_probability=1 / active
- pending:
  - 2026-09-06 00:00 JST以降にmorning greetingの確定投稿予定時刻をread-only確認
  - 2026-09-06 05:30 JSTに画像自動生成予定
  - 2026-09-06朝に投稿結果をread-only確認
  - 2026-09-05のfailed morning-greeting claimは変更・削除・再利用しない
  - 重要ニュースP0.7はユーザー判断で保留。勝手に開始しない
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
