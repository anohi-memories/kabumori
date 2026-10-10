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
- task_id: postona-pr106-f1-acl-final-rereview-20261009
- start_code: H1
- finish_code: C1
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: C1
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: C1 PASS; PR106 exact c0b6c03cb909d91f72b58424d64c6dfae1b8f14f merged as 68aaf3e547c09d54bd9682d357a12743d0ded7f2. Source only; migration unapplied. H1 closed; next task requires fresh allocation.
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
- next_owner: none
- status: done
- task_id: kabumori-portfolio-asset-card-background-polish-20261008
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS. PR #113 exact reviewed head bc54e91c7b72186fa03c35b7d3be157453651cb6 squash-merged as 28d9c61e6dc52fe71ee8bbcd3521b24ad7addc3e. Approved 1600x700 transparent botanical art at 0.45 opacity is behind the real asset-history sparkline, which is now up green/down red/flat grey, with thin segments and one endpoint. 375/402 Simulator review PASS, 433/433 app tests reported PASS; backend/DB/Auth/Edge/EAS/production mutation 0. G1 done/free.
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
- task_id: postona-ai-consult-pr114-session-epoch-corrective-20261009
- start_code: G3
- finish_code: K3
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: PR #114 accepted without additional review per user priority. Exact reviewed head 98d3cb727a967c2a921da6afee3faafa85cb9de6 squash-merged as 952db5b18e2a4464fb076ccfc32af31063a6bb7e. Workspace/epoch ABA guard, CAS confirmation, savedRef same-session isolation and app 234/234 + related Edge 90/90 accepted. G3 source slot closed/free. Read-only production S0 on 2026-10-10: content-settings table/functions absent, consult Edge absent, dry-run preview v16 outdated; live DB/Edge/memory feature NOT active. Separate user approval required before DB/Edge/real AI smoke/EAS; G5 priority for overlapping production boundaries. No real OpenAI/X, production mutation, deploy or EAS done.
- recommended_model: Sonnet5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-threads-phase2b-source-preparation-20261010
- start_code: G4
- finish_code: K4
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: PR106 Phase2a2 source merged as 68aaf3e; production migration not applied. Phase2b source-only, verify latest official Threads OAuth and isolate G5 Auth/OAuth/Vault boundaries. No live connect, merge or deploy.
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
