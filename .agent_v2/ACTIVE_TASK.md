# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: kabumori-f1-ai-ask-b0-terminal-finish-auth-fix-20261014
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- dependencies: J4 R3-P2 (terminal finish AUTH); PR186 v3; PR177/171/166 protected
- blocker: B1 and production NO_GO until independent focused re-review
- slot_use: AIに聞く B0 終端finish再返却の認可修正（J4残件1件）

## F2
- slot: F2
- status: review_required
- task_id: kabumori-f2-pause-delivery-runtime-candidate-20261015
- owner: claude
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: L2
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: F2 design PR #210 merged; F8 news gate runtime; shared POSTONA/AI protected
- blocker: L2 PASS_SOURCE_FIX / SECURITY_FOCUSED_REREVIEW_REQUIRED; Draft #213 head c10f1da593ba3dc365cf340e9569ae1caa9789b1; J2 R2(P1)/R3(P2) corrected in source candidate; production NO_GO; managed preflight pending
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-15-f2-pause-offline-design-accepted.md
- slot_use: kabumori X gate/planner/queue/Push source-only candidate after L2 design archived

## F3
- slot: F3
- status: done
- task_id: postona-f3-x-reservation-oauth-entitlement-dispatch-integration-20261016
- owner: claude
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: G3 PR145/151/163, F3 PR204, F5 PR214 and active P2 fix, F4 PR217, G4 Issue131
- blocker: F5/G4 Auth entitlement and OAuth owner guards, F3-L1/R2', production NO_GO
- slot_use: L3 PASS_SOURCE_CANDIDATE / PRODUCTION_NO_GO; PR224 head 2a9d6473, PG17 D3 10 cases reported, 28 mutants, G4/G3/F5 integration outstanding; archive before reuse.
- previous_archive: .agent_v2/archive/2026-10-16-F3-postona-f3-j3-v3-ack-lease-rollback-corrections-20261015/

## F4
- slot: F4
- status: review_required
- task_id: postona-f4-service-end-device-readiness-release-gate-inventory-20261017
- owner: claude
- next_owner: chatgpt
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: F5 PR240 HEAD 5e462ba73be691c80f75198d57782626f1d241cc accepted source fix, prior PR238, J2 V2 closed
- blocker: real iOS/managed Auth/Edge release validation pending; production NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-F4-postona-f4-f5-service-end-g1-g2-joint-integration-20261017/F4.md
- slot_use: source-only native smoke matrix and release blocker inventory, no source mutation

## F5
- slot: F5
- status: done
- task_id: common-account-f5-pr238-j2-v2-gate-stale-screen-handler-p2x2-fix-20261017
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: J2 V2 CHANGES_REQUIRED P2x2; joint PR238 b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6; F5 PR235 9480f24b; F4 PR236 605d8776
- blocker: gate embedded stale AccountDeletionScreen and stale reactivate_x_autopost_service click callback; managed Auth and production NO_GO
- slot_use: F5-only gate P2x2 repair; preserve F4 provider/surface and unrelated Phase12 PR233
- previous_archive: .agent_v2/archive/2026-10-17-F5-common-account-f5-postona-service-end-entitlement-epoch-g1-g2-20261017/
- review_required: no automatic repeated whole-scope J2 review; source regression and G4 handoff
- latest_result: PASS_SOURCE_FIX / PRODUCTION_NO_GO; J2 V2 P2x2 fixed in the F5 gate only, PR240 head 5e462ba7 Draft stacked on PR238 (b8e91ea8); fail-before 18/20 on exact PR238 then 20/20, app suite 396 pass, tsc+lint rc=0, gate mutants 23/23; mocked harness only, no managed access; G4 to check targeted before/after + regression, no automatic J2 rerun.

- l5_verdict: PASS_SOURCE_FIX / G4_INTEGRATION_CONFIRMATION_REQUIRED / PRODUCTION_NO_GO (2026-10-17). PR240 head 5e462ba73be691c80f75198d57782626f1d241cc; implementer reports before 18/20 failing, after 20/20 passing, app 396, mutation 23/23; shared assembled integration-test 1 case updated, G4 should confirm. No merge/deploy/managed operation.

