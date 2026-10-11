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
- status: ready
- task_id: postona-h1-threads-oauth-edge-offline-implementation-20261011
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: codex
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: User 2026-10-11 explicitly requested Codex implementation for legitimate Threads OAuth offline Edge candidate after Claude safety interruption. TEMPORARY IMPLEMENTATION (臨時実装) exception to normal Codex review routing, NOT a request to circumvent safety safeguards. H1 owns new isolated mock-only source candidate on fresh PR124 head, new Draft stacked PR only if safe. No production/providercalls, login, real token, migration, OAuth hardening, merge/deploy. Former H1 defensive investigation C1 is completed; entire previous H1 TASK and Report protected. Return C1 to POSTONA G4 chat.
- recommended_model: Sol（高）
## Codex H2
- owner: codex
- slot: codex-2
- status: review_required
- task_id: common-account-pr130-e11-r1-r5-narrow-security-rereview-20261011
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: chatgpt
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: H2 previously completed G2 PR110 narrow C2 review, TASK/report preserved. Current H2 only one focused independent review of G5 Draft stacked PR130 exact 5943fad5f724191f6ae77f3baf826a4c7698d542 vs PR122 exact f17a47e36632fff4a1f4cfb0b860df200e1c99e1 to verify prior E11 R1 P1 and R2–R5 P2 fixes. NO production/disposable Supabase, Auth DELETE, photo app pause, project creation, code edits, PR merge, schema/Edge deploy or provider secrets. PASS means offline runbook candidate only, not E11 user approval or real platform proof. Return C2 to G5 chat.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- status: ready
- task_id: kabumori-stock-detail-v1-readonly-navigation-20261011
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: New G1 銘柄詳細画面 V1 source-only UI feature. Build root Stack stock-detail view from genuine saved close report and existing tracked-stock user-scoped reads (NOT live quotes); stock-row/featured-card taps open detail with back to original portfolio/watchlist, explicit separate edit button opens existing editor; registered search rows open detail, unregistered search still opens existing registration editor. Five bottom NativeTabs absolutely frozen; AuthGate/G5, G2/new report generation, news collection, migration/Edge/production/EAS untouched. User 2026-10-11: old reporting missing 10/7–10/9 is intentional cutover backlog, new method already generated those closes — DO NOT investigate or fix old close; verify app saved report feed only after new method cutover. Fresh origin/main and isolated G1 worktree; one source-only PR no self-merge, return K1 for review.
- recommended_model: Sonnet5（高）
## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-market-report-fact-interpretation-v2-20261011
- start_code: G2
- finish_code: K2
- next_owner: chatgpt
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: Fact V2（事実は厳格に、事実に基づく分析・見通しは通す）を、PR #110 の上に積んだ Draft PR #132（head bd424616a135e7bf71592c2ac41acb3e03f8568d、base 319a442e は変更なし）として作成。生成と Fact の指示の方針変更と、監査で再現した誤検知3件の修正。事実の誤りの判定の厳しさは変更なし。全テスト成功、本番操作・デプロイ・マージ 0。Report は .agent/tasks/CLAUDE_TASK.md の先頭の節。K2 の判断待ち。
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
- status: idle
- task_id: none
- start_code: G4
- finish_code: K4
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: User 2026-10-11 moved Threads OAuth Edge offline implementation to H1. Original G4 `postona-threads-oauth-edge-offline-candidate-20261011` not completed; full TASK text preserved at .agent/archive/CLAUDE_TASK_4_threads_edge_pre_codex_20261011.md. G4 freed for independently assigned future POSTONA task; do not start unassigned G4 or use G4 worktree for H1. Previously deferred existing X OAuth security concern remains Issue #131 and archive, NOT a slot blocker.
- recommended_model: none (future G4 task must select)
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
