# Active Tasks Index

このファイルは共有オーケストレーションの6枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーの個別指定がある場合はその指定を優先する。
- 競合防止ルールは常に優先する。

## Codex H1
- owner: codex
- slot: codex-1
- status: idle
- task_id: none
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- report: `.agent/CODEX_REPORT.md`
- allocation: unassigned

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: assigned

## Claude G1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- allocation: assigned

## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: x-admin-multibrand-selector-phase2-merge-only-20260924
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- allocation: closed; unfinished continuation moved to G4

## Claude G3
- owner: claude
- slot: claude-3
- status: idle
- task_id: none
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: unassigned; X implementation slot

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: x-admin-phase2-vercel-gate-merge-and-postmerge-qa-20260924
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: assigned; X implementation continuation

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G4`: Claude G1〜G4開始。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K4`: ChatGPTが対応Claude枠だけ完了確認。
- `F`: 全6枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
