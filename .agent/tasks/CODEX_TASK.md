# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: none
- owner: codex
- status: idle
- purpose: なし
- scope: []
- forbidden: []
- completion_criteria: []
- commit: 必要な場合のみ最小差分
- push: 指示がある場合のみ
- deploy: 指示がある場合のみ
- next_owner: chatgpt

## Status values

- `idle`: 有効な指示なし
- `ready`: 作業開始可能
- `in_progress`: 作業中
- `review_required`: 実装済み・ちゃっぴー確認待ち
- `done`: 完了
