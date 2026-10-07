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
- Existing G1-G4 tasks are preserved. G5 priority is **conflict-based**, not a project-wide freeze: non-conflicting implementation/test/commit/push/PR/merge and non-conflicting production work may continue.
- If a production boundary overlaps G5 (same DB migration/table/RPC/function, Auth/RLS/permission, Edge Function, secret/settings/Cron/workflow/API boundary, or a shared baseline/fingerprint), G5 has priority and the conflicting operation waits.
- Same-Supabase-DB migration/DDL write sections are serialized only for the actual write/read-back window; waiting/review/user-input time must not keep a global lock active.
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
- status: done
- task_id: postona-pr106-function-contract-final-rereview-20261008
- start_code: H1
- finish_code: C1
- next_owner: none
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final C1 accepts CHANGES REQUIRED on PR #106 head 4b6dc57966e0d55b2e901a7707446c35b25a1f00. R2 exact provider-guard body is closed and unsafe EXECUTE paths are closed. Remaining blocker is a literal ACL exactness gap: empty owner ACL is accepted although canonical contract requires one owner EXECUTE entry; plus one migration-reservation file merge conflict. H1 closed/free; bounded corrective returned to G4.
- recommended_model: Sol（高）
## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-pr110-b1-b4-rereview-20261008
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: C2 accepted CHANGES REQUIRED. B4 is closed; residual B1-R1/B2-R1/B3-R1 were returned to G2. H2 free pending corrected-head rereview.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: claude
- status: ready
- task_id: kabumori-portfolio-asset-card-background-polish-20261008
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Source-only portfolio asset-summary polish. Use the user-approved transparent 1600×700 botanical background, keep the sparkline based only on real saved close market_value history, place decoration behind content at restrained opacity, and make sparkline color trend-aware for up/down/flat. 375/402 Simulator screenshots required. No portfolio data/search/watch/navigation/backend/Auth/DB/EAS changes.
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
- allocation: C2 corrective on existing PR #110 only. Fix only residual B1-R1 partial multi-unit objective Fact quote coverage, B2-R1 incomplete/repeated-emoji fact binding, and B3-R1 no-comma clause hedge laundering. B4 is accepted closed. Preserve all other accepted behavior. No merge/deploy/production mutation.
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: ai-lab-premium-length-policy-unlimited-20261007
- start_code: G3
- finish_code: K3
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: PR #109 source merged and production rollout APPLIED_PASS. DB capacity migration applied and read back; x-test-post v139 ACTIVE / verify_jwt=false with only three intended AI Lab runtime files changed. Manual scheduler/X/OpenAI verification calls=0. 2026-10-08 ten AI Lab rows are pending; first natural slot 07:51 JST. Natural scheduled-post observation remains pending, but G3 implementation/rollout slot is closed/free.
- recommended_model: Sonnet5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-multisocial-phase2a2-security-corrective-20261007
- start_code: G4
- finish_code: K4
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: C1 returned one final bounded corrective on existing PR #106 only: positively require exact owner EXECUTE ACL for the two existing trigger functions (empty owner ACL must fail atomically), and mechanically integrate fresh main to resolve the migration_source_invariants reservation conflict while preserving both POSTONA 20261007150000 and AI Lab 20261007173000 reservations. Preserve all accepted B1-B6/C1-R2 logic. No production/apply/deploy/provider operations.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-v1-phase2-real-account-smoke-20261007
- start_code: G5
- finish_code: K5
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: Final K5 PASS / READY_FOR_EAS. One approved production-authenticated smoke with an existing active Kabumori account passed: two logins, one real token refresh, two sign-outs, active/started:false service-start responses, and pre/post account/entitlement/profile/lifecycle fingerprints unchanged. Source changes 0; EAS/deploy 0. G5 window CLOSED and slot free. Future production concurrency follows conflict-based boundaries; G5 does not globally freeze unrelated slots.
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