## F6
- slot: F6
- status: review_required
- task_id: common-ai-f6-postona-ai-ledger-quota-idempotency-design-20261017
- owner: claude
- next_owner: chatgpt
- blocker: POSTONA ledger/quota/durable operationId architecture design; migration/production/paid calls NO_GO; privacy and F4+F5 review dependencies
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: PR239 source-only bridge contract, provider stack PR187→198→205→219→222→231→234→237→239; F4+F5 PR238 focused review pending
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr239-postona-contract-preflight.md
- slot_use: F6 POSTONA AI ledger quota idempotency SOURCE-ONLY design

## F7
- slot: F7
- status: ready
- task_id: mic-stage1-formal-verification-s1a-source-f7-20261015
- owner: claude
- next_owner: claude
- return_to: MICのちゃ（Market Intelligence Core専用チャット）
- completion_code: L7
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F7.md
- current_report_path: .agent_v2/tasks/F7.md#report
- dependencies: 旧G7 K7 PASS_DESIGN_ONLY、PR125 Draft design head aa47e40d、2026-10-15 shadow read-only GO_FOR_SOURCE_IMPLEMENTATION（S1-Aのみ）
- blocker: Production/merge/deploy NO_GO。F7開始時にfresh main・独立worktree・他slot競合を再確認。U1 equity no_new_observationはSQL合成テストで証明必須
- slot_use: MIC専属の新規F7 TASK（ユーザー明示指定の段階移行）。S1-A新RPC/migration source＋42 SQL tests/5 mutation plans；S1-B/他境界は別TASK。既存G7完了TASKの移動なし

## F8
- slot: F8
- status: review_required
- task_id: kabumori-f8-news-discovery-observer-pause-gate-20261016
- owner: claude
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: L8
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F8.md
- current_report_path: .agent_v2/tasks/F8.md#report
- dependencies: previous L8 observer gap design archived; Draft PR228 41fc4f58; PauseCoordinator contract PR212 b38064c2
- blocker: V4 PASS_FOCUSED_REVIEW (direct J4 independent review, PR232 db41bdae, 175 PASS, 12 mutants, no findings); integration/managed read-only preflight/Cron and in-flight checks NOT_VERIFIED; production NO_GO
- production_mutation_window: FORBIDDEN
- previous_archive: .agent_v2/archive/2026-10-16-F8-observer-stop-gap-design/
- slot_use: observer entry+egress gate implemented as source candidate; G1 to route focused validation

## F9
- slot: F9
- status: done
- task_id: api-optimization-b-f9-clean-pr190-residual-rights-tests-20261014
- owner: claude
- next_owner: none
- return_to: ニュース改善API最適化のちゃ
- completion_code: L9
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F9.md
- current_report_path: .agent_v2/tasks/F9.md#report
- dependencies: previous L9 accepted and archived; F8 and F9 isolated
- blocker: offline only; production/merge/deploy/paid API prohibited
- slot_use: Redact 288 rights-unconfirmed headlines/76 generated posts in isolated candidate; PR174 and PR115 protected

## F10
- slot: F10
- status: done
- task_id: orchestration-v3-pr229-n1-n2-focused-correction-f10-20261017
- owner: claude
- next_owner: none
- return_to: かぶモリ30枠統括のちゃ（このチャット）
- completion_code: L10
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- dependencies: PR #229 HEAD 284286248e561e55e8aef7682081998878d05cfa; independent rereview N1/N2 only; previous F10 TASK archived
- blocker: L10 PASS_SOURCE_FIX / V3_CUTOVER_NO_GO — independent N1/N2 rereview and connector/branch CAS proof pending
- slot_use: PR229 N1 pushurl/N2 BOM source correction accepted L10; F10 done/unreserved; V3 cutover NO_GO

