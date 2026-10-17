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
- status: done
- task_id: postona-f4-f5-service-end-g1-g2-joint-integration-20261017
- owner: claude
- next_owner: none
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: L4
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F4.md
- current_report_path: .agent_v2/tasks/F4.md#report
- dependencies: PR236 F4 605d8776; PR235 F5 9480f24b; both Draft; F5 L5 accepted; PR230 design B
- blocker: assembled-source integration and Auth/cross-user review pending; production NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-F4-postona-f4-service-lifecycle-provider-g1-g2-implementation-20261017/F4.md
- slot_use: integrate existing F4 Provider/Surface and F5 gate in isolated integration branch; no duplicate provider implementation

- l4_verdict_20261017_joint: PASS_SOURCE_INTEGRATION / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; PR238 b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6 Draft; 9/9 integration, app376/376, mutations13/13 reported; one focused independent review pending.

## F5
- slot: F5
- status: done
- task_id: common-account-f5-postona-service-end-entitlement-epoch-g1-g2-20261017
- owner: claude
- next_owner: none
- return_to: 共通アカウントG5のちゃ（新F5担当）
- completion_code: L5
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F5.md
- current_report_path: .agent_v2/tasks/F5.md#report
- dependencies: F4 PR230 e6725a165cd8f116a964926cdfceaa9334590491 design B + F4-owned lifecycle provider/surface implementation pending; POSTONA client PR197/211/217/221 ancestry; H5 reauthentication contract read-only; F5 prior PR233 499a9e1f security guard stack independent
- blocker: F4 provider runtime path/signature and ancestry/changed-path isolation must be confirmed in preflight; Phase12 PR233 security recheck separate; production NO_GO
- slot_use: POSTONA G1 stale enrollment after service end, G2 same-user session turnover support within F5-owned ServiceEnrollmentGate and gate-only tests
- previous_archive: .agent_v2/archive/2026-10-17-F5-common-account-f5-j1-v1-phase12-security-guards-p2x4-fix-20261016/
- review_required: focused F4/F5 joint Auth and cross-user integration review after implementation only
- latest_result: PASS_SOURCE_CANDIDATE / PRODUCTION_NO_GO; gate-side epoch refresh PR235 head 9480f24b Draft stacked on PR230 (e6725a16); 355 app tests, fail-before 15/19 then 19/19, tsc+lint clean, gate/seam mutants 13/13; seam to F4 provider NOT connected (LIFECYCLE_SIGNAL_CONNECTED=false) so G1 stays open in product until F4 provider lands; mocked harness only, no managed access; F4+F5 joint focused review pending.

- l5_verdict_20261017: PASS_SOURCE_CANDIDATE / INTEGRATION_PENDING / PRODUCTION_NO_GO. PR235 exact HEAD 9480f24b68c209f6bf33b499dc11824cf4595fdd; implementer-reported local 355 app tests, 19/19 gate tests, 13/13 mutants, TS/lint PASS. F4 provider export missing; F5 seam remains disconnected and actual G1 product behavior unresolved. F4/F5 integrated tests and one focused Auth/cross-user review required before release. No merge/deploy.

## F6
- slot: F6
- status: review_required
- task_id: common-ai-f6-postona-claude-bridge-integration-preflight-20261017
- owner: claude
- next_owner: chatgpt
- blocker: PREFLIGHT_DONE source-only Draft PR #239 (f590b80f, base PR237 d0c85b3e): docs contracts for POSTONA consult + post generation via H5 bridge (one-JSON consult input with POSTONA sanitizer as validateFacts, {text} post wrapper, user subject without slug brand, operationId, error mapping, Haiku proposal) + offline contract test 6 PASS; nothing wired; blockers: personal data to Anthropic (standing rule) + privacy notice, ledger POSTONA policies (DB), durable call store (DB), slug brand / cron subject, per-user quota + entitlement, isolation allowlist F6+H5, static pins, paid quality check, x-test-post deploy bundle; provider153 bridge27 market324 merged541 PASS; production NO_GO
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- completion_code: L6
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F6.md
- current_report_path: .agent_v2/tasks/F6.md#report
- dependencies: Draft PR187→198→205→219→222→231→234→237, H5 bridge, inventory PR216; F4 service lifecycle ready
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr237-escaped-keyword-fix.md
- slot_use: F6 POSTONA Claude API interface and offline integration preflight

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
- task_id: orchestration-v3-pr229-security-review-high-medium-fixes-f10-20261016
- owner: claude
- next_owner: none
- return_to: かぶモリ30枠統括のちゃ（このチャット）
- completion_code: L10
- recommended_model: Opus5.5（高）
- current_task_path: .agent_v2/tasks/F10.md
- current_report_path: .agent_v2/tasks/F10.md#report
- dependencies: Draft PR229 (7ce49c0b) independent review CHANGES_REQUIRED; previous F10 TASK archived; old/new operating systems protected
- blocker: L10 PASS_SOURCE_FIX / V3_CUTOVER_NO_GO — focused independent rereview, branch CAS and ChatGPT connector write proof outstanding
- slot_use: PR229 H1-H3/M1-M4/L1-L7 source fixes accepted at L10; F10 done/unreserved; no merge/cutover

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
