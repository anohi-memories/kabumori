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

## Project Critical Path — Common Account

- priority: **CRITICAL / project-wide**
- user decision: 共通アカウント完成を、かぶモリ・X自動投稿の次工程より最優先とする。
- G5 owns the shared common-account critical path.
- Existing G1-G4 tasks are preserved. Non-conflicting UI/source/read-only work may continue, but **no unrelated production DB/Auth/permission mutation may overtake an active/approved G5 production window**.
- G3 PR81 production apply remains HOLD whenever G5 has an approved/active production write.
- next shared milestone: production legacy backfill dry-run -> explicit backfill approval -> exact backfill -> Phase 2 integrations -> Phase 3 deletion/enforcement.

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
- task_id: common-account-v1-phase2-service-enrollment-corrective-rereview-20261006
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Mandatory focused re-review of corrected PR #95 exact head dd065e16. Verify prior R1-R5 closures, new service-start-intent migration/RPC atomic semantics, immutable session-bound transport, one-use re-enrollment intent, positive-ready push/notification gating, strict response validation, and PR #94/current-main compatibility. No merge/deploy/production mutation.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: x-social-mobile-pr76-final-security-rereview-20261005
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Final C2 PASS on PR #76 exact head 5448e545f4a88bbf6597a981c0bcbe4c01043c30. F1/F2/F3 closed, availability tradeoff accepted, no extra review required. PR #76 squash-merged as 3c5f80a61d114d2936b761fc05ee3b3d69e85f63. H2 free after fresh allocation.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-topic-learning-access-progress-and-swipe-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS and merged after C1 coordination. PR #94 exact head 97d374b48886ad33b61cd2288188d4b690e27a5c squash-merged as d30a518731e976ab1c0e4e19e26f461a174a3c1c. Native swipe parity, topic list 3-level switch, local 未読/学習済み, 375/402 verification complete. G1 free.
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-editorial-points-specificity-corrective-20261006
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: 10/6大引けの自然観測でfactual safetyはPASSしたが、3ポイントが「主要指数上昇／国際情勢を確認／米国株と為替を見る」と抽象化しすぎてeditorial未達。具体例文のprompt除去、generic見出し抑制、節目数値の例外、WARN-only specificity telemetry、不要rewrite/call増の見直しをsource/test onlyで実施。Hard境界・call ceilingは維持。production mutation禁止。
- recommended_model: Sonnet5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: x-social-mobile-pr41-live-generation-fresh-integration-20261006
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Final K3 PASS on AI persona-generation guidance. PR #78 head 1f33c58ca82a9d33d8c5c7282e0ac5c2fbb4aca9 squash-merged as 60dff4e28a763e3c182495dfc41cadf94671952f; Netlify preview success, Vercel failure was build-rate-limit and non-blocking. Next source-only task fresh-integrates stale PR #41 live general-user auto-post path. Replace direct service_role SELECT on social_mobile_content_settings with a narrow service-only brand-scoped read boundary; preserve AI Lab/Kabumori/PR76 and document, but do not implement, G5 entitlement enforcement. No production/merge/deploy. Recommended Opus5.5（高）.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-multisocial-phase1-architecture-inventory-20261006
- start_code: G4
- finish_code: K4
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: POSTONA multi-social Phase 1. Docs-only inventory and provider-neutral architecture design before runtime implementation. Map current X-specific seams, define X/Threads/Instagram provider-neutral post/account/publication model, capability matrix, Threads-first implementation slices and Instagram follow-on. Preserve active G3 PR41 live-generation boundary and G5 common-account/Auth/enrollment boundary. Runtime/migration/Edge/OAuth/Vault/production changes prohibited.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: review_required
- task_id: common-account-v1-phase2-service-enrollment-integration-20261006
- start_code: G5
- finish_code: K5
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepts corrected PR #95 head dd065e16 as PASS_CANDIDATE only. G5 reports H1 R1-R5 reproduced and fixed with forward service-start-intent migration, immutable session-bound RPC transport, one-use user/session reactivation intent, positive-ready side-effect gate, and strict payload validation. Production/deploy/EAS remain 0. Merge and migration apply HOLD pending mandatory H1 re-review.
- recommended_model: Opus5.5（極高）

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
