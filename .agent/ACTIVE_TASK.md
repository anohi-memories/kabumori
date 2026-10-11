# Active Tasks Index

このファイルは共有オーケストレーションの全15枠（Codex H1〜H5 + Claude G1〜G10）インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- `G5`〜`G10`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。idleだからという理由だけで自動使用しない。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- H1〜H5はCodexのレビュー・バグ修正・検証枠（固定プロジェクト専用にしない）。割当時は `return_to` / `completion_code` / 推薦モデルを必ず記入する。
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
- task_id: postona-h1-threads-oauth-edge-offline-implementation-20261011
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: C1 2026-10-11 accepted H1 mock-only Threads OAuth Edge candidate as PASS_OFFLINE_CANDIDATE / RELEASE_HOLD. Exact Draft PR135 e38788d6677082138f0990453c7d2f00549666d0 stacked on untouched protected Draft PR124 c30f246409a77080cbc03aef6c4cb72b5481e125, only 4 new source/test/docs files. H1-reported mocked 102/102 tests PASS; GitHub/source inspected by ChatGPT, tests not independently rerun. No actual Supabase/Meta/Threads/X/Auth/Vault calls, no production changes, RPC grant, migration, secret, deploy or merge; static Threads gate false. H1 task/report histories protected. H1 done/unreserved. Real integration still blocked by durable claim/authority transport, G5 T13/T9/T10, Meta/GoTrue/Vault proof and independent release gate. Existing X hardening Issue131 remains deferred; H2/H3-H5/G slots protected.
- recommended_model: Sol（高） (completed)
## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: kabumori-fact-v2-pr132-final-integrated-review-20261011
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: none
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: C2 COMPLETE CHANGES_REQUIRED — Fact V2 PR132 exact bd424616a135e7bf71592c2ac41acb3e03f8568d on protected PR110 319a442edcd61c07274e3409d8864234f9d77cd4; R1 same-day same-sentence negation exonerates second false affirmation, R2 TOPIX 算出値/ウエート 437円 masquerades as 1306, R3 wrong US postposed date 10/7 stripped. ALL P2 objective-fact guard regressions reproducible X+app mocked delivery; 55/55 baseline focus PASS, independent 14 probes 10 PASS 4 FAIL. Opus grounded inference ALLOW policy CONFIRMED valid; do NOT reverse. Vercel rate limit, not code failure. H2 source edits0; no prod/merge/deploy/paid API. H2 Report saved with historical suffix intact, H2 current TASK done/none, released but not pre-reserved. G2 one bounded correction registered, H2 prior G5 C2 history preserved.
- recommended_model: Sol（高） (completed)
## Codex H3
- owner: codex
- slot: codex-3
- status: idle
- task_id: none
- start_code: H3
- finish_code: C3
- completion_code: C3
- next_owner: none
- return_to: none（未割当）
- source: .agent/tasks/CODEX_TASK_3.md
- report: .agent/CODEX_REPORT_3.md
- allocation: 未割当（2026-10-11追加）。固定プロジェクト専用にしないCodex枠。割当時に return_to / completion_code C3 / 推薦モデルを必ず記入する。
- recommended_model: none
## Codex H4
- owner: codex
- slot: codex-4
- status: idle
- task_id: none
- start_code: H4
- finish_code: C4
- completion_code: C4
- next_owner: none
- return_to: none（未割当）
- source: .agent/tasks/CODEX_TASK_4.md
- report: .agent/CODEX_REPORT_4.md
- allocation: 未割当（2026-10-11追加）。固定プロジェクト専用にしないCodex枠。割当時に return_to / completion_code C4 / 推薦モデルを必ず記入する。
- recommended_model: none
## Codex H5
- owner: codex
- slot: codex-5
- status: ready
- task_id: postona-threads-oauth-runtime-bridge-h5-20261011
- start_code: H5
- finish_code: C5
- completion_code: C5
- next_owner: codex
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK_5.md
- report: .agent/CODEX_REPORT_5.md
- allocation: User 2026-10-11 authorized using H5 temporarily to finish POSTONA Threads connection and first text-post pilot. H5 explicitly assigned 臨時実装 Threads OAuth trusted runtime/verified principal/callback/durable claim/owner-only RPC transport source and mock PG tests, stacked on protected Draft PR135/PR124 if safe. This is NOT a model-safety bypass. G4 independently owns Threads publish API/manual UI (separate paths); G3 schedule, G5 shared Auth/T13/deletion and all other slots protected. No real Meta/Supabase/Auth calls, secrets, DB apply, production writes, merge, deploy or real posts until separate tester pilot authorization. H5 source implementation only; no permanent reservation after C5.
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
- allocation: K1 first source review of G1 PR #136 head e2dfdab5c7219aa2ff31c50c51f0125f816c16a7 found ONE P2 valuation freshness bug: stock-detail-view.ts registrationMatchesSnapshot compares ONLY quantity/average_price, but edits to cash/margin or long/short with unchanged numeric values still show OLD saved report valuation/P&L beside NEW position labels. G1 narrowly correct current helper to compare quantity/avg/position_type/side/tracking_type with same saved row, add fail-before/pass-after behavioral regressions, keep existing PR #136 and all other code untouched. No NativeTabs changes, no other slot, no source merge, production, DB/Edge/EAS; Vercel rate-limit failure not a source regression. Return K1 to かぶモリアプリG1のちゃ. Review source then decide user-approved merge.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-fact-v2-pr132-three-objective-guards-correction-20261011
- start_code: G2
- finish_code: K2
- next_owner: chatgpt
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: PR132 の C2 R1〜R3（例外が広すぎて通っていた客観的な誤り4文）を修正し、新しい head 68d45dde1be34715267b5066fa3b3686d756b79e を push 済み（Draft のまま、PR110 は変更なし）。4文はローカル判定・単位の除外・X とアプリへの配信のすべてで止まり、通すべき3文は届く。全テスト成功、本番操作・デプロイ・マージ 0。Report は .agent/tasks/CLAUDE_TASK.md の先頭の節。K2 の判断待ち。
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: postona-unified-ai-manual-schedule-planner-v1-20261011
- start_code: G3
- finish_code: K3
- next_owner: claude
- return_to: POSTONA G3のちゃ（AI相談・X投稿予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 reviewed Draft PR138 exact b244400ac710bdb6cd576631aacdb0b219bf73fd and G3 Report. Core source-only manual exact/random/interval and AI planner + preview accepted as PASS_CANDIDATE; source inspection found 3 P2 correctness gaps requiring SAME-PR narrow follow-up before K3 final: R1 reroll regenerates edited/reordered/cancelled drafts and resurrects cancelled posts; R2 AI frequency/consent cached from prior brand while new brand settings read pending/failed; R3 live brand-bound posts accountId unknown falsely rewritten as selected active X or Threads account, contaminating attribution/conflicts. Modify only isolated G3 schedule planner/UI/read-only types/tests, preserve source-only/no cloud reservation, protect G5/H1/G4/PR127 and all other tasks, no production writes, migration, Edge, X or deploy. Re-run local tests and return K3. No additional Codex now; Sol（高） integration review before eventual backend release.
- recommended_model: Sonnet5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: ready
- task_id: postona-threads-manual-text-publish-v1-20261011
- start_code: G4
- finish_code: K4
- next_owner: claude
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: User 2026-10-11 set POSTONA next milestone actual Threads single-account text publishing. G4 owns provider two-step text post adapter, safe single manual publication backend, and user-facing one-shot compose/consent/confirmed-status UI, source and mocks on independent fresh main branch. H5 parallel owns OAuth runtime/claim/owner boundary, no same files. G3 owns scheduler, G5 Auth/T13/T10. Keep release flags OFF until exact staged integration, focused Sol（高） review and explicit Meta tester/pilot permission. No live provider call, secrets, DB apply, production change, PR merge/deploy by this TASK; do not modify existing X posting/OAuth or G3 schedule. Draft scoped PR then K4.
- recommended_model: Opus5.5（高）
## Claude G5
- owner: claude
- slot: claude-5
- status: review_required
- task_id: common-account-phase3g-free-auth-provider-test-readiness-20261011
- start_code: G5
- finish_code: K5
- next_owner: chatgpt
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: G5 Phase3f K5 accepted source-only proof harness corrections Draft PR134 exact 1d4de2c73c42221ad4b2f9b1f231c271aa084907; Phase3f task completed and full history preserved. New G5 Phase3g OFFLINE public-docs/source feasibility of completely FREE OAuth/OIDC provider/test user support for managed E1-E12 before family photo downtime. Provide one bounded practical E1-E12 provider prerequisite matrix, actual Free tier provider/hook/rate eligibility, concrete consent-free provider test setup feasibility, user steps and GO/NO_GO; no repetitive R1-R5 audit. New independent worktree, one new doc Draft PR only; NO real Supabase/provider calls, signup, credentials, project/photo pause, Auth deletion, migration, app changes, paid tier, merge/deploy. Photo app PREPAUSE_BLOCKED; real E1-E12 NOT_RUN; managed_auth_delete BLOCKED. Return K5.
- recommended_model: Opus5.5（中）
## Claude G6
- owner: claude
- slot: claude-6
- status: idle
- task_id: none
- start_code: G6
- finish_code: K6
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report
- allocation: 未割当（2026-10-11追加）。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・自動投入しない。
- recommended_model: none
## Claude G7
- owner: claude
- slot: claude-7
- status: idle
- task_id: none
- start_code: G7
- finish_code: K7
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_7.md
- report: .agent/tasks/CLAUDE_TASK_7.md#report
- allocation: 未割当（2026-10-11追加）。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・自動投入しない。
- recommended_model: none
## Claude G8
- owner: claude
- slot: claude-8
- status: idle
- task_id: none
- start_code: G8
- finish_code: K8
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: 未割当（2026-10-11追加）。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・自動投入しない。
- recommended_model: none
## Claude G9
- owner: claude
- slot: claude-9
- status: idle
- task_id: none
- start_code: G9
- finish_code: K9
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_9.md
- report: .agent/tasks/CLAUDE_TASK_9.md#report
- allocation: 未割当（2026-10-11追加）。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・自動投入しない。
- recommended_model: none
## Claude G10
- owner: claude
- slot: claude-10
- status: idle
- task_id: none
- start_code: G10
- finish_code: K10
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_10.md
- report: .agent/tasks/CLAUDE_TASK_10.md#report
- allocation: 未割当（2026-10-11追加）。用途を固定しない予備枠。ユーザーまたはChatGPTの明示割当時だけ使用し、idleだけで作業開始・自動投入しない。
- recommended_model: none

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1`〜`H5`: Codex H1〜H5開始。ready / in_progressのTASKのみ。
- `G1`〜`G10`: Claude G1〜G10開始。ready / in_progressのTASKのみ。
- `C1`〜`C5`: ChatGPTが対応Codex枠だけ完了確認（H1→C1、H2→C2、H3→C3、H4→C4、H5→C5）。単独 `C` は使用しない。
- `K1`〜`K10`: ChatGPTが対応Claude枠だけ完了確認（G1→K1 … G10→K10）。
- 単独 `G` / `K`: G1〜G10（G5〜G10は明示割当済みの場合のみ）から、対象が1枠だけと明白な場合のみ使用。
- `F`: H1〜H5 + G1〜G10の全15枠の状態・競合・実際の空き状況を確認する統括コード。完了コードではなく、別チャット担当のTASKを完了・再割当しない。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
