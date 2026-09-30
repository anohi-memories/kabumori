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
- task_id: x-social-mobile-pr63-native-data-source-auth-ux-review-20260930
- start_code: H1
- finish_code: C1
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final C1 PASS on exact PR #63 head 5f2eae2; safe for source merge; production mutation 0.

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: x-ai-salaryman-dev-diary-pr61-final-acceptance-20260930
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: Final C2 PASS. PR #61 accepted for merge and separately controlled deploy.

## Claude G1
- owner: claude
- slot: claude-1
- status: idle
- task_id: none
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: free after Final K1 PASS of Home visual rebuild PR #60. Last accepted merge: 0ddf49132ecdab9b0d1afde8330556907cb34315. Next likely UI work is canonical asset insertion when header/Hero/topic artwork is ready.

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-shared-close-natural-observation-20260930
- start_code: G2
- finish_code: K2
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: 2026-09-30 natural close shared-cycle read-only observation after 16:40 JST; morning already PASS; no source/deploy/gate/manual invoke; recommended Sonnet5（中）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: x-social-mobile-pr63-merge-native-e3-resume-20260930
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: Final K3 BLOCKED at safety stop. Native real-data path verified, but the X account used for E3 was already connected to an existing production posting account, so no destructive step was started. Requires a genuinely new disposable X account before resuming; fresh user approval remains mandatory immediately before delete/X revoke/Vault mutation. No additional Codex review required yet; recommended Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: x-ai-salaryman-dev-diary-pr61-merge-prod-rollout-20260930
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: Final K4 PASS. PR #61 merged as f0ea0a964797524022f0b8aa51a670a78806dd26; production x-test-post is ACTIVE v129 with verify_jwt=false; deployed source 45/45 matches accepted merge; only x-test-post changed; manual X posts 0. G4 slot may be reused after fresh allocation.

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
