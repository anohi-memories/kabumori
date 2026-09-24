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
- task_id: kabumori-release-pr18-privacy-dataflow-eas-light-review-20260924
- start_code: H1
- finish_code: C1
- source: `.agent/tasks/CODEX_TASK.md`
- report: `.agent/CODEX_REPORT.md`
- allocation: assigned; PR #18 privacy/data-flow/EAS light review

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-autopost-phase1d-db-rpc-concurrency-final-review-20260924
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: assigned; Phase1D DB/RPC/permission/concurrency final review

## Claude G1
- owner: claude
- slot: claude-1
- status: done
- task_id: kabumori-release-foundation-appstore-web-links-eas-audit-20260924
- start_code: G1
- finish_code: K1
- source: `.agent/tasks/CLAUDE_TASK_1.md`
- allocation: closed; K1 implementation PASS, H1 review pending

## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: kabumori-app-morning-close-report-detail-and-portfolio-impact-20260924
- start_code: G2
- finish_code: K2
- source: `.agent/tasks/CLAUDE_TASK.md`
- allocation: closed; K2 implementation PASS, Codex review queued

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: closed; Final K3 implementation PASS, H2 review pending

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: x-admin-netlify-deploy-preview-pipeline-20260924
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: assigned; X admin Netlify Deploy Preview setup

## Deferred

- PR #15 final Vercel gate / merge / post-merge Admin QA is intentionally deferred while Netlify Preview is introduced.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G4`: Claude G1〜G4開始。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K4`: ChatGPTが対応Claude枠だけ完了確認。
- `F`: 全6枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
