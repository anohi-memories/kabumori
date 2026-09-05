# Claude Task 2

Claude Code（くろちゃん）並列スロット2の現在タスクです。`G2` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: none
- owner: claude
- slot: claude-2
- status: idle
- purpose: なし
- scope: []
- forbidden: []
- completion_criteria: []
- commit: 必要な場合のみ最小差分
- push: 指示がある場合のみ
- deploy: 指示がある場合のみ
- report_mode: inline
- next_owner: chatgpt

## Completion report

完了時はこのファイルの末尾に `## Report` を追加し、task_id / result / changed_files / tests / commit_hash / push / deploy / remaining_issues / safety_checks / next_recommendation を記録する。
