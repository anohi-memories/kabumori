# Codex Task 2

Codex（こでさん）並列スロット2の現在タスクです。`G3` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: none
- owner: codex
- slot: codex-2
- status: idle
- purpose: 有効な指示なし
- scope: なし
- forbidden: readyまたはin_progressの明示的なタスクが割り当てられるまで実装・production変更を開始しない
- completion_criteria: なし
- commit: なし
- push: なし
- deploy: なし
- report_mode: `.agent/CODEX_REPORT_2.md`
- next_owner: chatgpt

## Status values

- `idle`: 有効な指示なし
- `ready`: 作業開始可能
- `in_progress`: 作業中
- `review_required`: 実装済み・ちゃっぴー確認待ち
- `done`: 完了
