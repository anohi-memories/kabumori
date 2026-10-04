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
- task_id: ai-lab-pr82-claim-rereview-20261004
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Rereview PR #82 exact head 9f3b19a3cde490cf63735220ae191dcd4f11bdcb after C1 corrective. Verify durable pre-X claim, concurrency serialization, lease/fencing, provider-started ambiguous handling, exact idempotency, stable event_id+CI, evergreen cooldown skip, migration SECURITY DEFINER/ACL/RLS/drift, and no duplicate-X retry path. No merge/apply/deploy/production write/real X. Recommended Sol（高）.

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-social-mobile-pr81-content-settings-hardening-rereview-20261003
- start_code: H2
- finish_code: C2
- next_owner: codex
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Focused rereview of PR #81 exact head 5595fb131813542c55c43bc783af623cdb9ea442. Verify H2 F1-F4 closure: exact JSON/persona DB contract, effective least-privilege ACL/RLS, strictly monotonic updated_at CAS, fail-closed drift guard, real migration transactionality and production catalog compatibility. No merge/apply/deploy/production write. Recommended Sol（高）.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-topic-detail-learning-v2-20261003
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS. PR #83 exact head c810accebada37760a98a18bb184b50a61b7937b squash-merged as f5919eb6af3da51c0d4d4a6342ad23b3f0a68980. 全50トピックを5段階の静的学習フローへ強化し、Homeの短い要約は維持。284/284 tests、402/375pt visual checks、EAS 0、backend/DB/RPC/API/AI mutation 0。Codex review不要。G1 free after fresh allocation.
- recommended_model: Sonnet5（高）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-shared-report-v2-20261005-morning-natural-observation
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: read-only natural 2026-10-05 morning observation of production market-report-analysis v21 after PR #77 + PR #79 rollout; do not substantively observe before 08:10 JST, no polling/manual invoke/gate/deploy; inspect first-try vs retry, Hard/WARN boundaries, cost and factual integrity; recommended Sonnet5（中）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: x-social-mobile-content-settings-schema-hardening-20261003
- start_code: G3
- finish_code: K3
- next_owner: codex
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: K3 PASS to focused H2 rereview. PR #81 exact head 5595fb131813542c55c43bc783af623cdb9ea442 is open/mergeable; H2 F1-F4 are reported corrected with local disposable proof. No production apply/deploy/write. H2 review required before merge or any production migration approval. Recommended Sol（高）.

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: x-social-mobile-publish-toggle-transactional-corrective-20261003
- start_code: G4
- finish_code: K4
- next_owner: claude
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: Correct PR #76 after Final C1 FAIL. Build an atomic caller/membership/brand/account/CAS publish-toggle boundary, close brand TOCTOU with fresh pre-send authorization, prevent tenant-state reread leaks, align ON readiness semantics, and pin UI confirmation to exact account/context. New narrow migration/RPC allowed only for this boundary; no production apply/deploy/X operation. Recommended Opus5.5（極高）. Fresh Codex rereview Sol（極高） mandatory before merge.

## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-pr70-guard-boundary-corrective-20261002
- start_code: G5
- finish_code: K5
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: Final K5 PASS to rereview。PR #70 exact head 47a2ed6a1635177ba82004eace4bddb42d9d53e3。Phase 1からenforcing guardを外し、durable readiness/invalidation foundationへ限定。production mutation 0、merge/apply/deploy HOLD、H1 rereview assigned。

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
