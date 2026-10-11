# Active Tasks Index

このファイルは共有オーケストレーションの全15枠（Codex H1〜H5 + Claude G1〜G10）インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- `G5`〜`G10`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。idleだからという理由だけで自動使用しない。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- `G7` はMIC専用チャットの「Market Intelligence Core」作業担当（ユーザー明示指定2026-10-11）。MICの作業を他G枠へ勝手に割り当てない。各TASKはG7の真の空き・競合確認後のみ割り当てる。
- `G8` はこのチャットの「ニュース改善 A」専用、`G9` はこのチャットの「API最適化 B」専用（ユーザー明示指定2026-10-11）。ほかのG枠や別案件への自動引継ぎ・再割当禁止。各新TASKは対象枠の真の空き・競合を確認してから割り当てる。
- H1〜H4はCodexのレビュー・バグ修正・検証枠（固定プロジェクト専用にしない）。H5はCodex臨時実装専用で原則空けておき、レビュー・検証には使わない。割当時は `return_to` / `completion_code` / 推薦モデルを必ず記入する。
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
- status: done
- task_id: postona-threads-oauth-runtime-bridge-h5-20261011
- start_code: H5
- finish_code: C5
- completion_code: C5
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK_5.md
- report: .agent/CODEX_REPORT_5.md
- allocation: C5 2026-10-11 CHATGPT ACCEPTED PASS_SOURCE_CANDIDATE / RELEASE_HOLD. Exact Draft PR139 head b4fa672f97592e87682671454e868a92098cbd56, OPEN/UNMERGED, one commit 13 entirely new H5 source/test/docs paths stacked on original Draft PR135 exact e38788d6677082138f0990453c7d2f00549666d0. H5 PR reported Deno32 focus/97 combined PASS and fake-PG17 concurrency/ACL/parent integration PASS; tests not independently rerun. Auth+owner SQL state claim candidate implemented but effective production DB owner transport/session privileges/Meta/GoTrue/Vault/T13/T9/T10/mobile callback not proven; new Edge returns 503, static gate false. This C5 was independently recorded by ChatGPT from verified PR/source after Codex Report had NOT been synced; .agent/CODEX_REPORT_5.md explicitly distinguishes assessment authorship. No merge/deploy/real connection/post, no H5 park. H5 now done/unreserved; H1-H4/G1-G10 unaffected, future focused Sol（高） security review required only at integrated release gate.
- recommended_model: Sol（高） (source candidate completed; C5)
## Claude G1
- owner: claude
- slot: claude-1
- status: ready
- task_id: kabumori-portfolio-holdings-stale-valuation-guard-20261011
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: User-authorized G1 source-only portfolio stale valuation consistency. Reuse five-field holding snapshot match from merged PR136; withhold mismatched per-row P/L, suppress invalid impact top3 and aggregate totals if even one current vs saved holding mismatch, preserve saved close/date and canonical bottom five NativeTabs. Distinguish loading/error from verified empty; fail-before/pass-after tests; no production/DB/API/EAS/manual deploy, no G2 old-method report fix, no other slot interference. One separate G1 worktree and PR, no self-merge; return K1.
- recommended_model: Sonnet5（高）
## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-shared-report-x-app-cutover-preflight-20261011
- start_code: G2
- finish_code: K2
- next_owner: chatgpt
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: 新方式の朝刊・大引けの X／アプリ切替の本番前読み取り監査を完了（本番接続 NOT_RUN、製品ソース変更 0）。判定は NO_GO：P0 は新コードの未デプロイの可能性と本番の状態の未確認、P1 は共有パケットが無い日の全停止・個別レポートの20人上限・通知予約失敗での上書き・生成中の放置・アプリのバイナリ。段階0（読み取り）→段階1（デプロイ）→段階2（アプリだけ ON）→段階3（X も ON）の手順案とロールバックを Report に記載。K2 の判断待ち。
- recommended_model: Opus5.5（高）
## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: postona-unified-ai-manual-schedule-planner-v1-20261011
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- return_to: POSTONA G3のちゃ（AI相談・X投稿予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 accepted fixes R1 reroll content/cancel preservation and R3 unbound brand-level server posts on source. ONE R2b P2 still remains: schedule.tsx uses snapshot.workspace.id (first brand) for AI settings while activeAccount.brandId could be another brand; may show A consent/frequency in B preview. Source-only same Draft PR138 head 48f070cc6a8472990dc07760e61ce255e5d21c91. Fix selected account verified brand for repository.read, aiPlanningFor, owner and test actual screen wiring. No other changes, no G4/H1/G5 work, no prod/DB/Edge/X/merge. Return K3. Prior Report/history preserved.
- recommended_model: Sonnet5（中）
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
- status: ready
- task_id: common-ai-provider-g6-phase1f-production-ledger-apply-policies-20261011
- start_code: G6
- finish_code: K6
- next_owner: claude
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report
- production_mutation_window: RESERVED_NOT_ACTIVE (user-approved ONLY fixed ai_ledger migration 20261010050613 + exactly 2 system market_report Anthropic Opus test policies; must acquire ACTIVE at actual write after fresh G5/all-writer gate, release CLOSED after readback)
- user_authorization: 2026-10-11 user「おk」 after explicit question approving production ai ledger apply + monthly $5 / daily $2 policy insertion. This is NOT a general migration/project-wide deploy permission.
- allocation: Phase1e `PASS_READONLY_CHECK` K6 accepted and prior full G6 TASK/Report preserved under own TASK. G6 Phase1f performs *only* verified runner `check`, exact `apply`, then exact `policies` in isolated worktree. STOP without retry/cleanup if identity/CLI/result/ACL/fingerprint/G5 mutation overlap/window conflict/Stage B-D readback fail. Log G5 RPC+7/history+1 after success, not in G5 TASK. No secrets, temporary service key, paid AI, Edge, Cron, app model/report cutover, arbitrary SQL, other migrations or production deploy. Return K6 with observed effect; user consent does not allow auto-continue to provider smoke.
- recommended_model: Opus5.5（高）
## Claude G7
- owner: claude
- slot: claude-7
- status: ready
- task_id: mic-stage1-formal-verification-design-finalization-g7-20261011
- start_code: G7
- finish_code: K7
- completion_code: K7
- next_owner: claude
- return_to: MICのちゃ（Market Intelligence Core専用チャット）
- source: .agent/tasks/CLAUDE_TASK_7.md
- report: .agent/tasks/CLAUDE_TASK_7.md#report
- allocation: ユーザー明示指定2026-10-11でMIC作業をG7専任化。初回はDraft PR125のStage1正式Verification DESIGN ONLY最終補強（U2/U3/U6/U9決定反映、phantom INSERT / read snapshot / events parity / pointer整合性 / A1不一致 / SQL競合テスト計画）。PR125既存設計worktreeを共有せずG7専用独立worktreeから安全確認し、docs1ファイルだけを更新。PRはDraft、main merge・production・migration・Edge・Cron・ソース変更禁止。10/14以降の自然観測と正式実装GO判定は別工程。完了はK7でMICのちゃへ返却。他G/H枠のTASK/Report/branchを保護。
- recommended_model: Opus5.5（高）
## Claude G8
- owner: claude
- slot: claude-8
- status: ready
- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- start_code: G8
- finish_code: K8
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: USER EXPLICIT 2026-10-11 — このチャットのニュース改善 A のみをG8に固定。初回TASKはPR129の独立レビューP1×5/P2×4（F1〜F9）修正実装。Draft維持、無merge/deploy、PR116本番固定コミットおよび他枠を保護。G8作業はK8でこのチャットへ返却。他のG/H枠・別案件を引き継がない。
- recommended_model: Opus5.5（高）
## Claude G9
- owner: claude
- slot: claude-9
- status: ready
- task_id: api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011
- start_code: G9
- finish_code: K9
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_9.md
- report: .agent/tasks/CLAUDE_TASK_9.md#report
- allocation: USER EXPLICIT 2026-10-11 — このチャットのAPI最適化 B のみをG9に固定。初回TASKはPhase5成果からPR115 fixture権利18件の安全な改善準備、API費用・取りこぼし・生成失敗の評価設計（オフライン、無有料API、無production）。他のG/H枠・別案件、AのPR129を引き継がない。G9作業はK9でこのチャットへ返却。
- recommended_model: Sonnet5（高）
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
