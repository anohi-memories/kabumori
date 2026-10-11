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
- status: done
- task_id: postona-g4-x-oauth-containment-defensive-assessment-20261010
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: C1 accepted H1's published DEFENSIVE_ASSESSMENT_COMPLETE source-only evaluation and benign mock-PG 42501 deny proof; no exploitation/real production proof. Narrow legacy X OAuth completion restriction is conditional and would block new/reconnections; posting/refresh structurally separate but live continuity unknown. Report/history retained, H1 done and unreserved. No live preflight or ACL change authorized. G4 blocked awaiting ChatGPT/user next decision; H2/G5 untouched.
- recommended_model: Sol（高） (completed)
## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: common-account-pr130-e11-r1-r5-narrow-security-rereview-20261011
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: codex
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: H2 previously completed G2 PR110 narrow C2 review, TASK/report preserved. Current H2 only one focused independent review of G5 Draft stacked PR130 exact 5943fad5f724191f6ae77f3baf826a4c7698d542 vs PR122 exact f17a47e36632fff4a1f4cfb0b860df200e1c99e1 to verify prior E11 R1 P1 and R2–R5 P2 fixes. NO production/disposable Supabase, Auth DELETE, photo app pause, project creation, code edits, PR merge, schema/Edge deploy or provider secrets. PASS means offline runbook candidate only, not E11 user approval or real platform proof. Return C2 to G5 chat.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- status: done
- task_id: kabumori-watchlist-simulator-user-login-realdata-qa-20261011
- start_code: G1
- finish_code: K1
- next_owner: none
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: K1 accepted genuine-data Simulator 402pt check PASS_REAL_DATA_OBSERVED / PARTIAL_COVERAGE. User personally signed in; source from merged PR120 ran in own Metro 8082. Real saved watch rows 18/18 visible exactly once, correct saved-close/basis/two-decimal change, search/editor/read-only refresh and portfolio-watch segment + original five NativeTabs PASS. No ≥5% featured/news featured/missing-price real data was present; those are NOT_OBSERVED, 375pt and physical iPhone NOT_RUN. G1 report notes latest saved close 10/6 while 10/7–10/9 had morning reports only — independent G2/news-delivery follow-up required, cause not proven and G2 active task NOT overwritten. No app code changes, EAS/deploy=0, user watchlist edits=0, credentials not logged; standard login idempotent enrollment RPC was not independently inspected for server effects. G1 task closed/slot free only after fresh worktree and task check for next assignment.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-market-report-fact-interpretation-v2-20261011
- start_code: G2
- finish_code: K2
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 accepted previous delivery-first PR110 source candidate exact head 319a442edcd61c07274e3409d8864234f9d77cd4, G2-reported 1345/1345 local regression tests PASS; true H2 twenty fail-open cases corrected, native noun-subject 5 preserved. PRIOR PR110 OPEN/UNMERGED/RELEASE_HOLD, no merge/deploy. NEW TASK Fact V2: classify objective factual errors as Hard; allow Opus independent economic analysis and reasoned forecasts grounded in verified upstream material without requiring verbatim market causation in news; unverified observed-historical cause should be careful inference/advisory/rewrite, not fabricated certainty. Avoid systematic analysis deletion / repetitive regex word reviews; implement only G2-owned source and offline tests in NEW safe separate stacked Draft PR based on exact protected PR110 head, no edits to original branch or other slots; no paid/provider/production. Return K2; one integrated security/factual safety review at most, not broad recurring review.
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: postona-x-autopost-production-readiness-20261010
- start_code: G3
- finish_code: K3
- next_owner: none
- return_to: POSTONA G3のちゃ（AI相談V1本番接続担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 accepted G3 Stage3B X autopost rollout readiness as PASS_PREPARATION_ONLY / PREPARED_BLOCKED_ON_G5. Draft PR127 exact 4b0278228e726b65d782e9b231eb6fe84d9173ad contains only 5 new docs/offline-test and read-only inventory files; no source/SQL migrations/Edge changed or PR merged. G3-reported local PG O1/A1-A3/R1-R4, six existing pilot parts, ACL adverse, Deno 808/808; live read-only Supabase independently confirms 160000/160100/160200 not applied, publish authority/reader/check absent, AI consultation table and Stage3A refresh table present; x-test-post v141 unchanged. NO live write/deploy/X post/enable/EAS. Blocking G5 active x_autopost entitlement (claim/check/set), service deletion FK cleanup/T13; G4 real X OAuth account identity/T9 and current preclaim containment; G3 future booking generation and four-file deployed-bundle ownership diff. No Codex rereview of offline candidate; one integrated Sol（高） security review before actual production publish authorization. PR127 OPEN DRAFT UNMERGED, no new G3 task; next work driven by G5/G4 owner handoff with separate approval gates.
- recommended_model: Opus5.5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-threads-oauth-edge-offline-candidate-20261011
- start_code: G4
- finish_code: K4
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: User 2026-10-11 directed immediate reuse of G4 for ordinary development. Threads OAuth Edge handler/adapter **unwired offline candidate** assigned, building on Draft PR124 exact head c30f246409a77080cbc03aef6c4cb72b5481e125 in separate G4 worktree and new stacked Draft PR if safe. Source only; static Threads gate false; no merge/deploy/production writes/provider calls or modifications to G3/G5/X OAuth. Previous G4 existing-X OAuth TASK was NOT completed, explicitly deferred and fully archived to .agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md; unresolved issue tracked in GitHub Issue #131 OUTSIDE G4. PR126 remains Draft/held. The archived issue does not block G4; G3/G5/H tasks preserved.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-phase3e-e11-offline-review-r1-r5-corrective-20261011
- start_code: G5
- finish_code: K5
- next_owner: none
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepted G5 Phase3e OFFLINE_ONLY R1 P1 / R2–R5 P2 corrective as PASS_OFFLINE_CORRECTIVE_CANDIDATE / TARGETED_SECURITY_REREVIEW_REQUIRED. Exact Draft stacked PR130 head 5943fad5f724191f6ae77f3baf826a4c7698d542 on original Draft PR122 head f17a47e36632fff4a1f4cfb0b860df200e1c99e1; 22 offline-only delta files, no migration/Auth/Edge/runtime modifications or merge. Claude-reported Deno56/56, mutations58/58, fake-PG local proof PASS, remote Supabase tests NOT_RUN. G5 source completed done/next_owner none. Real E11 and Option D not authorized; family photo app must NOT be paused; PREPAUSE_BLOCKED; no project creation, no paid tier. H2 belongs to G2 PR110 review and cannot be overwritten; one separate narrow Sol（高） review in confirmed free H slot before further approval.
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
