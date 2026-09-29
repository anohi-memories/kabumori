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
- status: ready
- task_id: kabumori-data-packet-prod-sync-verification-rollout-20260929
- start_code: H1
- finish_code: C1
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: take over G1 production-read blocker; independently preflight cron + app/x gates, then controlled single market-report-data-packet deploy/read-back only if safe. No source edits, no manual cycle. Recommended Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-social-mobile-account-deletion-prod-stage1-verification-20260929
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: independent production verification of Stage 1 migration/read-back + account-delete Edge deploy + non-destructive smoke; no real deletion/revoke; recommended Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: kabumori-data-packet-session-reuse-prod-sync-20260929
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: STOP before mutation because production DB reads were blocked by G1 classifier. Source drift/tests proven; rollout continuation handed to H1. Do not restart concurrently. Recommended Sonnet5（高）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-shared-analysis-content-guard-fix-20260929
- start_code: G2
- finish_code: K2
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 CHANGES REQUIRED on PR #57 head 485f4bf; global bypass is fixed, but generic LCS>=3 support matching can treat polarity-inverted causes (e.g. 半導体株安→半導体株高) as supported. Replace with polarity-preserving deterministic matching and add regressions. No deploy/gates/data-packet edits. Recommended Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: x-social-mobile-account-deletion-prod-rollout-stage1-20260929
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: production Stage 1 only — exact migration apply/read-back + account-delete Edge deploy/source identity + non-destructive smoke; no real deletion/revoke/activation; recommended Opus5.5（高）

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
