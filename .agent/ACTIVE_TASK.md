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
- task_id: common-account-v1-phase2-service-enrollment-review-20261006
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Mandatory focused review of PR #95 exact head c06fac64. Review lifecycle RPC boundary, fail-closed states, ended explicit-reactivation race, single-flight/user switching, Kabumori gate, X OAuth separation, and compatibility with moving PR #94. Source review only; no merge/deploy/production mutation.
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
- next_owner: chatgpt
- status: review_required
- task_id: kabumori-topic-learning-access-progress-and-swipe-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS on PR #94 exact head 97d374b48886ad33b61cd2288188d4b690e27a5c。375pt実測PASS、376/376 tests、root-level news detailでnative swipe parity解決、topic list 3-level/未読・学習済み/Settings分離を受入。PR #95と src/app/_layout.tsx が1ファイル重複し、H1がPR95 exact headをレビュー中のためmergeのみHOLD。追加G1実装不要。C1後に安全なmerge順/integrationを調整。
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
- status: ready
- task_id: x-social-mobile-pr41-live-generation-fresh-integration-20261006
- start_code: G3
- finish_code: K3
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: Final K3 PASS on AI persona-generation guidance. PR #78 head 1f33c58ca82a9d33d8c5c7282e0ac5c2fbb4aca9 squash-merged as 60dff4e28a763e3c182495dfc41cadf94671952f; Netlify preview success, Vercel failure was build-rate-limit and non-blocking. Next source-only task fresh-integrates stale PR #41 live general-user auto-post path. Replace direct service_role SELECT on social_mobile_content_settings with a narrow service-only brand-scoped read boundary; preserve AI Lab/Kabumori/PR76 and document, but do not implement, G5 entitlement enforcement. No production/merge/deploy. Recommended Opus5.5（高）.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: x-morning-greeting-schedule-reliability-bc-20261006
- start_code: G4
- finish_code: K4
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Final K4 PASS. PR #92 exact head 3d5475849217e1ca9f40bbedf12a42c0e5671504 squash-merged as 19c85c4381c55161207032146d6f66eb8a0c99f5. Plan B adds four staggered generator schedules (00:17/02:47/04:17/05:17 JST) with same-day idempotency; Plan C adds read-only missing/late checks at 06:07/09:47 JST. 44/44 tests, fresh-main overlap 0, CI green, production mutation/deploy/X/PAT/Vault/pg_cron=0. No Codex review required. G4 free after fresh allocation. Plan A remains separate.
- recommended_model: Sonnet5（高）

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
- allocation: K5 accepts PASS_CANDIDATE for PR #95 exact head c06fac64, production/deploy 0. Mandatory H1 review allocated before merge because both apps' Auth/session bootstrap changes. PR #95 merge/deploy HOLD pending C1. G5 must not start Phase 3 yet.
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
