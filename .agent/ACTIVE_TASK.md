# Active Tasks Index

このファイルは共有オーケストレーションの6枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーの個別指定がある場合はその指定を優先する。
- 競合防止ルールは常に優先する。

## Deployment policy

- X自動投稿・Web管理画面の開発中/PR/テスト用PreviewはNetlifyを優先する。
- レビュー完了後の最終production deployのみVercelを使う。
- かぶモリExpo/native本体はVercelを通常開発・merge gateに使用しない。
- Expo native/iOS実機・TestFlightは従来どおり別工程。
- かぶモリ将来WebはPreview/ProductionともNetlifyを使用する。

## Codex H1
- owner: codex
- slot: codex-1
- status: done
- task_id: kabumori-market-report-analysis-prod-sync-content-guard-20260929
- start_code: H1
- finish_code: C1
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: cancelled before execution as misrouted; production mutation 0. Task moved to G2. H1 must not run it concurrently.

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: x-social-mobile-account-deletion-prod-stage1-verification-20260929
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: closed after C2 reconciliation; deletion target checks passed; no deletion defect

## Claude G1
- owner: claude
- slot: claude-1
- status: in_progress
- task_id: kabumori-home-ui-continuation-20260929
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: PR #60 visual QA in progress. Fixed 04 Yume-chan only; simulator check then one fresh iOS preview build. No 10-state selector, no backend work, no Codex review. Historical data-packet blocker is already closed by H1/C1. Recommended Sonnet5（高）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-shared-morning-natural-observation-20260930
- start_code: G2
- finish_code: K2
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: read-only 2026-09-30 natural morning shared-cycle observation after 08:10 JST; no source/deploy/gate/manual invoke; recommended Sonnet5（中）

## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: x-social-mobile-account-deletion-prod-e2e-stage2-resume-20260930
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: resume Stage 2 disposable-account E2E after merged PR #59 UI fix; fresh user confirmation required before destructive valid-user action; recommended Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: idle
- task_id: none
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: unassigned; user-requested close after safe Stage A STOP. Previous Phase 3 findings remain preserved; no source changes and no pending review.

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G4`: Claude G1〜G4開始。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K4`: ChatGPTが対応Claude枠だけ完了確認。
- `F`: 全6枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
