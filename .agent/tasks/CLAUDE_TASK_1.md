# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: none
- owner: claude
- slot: claude-1
- status: idle
- purpose: なし
- scope: []
- forbidden: []
- completion_criteria: []
- commit: 必要な場合のみ最小差分
- push: 指示がある場合のみ
- deploy: 指示がある場合のみ
- report: `.agent/reports/CLAUDE_REPORT_1.md`
- next_owner: chatgpt

## Status values

- `idle`: 有効な指示なし
- `ready`: 作業開始可能
- `in_progress`: 作業中
- `review_required`: 実装済み・ちゃっぴー確認待ち
- `done`: 完了
