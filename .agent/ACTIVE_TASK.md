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
- task_id: common-ai-provider-pr117-pr119-integrated-security-review-20261010
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: codex
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: One quota-conscious consolidated independent security review of PR117 exact 2ddae0dcb3f1e062ce7d853207bcc9dfbe0fb226 (27 source-only files) + stacked PR119 exact c7d0f6e099cddd8a21c870cc38f5cf0030d773b2 (18 files incl seven SECURITY DEFINER RPCs/migration). Focus actual SQL effective ACL, atomic budget reservations, crash/recovery, keys, fail-closed. No real API/production/merge/deploy. Earlier isolated PR117 review NOT_RUN as history. H2 untouched; G2 PR110 pending separately.
- recommended_model: Sol（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: common-account-pr112-r1l-r2-apple-boundary-exact-head-rereview-20261010
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- return_to: 共通アカウントG5のちゃ
- completion_code: C2
- allocation: C2 accepted independent R1L/R2 exact-head source-only PASS for PR112 54b9435b0dcc0d0e79ae6eba4340eee44508141c. Old RPC bypass closed/new 75 denied SQL calls, Apple uncertain HTTP response safe/new 21 variants; 555/555 tests, PG1/2/3a, SQL48/48 TS45/45, lint/check PASS. Review CLOSED; H2 not reserved for G2/G3; new task requires fresh allocation. PR merge, production apply/deploy/EAS HOLD; whole deletion schema gate BLOCKED.
- recommended_model: Sol（極高）

## Claude G1
- owner: claude
- slot: claude-1
- status: review_required
- task_id: kabumori-watchlist-highlight-hybrid-ui-20261010
- start_code: G1
- finish_code: K1
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: FINAL K1 source/UI PASS at exact PR #120 head 7bf19faf9cf7e7c67fbab987e4f57188518e77d0; one-display-defect correction independently inspected (2 featured + 5 rest => badge 5, all 3 featured => no empty remainder), 457/457 app tests reported PASS, 375/402pt screenshots viewed, 5 NativeTabs untouched. GitHub final mergeability read returned null/unknown despite zero file overlap with fresh main: PR remains OPEN, merge HOLD for a refreshed affirmative clean merge gate and potential auto-Web-deploy side-effect check. G1 no further implementation required; next_owner chatgpt for merge gate; DO NOT reassign overlapping G1 UI files. No Codex extra review; no EAS/DB/Edge/production changes.
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
- allocation: Latest G2 report PR #110 head cb3d77d50e848d043f5427df363769b75d3c7764. K2 PASS_CANDIDATE: original seven B1-R1/B2-R1/B3-R1 failures reportedly closed; local Sol/Claude comparison completed separately. Await truly free H1/H2 for final exact-head review; never overwrite H1 POSTONA or H2 G5 TASK. Merge/deploy HOLD.
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: postona-ai-consult-v1-production-activation-20261010
- start_code: G3
- finish_code: K3
- next_owner: none
- return_to: POSTONA G3のちゃ（AI相談V1本番接続担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 PASS on 2026-10-10 after G3 reported S0–S5 production activation PASS and independent read-only Supabase verification of both applied migration versions, owner+RLS+three authenticated owner policies, least-privilege grants, five functions and source constraints, and consulted Edge v1 / preview Edge v17 ACTIVE verify_jwt=true; one confirmed settings row. G3 real AI smoke 19/19 PASS (reported, not re-run by ChatGPT), 3 paid calls, X posts/scheduled changes/publish permissions 0 per G3 before/after evidence. Existing X automation unaffected per report. PR123 nine-file operational execution bundle remains OPEN/UNMERGED, no main-source merge requested. Production write window CLOSED. No added Codex review; no new G3 task assigned. G4/G5 ownership unchanged.
- recommended_model: Opus5.5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-threads-phase2b-workspace-oauth-candidate-20261010
- start_code: G4
- finish_code: K4
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: T9/T10/T13 shared design agreed at docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md. G4 prepares independently isolated, disabled source-only provider-neutral personal workspace and Threads begin/complete OAuth candidates/tests. T13 real guard remains G5-owned/in-progress; T10 lifecycle remains G5-owned. No G3/G5 changes, live Threads, migration apply, production/provider calls, merge or deploy. Protect static gate=false and X behavior. Return K4 to explicit G4 chat.
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
