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
- task_id: kabumori-personalized-report-delivery-p1-hardening-20261011
- start_code: G2
- finish_code: K2
- next_owner: chatgpt
- return_to: かぶモリアプリG2のちゃ
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: 個別レポートの配信安定化 P1（20人の上限・完成したレポートの保護・止まった生成中）を Draft PR #141（head 4bc5c0177aa74085eb488604a00e2b66c7fe527c）として作成。DB・Cron・権限の変更なし、全テスト成功、本番操作・デプロイ・マージ 0。21人以上への全員配信は複数回実行の Cron が別に必要（PARTIAL）。本番は前回の P0 が未解消のため NO_GO のまま。Report は .agent/tasks/CLAUDE_TASK.md の先頭の節。K2 の判断待ち。
- recommended_model: Opus5.5（高）
## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: postona-unified-ai-manual-schedule-planner-v1-20261011
- start_code: G3
- finish_code: K3
- next_owner: none
- return_to: POSTONA G3のちゃ（AI相談・X投稿予約担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 FINAL PASS_SOURCE_PREVIEW_ONLY. Accepted unified manual exact/random/interval and AI flexible local preview Draft PR138 exact f6b8f866b449cd432f649c132bbaa2e70a9f2ace OPEN/DRAFT/UNMERGED. R1 reroll preserves edited/reordered/cancelled, R2 and R2b safely bind AI frequency/opt-in to currently selected activeAccount.brandId (not first snapshot.workspace), R3 legacy unknown posts remain brand-level read-only and not attributed. G3 reports 277/277 app and 22/22 domain tests PASS; source/Report inspected by ChatGPT but tests not independently rerun. No live saved reservations, Supabase writes, RPC/migration/Edge/Cron, real X/Meta/AI posting, merge/deploy/EAS. PR branch behind main, GitHub mergeability unknown; source merge requires separate checks/authorization. G3 closed with no successor TASK. G4/H5/G5/G6 and all other slots protected; one Sol（高） security review only for future actual Auth/RLS/publisher rollout.
- recommended_model: Sonnet5（中）
## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: postona-threads-manual-text-publish-v1-20261011
- start_code: G4
- finish_code: K4
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: K4 2026-10-11 PASS_SOURCE_CANDIDATE / RELEASE_HOLD. Reviewed G4 TASK Report and Draft PR140 exact 2e75a6a842e70f3de78558681803b60935fb4251: OPEN/DRAFT/NOT_MERGED, one commit/20 bounded files. G4 reports Deno86, mobile252, disposable PG17 concurrency/ACL PASS (ChatGPT inspected code but did not rerun). Two-stage Meta TEXT manual posting, pre-provider claim/consent and status/read-back source implemented; Edge gate THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false, mobile UI flag false, no live Meta/DB/app connection or post. Production HOLD especially service_role redeem after user claim does not recheck G5 T13/owner membership at redeem within 60s grant, requires reviewed safe lifecycle/role race design with H5/G5 before real publishing; credential-expires-at reader/T10 still missing. PR124/135/139 OAuth chain and Phase2a-2/T13/Meta pilot unmet. G4 done/unreserved and historic Report preserved; no Codex review until joint integrated gate; no PR merge/deploy. Other slots protected.
- recommended_model: Opus5.5（高） (completed)
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-phase3g-free-auth-provider-test-readiness-20261011
- start_code: G5
- finish_code: K5
- next_owner: none
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 2026-10-11 accepted Phase3g as PASS_SOURCE_FEASIBILITY / IDP_PREPAUSE_BLOCKED. Verified Draft PR137 HEAD eba0ba5abc56f8188a03d567d319754e4ac8ea4c, one new docs file, OPEN/DRAFT/UNMERGED, and PR121/122/128/130/134 protected unchanged. Supabase Free custom OIDC/hooks/rate feasibility verified against official docs; Auth0 users/config/cost and managed E1-E12 NOT_RUN. Photo app NOT_PAUSED, real project/provider calls 0, paid actions 0; E11/Option D/managed_auth_delete/production BLOCKED. G5 completed and unreserved; no next task until user decision on local no-downtime OSS pilot / Auth0 Free preparation / later independently approved managed E1 pilot. Other slots protected.
- recommended_model: Opus5.5（中）
## Claude G6
- owner: claude
- slot: claude-6
- status: in_progress
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
- task_id: news-improvement-a-pr129-k8-f7-rotation-and-f9-boundary-g8-20261011
- start_code: G8
- finish_code: K8
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_8.md
- report: .agent/tasks/CLAUDE_TASK_8.md#report
- allocation: USER EXPLICIT G8はニュース改善A専任。前TASK `news-improvement-a-pr129-f1-f9-remediation-g8-20261011` K8はCHANGES_REQUIRED：PR129修正984eeb41を確認、F1〜F6/F8の修正あり。F7の10分単位rotationは毎時起動3候補では同じ2候補に固定されるため、G8へ狭いR2是正を再割当。F9 guarded PATCHのstatus/content_hash/判定競合と残留no_post等の方針を確認。PR129 Draft、PR116固定本番と他slotを保護。K8で本チャットへ返却。G9/API-Bは不干渉。
- recommended_model: Opus5.5（高）
## Claude G9
- owner: claude
- slot: claude-9
- status: ready
- task_id: api-optimization-b-g9-r2-licenses-and-external-call-gate-20261011
- start_code: G9
- finish_code: K9
- next_owner: claude
- return_to: ニュース改善API最適化のちゃ
- source: .agent/tasks/CLAUDE_TASK_9.md
- report: .agent/tasks/CLAUDE_TASK_9.md#report
- allocation: USER EXPLICIT G9=API最適化B専任。前K9のbranch b6020dbbオフライン評価基盤の実装成果はPASS_OFFLINE_PARTIAL。しかしrights_unconfirmedの第三者本文がlocal runtimeBodiesハッシュ一致でlive送信可能、probe_cli明示legacyでも外部count_tokens送信可能なためRELEASE_HOLD。限定R2で外部送信前の権利ゲートをfail-closed化。PR115の既存fixture/履歴は所有者判断待ち、PR115/G8 PR129/他slotは変更禁止。K9でこのチャットへ。
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
