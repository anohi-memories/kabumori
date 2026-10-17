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
- status: in_progress
- task_id: postona-f3-publish-enabled-t13-active-service-write-guard-20261017
- owner: claude
- next_owner: claude
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: PR76 set_social_account_publish_enabled, F3 PR257/224/182, F5 T13/Phase13 D-2, G4 verified X PR126 Issue131
- blocker: G4 X verification/token port, managed F5 T13 integration, R2', production NO_GO
- slot_use: T13 guard for X publish-enabled ON, preserve OFF and PR182 sending fence; narrow source-only candidate
- previous_archive: .agent_v2/archive/2026-10-17-F3-postona-f3-x-oauth-t13-reservation-owner-guard-20261017/

## F4
- slot: F4
- status: done
- task_id: postona-f4-threads-credential-rotate-cas-sql-contract-20261017
- owner: claude
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: PR251/J2 pending scoped review, PR255 refresh design, H5 Vault, F5 lifecycle fences
- blocker: source-only CAS contract; managed/no real Meta, pilot and production NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-F4-postona-f4-threads-token-refresh-source-design-20261017/F4.md
- slot_use: F4-owned Threads credential CAS SQL proposal and offline PG tests


- l4_verdict_20261017_rotation: PASS_SOURCE_CANDIDATE / SQL_REVIEW_REQUIRED / PRODUCTION_AND_PILOT_NO_GO; PR258 HEAD 713955b5371cf4f1de4681ecec1737e1ccc7d4cd; source candidate only, no Vault/managed operation.
## F5
- slot: F5
- status: done
- task_id: common-account-f5-phase13-d2-x-saga-inert-standin-harness-20261017
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: G4 D-2_IMPLEMENTATION_GO and F3/G3 PASS_CONTRACT_REVIEW; PR254/250/233, F3 PR204 and F5 PR214
- blocker: R2' POSTONA-only real X scope unresolved; G3 T13; managed unapproved, production NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-F5-common-account-f5-phase13-baseline-contract-extend-20261017/
- review_required: conditional, no automatic wide review; Phase12 #233 P2x4 focused gate remains independent
- slot_use: testing-only dependency-injected inert X saga stand-in; no production X cleanup, F3/G3/F4/F6, Auth, DB, OAuth, SNS or deployment
- latest_result: 2026-10-17 JST SOURCE_CANDIDATE_COMPLETE; Draft PR259 head 422c101aff4bb475db075abf2c0e9423582069ae on PR254 503a6ca8; offline inert X saga stand-in injected only at the F5 harness boundary (deps.x / deps.rpc / fake network routes), single registered simulated->done conversion, structural production exclusion E1-E6 + tripwires + X-side DB observer; 36 stand-in + 151 harness + 143 account-delete + 10 PG17 e2e tests, 38/38 new and 35/66/37/49 old mutants; no production/managed access; R2' (F3), T13 managed/enabled-publish legs (PR257 source candidate only), managed M12, #233 limited recheck remain; production NO_GO

- l5_verdict: PASS_SOURCE_CANDIDATE / PRODUCTION_NO_GO (2026-10-17); PR259 Draft HEAD 422c101aff4bb475db075abf2c0e9423582069ae, inert simulated X only, no production paths. Reported 36 stand-in, 151 harness, 143 account-delete, 10 PG17 E2E PASS; 38/38 mutations; R2' and managed M12 remain blocked. Archive before reuse.

## F6
- slot: F6
- status: ready
- task_id: common-ai-f6-pr256-policy-pii-erasure-p2-fix-20261017
- owner: claude
- next_owner: claude
- blocker: PR256 independent Claude CHANGES_REQUIRED P2 policy_key/note PII remains after erasure, P3x3; F6 focused offline source fix only; production NO_GO
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: PR256 exact HEAD 1830320bd93fcfa458411dcf00f130d87d607d39 on reviewed PR249; F5/G5 deletion integration separate
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr256-erasure-reviewed-changes-required.md
- slot_use: F6 PR256 P2 privacy residual policy_key/note repair and P3 scoped guards

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
- task_id: orchestration-v3-incremental-index-fastpath-f10-20261017
- owner: claude
- next_owner: none
- return_to: かぶモリ30枠統括のちゃ（このチャット）
- completion_code: L10
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- dependencies: PR229 source, Issue244, prior F10 archive checksum completion
- blocker: L10 source accepted; V3 main merge and pilot still NO_GO pending integration gates
- slot_use: V3 incremental index implementation completed and accepted at L10

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
- task_id: postona-j2-pr251-threads-oauth-entry-redirect-focused-review-20261017
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: PR251 HEAD 3163928d5fa3b8e6984f6350ce5a8faf31d23ffc
- blocker: V2 CHANGES_REQUIRED P2 R1 Android callback-filter validation; focused106 PASS, adverse6 PASS/2 FAIL; no real OAuth/managed testing; production and pilot NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-J2-postona-j2-pr238-auth-cross-user-review-20261017/
- slot_use: read-only one-pass focused OAuth edge/redirect review


- v2_verdict: CHANGES_REQUIRED / P2 R1 Android filter categories/port validation / 2026-10-17 / PR251 unchanged; F4 follow-up required; PRODUCTION_AND_PILOT_NO_GO.
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
