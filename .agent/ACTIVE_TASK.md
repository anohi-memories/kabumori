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
- status: ready
- task_id: postona-threads-pr144-auth-publish-p1-security-review-h3-20261012
- start_code: H3
- finish_code: C3
- completion_code: C3
- next_owner: codex
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK_3.md
- report: .agent/CODEX_REPORT_3.md
- allocation: K4 2026-10-12 accepted PR144 G4 Threads Auth-to-manual TEXT publish source candidate only. H3 newly assigned one focused independent Sol（高） SECURITY REVIEW of exact Draft PR144 head d4a1e87b77d1fbd362dc51809ce2d998afda15ea stacked on protected PR140 2e75a6a842e70f3de78558681803b60935fb4251; examine G4 SECURITY DEFINER SQL claim/release/record replacement, Auth session and G5 T13/lifecycle after revoke, HMAC nonce proof/replay and Vault access, H5 owner-only callback/custody, actual safe flags/dual write idempotency, disposable SQL/test fidelity. Do not edit product or PR, real Supabase/Meta/X/Vault/production, grants, migration apply, merge/deploy, posts. Distinguish mocked reports from managed proof. H4 occupied separately with G8 News PR129 review and protected; H1/H2/H5/G3/G5/G6-G10 protected. C3 return here. H3 freed after C3.
- recommended_model: Sol（高）
## Codex H4
- owner: codex
- slot: codex-4
- status: done
- task_id: news-improvement-a-pr129-phase7-r2-final-focused-review-h4-20261012
- start_code: H4
- finish_code: C4
- completion_code: C4
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CODEX_TASK_4.md
- report: .agent/CODEX_REPORT_4.md
- allocation: C4 2026-10-12 CHANGES_REQUIRED。独立H4がPR129 head `7bf9b8a0` で既存968 PASS、独立12probe=9 PASS/3 FAILを実施。H4-R1 P1:決算表折返し誤Fact、R2 P2:本文更新と判定保存のCAS競合、R3 P2:過去FOMC決定を現在決定と誤認。レビュー完了、コード未変更、本番アクセス・merge・deployなし。G8ニュース改善Aだけへ限定修正TASKを戻す。H4はdone/unreserved、他案件を勝手に引継がない。
- recommended_model: Sol（高） (completed)
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
- task_id: kabumori-g1-portfolio-watchlist-simulator-qa-20261012
- start_code: G1
- finish_code: K1
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: 2026-10-12 G1 read-only Simulator QA authorized after PR142 squash merge 4d0d0660831c1bf7403a908592c337c284332cdf. Verify 375pt/402pt portfolio/watchlist/detail navigation with synthetic stale-valuation fixtures. No real user data edits, G2/G5 work, native tabs changes, EAS or deploy. Original K1 report archived in TASK.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-market-report-scalable-broadcast-push-v1-20261012
- start_code: G2
- finish_code: K2
- next_owner: claude
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: K2 2026-10-12 PASS_SOURCE_FIX for C3 P2: PR143 head 889ca1b44cf82bd3ecb913818dca568456849feb verified 1 commit after H3 old head, exact 5 files, SQL fail expires_at fence + MemStore mock + worker 3 regressions/SQL 2 regressions/mutation. G2 reported PG17 14 mutants PASS, worker34, personalized134, market283, data42, app508, X shared10 PASS; ChatGPT reviewed exact patch but did not run tests. PR143 OPEN/DRAFT/unmerged, no production. New G2: shared market morning/close broadcast push for opted-in users at 10k+ scale, dedicated/priority-safe producer+dispatch/queue, unique once-per-user, Expo unknown delivery handling, no important-news starvation, performance model, runbook, offline-only new Draft PR; PR143/PR141 protected. No DB/Cron/Edge/app deployment/real Expo/X/paid model/merge. Return K2.
- recommended_model: Opus5.5（高）
## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: postona-x-reservation-store-offline-v1-g3-20261011
- start_code: G3
- finish_code: K3
- next_owner: claude
- return_to: POSTONA G3のちゃ（AI自動投稿・X予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 PR145 exact 1306cdc5d37e8b28b4819484846aed00875654b2 CHANGES_REQUIRED two P2. R1 SQL finish() accepts expired lease if claim_due() sweeper did not run; enforce deadline independent of sweep and add real PG regression (no duplicate posting; preserve published idempotence). R2 manual_interval mode accepts arbitrary irregular timestamps because app sends no cadence metadata and SQL checks only 60min gap; transmit intended interval and validate on server atomically with interval tests. Same PR145 source-only candidate, G5/G4 deny stubs / client store flag stay OFF; past reported PG/mutation/Deno/app tests accepted as evidence only, not independently rerun. Do not modify G4/H5/G5 or other worktrees, no live DB/Edge/Cron/OAuth/X/Meta/AI/deploy/merge/EAS. Return K3. Sol（高） independent review only before real G5/G4-integrated Auth/RLS/publisher rollout.
- recommended_model: Opus5.5（中）
## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: postona-threads-connect-publish-integrated-offline-v1-g4-20261011
- start_code: G4
- finish_code: K4
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- report: .agent/tasks/CLAUDE_TASK_4.md#report
- allocation: K4 2026-10-12 PASS_SOURCE_CANDIDATE / GO_SOURCE_ONLY / BLOCKED_REAL_PILOT. Verified [Draft PR144] head d4a1e87b77d1fbd362dc51809ce2d998afda15ea, OPEN/DRAFT/UNMERGED, 1 commit/24 scoped G4 paths stacked on protected PR140 2e75a6a842e70f3de78558681803b60935fb4251; all other protected PR124/135/139/121 unchanged. G4 reports disposable PG17 negative release tests, simulated integrated 176 Deno, focused 93, app258 PASS; ChatGPT reviewed source/SQL/PR, did not independently rerun tests or real managed Auth/Vault/Meta. P1 claim+service_role redeem replaced with JWT-scoped HMAC attested transactional release SQL candidate, credential custody candidate and disabled Connect UI, WITHOUT claiming live risk resolved. Critical cross-provider Auth/RPC/role/custody code gets ONE focused independent H3 Sol（高） security review; G4 done and slot freed, no new G4 work pending C3 outcome. Both connect and publish server/mobile gates remain false; actual Threads connection/post, PR merge/deploy/prod DB apply/GRANT/keys not authorized. Meta tester and G5 real T13/T10/H5 owner transport missing. Historic G4 report preserved; G5/G3/G6/H4 and all other slots unaffected.
- recommended_model: Opus5.5（高） (completed K4)
## Claude G5
- owner: claude
- slot: claude-5
- status: in_progress
- task_id: common-account-phase3i-local-findings-safe-lifecycle-plan-20261012
- start_code: G5
- finish_code: K5
- next_owner: claude
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: User 2026-10-12「おk すすめて」 approved next G5 Phase3i bounded LOCAL-OFFLINE account lifecycle containment design and synthetic regression tests based on Phase3h F1/F2/F3/F4/F6/F7. Opus5.5 high. New G5 independent worktree, new docs/tests only, optional new Draft PR; older G5 Draft PRs #121/#122/#128/#130/#134/#137/#146 remain unchanged. Other G/H TASK and worktrees protected. No managed Supabase, real auth/prov, photo pause, live DB/Edge, migration, Option D/E11, paid action, merge/deploy. IDP_PREPAUSE_BLOCKED and managed_auth_delete BLOCKED. Return K5.
- recommended_model: Opus5.5（高）
## Claude G6
- owner: claude
- slot: claude-6
- status: ready
- task_id: common-ai-provider-g6-phase2a-market-report-adapter-offline-20261012
- start_code: G6
- finish_code: K6
- next_owner: claude
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- source: .agent/tasks/CLAUDE_TASK_6.md
- report: .agent/tasks/CLAUDE_TASK_6.md#report--phase2a
- recommended_model: Opus5.5（高）
- latest_result: K6 Phase1g PASS; ONE Opus5.5 paid smoke, ledger reservation1/usage1/open0, user-confirmed temporary secret revocation and ledger.env removal. Prior TASK done/none, safely preserved in G6 TASK history. OLD index stale in_progress corrected.
- allocation: Phase2a source-only common AI provider adapter and synthetic fixture/fake-ledger tests; new G6-only independent Draft PR. No changes to G2 scalable morning/close notification pipeline, PR143, G5 Auth, G8 news, G9 model evaluations, other G/H slots.
- production_mutation_window: FORBIDDEN (offline-only). No external paid calls, actual market report generation, Edge secrets, DB migration, Cron, deploy, merge or cutover.
## Claude G7
- owner: claude
- slot: claude-7
- status: done
- task_id: mic-stage1-formal-verification-design-finalization-g7-20261011
- start_code: G7
- finish_code: K7
- completion_code: K7
- next_owner: none
- return_to: MICのちゃ（Market Intelligence Core専用チャット）
- source: .agent/tasks/CLAUDE_TASK_7.md
- report: .agent/tasks/CLAUDE_TASK_7.md#report
- allocation: K7 2026-10-11 PASS_DESIGN_ONLY / TASK_COMPLETE。PR125 exact `aa47e40d2a3ba7ec8bfc7d1d30c8eb51d53f2c48` OPEN/Draft/UNMERGED、G7差分は設計文書のみ(+352/-163)でコード/migration/本番変更なし。U2/U3/U6/U9設計決定・単一事実スナップショット・イベント50件超/同ID改定・ポインタ/rollback/SQL42テスト設計を確認。ローカル静的チェックはClaude報告、GitHub diffをChatGPT read-back。U12/U13、実SQL/競合/権限テストは実装レビューで検証。10/14以降の自然shadow観測まで実装GOなし、PR merge/deploy禁止。G7 TASKは完了・next_owner:noneで解放するがMICの今後のG実装担当はユーザー指定によりG7のみ。別作業は新TASKで明示割当。
- recommended_model: Opus5.5（高）
## Claude G8
- owner: claude
- slot: claude-8
- status: ready
- task_id: news-improvement-a-pr129-h4-r1-r2-r3-correction-g8-20261012
- start_code: G8
- finish_code: K8
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: USER EXPLICIT ニュース改善Aの専任G8。H4/C4のP1×1・P2×2独立レビュー指摘だけをPR129へ実装するR3 TASK。決算短信の折返し表をfail-closed、本文更新後の古い判定保存を原子的CASで防止、FOMC声明の過去判断と現在判断を正しく分離。前のR1/R2実装・Report保全、PR129 Draft維持、merge/deploy/本番変更なし。C4レビューは完了、次のK8で確認。G9その他枠は非干渉。
- recommended_model: Opus5.5（高）
## Claude G9
- owner: claude
- slot: claude-9
- status: done
- task_id: api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011
- start_code: G9
- finish_code: K9
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_9.md
- report: .agent/tasks/CLAUDE_TASK_9.md#report
- allocation: USER EXPLICIT G9=API最適化B専任。K9 2026-10-12 **PASS_OFFLINE_BRANCH_READY / PR_NOT_CREATED / RELEASE_HOLD**。新規Bだけのclean-historyブランチ `claude/b-provider-compare-rights-safe-20261012` commit `c476ef8a` に129新規ファイル、旧本文入り `cases.json` なし。G9報告302 PASS/1 ignored。Draft PR作成はClaude安全機構により拒否、無理に回避せずユーザー作成待ち。TDnet見出し3件の本文重複/旧PR115 Git refsの本文/元main既存重複2ファイルは別の判断事項。PR115/本番/外部AI利用は未変更、merge/deploy不可。新TASK未割当、他案件に転用禁止、G8その他枠不干渉。
- recommended_model: Opus5.5（高） (completed)
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
