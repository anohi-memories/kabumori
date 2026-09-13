# Active Tasks Index

このファイルは共有オーケストレーションの後方互換用インデックスです。実装指示の正本は各専用TASKです。

- Codex slot 1: `.agent/tasks/CODEX_TASK.md`
- Codex slot 2: `.agent/tasks/CODEX_TASK_2.md`
- Claude slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
- Claude slot 2: `.agent/tasks/CLAUDE_TASK.md`
- 共通ルール: `.agent/ORCHESTRATION.md`
- 現在地: `.agent/CURRENT_STATE.md`

## Current slots

### Codex slot 1
- owner: codex
- slot: codex-1
- status: ready
- task_id: x-multibrand-phase3c-oauth-start-void-rpc-fix-20260912
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- note: Claude slot 2から正式移管。OAuth開始POSTのvoid RPCレスポンス処理バグを最小修正する。X投稿/live化/Cron変更は禁止。

### Codex slot 2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-close-report-topix-source-correction-20260911
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`

### Claude slot 1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: personalized-portfolio-morning-close-reports-phase1-20260911
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`

### Claude slot 2
- owner: claude
- slot: claude-2
- status: in_progress
- task_id: x-multibrand-phase3d-ai-lab-dry-run-routing-safety-20260913
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- note: OAuth/Vault領域はCodex slot1のkabumori-x-oauth-recovery（done）で確定済み。Phase 3Dはbrand-routing/claim/publish/dedupeの安全性確認。

## Control codes

- `H1`: Codex slot 1開始。
- `H2`: Codex slot 2開始。
- `G`: Claudeではready/in_progressが1枠だけならその枠開始。
- `G1`: Claude slot 1開始。
- `G2`: Claude slot 2開始。
- `C1`: ChatGPTがCodex slot 1完了だけ確認。
- `C2`: ChatGPTがCodex slot 2完了だけ確認。
- `K1`: ChatGPTがClaude slot 1完了だけ確認。
- `K2`: ChatGPTがClaude slot 2完了だけ確認。
- `K`: Claude側の完了対象が1枠だけで明白な場合の簡易コード。
- `F`: 全4スロットの全体状況・競合・空き状況を確認する統括コード。

4スロットの並行実行は、task_idと変更対象が分離され競合しない場合に限る。Codex/Claudeの別を問わず、同じファイル・DB migration/RPC・Edge Function・workflow・production設定を複数スロットで同時変更しない。
