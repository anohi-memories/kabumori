# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: ready
- task_id: postona-f1-x-manual-publish-ui-source-20261018
- owner: claude
- next_owner: claude
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- previous_archive: .agent_v2/archive/2026-10-18-F1-kabumori-f1-ai-ask-b0-terminal-finish-auth-fix-20261014/
- dependencies: POSTONA総合指令室 Issue269; F3 X manual publish/PR182/224/257/262; F4 G4 Issue131 X verified/token interface; F5 T13 service active; PR238 Auth UI protected
- blocker: API real publish/actual verified credential/managed Auth remain unconnected; offline UI only. Must check independent clean F1 worktree and 30-slot conflicts before start; production/SNS/merge/deploy NO_GO.
- slot_use: Implement POSTONA source-only X manual publish form/preview/safe disabled send and initial home navigation; no edits to schedule.tsx or F4/F5 Auth screens. Archive SHA256 7b601b2c01d982dc99aed3a45616bdd48349b6a02b10b30835898088b10ea1fc and restore verified before reassignment.

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
- status: review_required
- task_id: postona-f3-m1-single-text-post-offline-end-to-end-20261018
- owner: claude
- next_owner: chatgpt
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: Issue269 M1, F1 hand-input UI, F4/G4 PR126 X identity/token, F5 entitlement/T13, F3 PR224→257→262 and PR182
- blocker: real X identity/credential and managed Auth not integrated; source-only; real X/prod NO_GO
- slot_use: M1 synthetic Auth/PG17/mock X single-text send with send-before guard, receipt durable readback; G1 UI, G4 token, G5 Auth protected
- previous_archive: .agent_v2/archive/2026-10-18-F3-postona-f3-publish-enabled-t13-active-service-write-guard-20261017/

## F4
- slot: F4
- status: done
- task_id: postona-f4-pr258-credential-claim-owner-fence-race-p2-fix-20261017
- owner: claude
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: PR258 head 713955b5 and J2 V2 owner-fence race; F5 lifecycle interface coordinated
- blocker: source candidate only, actual Vault and managed unapproved; production/pilot NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-F4-postona-f4-pr251-android-intent-filter-p2-fix-20261017/F4.md
- slot_use: minimal CAS SQL owner race P2 correction and PG17 regression


- l4_verdict_20261018: PASS_SOURCE_FIX / F5_ACK_PENDING / LIMITED_SQL_R1_RECHECK_RECOMMENDED / PRODUCTION_AND_PILOT_NO_GO; PR263 HEAD a1cc77e4cb3b09b0775a7e60c2c76fecd18f3705 Draft.
## F5
- slot: F5
- status: ready
- task_id: postona-f5-m1-x-first-manual-publish-auth-entitlement-t13-contract-20261018
- owner: claude
- next_owner: claude
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: POSTONA総合指令室 Issue269 comment6245437308; F3 PR224/257/262 and G4 token/verified owner; Issue267 ACK pending; PR233 pre-managed restricted recheck
- blocker: real Auth/managed Supabase/production/migration/SNS unapproved; G4 credential owner and F3 sender contract still source-only
- review_required: conditional only for new security boundary, Codex Sol（高）
- previous_archive: .agent_v2/archive/2026-10-18-F5-common-account-f5-phase13-d3-hosted-sandbox-preflight-readiness-20261017/
- slot_use: initial manual X Auth→POSTONA entitlement→owner→T13→publish-enabled→pre-send recheck source-only local synthetic integration and Issue267 read-only ACK; no actual X or DB

## F6
- slot: F6
- status: review_required
- task_id: common-ai-f6-postona-openai-consult-offline-one-request-integration-20261018
- owner: claude
- next_owner: chatgpt
- blocker: AI consultation server-side POSTONA entitlement/stop enforcement missing, mock-only; F5 X M1 and F1 UI source changes protected; production NO_GO
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: Issue269 comment6245437658, existing OpenAI consult and PR239/241/249/264; F5 active X auth M1, F1 active X UI; no overlap
- previous_archive: .agent_v2/archive/2026-10-18-f6-f5-account-deletion-cleanup-contract.md
- slot_use: one offline mocked POSTONA OpenAI consult→shared provider/cost/authorization/dedupe E2E; no product runtime external calls

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
- task_id: orchestration-v3-gh-pilot-rule-integration-f10-20261018
- owner: claude
- next_owner: none
- return_to: かぶモリ30枠統括のちゃ（このチャット）
- completion_code: L10
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- dependencies: PR229 merged; PR252 merged; Issue244; Draft PR248/253; prior F10 task archived
- blocker: pilot G/H activation, main rule merge and slot assignment not authorized
- slot_use: V3 pilot rules integration candidate and protected 30-slot routing

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
- task_id: postona-j2-pr263-threads-owner-fence-race-p2-rereview-20261018
- owner: codex
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: PR263 HEAD a1cc77e4cb3b09b0775a7e60c2c76fecd18f3705 and F5 checked-owner contract ACK
- blocker: PASS_FOCUSED_REVIEW / F5_ACK_PENDING; private-helper contract ACK and managed/H5 integration remain; production/pilot NO_GO
- previous_archive: .agent_v2/archive/2026-10-18-J2-postona-j2-pr260-android-intent-filter-p2-focused-rereview-20261017/
- slot_use: PR263 narrow review complete; PG17 behavior14/races13/13/mutations26/26/independent synchronized9 PASS; no source edits or new P2+ finding; V2 accepted by G4; retain F5 ACK gate

## J3
- slot: J3
- status: ready
- task_id: kabumori-j3-f2-pr213-p1p2-focused-rereview-20261018
- owner: codex
- next_owner: codex
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F2 L2 pending; PR213 HEAD c10f1da593ba3dc365cf340e9569ae1caa9789b1; original findings PR218 HEAD e2730e7b83e07fb73be099ba20251581b2969f30; F8 R1 separate
- blocker: Previous J3 cancelled worktree/uncommitted state NOT_VERIFIED. MUST use a verified independent clean checkout/worktree without touching old one; source-only/no real X/AI/managed/production.
- previous_archive: .agent_v2/archive/2026-10-17-J3-duplicate-review-cancelled/
- slot_use: Independent narrow review of F2 R2 P1 unauthenticated AI-generation entry and R3 P2 wrong-owner planner restore, POSTONA/other-brand nonregression only. No broad review; G1 receives V3 before F2 L2 closure. No edits to F2 source.

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