## J1
- slot: J1
- status: done
- task_id: common-account-j1-f5-pr226-disposable-guard-focused-review-20261016
- owner: codex
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: V1
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J1.md
- current_report_path: .agent_v2/reports/J1.md
- dependencies: F5 Phase12 Draft PR226 3d87a8457ddade3209583cbb820d5e5feec23f00 on PR223 28695586f63a30c739a44b829e79a7950932b5e7
- blocker: CHANGES_REQUIRED P2×4: probe hash check/use mismatch, --only skips G3b before chain apply, transitive network-helper miss, inventory diff secret-shaped output. Production schema inventory and managed disposable both NO_GO/unapproved.
- slot_use: PR226 narrow review complete; selected27 typed PASS, independent7 PASS/4 FAIL; guard_test TS2345 runtime NOT_VERIFIED. Content commit d7d514f064de3c959273a479ebccc6f72f49f280 normally pushed/read-back PASS; return V1 to 共通アカウントG5のちゃ（新F5担当）. No prior common-AI review repeated.
- previous_archive: .agent_v2/archive/2026-10-16-J1-common-ai-j1-pr222-r1a-a1-focused-review-20261016/

## J2
- slot: J2
- status: done
- task_id: postona-j2-pr238-auth-cross-user-review-20261017
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: PR238 b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6
- blocker: CHANGES_REQUIRED P2×2: embedded management flow lost after new-login ready; obsolete reenroll callback send-time owner/epoch/request fence missing (user-switch form inherited). Production NO_GO.
- previous_archive: .agent_v2/archive/2026-10-17-J2-focused-review-closed/
- slot_use: PR238 focused review complete; existing68 PASS, adverse3 PASS/3 FAIL (2 causes), baseline1 PASS; return V2 to POSTONA G4ちゃ. No product or production changes.

- v2_verdict_20261017: CHANGES_REQUIRED accepted P2x2; F5 gate fix and F4 integrated regressions needed; production NO_GO.

## J3
- slot: J3
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: none
- completion_code: V3
- recommended_model: none
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: none for new task; independent worktree and conflicts must be checked at new assignment
- blocker: previous review user-cancelled; old worktree/uncommitted state NOT_VERIFIED; protect it at next startup
- previous_archive: .agent_v2/archive/2026-10-17-J3-duplicate-review-cancelled/
- slot_use: available for a newly registered distinct task_id only; do not start while idle

## J4
- slot: J4
- status: done
- task_id: postona-j4-pr217-r2c-final-preview-focused-rereview-20261015
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V4
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J4.md
- current_report_path: .agent_v2/reports/J4.md
- dependencies: PR217 d4bcd09e stacked PR211 eb1011f2 / PR197 2171ee4c; actual F5 PR193 handler; F5 PR214 integration separate
- blocker: CHANGES_REQUIRED P2: concurrent public preview B/null observations bypass active end sticky fence; stale A settle can return completion/facts. Original serial R2c fixed, screen guarded; production NO_GO
- slot_use: PR217 focused independent concurrency rereview with actual F5 synthetic seam; no product changes
- previous_archive: .agent_v2/archive/2026-10-15-J4-postona-j4-pr211-p2-client-fixes-focused-security-rereview-20261015/
- v4_verdict: CHANGES_REQUIRED P2 x1; original R2c 2 FAIL→2 PASS, focused19/seam8/app313 PASS, new concurrency 4 FAIL/2 controls PASS. Await coordinator V4.
- latest_assignment: PR217 focused review completed 2026-10-16; return to POSTONA G4 coordinator, V4.

## J5
- slot: J5
- status: idle
- task_id: none
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V5
- recommended_model: none
- current_task_path: .agent_v2/tasks/J5.md
- current_report_path: .agent_v2/reports/J5.md
- dependencies: J4 V4 CHANGES_REQUIRED P2 R1/R2, PR197 HEAD 2171ee4c, F5 PR193 typed response; no F3/F5/F4 backend changes
- blocker: PRODUCTION_NO_GO, owner server/Auth/SNS and independent review remain
- slot_use: user-directed Codex emergency POSTONA client fix, outcome mandatory evidence and warning preservation, original J5 archived
- cancellation: prior unstarted task archived; new F4 task owns correction.

## コード

- `F1`〜`F10`: 新Claude枠の開始。完了確認は `L1`〜`L10`（1対1）。
- `J1`〜`J5`: 新Codex枠の開始。完了確認は `V1`〜`V5`（1対1）。
- 単独 `F`（数字なし）: 新旧30枠の統括。`F1`〜`F10` とは完全一致で区別する。
