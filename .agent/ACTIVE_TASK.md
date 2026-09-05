# Active Tasks Index

このファイルは共有オーケストレーションの後方互換用インデックスです。実装指示の正本は各専用TASKです。

- Codex: `.agent/tasks/CODEX_TASK.md`
- Claude slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
- Claude slot 2: `.agent/tasks/CLAUDE_TASK.md`
- 共通ルール: `.agent/ORCHESTRATION.md`
- 現在地: `.agent/CURRENT_STATE.md`

## Current slots

### Codex
- owner: codex
- status: idle
- task_id: none
- start_code: G
- finish_code: C
- source: `.agent/tasks/CODEX_TASK.md`

### Claude slot 1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: important-news-trump-fed-trade-coverage-20260905
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`

### Claude slot 2
- owner: claude
- slot: claude-2
- status: idle
- task_id: none
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`

## Control codes

- `G`: Codex開始。Claudeではready/in_progressが1枠だけならその枠開始。
- `G1`: Claude slot 1開始。
- `G2`: Claude slot 2開始。
- `C`: ChatGPTがCodex完了だけ確認。
- `K1`: ChatGPTがClaude slot 1完了だけ確認。
- `K2`: ChatGPTがClaude slot 2完了だけ確認。
- `K`: Claude側の完了対象が1枠だけで明白な場合の簡易コード。
- `F`: 全3スロットの全体状況・競合・空き状況を確認する統括コード。

3スロットの並行実行は、task_idと変更対象が分離され競合しない場合に限る。
