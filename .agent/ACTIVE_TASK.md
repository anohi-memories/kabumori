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
- status: idle
- task_id: none
- next_owner: none
- return_to: none
- completion_code: none
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: PR #117 source-only H1 review was deferred BEFORE execution at user request to preserve Codex 5-hour quota. Prior allocation common-ai-provider-pr117-phase1a-independent-review-20261010 is historical, NOT_RUN; no review PASS asserted. Do not invoke H1 unless a new ready task is explicitly allocated. Plan one focused review at integration/production boundary instead. G2 PR110 remains independently queued; H2 unchanged.
- recommended_model: none (no current task)

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
- status: ready
- task_id: kabumori-watchlist-highlight-hybrid-ui-20261010
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: User-approved hybrid watchlist within existing 銘柄 tab: [ポートフォリオ|ウォッチリスト] segmented switch, 0–3 evidence-based auto-highlight cards, remaining compact watch rows, no fake current data/news. CRITICAL: do not modify existing NativeTabs, their five labels/order/icons/style or tab routes; screenshot's bottom menu is not canonical. Source-only, PR without self-merge, DB/Auth/API/Edge/EAS/production 0. Independent G1 worktree and fresh main/open-PR overlap check mandatory at startup. return K1 to かぶモリアプリG1のちゃ.
- recommended_model: Sonnet5（高）
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
- status: in_progress
- task_id: postona-ai-consult-v1-production-activation-20261010
- start_code: G3
- finish_code: K3
- next_owner: claude
- return_to: POSTONA G3のちゃ（AI相談V1本番接続担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: User explicitly approved S0–S5 bounded activation on 2026-10-10; PR114 merged (952db5b); prior G3 TASK/Report archived intact in same file. Activate only reviewed settings candidate+hardening atomic single-transaction chain, immediate RLS/ACL read-back, consult and dry-run Edge JWT deployments, no-post smoke. On G5 overlapping DB write critical section STOP/serialize. G4 PR118/Threads and G5 PR112/Auth untouched. No X publish/schedule, EAS, provider switch, other migrations, PR114 rereview, or automatic added Codex review. Independent fresh G3 worktree is a mandatory startup gate.
- recommended_model: Opus5.5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: postona-threads-phase2b-source-preparation-20261010
- start_code: G4
- finish_code: K4
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: K4 PASS: PR #118 3-file standalone Threads connection contract and docs, accepted exact head 9b71757068271cce38cedda12f6d74e705ac13ca, squash merged b49306c0d7486adb9afdb9ae4e42defa33ace07f; no runtime imports, static disabled gate. No Codex rereview now (defer to security-critical live RPC/OAuth integration). G5 T13/T9/T10 coordination and Meta app verification needed before next G4 task. Production Phase2a2 migration not applied; no connect/deploy.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-pr112-h2-r1-r2-effective-boundary-corrective-20261010
- start_code: G5
- finish_code: K5
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: C2 accepted G5 PR112 source corrected exact head 54b9435b0dcc0d0e79ae6eba4340eee44508141c as independently PASS (H2). Source merge candidate only, PR OPEN/UNMERGED; separate authorization/fresh merge checks required. Whole common-account Auth deletion release gate blocked, production preflight/provider E2E and identity writer-fence missing. G5 task closed; preserve its PR/worktree before reassignment. No production/migration/Edge deploy/EAS.
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
