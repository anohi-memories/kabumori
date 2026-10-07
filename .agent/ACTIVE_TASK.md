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
- task_id: postona-pr106-phase2a2-security-rereview-20261007
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Focused exact-head rereview of corrected POSTONA PR #106 head a8f313dc72b087ab86482781297848fe6e23bdcc. Verify B1-B6 closure, defensive postconditions and X regressions only. No merge/apply/deploy/production/provider access.
- recommended_model: Sol（高）
## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-trace-gpt61-rollout-runbook-review-20261007
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: User explicitly waived the focused PR #108 review to prioritize today's natural close-cycle rollout. No Codex PASS is claimed. PR #108 is merged and the production rollout completed with direct bounded read-backs. H2 free.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-portfolio-canonical-ui-v1-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: G1 market-report allocation was a routing mistake and is cancelled. G1 remains free after the completed portfolio task; do not start the delivery-first report task from G1.
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-market-report-delivery-first-guard-calibration-20261007
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: Canonical delivery-first market-report calibration. X is Premium; legacy short length is advisory only. Objective errors should be removed at smallest-unit granularity and remaining coherent content delivered; whole-report failure is last resort. Deterministic AI disclaimer required on X/App. IMPORTANT: user will not start G2 until after the 16:35 JST natural retry is complete and checked.
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: ai-lab-topic-continuity-pr109-security-corrective-20261007
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: C1 CHANGES REQUIRED corrective on existing PR #109 only. Preserve accepted 74-topic/Tier2+Tier3/cooldown/capacity behavior; fix migration B1 SET ROLE graph guard, B2 canonical prerequisite table-shape proof, B3 exact unchanged lifecycle-function body proof. Add adverse rollback fixtures. No production/apply/deploy/merge.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: review_required
- task_id: postona-multisocial-phase2a2-security-corrective-20261007
- start_code: G4
- finish_code: K4
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: K4 accepts corrected PR #106 head a8f313dc72b087ab86482781297848fe6e23bdcc as PASS_CANDIDATE only. B1-B6 are reported fixed with expanded PostgreSQL/adversarial/mutation coverage; CI green; fresh-main file overlap 0; production/deploy/provider mutations 0. Merge HOLD pending H1 exact-head security rereview.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-v1-phase2-native-client-validation-20261007
- start_code: G5
- finish_code: K5
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: Final K5 PASS. Native client validation completed with no source fix. Current client matches the deployed Phase 2 service-enrollment response contract. Production access/deploy/EAS remained 0. Any later real-account smoke requires a separate explicit approval gate.
- recommended_model: Opus5.5（高）

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
