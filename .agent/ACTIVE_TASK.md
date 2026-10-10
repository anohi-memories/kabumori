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
- next shared milestone: Phase 3a source implementation -> focused security review -> production preflight/apply gates -> final EAS/TestFlight after the common-account feature set is complete.

## Deployment policy

- X自動投稿・Web管理画面の開発中/PR/テスト用PreviewはNetlifyを優先する。
- レビュー完了後の最終production deployのみVercelを使う。
- かぶモリExpo/native本体はVercelを通常開発・merge gateに使用しない。
- Expo native/iOS実機・TestFlightは従来どおり別工程。
- かぶモリ将来WebはPreview/ProductionともNetlifyを使用する。

## Codex H1
- owner: codex
- slot: codex-1
- status: review_required
- task_id: common-ai-provider-pr119-c1-r1-r2-narrow-rereview-20261010
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: chatgpt
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Narrow one-time PR119 exact-head 8ef3843f51e771088dfe58e2e5a262db0b62644a review for previously reproduced R1 P1 duplicate HTTP dispatch and R2 P2 SET ROLE privilege-path only; prior full Phase1a+1b H1 review complete. Verify with local disposable SQL and fake-provider focused reproductions, no repeat comprehensive review; PR117 exact head 2ddae0dcb3f1e062ce7d853207bcc9dfbe0fb226 protected. No production, actual provider calls, Secrets, merge or deploy. Return C1 here. H2 and G1-G5 untouched.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-market-report-pr110-b1r1-b2r1-b3r1-final-review-20261010
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: C2 reviewed exact PR110 head cb3d77d50e848d043f5427df363769b75d3c7764: CHANGES_REQUIRED, seven former B1-R1/B2-R1/B3-R1 residuals CLOSED; one P2 normal subject-particle が false-positive needs narrow G2 correction. H2 closed. 1337/1337 baseline PASS, 10-control additional test 8 PASS 2 FAIL (one issue). Source edits 0; merge/deploy HOLD. G2 corrective TASK publication not yet confirmed; do not start until canonical G2 TASK status is ready.
- recommended_model: Sol（高） (completed)

## Claude G1
- owner: claude
- slot: claude-1
- status: done
- task_id: kabumori-watchlist-real-data-simulator-qa-20261010
- start_code: G1
- finish_code: K1
- next_owner: none
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: K1 final PASS_SAFE_STOP for Simulator PRE-FLIGHT ONLY. Claude reported Xcode/iOS Simulator and dev-client present but no authorized signed-in Supabase session; genuine data, watch registrations, saved report basis, highlighted cards and real navigation tests therefore BLOCKED_AUTH / NOT_OBSERVED. Earlier PR120 fixture tests 457/457 reported PASS are NOT equivalent to real account tests. No source/UI changes, EAS=0, DB/user writes=0, deployment=0, credentials exposure=0; other slots and Metro 8081 untouched. No new G1 TASK assigned: wait for user-assisted sign-in on a dedicated Simulator before separate real-data QA continuation. G1 task complete and free, but real-data QA gate NOT PASS.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-market-report-delivery-first-guard-calibration-20261007
- start_code: G2
- finish_code: K2
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: PR110 の C2 差し戻し（P2 1件：名詞＋主語の「が」）を修正し、新しい head 2c876b0bafee31844b9854c4a7d34ba69660d4cf を push 済み。Report は .agent/tasks/CLAUDE_TASK.md の先頭の節。全テスト成功、本番操作・デプロイ 0。K2 の判断待ち。マージ・デプロイは保留。
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: postona-x-autopost-production-readiness-20261010
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- return_to: POSTONA G3のちゃ（AI相談V1本番接続担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: After accepted G3 AI-consult V1 K3 PASS, assign separate source-only Stage3B X autopost production readiness. Live DB lacks PR41's 20261006160000/160100/160200 migrations. G3 offline prerequisite/ACL/RLS/tenant test, publish-consent policy, G5 x_autopost entitlement gap and G4 X OAuth/T9 dependency matrix, migration rollout plan only. NEW independent G3 worktree. No production writes, actual X posts, publish enable, scheduler, OAuth/Edge deploy, EAS, PR merge or touching G4/G5/PR123. G5 draft T13/Auth/managed deletion remain blocked and require own separate approval. K3 after local proof; then decide G5 handoff/security review and independently approved real X pilot.
- recommended_model: Opus5.5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-x-oauth-preclaim-containment-readiness-20261010
- start_code: G4
- finish_code: K4
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: K4 accepted previous X OAuth v2 source-only PR126 exact 65f49f98dab39b974e6e4b450f376a37f99ef1ac PASS_CANDIDATE, Draft OPEN/UNMERGED, mergeable=false, no production. G4 local PG reproduced possible authenticated direct-RPC X ID preclaim and denial of legitimate X connection; no verified live exploit and not proven token theft/posting. New G4 task is isolated source-only early existing-X containment/permission/read-only production-preflight DESIGN; assess outage/rollout/rollback, fake-DB proof, no G5 PR121/T9 PR124 dependency or production reads/writes/changes, no PR126 modifications. Security review and user approval required before any live grant, RPC, Edge or connection pause. G3/G5/H unchanged. Return K4 to named G4 chat.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-phase3c-disposable-supabase-proof-readiness-20261010
- start_code: G5
- finish_code: K5
- next_owner: none
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepted G5 Phase3c OFFLINE ONLY readiness of disposable managed-Supabase E1–E12 proof runbook and deny-by-default harness. Draft PR122 exact f17a47e36632fff4a1f4cfb0b860df200e1c99e1 OPEN/UNMERGED, 21 G5-only files, no main/PR overlap. G5 reported 35/35 Deno, 31/31 mutations, local PG fingerprint and existing Phase1/2/3a PASS; ChatGPT checked GitHub/source but did not run tests. Live Supabase project creation/use, real Auth/Storage/Apple/X/Meta tests, destructive user operations, Option-D architecture, production deploy/migration/feature activation NOT APPROVED. Whole-account deletion gate remains blocked; PR121 remains Draft. G5 slot done, next_owner none pending user decision on new disposable project, preserve other slots.
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
