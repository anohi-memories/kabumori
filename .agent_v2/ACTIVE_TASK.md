# Active Tasks Index v2（新系統15枠）

新系統（F1〜F10 / J1〜J5）の現在状態だけを置く索引。詳細と正本は各TASK / Report。過去のK / L / C / V判定は書かない。statusだけで空き判定しない。

- 旧系統（G1〜G10 / H1〜H5）の索引は `.agent/ACTIVE_TASK.md`（移行期間中の現行正本）。
- 単独 `F` は、移行期間中この索引と旧索引の両方を見て新旧30枠を統括する（`.agent_v2/ORCHESTRATION.md`）。
- 導入PRのmerge前は新系統を使わない。merge後も、TASKが置かれるまで全枠 `idle`。

## F1
- slot: F1
- status: done
- task_id: postona-f1-m2-restart-pending-uncertain-guard-20261018
- owner: claude
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（新F1担当）
- completion_code: L1
- recommended_model: Sonnet5（高）
- current_task_path: .agent_v2/tasks/F1.md
- current_report_path: .agent_v2/tasks/F1.md#report
- previous_archive: .agent_v2/archive/2026-10-18-F1-postona-m1-single-post-contract-adapter-L1/
- dependencies: PR #274 UI → PR #277 adapter, F3 PR #272 durable readback, G2 visual QA, F4 credential, F5 entitlement
- blocker: server-side durable restart safety not verified; read-only/offline F1-only scope; send disabled; independent clean worktree and fresh origin/main required
- slot_use: Issue269 approved milestone 2: restart/pending/uncertain guard and duplicate-send avoidance, no API/DB/Auth/production operations

## F2
- slot: F2
- status: done
- task_id: kabumori-f2-pause-delivery-runtime-candidate-20261015
- owner: claude
- next_owner: none
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

- pause_closure: USER_DEFERRED_FOR_KABUMORI_PAUSE / L2 administrative source-only freeze; no security PASS
- pause_archive: .agent_v2/archive/2026-10-18-kabumori-pause-f2-j3-user-deferred/

## F3
- slot: F3
- status: done
- task_id: postona-f3-m1-f1-live-pre-send-entitlement-credential-fence-20261018
- owner: claude
- next_owner: none
- return_to: POSTONA G3のちゃ（新F3担当・X投稿／予約担当）
- completion_code: L3
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F3.md
- current_report_path: .agent_v2/tasks/F3.md#report
- dependencies: Issue269 M1-F1 #6246561404, F5 PR275 live entitlement contract, F3 PR272/262/257/224/182, G4 PR126 verified/credential, F1 UI
- blocker: real X token/verified and managed Auth absent; source-only mock X, real X/prod NO_GO
- slot_use: Fix M1-F1 pre-send live F5 service state and G4 owner/credential generation + publish guard; unknown uncertain and after_freeze receipt; synthetic E2E only
- previous_archive: .agent_v2/archive/2026-10-18-F3-postona-f3-m1-single-text-post-offline-end-to-end-20261018/

## F4
- slot: F4
- status: done
- task_id: postona-f4-pr276-j2-p2x2-provenance-owner-epoch-atomic-credential-fix-20261018
- owner: claude
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: Issue269 comment6248764751 SOURCE_ONLY_SECURITY_FIX_GO; J2 PR276 V2 P2x2; PR276 head 39ab57ab; PR126 65f49f98; G3 PR278 atomic credentialFor 64hex; F5 owner lifecycle ACK
- blocker: PR282 source candidate delivered; F5 owner epoch missing/ACK pending, G3 atomic port ACK pending, independent J2 focused security rereview required; real OAuth/X/managed/prod NO_GO
- previous_archive: .agent_v2/archive/2026-10-18-F4-postona-f4-m1-x-identity-verified-credential-port-source-20261018/
- slot_use: G4-owned source-only P2x2 repair + atomic provider contract, isolated PG17/mock no production

## F5
- slot: F5
- status: ready
- task_id: common-account-f5-shared-owner-epoch-monotonic-source-candidate-20261019
- owner: claude
- next_owner: claude
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- previous_archive: .agent_v2/archive/2026-10-19-F5-postona-f5-m2-ai-consult-auth-acl-owner-gap-source-design-20261018/
- dependencies: Issue269 comment 6251536852; G4 PR282 owner epoch; G3 PR278; J2 review
- blocker: independent clean worktree and exact membership ownership/PR overlap need verification before coding
- review_required: focused Codex Sol（高） before production application; no J slot assigned
- slot_use: shared cross-app owner epoch source candidate, offline tests only; AI Option B remains HOLD

## F6
- slot: F6
- status: done
- task_id: common-ai-f6-postona-openai-consult-offline-one-request-integration-20261018
- owner: claude
- next_owner: none
- blocker: L6 PASS_OFFLINE_INTEGRATION PR273, live POSTONA consult remains unconnected; production entitlement, operationId, actual call store/quota, managed RLS and API verification NOT_VERIFIED; production NO_GO.
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
- status: idle
- task_id: none
- owner: claude
- next_owner: none
- return_to: none
- completion_code: L10
- recommended_model: none
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- blocker: G10 V3 cutover; do not assign F10
- previous_archive: .agent_v2/archive/2026-10-18-F10-orchestration-f10-v3-automation-readiness-compat-source-20261018/

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
- status: ready
- task_id: postona-j2-pr282-r1-r2-atomic-credential-focused-rereview-20261018
- owner: codex
- next_owner: codex
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- dependencies: PR282 HEAD39b9064dc79ad52b430ba820006cd3310bf3140f on PR276 HEAD39ab57ab; prior J2 V2 P2x2; G3 PR278 and F5 owner epoch missing
- blocker: Focused security rereview NOT_STARTED; F5 owner epoch unavailable in real source and G3 atomic ACK pending; no real OAuth/Vault/X/managed/production/merge/deploy
- previous_archive: .agent_v2/archive/2026-10-18-J2-postona-j2-pr276-x-oauth-credential-security-review-20261018/
- slot_use: independent restricted source-only security retest P2x2 + atomic token generation, no product edits

## J3
- slot: J3
- status: done
- task_id: kabumori-j3-f2-pr213-p1p2-focused-rereview-20261018
- owner: codex
- next_owner: none
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- completion_code: V3
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J3.md
- current_report_path: .agent_v2/reports/J3.md
- dependencies: F2 L2 pending; PR213 HEAD c10f1da593ba3dc365cf340e9569ae1caa9789b1; original findings PR218 HEAD e2730e7b83e07fb73be099ba20251581b2969f30; F8 R1 separate
- blocker: Previous J3 cancelled worktree/uncommitted state NOT_VERIFIED. MUST use a verified independent clean checkout/worktree without touching old one; source-only/no real X/AI/managed/production.
- previous_archive: .agent_v2/archive/2026-10-17-J3-duplicate-review-cancelled/
- slot_use: Independent narrow review of F2 R2 P1 unauthenticated AI-generation entry and R3 P2 wrong-owner planner restore, POSTONA/other-brand nonregression only. No broad review; G1 receives V3 before F2 L2 closure. No edits to F2 source.

- pause_closure: USER_CANCELLED_UNSTARTED / V3 NOT_EXECUTED; no security PASS
- pause_archive: .agent_v2/archive/2026-10-18-kabumori-pause-f2-j3-user-deferred/

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
