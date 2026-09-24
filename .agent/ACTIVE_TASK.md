# Active Tasks Index

このファイルは共有オーケストレーションの6枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Codex H1
- owner: codex
- slot: codex-1
- status: ready
- task_id: x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- report: `.agent/CODEX_REPORT.md`
- allocation: assigned; not available for a new TASK

## Codex H2
- owner: codex
- slot: codex-2
- status: idle
- task_id: none
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: unassigned; available if no conflicting work appears at fresh-check

## Claude G1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: kabumori-mobile-auth-real-e2e-disposable-account-20260924
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- allocation: assigned; not available for a new TASK

## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: x-admin-multibrand-selector-phase2-merge-only-20260924
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- allocation: assigned; not available for a new TASK

## Claude G3
- owner: claude
- slot: claude-3
- status: idle
- task_id: none
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: unassigned

## Claude G4
- owner: claude
- slot: claude-4
- status: idle
- task_id: none
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: unassigned

## Control codes

- `H1` / `H2`: Codex H1/H2開始。通常はレビュー・バグ修正・検証。
- `G1`〜`G4`: Claude G1〜G4開始。
- `G`: Claudeの開始可能枠が1つだけ明白な場合の簡易開始コード。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K4`: ChatGPTが対応Claude枠だけ完了確認。
- `K`: Claudeの未評価完了対象が1枠だけ明白な場合の簡易確認。
- `F`: 全6枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
