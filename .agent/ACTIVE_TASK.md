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
- task_id: x-social-mobile-pr76-publish-toggle-review-20261002
- start_code: H1
- finish_code: C1
- next_owner: codex
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Focused security review of PR #76 exact head a59a89e9c585fb6e780e1af2ecc898c830f5524e. Verify Auth/tenant isolation, owner/admin policy, strict ON prerequisites, fail-safe OFF, CAS/races, brand active/live TOCTOU vs runtime publish guard, exact publish_enabled-only mutation, JWT/config and safe client behavior. No merge/deploy/production toggle/X operation. Recommended Sol（高）.

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-social-mobile-pr78-ai-consult-review-20261002
- start_code: H2
- finish_code: C2
- next_owner: codex
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Focused review of PR #78 exact head 6e9f78a31bae9b65599732a9b416dcb50f2bfbc7. Verify JWT/tenant isolation, forged-history/prompt injection, strict structured output, no implicit persistence, updated_at CAS against production schema/triggers, history-learning no-X boundary, cost/rate-limit rollout risk and verify_jwt config. No merge/deploy/production write/live AI/X operation. Recommended Sol（高）.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-home-report-hero-8-state-assets-20261001
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS. Base 8-state Hero PR #72 was already merged; follow-up PR #74 (global 6pt character/CTA lift + CTA height/inset) squash-merged as 9b37c350a3b9d1a936d0e03ddc281e315aba50f2, then final 02/07 aligned assets PR #75 squash-merged as 02ba0e2d728833fb76b74237cc3c237130bcdbf1. Final asset hashes pinned; app tests reported 255/255; EAS build 0; backend/production mutation 0; no Codex review required. G1 free after fresh allocation.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-pr79-session-date-watch-relation-corrective-20261002
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: amend PR #79 before review; fix sentence-wide watch-word laundering so only genuine prior-session watch references bypass date mismatch; preserve all concrete wrong-date/session Hard blocks; no merge/deploy/gate/manual cycle; recommended Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: x-social-mobile-ai-consult-v1-20261002
- start_code: G3
- finish_code: K3
- next_owner: codex
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: K3 PASS to focused Codex review. PR #78 exact head 6e9f78a31bae9b65599732a9b416dcb50f2bfbc7 is open/mergeable; 11 files, source/tests only, no migration/deploy/production mutation/X operation. H2 review assigned before merge because this adds authenticated AI API + confirmed settings persistence. Recommended review Sol（高）.

## Claude G4
- owner: claude
- slot: claude-4
- status: review_required
- task_id: x-social-mobile-publish-toggle-v1-20261002
- start_code: G4
- finish_code: K4
- next_owner: codex
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: K4 PASS to focused Codex review. PR #76 exact head a59a89e9c585fb6e780e1af2ecc898c830f5524e is open/mergeable; CI green; main +5 commits with no overlap. Source/tests only, production mutation 0, X operations 0. H1 review assigned before merge because this is a posting-permission/security boundary. Recommended review Sol（高）.

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
