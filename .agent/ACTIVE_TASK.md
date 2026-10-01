# Active Tasks Index

このファイルは共有オーケストレーションの7枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- `G5`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。
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
- task_id: kabumori-pr67-shared-report-v2-hard-fact-review-20261001
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: focused pre-merge review of PR #67 exact head 5877045f7554cd4e089fb3b79091bf8e2bb38456; Hard Fact vs Quality WARN, mixed-session guard, rewrite fallback/call budget, v1 compatibility, X/App privacy and news priority; no merge/deploy/gate/real X; recommended Sol（高）
## Codex H2
- owner: codex
- slot: codex-2
- next_owner: codex
- status: ready
- task_id: x-ai-lab-pr66-topic-dedup-review-20261001
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: Focused pre-merge review of PR #66 exact head 4f692e4d805ccd3ee628058bb20ee6c1f62cdd6d. Check topic rotation/cooldown, bounded regeneration/fail-closed behavior, PostgREST count semantics, and cross-brand isolation. No deploy/merge/real X/production mutation. Recommended Luna（高）.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: chatgpt
- status: review_required
- task_id: kabumori-home-visual-rebuild-reference-20260930
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- previous_allocation: free after Final K1 PASS of Home visual rebuild PR #60. Last accepted merge: 0ddf49132ecdab9b0d1afde8330556907cb34315. Next likely UI work is canonical asset insertion when header/Hero/topic artwork is ready.
- allocation: 正本TASKはreview_required / next_owner chatgpt。最新のheader-logo ReportはK1確認待ち。以前のPR #60完了記録は保持し、この変更では完了判定・再割当しない。
- snapshot_sync: 2026-10-01 JST; fresh mainのTASKヘッダから索引のみ更新。旧allocationはprevious_allocationとして保存。

## Claude G2
- owner: claude
- slot: cl## Claude G2
- owner: claude
- slot: claude-2
- next_owner: codex
- status: review_required
- task_id: kabumori-shared-report-v2-rich-presentation-hard-facts-20261001
- start_code: G2
- finish_code: K2
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 source candidate accepted at PR #67 exact head 5877045f7554cd4e089fb3b79091bf8e2bb38456; independent H1 review required before merge/deploy; consumers remain OFF; H1 recommended Sol（高）
aude-3
- next_owner: none
- status: done
- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: Final K3 PASS. Disposable social-mobile service deletion E3 completed: X authorization revoked, service-specific workspace/membership/account/credentials/transient OAuth data removed, unexpected residue 0, protected production posting accounts unchanged, real X posts 0. Shared Auth/profile intentionally retained under social_only. No source change; no extra Codex review. Remaining UI release blocker: invisible native Login methods navigation buttons. G3 may be reused only after fresh allocation/competition check.

## Claude G3
- owner: claude
- slot: claude-3
- next_owner: claude
- status: ready
- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- start_code: G3
- finish_code: K3
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: Finish the remaining social-mobile account-deletion UI release blockers only: root-cause/fix invisible native Login methods buttons and add a discoverable Settings account-management entry. Preserve existing deletion backend/scope semantics and feature gate; no common-account/service-entitlement implementation, no G4 overlap, no deploy/destructive operation. Recommended Sonnet5（高）.

## Claude G4
- owner: claude
- slot: claude-4
- next_owner: chatgpt
- status: review_required
- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: Final C1 accepted PR #65 source/security at exact head e5a66f5ba71f64b1a38d8f89faff3d0a31972949. Merge is still held until safe operator provider-side account-switch E2E proves a different X account can authenticate without silent reuse. Production mutation 0.

## Claude G5
- owner: claude
- slot: claude-5
- status: idle
- task_id: none
- start_code: G5
- finish_code: K5
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: 未割当。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・MIC自動割当しない。

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G5`: Claude G1〜G5開始。ready / in_progressのTASKのみ。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K5`: ChatGPTが対応Claude枠だけ完了確認。
- 単独 `G` / `K`: G5も候補に含め、対象が1枠だけと明白な場合のみ使用。
- `F`: H1/H2 + G1〜G5の全7枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
