# Active Tasks Index

このファイルはF/G運用の後方互換用インデックスです。実装指示の正本は担当者ごとの専用タスクファイルです。

- Codex正本: `.agent/tasks/CODEX_TASK.md`
- Claude Code正本: `.agent/tasks/CLAUDE_TASK.md`
- 共通ルール: `.agent/ORCHESTRATION.md`
- 現在地: `.agent/CURRENT_STATE.md`

## Current slots

### Codex

- owner: codex
- status: idle
- task_id: none
- source: `.agent/tasks/CODEX_TASK.md`

### Claude Code

- owner: claude
- status: idle
- task_id: none
- source: `.agent/tasks/CLAUDE_TASK.md`

## F/G compatibility

古いF/G指示でこのファイルだけを読んだ場合でも、上記の各専用タスクファイルまで必ず確認してください。

- `F`: ChatGPTは両タスクスロット、CURRENT_STATE、両REPORTを確認して全体判断する。
- `G`: Codex/Claude Codeは自分専用タスクを確認し、`ready` または `in_progress` の場合だけ作業する。

CodexとClaude Codeは、task_idと変更対象が分離され、競合しない場合に限り同時進行できます。
